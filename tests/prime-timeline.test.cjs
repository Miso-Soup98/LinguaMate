const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/shared/prime-timeline.js"), "utf8"), context);
const create = context.lmPrimeTimeline.create;
const snapshot = (timeline) => JSON.parse(JSON.stringify(timeline.breaks()));

test("a timeline without ads preserves media and content timestamps", () => {
  const timeline = create();
  for (const time of [0, 0.125, 999, 10000, 3600000]) {
    assert.equal(timeline.toContent(time), time);
    assert.equal(timeline.toMedia(time), time);
  }
  assert.deepEqual(snapshot(timeline), []);
});

test("an inserted ad freezes content until its end and inverse seeks skip the ad boundary", () => {
  const timeline = create();
  assert.equal(timeline.addBreak(10000, 40000), true);
  assert.equal(timeline.toContent(9999), 9999);
  assert.equal(timeline.toContent(10000), 10000);
  assert.equal(timeline.toContent(25000), 10000);
  assert.equal(timeline.toContent(39999), 10000);
  assert.equal(timeline.toContent(40000), 10000);
  assert.equal(timeline.toContent(42500), 12500);
  assert.equal(timeline.toMedia(9999), 9999);
  assert.equal(timeline.toMedia(10000), 40000);
  assert.equal(timeline.toMedia(12500), 42500);
});

test("multiple ads preserve correct seeking before, between and after breaks", () => {
  const timeline = create();
  timeline.setBreaks([{ start: 10000, end: 40000 }, { start: 60000, end: 80000 }]);
  assert.equal(timeline.toContent(65000), 30000);
  assert.equal(timeline.toContent(80000), 30000);
  assert.equal(timeline.toContent(95000), 45000);
  // Jump backwards across both ads, then forward across one or both.
  for (const [content, media] of [[45000, 95000], [5000, 5000], [15000, 45000], [30000, 80000], [10000, 40000]]) {
    assert.equal(timeline.toMedia(content), media);
    assert.equal(timeline.toContent(media), content);
  }
});

test("pre-rolls and consecutive ads collapse into one shared content boundary", () => {
  const timeline = create();
  timeline.setBreaks([{ start: 0, end: 15000 }, { start: 15000, end: 30000 }, { start: 60000, end: 70000 }]);
  assert.deepEqual(snapshot(timeline), [{ start: 0, end: 30000 }, { start: 60000, end: 70000 }]);
  assert.equal(timeline.toContent(0), 0);
  assert.equal(timeline.toContent(25000), 0);
  assert.equal(timeline.toContent(30000), 0);
  assert.equal(timeline.toMedia(0), 30000);
  assert.equal(timeline.toMedia(30000), 70000);
});

test("overlap, containment and duplicate observations never count advertising twice", () => {
  const timeline = create();
  timeline.setBreaks([{ start: 50000, end: 60000 }, { start: 10000, end: 20000 }, { start: 15000, end: 25000 }]);
  timeline.addBreak(12000, 18000);
  timeline.addBreak(50000, 60000);
  timeline.addBreak(25000, 30000);
  assert.deepEqual(snapshot(timeline), [{ start: 10000, end: 30000 }, { start: 50000, end: 60000 }]);
  assert.equal(timeline.toContent(70000), 40000);
  timeline.addBreak(20000, 55000);
  assert.deepEqual(snapshot(timeline), [{ start: 10000, end: 60000 }]);
  assert.equal(timeline.toMedia(10000), 60000);
});

test("authoritative replacement removes old observations and reset clears all offsets", () => {
  const timeline = create();
  timeline.addBreak(10000, 20000);
  timeline.setBreaks([{ start: 30000, end: 35000 }]);
  assert.deepEqual(snapshot(timeline), [{ start: 30000, end: 35000 }]);
  assert.equal(timeline.toMedia(15000), 15000);
  timeline.setBreaks([]);
  assert.equal(timeline.toMedia(40000), 40000);
  timeline.addBreak(0, 10000);
  timeline.reset();
  assert.deepEqual(snapshot(timeline), []);
  assert.equal(timeline.toMedia(0), 0);
  assert.equal(timeline.toContent(40000), 40000);
});

test("malformed break lists and observations are rejected without corrupting the timeline", () => {
  const timeline = create();
  timeline.addBreak(100, 200);
  for (const value of [null, undefined, {}, "", 0, [null], [[]], new Array(2), [{ start: 0 }], [{ start: 0, end: 0 }],
    [{ start: -1, end: 100 }], [{ start: 100, end: 99 }], [{ start: NaN, end: 100 }],
    [{ start: 0, end: Infinity }], [{ start: "0", end: 100 }], [{ start: false, end: 100 }],
    [{ start: 300, end: 400 }, { start: 500, end: -1 }]]) {
    assert.equal(timeline.setBreaks(value), false);
    assert.deepEqual(snapshot(timeline), [{ start: 100, end: 200 }]);
  }
  for (const [start, end] of [[0, 0], [100, 1], [-1, 100], [0, Infinity], [NaN, 100], ["0", 100], [null, 100], [true, 100]]) {
    assert.equal(timeline.addBreak(start, end), false);
    assert.deepEqual(snapshot(timeline), [{ start: 100, end: 200 }]);
  }
});

test("timestamps reject invalid values and retain fractional millisecond precision", () => {
  const timeline = create();
  timeline.addBreak(0.25, 0.75);
  assert.equal(timeline.toContent(0.125), 0.125);
  assert.equal(timeline.toContent(0.5), 0.25);
  assert.equal(timeline.toContent(1), 0.5);
  assert.equal(timeline.toMedia(0.25), 0.75);
  assert.equal(timeline.toMedia(0.5), 1);
  for (const value of [NaN, Infinity, -Infinity, -1, "1", null, undefined, true, {}, []]) {
    assert.equal(Number.isNaN(timeline.toContent(value)), true);
    assert.equal(Number.isNaN(timeline.toMedia(value)), true);
  }
});

test("break snapshots and caller-owned input cannot mutate the stored intervals", () => {
  const timeline = create();
  const source = [{ start: 100, end: 200 }];
  timeline.setBreaks(source);
  source[0].start = 0;
  source.push({ start: 400, end: 500 });
  const copy = timeline.breaks();
  copy[0].end = 99999;
  copy.push({ start: 600, end: 700 });
  assert.deepEqual(snapshot(timeline), [{ start: 100, end: 200 }]);
});

test("round trips are monotonic across unsorted fractional and overlapping breaks", () => {
  const timeline = create();
  timeline.setBreaks([{ start: 800, end: 950 }, { start: 20.25, end: 80.5 }, { start: 60, end: 100 }, { start: 300, end: 350 }]);
  let previous = -1;
  for (let media = 0; media <= 1200; media += 0.25) {
    const content = timeline.toContent(media);
    assert.equal(content >= previous, true);
    assert.equal(timeline.toContent(timeline.toMedia(content)), content);
    previous = content;
  }
  for (let content = 0; content <= 1200; content += 0.25) {
    assert.equal(timeline.toContent(timeline.toMedia(content)), content);
  }
});

test("separate factory instances do not share observed ad intervals", () => {
  const first = create();
  const second = create();
  first.addBreak(0, 10000);
  assert.equal(first.toMedia(0), 10000);
  assert.equal(second.toMedia(0), 0);
  second.addBreak(20000, 30000);
  first.reset();
  assert.deepEqual(snapshot(second), [{ start: 20000, end: 30000 }]);
});
