const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

function storageHarness(initial = {}) {
  const data = { local: { vocab: [], known: {}, ...clone(initial) }, sync: {} };
  let listener;
  const storage = Object.fromEntries(["local", "sync"].map((name) => [name, {
    async get(defaults) { await Promise.resolve(); return clone({ ...defaults, ...data[name] }); },
    async set(patch) { await Promise.resolve(); Object.assign(data[name], clone(patch)); }
  }]));
  vm.runInNewContext(source("src/background/service-worker.js"), {
    chrome: { storage, runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } }, contextMenus: { onClicked: { addListener() {} } } },
    console, Intl, URLSearchParams, importScripts() {}
  });
  return { data, send(message) { return new Promise((resolve) => listener(message, {}, (result) => resolve(clone(result)))); } };
}

function item(surface = "食べました", overrides = {}) {
  return { word: "食べる", lang: "ja", nativeLang: "zh-CN", translation: "吃", context: `昨日${surface}。`, videoUrl: "https://www.youtube.com/watch?v=example", videoTitle: "Episode", time: 12,
    japanese: { lemma: "食べる", reading: "タベマシタ", baseReading: "タベル", pos: "動詞", conjugation: "礼貌 · 过去", surface }, ...overrides };
}
function legacy(word, overrides = {}) {
  return { id: `old-${word}`, word, lang: "ja", nativeLang: "zh-CN", translation: "旧释义", phonetic: "", context: "旧例句", videoTitle: "Old", videoUrl: "", time: 1, status: "learning", reps: 6, interval: 20, ease: 2.8, due: 2000000000000, createdAt: 1, updatedAt: 2, ...overrides };
}
const backup = (vocab, known = {}) => ({ format: "linguamate-backup", version: 1, exportedAt: "2026-10-23T00:00:00.000Z", vocab, known });

test("regional Japanese labels preserve old cards, mastery and backup identities without creating another inflection card", async () => {
  const key = `ja-JP:食べる|reading=${encodeURIComponent("たべる")}|entry=`;
  const old = legacy("食べる", { lang: "ja-JP", status: "known", japanese: item().japanese });
  const h = storageHarness({ vocab: [old], known: { [key]: true } });
  const listed = await h.send({ type: "LM_VOCAB_LIST" });
  assert.equal(listed.vocab[0].lang, "ja");
  assert.equal(listed.vocab[0].id, old.id);
  assert.equal(listed.known[key.replace("ja-JP:", "ja:")], true);
  const added = await h.send({ type: "LM_VOCAB_ADD", item: item("食べない") });
  assert.equal(added.ok, true);
  assert.equal(added.item.id, old.id);
  assert.equal(added.item.reps, old.reps);
  assert.equal(h.data.local.vocab.length, 1);
  assert.equal(h.data.local.vocab[0].lang, "ja");
  const restored = storageHarness();
  assert.equal((await restored.send({ type: "LM_DATA_IMPORT", backup: backup([old], { [key]: true }), mode: "replace" })).ok, true);
  assert.equal(restored.data.local.vocab[0].lang, "ja");
  assert.equal(restored.data.local.known[key.replace("ja-JP:", "ja:")], true);
});

test("Japanese inflections merge under the lemma and preserve review progress and distinct source examples", async () => {
  const h = storageHarness();
  const first = await h.send({ type: "LM_VOCAB_ADD", item: item() });
  assert.equal(first.ok, true);
  await h.send({ type: "LM_VOCAB_UPDATE", id: first.item.id, patch: { reps: 5, due: 2000000000000, interval: 10, ease: 2.7 } });
  const next = item("食べなかった", { time: 22 });
  next.japanese.reading = "タベナカッタ";
  next.japanese.conjugation = "否定 · 过去";
  await h.send({ type: "LM_VOCAB_ADD", item: next });
  await h.send({ type: "LM_VOCAB_ADD", item: next });
  assert.equal(h.data.local.vocab.length, 1);
  const saved = h.data.local.vocab[0];
  assert.equal(saved.word, "食べる");
  assert.equal(saved.id, first.item.id);
  assert.equal(saved.reps, 5);
  assert.equal(saved.due, 2000000000000);
  assert.equal(saved.interval, 10);
  assert.deepEqual(saved.sourceForms.map((form) => form.surface), ["食べなかった", "食べました"]);
  assert.equal(saved.sourceForms[0].time, 22);
  assert.equal(saved.sourceForms[0].reading, "タベナカッタ");
});

