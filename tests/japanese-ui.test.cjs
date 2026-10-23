const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const fixture = { exports: {} };
vm.runInNewContext(source("tests/prime-harness.cjs").replace("module.exports = { primeHarness };", "module.exports = { Events, Element };"), { require, module: fixture, __dirname });
const { Element } = fixture.exports;
const ui = vm.runInNewContext(source("src/shared/japanese-ui.js") + "\nlmJapaneseUi;");

function harness() {
  const document = {};
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (value) => { const node = new Element("#text", document, 3); node._text = value; return node; };
  document.createDocumentFragment = () => new Element("#fragment", document, 11);
  const root = document.createElement("div");
  const line = document.createElement("div");
  line.className = "lm-line lm-line-learning";
  root.appendChild(line);
  return { document, root, line };
}

const eat = { surface: "食べました", lemma: "食べる", reading: "たべました", baseReading: "たべる", pos: "動詞 · 一段", conjugation: ["礼貌体", "过去"] };

test("ruby labels never contaminate lookup metadata or the original surface", () => {
  const h = harness();
  const words = ui.renderWords(h.line, [eat, { surface: "。", isWord: false }], { furigana: "all" });
  assert.equal(words.length, 1);
  const word = words[0];
  assert.equal(word.dataset.word, "食べました");
  assert.equal(word.dataset.lemma, "食べる");
  assert.equal(word.dataset.reading, "たべました");
  assert.equal(word.dataset.baseReading, "たべる");
  assert.equal(word.dataset.conjugation, "礼貌体 · 过去");
  assert.equal(word.querySelector("rt").textContent, "たべました");
  assert.equal(word.querySelector("rt").getAttribute("aria-hidden"), "true");
  assert.equal(word.dataset.lang, "ja");
  assert.equal(h.line.children.at(-1).textContent, "。");
  assert.equal(ui.textWithoutReading(word), "食べました");
});

test("unknown mode hides readings only for mastered lemmas and preserves kana words", () => {
  const h = harness();
  const words = ui.renderWords(h.line, [eat, { surface: "駅", lemma: "駅", reading: "えき" }, { surface: "こんにちは", reading: "こんにちは" }], { known: { "ja:食べる": true } });
  assert.ok(words[0].querySelector("ruby"), "the stable ruby anchor allows a later mastery change without replacing the hovered word");
  assert.equal(words[0].classList.contains("lm-known"), true);
  assert.equal(words[1].querySelector("rt").textContent, "えき");
  assert.equal(words[2].querySelector("ruby"), null);
  const setKnown = ui.renderWords(h.line, [eat], { known: new Set(["ja:食べる"]) });
  assert.equal(setKnown[0].classList.contains("lm-known"), true);
});

test("all, hover, off modes and missing readings behave without inventing readings", () => {
  const h = harness();
  const all = ui.renderWords(h.line, [eat], { furigana: "all", known: { "ja:食べる": true } })[0];
  assert.ok(all.querySelector("ruby"));
  const hover = ui.renderWords(h.line, [eat], { furigana: "hover" })[0];
  assert.ok(hover.querySelector("ruby"));
  assert.equal(hover.dataset.furigana, "hover");
  assert.equal(ui.renderWords(h.line, [eat], { furigana: "off" })[0].querySelector("ruby"), null);
  const missing = ui.renderWords(h.line, [{ surface: "生", lemma: "生" }, { surface: "何", reading: "*" }], { furigana: "all" });
  assert.equal(missing[0].querySelector("ruby"), null);
  assert.equal(missing[1].querySelector("ruby"), null);
});

test("metadata cards escape subtitle markup and show alternative analyses honestly", () => {
  const html = ui.cardHtml({ ...eat, surface: '<img src=x onerror="bad()">', ambiguous: true, candidates: [{ lemma: "食べる", conjugation: "可能形" }, { lemma: "食べる", conjugation: "被动形" }] });
  assert.ok(html.includes("&lt;img"));
  assert.equal(html.includes("<img"), false);
  for (const label of ["字幕形式", "辞书形", "假名", "原形读音", "词性", "活用", "可能形", "被动形", "未自动判定语境含义"]) assert.ok(html.includes(label), label);
  assert.equal(html.includes("美式"), false);
  assert.equal(ui.cardHtml({ surface: "生" }).includes("假名"), false);
});

