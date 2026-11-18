// A port ties each inference to the originating tab. Closing it cancels work.
let worker, owner, idleTimer;
function release() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = owner = null;
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "lm-ja-audio" || port.sender?.frameId !== 0 ||
      !port.sender?.tab || !/^https:\/\/(?:www\.|m\.)?youtube\.com\//.test(port.sender.url || "")) return;
  port.onDisconnect.addListener(() => { if (owner === port) release(); });
  port.onMessage.addListener(msg => {
    if (owner) { port.postMessage({ error: "另一句正在校对，请稍后再试" }); return; }
    if (typeof msg.pcm !== "string" || !msg.pcm.length || msg.pcm.length > 820000) {
      port.postMessage({ error: "音频长度不受支持" }); return;
    }
    try {
      const bytes = Uint8Array.from(atob(msg.pcm), c => c.charCodeAt(0));
      const samples = Float32Array.from(new Int16Array(bytes.buffer), v => v / 32768);
      clearTimeout(idleTimer);
      worker ||= new Worker("recognize.mjs", { type: "module" });
      owner = port;
      worker.onmessage = ({ data }) => {
        if (owner !== port) return;
        if (!data.status) {
          owner = null;
          idleTimer = setTimeout(release, 90000);
        }
        port.postMessage(data);
      };
      worker.onerror = e => { release(); port.postMessage({ error: "本地识别未能运行：" + e.message }); };
      worker.postMessage({ samples }, [samples.buffer]);
    } catch (error) { release(); port.postMessage({ error: error.message }); }
  });
});