test("Japanese cards separate kanji homophones and homographs with different readings", async () => {
  const h = storageHarness();
  for (const [word, reading] of [["橋", "ハシ"], ["箸", "ハシ"], ["生", "ナマ"], ["生", "セイ"]]) {
    const result = await h.send({ type: "LM_VOCAB_ADD", item: item(word, { word, japanese: { lemma: word, surface: word, reading, baseReading: reading, pos: "名詞" } }) });
    assert.equal(result.ok, true);
  }
  assert.equal(h.data.local.vocab.length, 4);
  const exported = await h.send({ type: "LM_DATA_EXPORT" });
  const restored = storageHarness();
  assert.equal((await restored.send({ type: "LM_DATA_IMPORT", backup: exported.data, mode: "replace" })).ok, true);
  assert.equal(restored.data.local.vocab.length, 4);
});

test("a legacy surface record upgrades without losing its ID, mastery or scheduling", async () => {
  const old = legacy("食べました", { status: "known" });
  const h = storageHarness({ vocab: [old], known: { "ja:食べました": true } });
  const result = await h.send({ type: "LM_VOCAB_ADD", item: item() });
  assert.equal(result.ok, true);
  assert.equal(h.data.local.vocab.length, 1);
  for (const field of ["id", "status", "reps", "interval", "ease", "due", "createdAt"]) assert.equal(result.item[field], old[field]);
  assert.equal(result.item.word, "食べる");
  assert.equal(result.item.sourceForms.length, 2);
  assert.ok(result.item.sourceForms.some((form) => form.context === "旧例句"));
  assert.equal(h.data.local.known["ja:食べました"], undefined);
  assert.equal(Object.keys(h.data.local.known).length, 1);
});

test("source examples cap at 20 and concurrent additions retain their distinct contexts", async () => {
  const h = storageHarness();
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => h.send({ type: "LM_VOCAB_ADD", item: item("食べた", { context: `例句${index}`, time: index }) })));
  assert.ok(results.every((result) => result.ok));
  assert.equal(h.data.local.vocab.length, 1);
  const sources = h.data.local.vocab[0].sourceForms;
  assert.equal(sources.length, 20);
  assert.equal(sources[0].context, "例句29");
  assert.equal(new Set(sources.map((form) => form.context)).size, 20);
});

test("katakana/hiragana base readings deduplicate and later dictionary identity enriches the same card", async () => {
  const h = storageHarness();
  const first = await h.send({ type: "LM_VOCAB_ADD", item: item() });
  const enriched = item();
  enriched.japanese.baseReading = "たべる";
  enriched.japanese.entryId = "entry-1";
  const second = await h.send({ type: "LM_VOCAB_ADD", item: enriched });
  assert.equal(second.ok, true);
  assert.equal(second.item.id, first.item.id);
  assert.equal(h.data.local.vocab.length, 1);
  assert.equal(second.item.japanese.entryId, "entry-1");
});

test("Japanese metadata and reading-specific mastery survive complete backup round trips", async () => {
  const h = storageHarness();
  const added = await h.send({ type: "LM_VOCAB_ADD", item: item() });
  await h.send({ type: "LM_VOCAB_UPDATE", id: added.item.id, patch: { status: "known", reps: 4, due: 2000000000000 } });
  const exported = await h.send({ type: "LM_DATA_EXPORT" });
  assert.equal(exported.data.version, 1);
  assert.equal(Object.keys(exported.data.known).length, 1);
  const restored = storageHarness();
  assert.equal((await restored.send({ type: "LM_DATA_IMPORT", backup: exported.data, mode: "replace" })).ok, true);
  assert.deepEqual(restored.data.local.vocab, h.data.local.vocab);
  assert.deepEqual(restored.data.local.known, h.data.local.known);
  const old = storageHarness();
  assert.equal((await old.send({ type: "LM_DATA_IMPORT", backup: backup([legacy("猫")]), mode: "replace" })).ok, true);
  assert.equal(old.data.local.vocab[0].reps, 6);
});

