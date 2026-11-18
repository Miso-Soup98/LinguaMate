const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("audio slices stay within a continuous playback interval and discard ads and old samples", async () => {
  const video = new EventTarget(), track = new EventTarget();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let processor, isAd = false, stopped = false;
  track.stop = () => { stopped = true; };
  Object.assign(video, {
    captureStream: () => stream, currentTime: 0, playbackRate: 1,
    paused: false, seeking: false, readyState: 4, closest: () => isAd
  });
  class AudioContext {
    createScriptProcessor() { return processor = { connect() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    async resume() {}
    async close() {}
  }
  const context = vm.createContext({
    AudioContext, MediaStream: class {}, AbortController, window: new EventTarget()
  });
  const file = path.resolve(__dirname, "../src/content/youtube-audio.js");
  vm.runInContext(fs.readFileSync(file, "utf8") + "\nglobalThis.audio = lmYoutubeAudio;", context);
  const audio = context.audio;
  await audio.start(video, () => true, () => {});
  const feed = (count, amplitude = .25) => {
    const input = new Float32Array(1024).fill(amplitude);
    for (let i = 0; i < count; i++) {
      video.currentTime += input.length / 16000;
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => input } });
    }
  };
  feed(40);
  const clip = audio.slice(.5, 1.5);
  assert.ok(clip.length >= 16000 && clip.length <= 16000 * 1.3);
  assert.equal(clip[0], .25);
  assert.equal(audio.slice(.5, 4), null);
  isAd = true;
  feed(3);
  assert.equal(audio.slice(.5, 1.5), null);
  isAd = false;
  feed(500);
  assert.equal(audio.slice(2.8, 3.5), null);
  assert.ok(audio.slice(33, 34));
  video.dispatchEvent(new Event("seeking"));
  assert.equal(audio.slice(33, 34), null);
  const start = video.currentTime;
  feed(30, 0);
  assert.throws(() => audio.slice(start + .1, start + 1), /声音/);
  audio.stop();
  assert.equal(audio.active, false);
  assert.equal(stopped, true);
  assert.equal(processor.onaudioprocess, null);
});
