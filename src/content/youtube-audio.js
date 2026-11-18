// Capture only the player's audio track; no microphone or tab-wide sound.
const lmYoutubeAudio = (() => {
  const rate = 16000;
  let session;
  function stop() {
    if (!session) return;
    const { stream, ctx, processor, events } = session;
    session = null;
    events.abort();
    if (processor) {
      processor.port.onmessage = null;
      processor.port.close();
      processor.disconnect();
    }
    stream.getTracks().forEach(track => track.stop());
    ctx?.close().catch(() => {});
  }
  async function start(video, valid, notifyEnd) {
    stop();
    if (!video?.captureStream) throw new Error("当前视频无法提供原声音轨");
    const stream = video.captureStream();
    const tracks = stream.getAudioTracks();
    if (!tracks.length) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error("请先播放视频，再开启原声校对");
    }
    const events = new AbortController();
    const state = session = { stream, events, video, blocks: [], ctx: null, processor: null };
    let validFrom = 0;
    const reset = () => {
      state.blocks.length = 0;
      validFrom = state.ctx?.currentTime || 0;
    };
    for (const event of ["seeking","ratechange","emptied","waiting"]) video.addEventListener(event, reset, { signal: events.signal });
    const end = () => { if (session === state) { stop(); notifyEnd(); } };
    // Finishing the video may end its captured track. Keep the last sentence
    // available for review until the viewer leaves or starts playback again.
    tracks[0].addEventListener("ended", () => {
      if (!video.ended) { end(); return; }
      video.addEventListener("play", () => {
        if (session === state) start(video, valid, notifyEnd).catch(notifyEnd);
      }, { once: true, signal: events.signal });
    }, { signal: events.signal });
    window.addEventListener("pagehide", end, { signal: events.signal });
    try {
      const ctx = state.ctx = new AudioContext({ sampleRate: rate });
      await ctx.audioWorklet.addModule(chrome.runtime.getURL("src/audio/capture-worklet.js"), { credentials: "omit" });
      if (session !== state) return;
      if (!valid()) { end(); return; }
      const processor = state.processor = new AudioWorkletNode(ctx, "linguamate-capture", {
        channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1]
      });
      const source = ctx.createMediaStreamSource(new MediaStream(tracks));
      source.connect(processor);
      processor.connect(ctx.destination);
      processor.onprocessorerror = end;
      processor.port.onmessage = ({ data: { samples: data, endTime } }) => {
        if (session !== state) return;
        if (!valid()) { end(); return; }
        if (video.closest(".ad-showing, .ad-interrupting")) { reset(); return; }
        if (video.paused || video.seeking || video.readyState < 3) return;
        const seconds = data.length / rate;
        if (endTime - seconds < validFrom - 1 / rate) return;
        const lag = Math.max(0, ctx.currentTime - endTime);
        const observed = video.currentTime - lag * video.playbackRate;
        const duration = seconds * video.playbackRate;
        let previous = state.blocks.at(-1);
        if (previous && Math.abs(previous.end + duration - observed) > .18) { reset(); previous = null; }
        const start = previous?.end ?? observed - duration;
        state.blocks.push({ start, end: start + duration, data });
        while (state.blocks.length > 470 || state.blocks[0].end < observed - 30) state.blocks.shift();
      };
      await ctx.resume();
    } catch (error) {
      if (session !== state) return;
      stop();
      throw error;
    }
  }
  function slice(start, end) {
    const recorded = session?.blocks;
    if (!recorded?.length || recorded[0].start > start + .07 || recorded.at(-1).end < end - .07) return null;
    // Caption and audio clocks have different frame boundaries. Keep a small
    // acoustic margin when available so initial or final syllables survive.
    start -= .16;
    end += .12;
    const blocks = recorded.filter(b => b.end > start && b.start < end);
    const parts = blocks.map(b => {
      const scale = b.data.length / (b.end - b.start);
      return b.data.subarray(Math.max(0, Math.round((start-b.start)*scale)), Math.min(b.data.length, Math.round((end-b.start)*scale)));
    });
    const samples = new Float32Array(parts.reduce((n,p) => n+p.length,0));
    let offset = 0, energy = 0;
    for (const p of parts) { samples.set(p, offset); offset += p.length; }
    for (const v of samples) energy += v*v;
    if (samples.length < 3200 || samples.length > rate*19) throw new Error("请选取不超过 18 秒的完整语句，并尝试以正常速度播放");
    if (energy / samples.length < 1e-8) throw new Error("未采到可辨识的声音，请检查播放器音量和音轨后重播");
    return samples;
  }
  function replay(samples) {
    if (!session) return;
    session.video.pause();
    const state = session;
    state.replay?.stop();
    const { ctx } = state;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples, 0);
    const player = ctx.createBufferSource();
    state.replay = player;
    player.onended = () => {
      player.disconnect();
      if (state.replay === player) state.replay = null;
    };
    player.buffer = buffer;
    player.connect(ctx.destination);
    ctx.resume(); player.start();
  }
  async function recognize(samples, signal, status) {
    const ready = await lmSendMessage("LM_AUDIO_PREPARE");
    if (!ready?.ok) throw new Error(ready?.error || "无法启动本地识别");
    signal.throwIfAborted();
    const pcm = Int16Array.from(samples, n => Math.round(Math.max(-1,Math.min(1,n))*32767));
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "lm-ja-audio" });
      const cancel = () => { port.disconnect(); reject(new Error("已取消校对")); };
      signal.addEventListener("abort", cancel, { once:true });
      port.onDisconnect.addListener(() => {
        signal.removeEventListener("abort", cancel);
        reject(new Error(chrome.runtime.lastError?.message || "本地识别已断开，请重试"));
      });
      port.onMessage.addListener(msg => {
        if (msg.status) { status(msg.status); return; }
        signal.removeEventListener("abort", cancel);
        if (msg.error) reject(new Error(msg.error)); else resolve(msg);
        port.disconnect();
      });
      port.postMessage({ pcm: btoa(binary) });
    });
  }
  return { start, stop, slice, replay, recognize, get active() { return !!session; } };
})();