test("merging a backup preserves the current schedule and accumulates Japanese source examples", async () => {
  const h = storageHarness();
  const added = await h.send({ type: "LM_VOCAB_ADD", item: item() });
  await h.send({ type: "LM_VOCAB_UPDATE", id: added.item.id, patch: { reps: 9, due: 2000000000000 } });
  const other = storageHarness();
  await other.send({ type: "LM_VOCAB_ADD", item: item("食べない", { time: 5 }) });
  const exported = await other.send({ type: "LM_DATA_EXPORT" });
  assert.equal((await h.send({ type: "LM_DATA_IMPORT", backup: exported.data, mode: "merge" })).ok, true);
  assert.equal(h.data.local.vocab.length, 1);
  assert.equal(h.data.local.vocab[0].reps, 9);
  assert.equal(h.data.local.vocab[0].due, 2000000000000);
  assert.deepEqual(h.data.local.vocab[0].sourceForms.map((form) => form.surface), ["食べました", "食べない"]);
});

test("invalid Japanese metadata and source examples cannot replace existing learning data", async () => {
  const h = storageHarness({ vocab: [legacy("猫")] });
  const cases = [item("x", { japanese: { lemma: "" } }), item("x", { japanese: { lemma: "食べる", reading: {} } }), item("x", { sourceForms: [{ surface: "食べる", time: -1 }] }), item("x", { sourceForms: Array.from({ length: 21 }, () => ({ surface: "食べる" })) })];
  for (const bad of cases) assert.equal((await h.send({ type: "LM_VOCAB_ADD", item: bad })).ok, false);
  const malformed = legacy("食べる", { japanese: { lemma: "食べる", reading: "たべる" }, sourceForms: [{ surface: "食べた", time: -1 }] });
  assert.equal((await h.send({ type: "LM_DATA_IMPORT", backup: backup([malformed]), mode: "replace" })).ok, false);
  assert.equal(h.data.local.vocab[0].word, "猫");
});

test("Japanese furigana settings accept four modes and reject partial invalid writes", async () => {
  const h = storageHarness();
  assert.equal((await h.send({ type: "LM_GET_SETTINGS" })).settings.japaneseFurigana, "unknown");
  for (const japaneseFurigana of ["all", "unknown", "hover", "off"]) assert.equal((await h.send({ type: "LM_SET_SETTINGS", settings: { japaneseFurigana } })).ok, true);
  assert.equal((await h.send({ type: "LM_SET_SETTINGS", settings: { enabled: false, japaneseFurigana: "invalid" } })).ok, false);
  assert.equal(h.data.sync.enabled, undefined);
  assert.equal(h.data.sync.japaneseFurigana, "off");
});

