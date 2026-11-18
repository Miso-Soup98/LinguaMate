const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("audio slices stay within a continuous playback interval and discard ads and old samples", async () => {
  const video = new EventTarget(), track = new EventTarget();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let ctx, processor, isAd = false, stopped = false;
  track.stop = () => { stopped = true; };
  Object.assign(video, {
    captureStream: () => stream, currentTime: 0, playbackRate: 1,
    paused: false, seeking: false, readyState: 4, closest: () => isAd
  });
  class AudioContext {
    constructor() {
      ctx = this;
      this.currentTime = 0;
      this.audioWorklet = { addModule: async name => assert.equal(name, "src/audio/capture-worklet.js") };
    }
    createMediaStreamSource() { return { connect() {} }; }
    async resume() {}
    async close() {}
  }
  const context = vm.createContext({
    AudioContext, chrome: { runtime: { getURL: path => path } },
    AudioWorkletNode: class {
      constructor() { processor = this; this.port = { close() {} }; }
      connect() {}
      disconnect() {}
    }, MediaStream: class {}, AbortController, window: new EventTarget()
  });
  const file = path.resolve(__dirname, "../src/content/youtube-audio.js");
  vm.runInContext(fs.readFileSync(file, "utf8") + "\nglobalThis.audio = lmYoutubeAudio;", context);
  const audio = context.audio;
  await audio.start(video, () => true, () => {});
  const feed = (count, amplitude = .25) => {
    const input = new Float32Array(1024).fill(amplitude);
    for (let i = 0; i < count; i++) {
      video.currentTime += input.length / 16000;
      ctx.currentTime += input.length / 16000;
      processor.port.onmessage({ data: { samples: input, endTime: ctx.currentTime } });
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
  processor.port.onmessage({ data: { samples: new Float32Array(1024).fill(.5), endTime: ctx.currentTime - .5 } });
  assert.equal(audio.slice(video.currentTime - .05, video.currentTime), null);
  const start = video.currentTime;
  feed(30, 0);
  assert.throws(() => audio.slice(start + .1, start + 1), /声音/);
  audio.stop();
  assert.equal(audio.active, false);
  assert.equal(stopped, true);
  assert.equal(processor.port.onmessage, null);
  const oldProcessor = processor;
  const pending = audio.start(video, () => true, () => {});
  audio.stop();
  await pending;
  assert.equal(processor, oldProcessor, "closing during module loading does not reconnect the track");
});

test("the capture worklet batches contiguous mono samples and timestamps each block", () => {
  let Capture;
  const messages = [];
  const context = vm.createContext({
    currentFrame: 0, sampleRate: 16000,
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: (msg, transfer) => messages.push(structuredClone(msg, { transfer })) }; }
    },
    registerProcessor(name, ctor) { assert.equal(name, "linguamate-capture"); Capture = ctor; }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/audio/capture-worklet.js"), "utf8"), context);
  const node = new Capture();
  node.process([[new Float32Array(128).fill(-1)]]);
  node.process([[]]);
  context.currentFrame = 256;
  for (let index = 0; index < 9; index++) {
    node.process([[new Float32Array(256).fill(index)]]);
    context.currentFrame += 256;
  }
  assert.equal(messages.length, 2);
  assert.equal(messages[0].endTime, 1280 / 16000);
  assert.equal(messages[0].samples.length, 1024);
  assert.equal(messages[0].samples[0], 0);
  assert.equal(messages[0].samples.at(-1), 3);
  assert.equal(messages[1].samples[0], 4);
  assert.equal(messages[1].samples.at(-1), 7);
});

test("model download progress handles chunked, compressed and sized responses", async () => {
  const { readModelResponse } = await import("../src/audio/read-model-response.mjs");
  for (const [headers, percent] of [
    [{}, null],
    [{ "Content-Length": "5", "Content-Encoding": "gzip" }, null],
    [{ "Content-Length": "4" }, 50]
  ]) {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
      controller.enqueue(Uint8Array.of(3, 4));
      controller.close();
    } });
    const reports = [];
    const bytes = await readModelResponse(new Response(stream, { headers }), event => reports.push(event));
    assert.deepEqual([...bytes], [1, 2, 3, 4]);
    assert.equal(reports[0].progress, percent);
    assert.equal(reports[0].loaded, 2);
    assert.deepEqual(reports.at(-1), { loaded: 4, total: 4, progress: 100 });
  }
  const broken = new ReadableStream({ start(controller) { controller.error(new Error("interrupted")); } });
  await assert.rejects(readModelResponse(new Response(broken), () => assert.fail("unexpected progress")), /interrupted/);
});
