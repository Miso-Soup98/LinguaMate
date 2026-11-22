const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../src/content/youtube-progress.js"), "utf8");
function fixture({ type = "reload", url = "https://www.youtube.com/watch?v=abc", storage = new Map() } = {}) {
  let time = 0;
  const context = vm.createContext({
    URL, location: new URL(url),
    performance: { getEntriesByType: () => [{ type }], now: () => time },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    }
  });
  vm.runInContext(script + "\nthis.progress = lmYoutubeProgress", context);
  const video = {
    readyState: 2, currentTime: 0, duration: 180, seeking: false, ended: false, paused: true,
    ad: false, closest() { return this.ad; },
    seekable: { length: 1, start: () => 0, end: () => 180 },
    play() { assert.fail("refresh must not start a paused video"); }
  };
  const progress = context.progress;
  const observe = (elapsed, id = "abc") => { time += elapsed; progress.observe(video, id); };
  return { progress, video, observe, storage };
}

function savedPosition() {
  const page = fixture({ type: "navigate" });
  page.video.currentTime = 57.5;
  page.observe(0);
  page.progress.save("abc");
  return page.storage;
}

test("same-tab reload restores position once without changing paused playback", () => {
  const page = fixture({ storage: savedPosition() });
  page.observe(0);
  page.observe(600);
  assert.equal(page.video.currentTime, 0, "allow the player to handle the start position");
  page.progress.save("abc");
  page.observe(500);
  assert.equal(page.video.currentTime, 57.5);
  assert.equal(page.video.paused, true);
  page.video.currentTime = 10;
  page.observe(3000);
  assert.equal(page.video.currentTime, 10, "later seeks are respected");
});

test("links, explicit seeks, other videos and native resume take precedence", () => {
  for (const options of [
    { type: "navigate" },
    { url: "https://www.youtube.com/watch?v=xyz" },
    { url: "https://www.youtube.com/watch?v=abc&t=15s" },
    { url: "https://www.youtube.com/watch?v=abc#t=15s" },
    { url: "https://www.youtube.com/shorts/abc" }
  ]) {
    const page = fixture({ ...options, storage: savedPosition() });
    page.observe(0);
    page.observe(1500);
    assert.equal(page.video.currentTime, 0, options.url || options.type);
  }
  const native = fixture({ storage: savedPosition() });
  native.observe(0);
  native.video.currentTime = 88;
  native.observe(1200);
  assert.equal(native.video.currentTime, 88);
  const manual = fixture({ storage: savedPosition() });
  manual.observe(0);
  manual.progress.skip();
  manual.video.currentTime = 1;
  manual.observe(1200);
  assert.equal(manual.video.currentTime, 1);
});

test("resume waits for the programme and a seekable range", () => {
  const page = fixture({ storage: savedPosition() });
  page.video.ad = true;
  page.observe(0);
  page.observe(3000);
  assert.equal(page.video.currentTime, 0);
  page.video.ad = false;
  page.video.seekable.length = 0;
  page.observe(0);
  page.observe(1200);
  assert.equal(page.video.currentTime, 0);
  page.video.seekable.length = 1;
  page.observe(220);
  assert.equal(page.video.currentTime, 57.5);
  page.video.ended = true;
  page.observe(120);
  page.progress.save("abc");
  assert.equal(page.storage.size, 0);
});