test("mastery messages distinguish Japanese readings and never equate saving with mastery", async () => {
  const h = storageHarness();
  const rows = [];
  for (const reading of ["なま", "せい"]) {
    const added = await h.send({ type: "LM_VOCAB_ADD", item: item("生", { word: "生", japanese: { lemma: "生", surface: "生", baseReading: reading, reading } }) });
    rows.push(added.item);
  }
  assert.deepEqual(h.data.local.known, {});
  assert.ok(h.data.local.vocab.every((row) => row.status === "learning"));
  const analysis = { ...rows[0].japanese, conjugation: { labels: [], ambiguous: false } };
  const marked = await h.send({ type: "LM_MARK_KNOWN", word: "生", lang: "ja", japanese: analysis, known: true });
  assert.equal(marked.ok, true);
  assert.equal(h.data.local.vocab.find((row) => row.id === rows[0].id).status, "known");
  assert.equal(h.data.local.vocab.find((row) => row.id === rows[1].id).status, "learning");
  const engine = vm.runInNewContext(source("src/shared/japanese.js") + "\nlmJapanese;");
  assert.equal(marked.known[engine.termKey(rows[0].japanese)], true);
  assert.equal(marked.known[engine.termKey(rows[1].japanese)], undefined);
  const exported = await h.send({ type: "LM_DATA_EXPORT" });
  const restored = storageHarness();
  assert.equal((await restored.send({ type: "LM_DATA_IMPORT", backup: exported.data, mode: "replace" })).ok, true);
  await restored.send({ type: "LM_MARK_KNOWN", word: "生", lang: "ja", japanese: rows[0].japanese, known: false });
  assert.deepEqual(restored.data.local.known, {});
  assert.ok(restored.data.local.vocab.every((row) => row.status === "learning"));
});

test("targeted mastery migrates broad legacy flags before changing one reading", async () => {
  const raw = legacy("生", { id: "raw", status: "known", japanese: { lemma: "生", surface: "生", baseReading: "なま" } });
  const life = legacy("生", { id: "life", status: "known", japanese: { lemma: "生", surface: "生", baseReading: "せい" } });
  const h = storageHarness({ vocab: [raw, life], known: { "ja:生": true } });
  const response = await h.send({ type: "LM_MARK_KNOWN", word: "生", lang: "ja", japanese: raw.japanese, known: false });
  assert.equal(response.ok, true);
  assert.equal(response.known["ja:生"], undefined);
  assert.equal(h.data.local.vocab.find((row) => row.id === "raw").status, "learning");
  assert.equal(h.data.local.vocab.find((row) => row.id === "life").status, "known");
  assert.equal(Object.keys(response.known).length, 1);
});

test("relearning a specific card through review also removes broad legacy mastery without affecting its homograph", async () => {
  const raw = legacy("生", { id: "raw", status: "known", japanese: { lemma: "生", surface: "生", baseReading: "なま" } });
  const life = legacy("生", { id: "life", status: "known", japanese: { lemma: "生", surface: "生", baseReading: "せい" } });
  const h = storageHarness({ vocab: [raw, life], known: { "ja:生": true } });
  assert.equal((await h.send({ type: "LM_VOCAB_UPDATE", id: "raw", patch: { status: "learning" } })).ok, true);
  const engine = vm.runInNewContext(source("src/shared/japanese.js") + "\nlmJapanese;");
  assert.equal(h.data.local.known["ja:生"], undefined);
  assert.equal(h.data.local.known[engine.termKey(raw.japanese)], undefined);
  assert.equal(h.data.local.known[engine.termKey(life.japanese)], true);
});

test("backup validation rejects duplicate legacy and enriched aliases atomically", async () => {
  const enriched = legacy("食べる", { id: "new-alias", japanese: { lemma: "食べる", surface: "食べました", baseReading: "たべる" } });
  const h = storageHarness({ vocab: [legacy("猫")] });
  const result = await h.send({ type: "LM_DATA_IMPORT", mode: "replace", backup: backup([legacy("食べました"), enriched]) });
  assert.equal(result.ok, false);
  assert.match(result.error, /duplicate_backup_item/);
  assert.equal(h.data.local.vocab[0].word, "猫");
});

test("canceling unsaved Japanese mastery after dictionary lookup fills entryId clears the earlier wildcard key", async () => {
  const h = storageHarness();
  const analysis = { lemma: "食べる", surface: "食べた", baseReading: "たべる" };
  assert.equal((await h.send({ type: "LM_MARK_KNOWN", word: "食べる", lang: "ja", japanese: analysis, known: true })).ok, true);
  assert.equal(Object.keys(h.data.local.known).length, 1);
  const unmarked = await h.send({ type: "LM_MARK_KNOWN", word: "食べる", lang: "ja", japanese: { ...analysis, entryId: "1358280" }, known: false });
  assert.equal(unmarked.ok, true);
  assert.deepEqual(unmarked.known, {});
  assert.equal(h.data.local.vocab.length, 0);
});