test("real engine conjugation objects and interpretation candidates remain visible", () => {
  const html = ui.cardHtml({ ...eat, conjugation: { type: "一段", form: "未然形", labels: ["否定"], ambiguous: true }, candidates: [{ interpretation: "可能" }, { interpretation: "被动" }] });
  for (const text of ["一段", "未然形", "否定", "可能", "被动", "未自动判定语境含义"]) assert.ok(html.includes(text), text);
  const h = harness();
  const word = ui.renderWords(h.line, [{ ...eat, conjugation: { type: "一段", form: "未然形", labels: ["否定"], ambiguous: true } }])[0];
  assert.equal(ui.tokenFrom(word).conjugation, "一段 · 未然形 · 否定");
  assert.equal(ui.tokenFrom(word).ambiguous, true);
});

test("mastery keys distinguish homograph readings while preserving legacy word keys", () => {
  const known = { "ja:生|reading=%E3%81%AA%E3%81%BE|entry=100": true };
  assert.equal(ui.isKnown({ lemma: "生", baseReading: "ナマ" }, known), true);
  assert.equal(ui.isKnown({ lemma: "生", baseReading: "せい" }, known), false);
  assert.equal(ui.isKnown({ lemma: "生", baseReading: "せい" }, { "ja:生": true }), true);
});

function selection(h, { text = "食べなければならない", endLine = h.line, start = h.line, end = endLine, selected = [], fragment } = {}) {
  const range = {
    collapsed: false,
    startContainer: start,
    endContainer: end,
    cloneContents() { return fragment || h.document.createTextNode(text); },
    intersectsNode(node) { return selected.includes(node); }
  };
  return { isCollapsed: false, rangeCount: 1, getRangeAt() { return range; }, range };
}

test("phrase selection strips ruby readings and returns a surface lookup with constituent tokens", () => {
  const h = harness();
  const words = ui.renderWords(h.line, [eat, { surface: "から", lemma: "から", pos: "助詞" }], { furigana: "all" });
  // The cloned range has its own ruby tree just as a real Range would.
  const clone = h.document.createDocumentFragment();
  const ruby = h.document.createElement("ruby");
  ruby.appendChild(h.document.createTextNode("食べました"));
  const rt = h.document.createElement("rt"); rt.textContent = "たべました"; ruby.appendChild(rt);
  clone.appendChild(ruby); clone.appendChild(h.document.createTextNode("から"));
  const result = ui.selectionFrom(h.root, selection(h, { fragment: clone, selected: words }));
  assert.equal(result.surface, "食べましたから");
  assert.equal(result.isPhrase, true);
  assert.equal(result.tokens.length, 2);
  assert.equal(result.lemma, undefined, "a phrase must not inherit the first token's dictionary lemma");
  assert.equal(result.lang, "ja");
});

test("a whole selected word retains its lemma but partial words do not", () => {
  const h = harness();
  const words = ui.renderWords(h.line, [eat]);
  const full = ui.selectionFrom(h.root, selection(h, { text: "食べました", selected: words }));
  assert.equal(full.lemma, "食べる");
  assert.equal(full.isPhrase, false);
  const partial = ui.selectionFrom(h.root, selection(h, { text: "食べ", selected: words }));
  assert.equal(partial.lemma, undefined);
  assert.equal(partial.isPhrase, true);
});

test("cross-line, external, empty and excessive selections never become phrase actions", () => {
  const h = harness();
  const second = h.document.createElement("div"); second.className = "lm-cue-learning"; h.root.appendChild(second);
  assert.equal(ui.selectionFrom(h.root, selection(h, { end: second })), null);
  assert.equal(ui.selectionFrom(h.root, selection(h, { end: h.document.createElement("p") })), null);
  assert.equal(ui.selectionFrom(h.root, selection(h, { text: "   " })), null);
  assert.equal(ui.selectionFrom(h.root, selection(h, { text: "駅".repeat(201) })), null);
  const collapsed = selection(h); collapsed.isCollapsed = true;
  assert.equal(ui.selectionFrom(h.root, collapsed), null);
});

