const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const fixture = { exports: {} };
vm.runInNewContext(source("tests/prime-harness.cjs").replace("module.exports = { primeHarness };", "module.exports = { Element };"), { require, module: fixture, __dirname });
const { Element } = fixture.exports;
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };
const analysis = { surface: "食べませんでした", lemma: "食べる", reading: "たべませんでした", baseReading: "たべる", pos: "動詞", conjugation: { type: "一段", form: "連用形", labels: ["礼貌体", "否定", "过去"] }, isWordLike: true };

function harness({ intersectionObserver = false } = {}) {
  const document = {};
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (value) => { const node = new Element("#text", document, 3); node._text = value; return node; };
  document.createDocumentFragment = () => new Element("#fragment", document, 11);
  document.documentElement = document.createElement("html");
  document.querySelectorAll = (selector) => document.documentElement.querySelectorAll(selector);
  const requests = [];
  const pending = [];
  const timers = [];
  const observers = [];
  const Observer = intersectionObserver ? class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
  } : undefined;
  const context = vm.createContext({ document, Intl, IntersectionObserver: Observer, setTimeout(callback) { timers.push(callback); return timers.length; }, lmSendMessage(type, payload) { requests.push({ type, payload }); return new Promise((resolve) => pending.push(resolve)); } });
  vm.runInContext(source("src/shared/japanese-ui.js"), context);
  vm.runInContext(source("src/shared/japanese-client.js"), context);
  const createTarget = () => { const target = document.createElement("div"); target.className = "lm-line"; document.documentElement.appendChild(target); return target; };
  return { document, client: context.lmJapaneseClient, createTarget, requests, pending, timers, observers };
}

test("subtitle analyses coalesce across targets, cache confirmed results and preserve stable renders", async () => {
  const h = harness();
  const first = h.createTarget(), second = h.createTarget();
  let analyzed = 0;
  const options = { lang: "ja", furigana: "all", onAnalyzed() { analyzed += 1; } };
  const one = h.client.render(first, analysis.surface, options);
  const two = h.client.render(second, analysis.surface, options);
  assert.ok(first.querySelector(".lm-word"), "the original text remains interactive while analysis loads");
  await flush();
  assert.equal(h.requests.length, 1);
  h.pending[0]({ ok: true, tokens: [analysis] });
  await Promise.all([one, two]);
  assert.equal(first.querySelector(".lm-word").dataset.lemma, "食べる");
  assert.equal(second.querySelector("rt").textContent, analysis.reading);
  const node = first.querySelector(".lm-word");
  await h.client.render(first, analysis.surface, options);
  assert.equal(first.querySelector(".lm-word"), node, "unchanged ticks must not replace the hover target");
  await h.client.render(h.createTarget(), analysis.surface, options);
  assert.equal(h.requests.length, 1);
  assert.equal(analyzed, 3);
});

test("late analyses cannot overwrite a newer caption or a non-Japanese render", async () => {
  const h = harness(); const target = h.createTarget();
  const old = h.client.render(target, analysis.surface, { lang: "ja" }); await flush();
  const newer = h.client.render(target, "駅", { lang: "ja" }); await flush();
  h.pending[0]({ ok: true, tokens: [analysis] }); await old;
  assert.equal(target.querySelector(".lm-word").dataset.word, "駅");
  h.client.invalidate(target); target.textContent = "English sentence";
  h.pending[1]({ ok: true, tokens: [{ surface: "駅", lemma: "駅", reading: "えき" }] }); await newer;
  assert.equal(target.textContent, "English sentence");
});

test("analysis completion waits for an active hover before replacing fallback word nodes", async () => {
  const h = harness(); const target = h.createTarget();
  const promise = h.client.render(target, analysis.surface, { lang: "ja", furigana: "all" }); await flush();
  const original = target.querySelector(".lm-word"); original.hovered = true;
  h.pending[0]({ ok: true, tokens: [analysis] }); await promise;
  assert.equal(target.querySelector(".lm-word"), original);
  assert.equal(target.querySelector("rt"), null);
  original.hovered = false; h.timers.shift()();
  assert.equal(target.querySelector(".lm-word").dataset.lemma, "食べる");
  assert.equal(target.querySelector("rt").textContent, analysis.reading);
});

test("analysis errors and incomplete token sequences preserve the original interactive text", async () => {
  const h = harness(); const target = h.createTarget();
  const promise = h.client.render(target, analysis.surface, { lang: "ja" }); await flush();
  const originalText = target.textContent;
  h.pending[0]({ ok: true, tokens: [{ surface: "食べる", lemma: "食べる" }] }); await promise;
  assert.equal(target.textContent, originalText);
  assert.equal(target.dataset.japaneseState, "unavailable");
  assert.ok(target.querySelector(".lm-word"));
});

test("persistent analysis contains only supported text fields and flattens real conjugation metadata", () => {
  const h = harness();
  const saved = h.client.persistent({ ...analysis, candidates: [{ interpretation: "可能" }], parts: [{ source: "ignored" }], unknown: true, entryId: "10001" });
  assert.equal(saved.conjugation, "一段 · 連用形 · 礼貌体 · 否定 · 过去");
  assert.equal(saved.lemma, "食べる");
  assert.equal(saved.entryId, "10001");
  assert.equal(saved.candidates, undefined);
  assert.equal(saved.parts, undefined);
  assert.equal(h.client.persistent({ surface: "未知の語" }), undefined);
});

test("offscreen transcript analysis waits for visibility or deliberate interaction while overlays start immediately", async () => {
  const h = harness({ intersectionObserver: true });
  const lines = Array.from({ length: 100 }, (_, index) => {
    const target = h.createTarget(); target.className = "lm-cue-learning";
    h.client.render(target, `字幕${index}`, { lang: "ja" }); return target;
  });
  await flush(); assert.equal(h.requests.length, 0, "a long transcript should not analyze every row at once");
  assert.equal(h.observers[0].options.rootMargin, "250px");
  h.observers[0].callback([{ target: lines[0], isIntersecting: true }, { target: lines[1], isIntersecting: true }]);
  await flush(); assert.equal(h.requests.length, 2);
  const overlay = h.createTarget(); h.client.render(overlay, "当前字幕", { lang: "ja" }); await flush();
  assert.equal(h.requests.length, 3);
  lines[80].emit("mouseenter"); await flush();
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].payload.text, "字幕80", "a user interaction can prioritize an offscreen row");
  for (const target of lines) h.client.invalidate(target);
  h.client.invalidate(overlay);
});

test("analysis concurrency is bounded and an overlay jumps ahead of queued transcript rows", async () => {
  const h = harness();
  const lowPriority = Array.from({ length: 12 }, (_, index) => h.client.analyze(`排队字幕${index}`, false));
  await flush(); assert.equal(h.requests.length, 4);
  const current = h.client.analyze("当前播放字幕", true); await flush();
  assert.equal(h.requests.length, 4);
  h.pending[0]({ ok: true, tokens: [{ surface: "排队字幕0" }] }); await flush();
  assert.equal(h.requests.length, 5);
  assert.equal(h.requests[4].payload.text, "当前播放字幕");
  // Resolve the rest so this scheduling test leaves no unfinished request.
  let resolved = 1;
  while (resolved < 13) {
    const available = h.pending.length;
    for (; resolved < available; resolved += 1) h.pending[resolved]({ ok: true, tokens: [{ surface: h.requests[resolved].payload.text }] });
    await flush();
  }
  await Promise.all([...lowPriority, current]);
});