test("saving after a dictionary ID is resolved inherits wildcard mastery and review can clear it", async () => {
  const h = storageHarness();
  const analysis = { lemma: "食べる", surface: "食べた", baseReading: "たべる" };
  await h.send({ type: "LM_MARK_KNOWN", word: "食べる", lang: "ja", japanese: analysis, known: true });
  const added = await h.send({ type: "LM_VOCAB_ADD", item: item("食べた", { japanese: { ...analysis, entryId: "1358280" } }) });
  assert.equal(added.ok, true);
  assert.equal(added.item.status, "known");
  const updated = await h.send({ type: "LM_VOCAB_UPDATE", id: added.item.id, patch: { status: "learning" } });
  assert.equal(updated.ok, true);
  assert.deepEqual(h.data.local.known, {});
  assert.equal(h.data.local.vocab[0].status, "learning");
});

test("defined Japanese dictionary IDs stay independent while missing IDs behave as wildcards in storage and UI", async () => {
  const h = storageHarness();
  const a = { lemma: "生", surface: "生", baseReading: "せい", entryId: "entry-a" };
  const b = { ...a, entryId: "entry-b" };
  const raw = { ...a, baseReading: "なま", entryId: "entry-raw" };
  for (const japanese of [a, b, raw]) await h.send({ type: "LM_MARK_KNOWN", word: "生", lang: "ja", japanese, known: true });
  const ui = vm.runInNewContext(source("src/shared/japanese-ui.js") + "\nlmJapaneseUi;");
  const response = await h.send({ type: "LM_MARK_KNOWN", word: "生", lang: "ja", japanese: a, known: false });
  assert.equal(ui.isKnown(a, response.known), false);
  assert.equal(ui.isKnown(b, response.known), true);
  assert.equal(ui.isKnown(raw, response.known), true);
  assert.equal(ui.isKnown({ ...a, entryId: "" }, response.known), true);
  const newCard = await h.send({ type: "LM_VOCAB_ADD", item: item("生", { word: "生", japanese: a }) });
  assert.equal(newCard.item.status, "learning");
  const knownCard = await h.send({ type: "LM_VOCAB_ADD", item: item("生", { word: "生", japanese: b }) });
  assert.equal(knownCard.item.status, "known");
  await h.send({ type: "LM_VOCAB_DELETE", id: knownCard.item.id });
  assert.equal(ui.isKnown(b, h.data.local.known), true, "removing a bookmark must preserve mastery");
  await h.send({ type: "LM_MARK_KNOWN", word: "生", lang: "ja", japanese: { ...a, entryId: "" }, known: false });
  assert.equal(ui.isKnown(b, h.data.local.known), false);
  assert.equal(ui.isKnown(raw, h.data.local.known), true);
});

test("backup imports reconcile wildcard Japanese mastery with resolved card identities", async () => {
  const engine = vm.runInNewContext(source("src/shared/japanese.js") + "\nlmJapanese;");
  const readingOnly = { lemma: "食べる", surface: "食べた", baseReading: "たべる" };
  const row = legacy("食べる", { japanese: { ...readingOnly, entryId: "1358280" } });
  const h = storageHarness();
  assert.equal((await h.send({ type: "LM_DATA_IMPORT", mode: "replace", backup: backup([row], { [engine.termKey(readingOnly)]: true }) })).ok, true);
  assert.equal(h.data.local.vocab[0].status, "known");
  const unmarked = await h.send({ type: "LM_MARK_KNOWN", word: row.word, lang: "ja", japanese: row.japanese, known: false });
  assert.deepEqual(unmarked.known, {});
  assert.equal(h.data.local.vocab[0].status, "learning");
});