test("real Chrome selections exclude ruby text and furigana modes keep their intended visibility", { timeout: 45000 }, (t) => {
  const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((file) => file && fs.existsSync(file));
  if (!chrome) return t.skip("Set CHROME_PATH to enable real Range/ruby integration tests");
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "linguamate-japanese-ui-"));
  const checks = `
    const check = (value, message) => { if (!value) throw new Error(message); };
    const root = document.getElementById('lm-root'), line = root.querySelector('.lm-line');
    let words = lmJapaneseUi.renderWords(line, [${JSON.stringify(eat)}, {surface:'から',lemma:'から',pos:'助詞'}], {furigana:'hover'});
    check(getComputedStyle(words[0].querySelector('rt')).visibility === 'hidden', 'hover labels should initially be hidden');
    let range = document.createRange();
    range.setStart(words[0].querySelector('ruby').firstChild, 0);
    range.setEnd(words[1].firstChild, 2);
    let selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const phrase = lmJapaneseUi.selectionFrom(root, selection);
    check(phrase.surface === '食べましたから' && phrase.isPhrase && !phrase.lemma, 'ruby readings must not enter the phrase query');
    const nextLine = document.createElement('div'); nextLine.className='lm-line'; root.appendChild(nextLine);
    lmJapaneseUi.renderWords(nextLine, [{surface:'駅',reading:'えき'}], {furigana:'all'});
    range.setEnd(nextLine.querySelector('ruby').firstChild, 1); selection.removeAllRanges();selection.addRange(range);
    check(lmJapaneseUi.selectionFrom(root, selection) === null, 'cross-line selections should not produce an action');
    range.selectNodeContents(root);selection.removeAllRanges();selection.addRange(range);
    check(lmJapaneseUi.selectionFrom(root, selection) === null, 'whole container selections should not bypass cross-line validation');
    words = lmJapaneseUi.renderWords(line, [${JSON.stringify(eat)}], {furigana:'all'});
    check(getComputedStyle(words[0].querySelector('rt')).visibility === 'visible', 'all-mode readings should be visible');
    range.selectNodeContents(words[0]);selection.removeAllRanges();selection.addRange(range);
    const fullWord = lmJapaneseUi.selectionFrom(root, selection);
    check(fullWord.surface === '食べました' && fullWord.lemma === '食べる' && !fullWord.isPhrase, 'a complete selected word should retain its lemma');
    words = lmJapaneseUi.renderWords(line, [${JSON.stringify(eat)}], {furigana:'unknown',known:{'ja:食べる':true}});
    check(getComputedStyle(words[0].querySelector('rt')).display === 'none', 'mastered lemmas should hide unknown-mode readings');
    words[0].classList.remove('lm-known');
    check(getComputedStyle(words[0].querySelector('rt')).display !== 'none', 'unmarking mastery should show the existing reading without replacing the word');
    words = lmJapaneseUi.renderWords(line, [${JSON.stringify(eat)}], {furigana:'off'});
    check(!words[0].querySelector('ruby') && words[0].textContent === '食べました', 'off should preserve the exact original surface');
  `;
  const run = `try { ${checks} document.title='LM_JAPANESE_RESULT:ok'; } catch (error) { document.title='LM_JAPANESE_RESULT:'+btoa(unescape(encodeURIComponent(error.stack))); }`;
  const file = path.join(directory, "ruby.html");
  fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>pending</title><style>${source("src/content/youtube.css")}</style><div id="lm-root"><div class="lm-line"></div></div><script>${source("src/shared/japanese-ui.js")}</script><script>${run}</script>`, "utf8");
  try {
    const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--virtual-time-budget=1500", "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", timeout: 35000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const result = output.match(/<title>LM_JAPANESE_RESULT:([^<]+)<\/title>/)?.[1];
    assert.ok(result, "Chrome did not finish the Japanese UI checks");
    assert.equal(result, "ok", result === "ok" ? "" : Buffer.from(result, "base64").toString("utf8"));
  } finally {
    if (path.dirname(path.resolve(directory)) === temporaryRoot && path.basename(directory).startsWith("linguamate-japanese-ui-")) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