// Use the same lightweight DOM as the other options tests; all business logic
// runs from the shipped options.js, including event handlers and rendering.
const domModule = { exports: {} };
vm.runInNewContext(source("tests/prime-harness.cjs").replace("module.exports = { primeHarness };", "module.exports = { Events, Element };"), { require, module: domModule, __dirname });
const { Events, Element } = domModule.exports;
const originalMatches = Element.prototype.matches;
Element.prototype.matches = function (selector) {
  if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
  const compound = selector.match(/^(\w+)(\[.+\])$/);
  return compound ? this.localName === compound[1] && this.matches(compound[2]) : originalMatches.call(this, selector);
};
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
function optionsHarness(rows) {
  const document = new Events();
  document.createElement = (tag) => {
    const node = new Element(tag, document);
    node.value = "";
    node.options = [];
    node.add = (option) => node.options.push(option);
    for (const key of ["disabled", "hidden"]) Object.defineProperty(node, key, { get() { return this.getAttribute(key) !== null; }, set(value) { value ? this.setAttribute(key, "") : this.removeAttribute(key); } });
    return node;
  };
  document.createTextNode = (text) => { const node = new Element("#text", document, 3); node._text = text; return node; };
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  document.documentElement.appendChild(document.body);
  document.getElementById = (id) => document.documentElement.querySelector(`#${id}`);
  document.querySelector = (selector) => document.documentElement.querySelector(selector);
  document.querySelectorAll = (selector) => document.documentElement.querySelectorAll(selector);
  const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); if (id) node.id = id; parent.appendChild(node); return node; };
  add("nav");
  for (const id of ["search", "statusFilter", "langFilter", "cardLang", "japaneseCardType", "importFile", "importMode"]) add("input", id).value = ["statusFilter", "langFilter", "cardLang"].includes(id) ? "all" : id === "japaneseCardType" ? "meaning" : "";
  for (const id of ["vocabList", "cardBox", "operationStatus", "settingsStatus", "backupStatus"]) add("div", id);
  for (const id of ["retryVocab", "retryLoadSettings", "retrySaveSettings", "exportCsv", "exportAnki", "exportBackup", "importBackup"]) add("button", id);
  const form = add("form", "settingsForm");
  form.elements = [];
  form.reportValidity = () => true;
  for (const name of ["learningLang", "nativeLang", "japaneseFurigana", "fontSize", "playbackRate", "autoPause", "listenMode", "highlightRare", "hideYoutubeCaptions"]) { const node = add("input", "", form); form.elements.push(node); form.elements[name] = node; }
  const writes = [];
  const chrome = { runtime: { id: "ja-fixture", sendMessage(message, callback) {
    if (message.type === "LM_VOCAB_LIST") callback({ ok: true, vocab: clone(rows) });
    else if (message.type === "LM_GET_SETTINGS") callback({ ok: true, settings: { learningLang: "ja", nativeLang: "zh-CN", japaneseFurigana: "hover", fontSize: 22, playbackRate: 1 } });
    else if (message.type === "LM_VOCAB_UPDATE") { writes.push(clone(message)); callback({ ok: true, item: { ...rows.find((row) => row.id === message.id), ...message.patch } }); }
    else { writes.push(clone(message)); callback({ ok: true }); }
  } } };
  const context = vm.createContext({ document, chrome, console, setTimeout: () => 1, clearTimeout() {}, LM_LANGUAGES: [{ code: "ja", native: "日本語" }, { code: "en", native: "English" }, { code: "zh-CN", native: "中文" }], Option: function (label, value) { this.label = label; this.value = value; }, Blob, URL, confirm: () => false });
  vm.runInContext(source("src/shared/feedback.js"), context);
  vm.runInContext(source("src/options/options.js"), context);
  return { context, document, writes };
}
async function japaneseRow() {
  const h = storageHarness();
  const result = await h.send({ type: "LM_VOCAB_ADD", item: item() });
  return { ...result.item, due: 0 };
}

test("vocabulary searches both kana readings and encountered inflections and displays source forms", async () => {
  const h = optionsHarness([await japaneseRow(), legacy("cat", { lang: "en" })]);
  await flush();
  const search = h.document.getElementById("search");
  const list = h.document.getElementById("vocabList");
  search.value = "たべる"; search.emit("input");
  assert.match(list.textContent, /食べる/);
  assert.match(list.textContent, /タベル/);
  assert.doesNotMatch(list.textContent, /cat/);
  search.value = "食べました"; search.emit("input");
  assert.match(list.textContent, /食べる/);
  assert.match(list.textContent, /遇到的词形与例句/);
  assert.match(list.textContent, /礼貌 · 过去/);
});

test("Japanese reading and lemma questions conceal answers until reveal and grade the original card ID", async () => {
  const row = await japaneseRow();
  const h = optionsHarness([row]);
  await flush();
  const select = h.document.getElementById("japaneseCardType");
  const box = h.document.getElementById("cardBox");
  select.value = "reading"; select.emit("change");
  assert.match(box.querySelector("h2").textContent, /食べる/);
  assert.equal(box.querySelector("[data-reveal]").hidden, true);
  assert.match(box.querySelector("[data-reveal]").textContent, /タベル/);
  box.emit("click", { target: box.querySelector('[data-act="reveal"]') });
  assert.equal(box.querySelector("[data-reveal]").hidden, false);
  select.value = "lemma"; select.emit("change");
  assert.equal(box.querySelector("h2").textContent, "食べました");
  assert.equal(box.querySelector("[data-reveal]").hidden, true);
  assert.match(box.querySelector("[data-reveal]").textContent, /食べる（タベル）/);
  box.emit("click", { target: box.querySelector('[data-grade="good"]') });
  await flush();
  assert.equal(h.writes[0].id, row.id);
  assert.equal(h.writes[0].patch.reps, 1);
});

test("Japanese review selectors keep English questions unchanged and legacy Japanese cards usable", async () => {
  const english = legacy("hello", { lang: "en", phonetic: "/həˈloʊ/", due: 0 });
  const h = optionsHarness([english]);
  await flush();
  const select = h.document.getElementById("japaneseCardType");
  select.value = "lemma"; select.emit("change");
  const box = h.document.getElementById("cardBox");
  assert.equal(box.querySelector("h2").textContent, "hello");
  assert.match(box.textContent, /həˈloʊ/);
  assert.equal(box.querySelector('[data-act="reveal"]').textContent, "显示释义");
  const old = optionsHarness([legacy("猫", { due: 0 })]);
  await flush();
  old.document.getElementById("japaneseCardType").value = "reading";
  old.document.getElementById("japaneseCardType").emit("change");
  assert.match(old.document.getElementById("cardBox").textContent, /尚无假名信息/);
});

test("options accepts backups with Japanese homographs and round trips the new furigana setting", async () => {
  const first = await japaneseRow();
  const second = clone(first);
  first.word = first.japanese.lemma = "生";
  first.japanese.baseReading = "ナマ";
  second.id = "different-reading";
  second.word = second.japanese.lemma = "生";
  second.japanese.baseReading = "セイ";
  const h = optionsHarness([first]);
  await flush();
  assert.equal(h.context.validateBackup(backup([first, second])).vocab.length, 2);
  const form = h.document.getElementById("settingsForm");
  assert.equal(form.elements.japaneseFurigana.value, "hover");
  form.elements.japaneseFurigana.value = "off";
  form.emit("submit", { preventDefault() {} });
  await flush();
  assert.equal(h.writes[0].settings.japaneseFurigana, "off");
});

async function readerHarness(content, tokens) {
  const h = optionsHarness([]);
  await flush();
  const storage = storageHarness();
  const requests = [];
  h.context.window = h.context;
  h.context.location = { href: "https://example.test/japanese-article" };
  h.context.lmMergeSettings = (value) => value;
  h.document.title = "Japanese article";
  h.document.createDocumentFragment = () => new Element("#fragment", h.document, 11);
  h.context.chrome.runtime.onMessage = { addListener(fn) { h.listener = fn; } };
  h.context.chrome.runtime.sendMessage = (message, callback) => {
    requests.push(clone(message));
    if (message.type === "LM_GET_SETTINGS") callback({ ok: true, settings: { learningLang: "ja", nativeLang: "zh-CN", japaneseFurigana: "all" } });
    else if (message.type === "LM_JA_ANALYZE") callback({ ok: true, tokens });
    else if (message.type === "LM_LOOKUP") callback({ ok: true, result: { translation: "吃", phonetic: "たべる", japanese: tokens.find((token) => token.surface === message.word) } });
    else if (message.type === "LM_TRANSLATE") callback({ ok: true, result: { text: "译文" } });
    else storage.send(message).then(callback);
  };
  for (const file of ["src/shared/japanese.js", "src/shared/japanese-ui.js", "src/shared/japanese-client.js", "src/content/reader.js"]) vm.runInContext(source(file), h.context);
  h.listener({ type: "LM_READER", mode: "lm-lookup", text: content }, {}, () => {});
  for (let i = 0; i < 5; i += 1) await flush();
  return { ...h, storage, requests, root: h.document.getElementById("lm-reader-root") };
}

test("Japanese reader excludes ruby from lookup, saves the dictionary entry and accumulates related forms", async () => {
  const tokens = [
    { surface: "食べました", lemma: "食べる", reading: "たべました", baseReading: "たべる", pos: "動詞", conjugation: { labels: ["礼貌体", "过去"] } },
    { surface: " ", isWordLike: false },
    { surface: "食べない", lemma: "食べる", reading: "たべない", baseReading: "たべる", pos: "動詞", conjugation: { labels: ["否定"] } }
  ];
  const h = await readerHarness("食べました 食べない", tokens);
  const words = h.root.querySelectorAll(".lm-reader-word");
  assert.equal(words.length, 2);
  assert.equal(words[0].querySelector("rt").textContent, "たべました");
  assert.equal(h.requests.find((request) => request.type === "LM_LOOKUP").from, "ja", "short context menu lookup must use Japanese rather than auto");
  h.root.emit("click", { target: words[0].querySelector("rt") });
  for (let i = 0; i < 4; i += 1) await flush();
  let saved = h.storage.data.local.vocab;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].word, "食べる");
  assert.equal(saved[0].japanese.surface, "食べました");
  assert.equal(saved[0].japanese.conjugation, "礼貌体 · 过去");
  assert.equal(saved[0].context, "食べました 食べない");
  assert.equal(saved[0].videoUrl, "https://example.test/japanese-article");
  assert.ok(h.requests.some((request) => request.type === "LM_LOOKUP" && request.word === "食べました" && request.japanese.lemma === "食べる"));
  assert.ok(words.every((word) => word.classList.contains("lm-reader-saved")), "other inflections share the saved marker");
  assert.ok(h.requests.every((request) => request.word !== "食べましたたべました"));
  h.root.emit("click", { target: words[1] });
  for (let i = 0; i < 4; i += 1) await flush();
  saved = h.storage.data.local.vocab;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].sourceForms.map((form) => form.surface), ["食べない", "食べました"]);
  assert.deepEqual(h.storage.data.local.known, {}, "collecting a word is not mastering it");
});

test("Japanese reader bounds large selected text and translates it instead of treating a paragraph as one word", async () => {
  const content = "駅".repeat(8100);
  const h = await readerHarness(content, [{ surface: content.slice(0, 8000), lemma: content.slice(0, 8000), isWordLike: true }]);
  const analyzed = h.requests.find((request) => request.type === "LM_JA_ANALYZE");
  assert.equal(analyzed.text.length, 8000);
  assert.equal(h.requests.filter((request) => request.type === "LM_LOOKUP").length, 0);
  assert.equal(h.requests.find((request) => request.type === "LM_TRANSLATE").text.length, 4500);
  assert.match(h.root.querySelector("#lm-reader-trans").textContent, /译文/);
});
