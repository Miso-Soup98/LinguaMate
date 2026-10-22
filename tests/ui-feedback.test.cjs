const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const fixture = { exports: {} };
vm.runInNewContext(source("tests/prime-harness.cjs").replace("module.exports = { primeHarness };", "module.exports = { Events, Element };"), { require, module: fixture, __dirname });
const { Events, Element } = fixture.exports;
const originalMatches = Element.prototype.matches;
Element.prototype.matches = function (selector) {
  if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
  const compound = selector.match(/^(\w+)(\[.+\])$/);
  return compound ? this.localName === compound[1] && this.matches(compound[2]) : originalMatches.call(this, selector);
};
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
function documentFixture() {
  const document = new Events();
  document.createElement = (tag) => {
    const element = new Element(tag, document);
    element.value = "";
    element.options = [];
    element.add = (option) => { element.options.push(option); };
    for (const name of ["hidden", "disabled"]) Object.defineProperty(element, name, { get() { return this.getAttribute(name) !== null; }, set(value) { value ? this.setAttribute(name, "") : this.removeAttribute(name); } });
    return element;
  };
  document.createTextNode = (text) => { const node = new Element("#text", document, 3); node._text = text; return node; };
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  document.documentElement.appendChild(document.body);
  document.getElementById = (id) => document.documentElement.querySelector(`#${id}`);
  document.querySelector = (selector) => document.documentElement.querySelector(selector);
  document.querySelectorAll = (selector) => document.documentElement.querySelectorAll(selector);
  document.title = "Learning fixture";
  const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); if (id) node.id = id; parent.appendChild(node); return node; };
  return { document, add };
}
function contextFixture(send) {
  const { document, add } = documentFixture();
  const timers = new Map();
  let timerId = 0;
  const chrome = { runtime: { id: "fixture", lastError: null, sendMessage: send, onMessage: { addListener(listener) { chrome.listener = listener; } } } };
  const context = vm.createContext({ document, chrome, console, setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id) => timers.delete(id), LM_LANGUAGES: [{ code: "en", native: "英语" }, { code: "zh-CN", native: "中文" }], Option: function (label, value) { this.label = label; this.value = value; }, Blob, URL, confirm: () => false, location: { href: "https://example.test" } });
  vm.runInContext(source("src/shared/feedback.js"), context);
  return { document, add, chrome, context, timers };
}
function popupFixture(send) {
  const h = contextFixture(send);
  const checkboxes = ["enabled", "autoPause", "listenMode", "showNative", "nativeInteractive", "highlightRare"];
  for (const id of [...checkboxes, "learningLang", "nativeLang", "fontSize", "playbackRate", "accent"]) {
    const node = h.add(checkboxes.includes(id) ? "input" : "select", id);
    node.type = checkboxes.includes(id) ? "checkbox" : id === "fontSize" ? "range" : "select-one";
  }
  for (const id of ["operationStatus", "stats"]) h.add("p", id);
  for (const id of ["retrySettings", "openOptions"]) h.add("button", id);
  vm.runInContext(source("src/popup/popup.js"), h.context);
  return h;
}
const settings = { enabled: true, learningLang: "en", nativeLang: "zh-CN", fontSize: 22, playbackRate: 1, accent: "us" };
const row = { id: "word-1", word: "hello", translation: "你好", context: "Hello there", lang: "en", nativeLang: "zh-CN", status: "learning", phonetic: "", videoTitle: "", videoUrl: "", time: 0, reps: 1, interval: 0, ease: 2.5, due: 0, createdAt: 1, updatedAt: 1 };
function optionsFixture(send) {
  const h = contextFixture(send);
  h.add("nav");
  for (const id of ["search", "statusFilter", "langFilter", "cardLang", "importFile", "importMode"]) h.add("input", id).value = ["statusFilter", "langFilter", "cardLang"].includes(id) ? "all" : "";
  for (const id of ["vocabList", "cardBox", "operationStatus", "settingsStatus", "backupStatus"]) h.add("div", id);
  for (const id of ["retryVocab", "retryLoadSettings", "retrySaveSettings", "exportCsv", "exportAnki", "exportBackup", "importBackup"]) h.add("button", id);
  const form = h.add("form", "settingsForm");
  form.elements = [];
  form.reportValidity = () => true;
  for (const name of ["learningLang", "nativeLang", "fontSize", "playbackRate", "autoPause", "listenMode", "highlightRare", "hideYoutubeCaptions"]) { const input = h.add("input", null, form); form.elements.push(input); form.elements[name] = input; }
  vm.runInContext(source("src/options/options.js"), h.context);
  return h;
}

test("message helper returns actionable errors for invalidation, lastError, missing replies and timeout", async () => {
  const h = contextFixture(() => {});
  const timeout = h.context.lmSendMessage("LM_TEST", {}, 5);
  [...h.timers.values()][0]();
  assert.match((await timeout).error, /超时/);
  h.chrome.runtime.id = undefined;
  assert.match((await h.context.lmSendMessage("LM_TEST")).error, /刷新/);
  h.chrome.runtime.id = "fixture";
  h.chrome.runtime.sendMessage = (_message, callback) => { h.chrome.runtime.lastError = { message: "Extension context invalidated" }; callback(); h.chrome.runtime.lastError = null; };
  assert.match((await h.context.lmSendMessage("LM_TEST")).error, /刷新/);
  h.chrome.runtime.sendMessage = (_message, callback) => callback();
  assert.match((await h.context.lmSendMessage("LM_TEST")).error, /没有响应/);
});

test("status is accessible and does not interpret word or subtitle HTML", () => {
  const h = contextFixture(() => {});
  const status = h.add("div", "status");
  h.context.lmReportStatus(status, '<img src=x onerror="alert(1)">', "error");
  assert.equal(status.getAttribute("role"), "alert");
  assert.equal(status.getAttribute("aria-live"), "assertive");
  assert.equal(status.querySelector("img"), null);
  assert.match(status.textContent, /<img/);
});

test("popup serializes writes and keeps the user's latest field value", async () => {
  const writes = [];
  const h = popupFixture((message, callback) => {
    if (message.type === "LM_GET_SETTINGS") callback({ ok: true, settings });
    else if (message.type === "LM_VOCAB_LIST") callback({ ok: true, vocab: [] });
    else writes.push({ message, callback });
  });
  await flush();
  const input = h.document.getElementById("fontSize");
  input.value = "24"; h.document.emit("change", { target: input });
  input.value = "28"; h.document.emit("change", { target: input });
  input.value = "30"; h.document.emit("change", { target: input });
  assert.equal(writes.length, 1);
  writes[0].callback({ ok: true }); await flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].message.settings.fontSize, 30);
  writes[1].callback({ ok: true }); await flush();
  assert.equal(input.value, "30");
  assert.match(h.document.getElementById("operationStatus").textContent, /已保存/);
});

test("popup failed writes retain newer edits for an explicit retry", async () => {
  const writes = [];
  const h = popupFixture((message, callback) => {
    if (message.type === "LM_GET_SETTINGS") callback({ ok: true, settings });
    else if (message.type === "LM_VOCAB_LIST") callback({ ok: true, vocab: [] });
    else writes.push({ message, callback });
  });
  await flush();
  const input = h.document.getElementById("fontSize");
  input.value = "24"; h.document.emit("change", { target: input });
  input.value = "31"; h.document.emit("change", { target: input });
  writes[0].callback({ ok: false, error: "保存失败" }); await flush();
  assert.equal(h.document.getElementById("retrySettings").hidden, false);
  h.document.getElementById("retrySettings").click(); await flush();
  assert.equal(writes[1].message.settings.fontSize, 31);
  writes[1].callback({ ok: true }); await flush();
});

test("popup does not overwrite settings when the initial read fails", async () => {
  let writes = 0;
  const h = popupFixture((message, callback) => { if (message.type === "LM_SET_SETTINGS") writes += 1; callback({ ok: false, error: "读取失败" }); });
  await flush();
  assert.equal(h.document.getElementById("enabled").disabled, true);
  h.document.emit("change", { target: h.document.getElementById("enabled") });
  await flush();
  assert.equal(writes, 0);
});

test("options preserve rows and revealed review card when writes fail", async () => {
  const h = optionsFixture((message, callback) => {
    if (message.type === "LM_VOCAB_LIST") callback({ ok: true, vocab: [row] });
    else if (message.type === "LM_GET_SETTINGS") callback({ ok: true, settings });
    else callback({ ok: false, error: "存储失败" });
  });
  await flush();
  const list = h.document.getElementById("vocabList");
  const card = h.document.getElementById("cardBox");
  card.emit("click", { target: card.querySelector('[data-act="reveal"]') });
  assert.equal(card.querySelector("[data-reveal]").hidden, false);
  card.emit("click", { target: card.querySelector('[data-grade="good"]') }); await flush();
  assert.equal(card.querySelector("[data-reveal]").hidden, false);
  assert.match(card.textContent, /hello/);
  list.emit("click", { target: list.querySelector('[data-act="delete"]') }); await flush();
  assert.match(list.textContent, /hello/);
  assert.match(h.document.getElementById("operationStatus").textContent, /存储失败/);
});

test("options escape imported word and subtitle markup in list and cards", async () => {
  const unsafe = { ...row, word: '<img src=x onerror="bad()">', context: '<script>bad()</script>' };
  const h = optionsFixture((message, callback) => callback(message.type === "LM_VOCAB_LIST" ? { ok: true, vocab: [unsafe] } : { ok: true, settings }));
  await flush();
  for (const id of ["vocabList", "cardBox"]) {
    const container = h.document.getElementById(id);
    assert.equal(container.querySelector("img"), null);
    assert.equal(container.querySelector("script"), null);
    assert.match(container.textContent, /<img/);
  }
});

test("backup preview rejects malformed progress and replace requires confirmation", async () => {
  const imports = [];
  const h = optionsFixture((message, callback) => {
    if (message.type === "LM_DATA_IMPORT") imports.push(message);
    else callback(message.type === "LM_VOCAB_LIST" ? { ok: true, vocab: [row] } : { ok: true, settings });
  });
  await flush();
  const file = h.document.getElementById("importFile");
  const backup = { format: "linguamate-backup", version: 1, exportedAt: new Date().toISOString(), vocab: [row], known: {} };
  file.files = [{ size: 100, text: async () => JSON.stringify({ ...backup, vocab: [{ ...row, reps: -1 }] }) }];
  file.emit("change"); await flush();
  assert.equal(h.document.getElementById("importBackup").disabled, true);
  assert.match(h.document.getElementById("backupStatus").textContent, /复习进度无效/);
  file.files = [{ size: 100, text: async () => JSON.stringify(backup) }];
  file.emit("change"); await flush();
  assert.match(h.document.getElementById("backupStatus").textContent, /预览：1 个生词/);
  h.document.getElementById("importMode").value = "replace";
  h.document.getElementById("importBackup").click(); await flush();
  assert.equal(imports.length, 0);
});

test("options serialize repeated settings submissions and keep the newest inputs", async () => {
  const writes = [];
  const h = optionsFixture((message, callback) => {
    if (message.type === "LM_SET_SETTINGS") writes.push({ message, callback });
    else callback(message.type === "LM_VOCAB_LIST" ? { ok: true, vocab: [row] } : { ok: true, settings });
  });
  await flush();
  const form = h.document.getElementById("settingsForm");
  form.elements.fontSize.value = "26";
  form.emit("submit");
  form.elements.fontSize.value = "33";
  form.emit("input"); form.emit("submit");
  assert.equal(writes.length, 1);
  writes[0].callback({ ok: true }); await flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].message.settings.fontSize, 33);
  writes[1].callback({ ok: true }); await flush();
  assert.equal(form.elements.fontSize.value, "33");
  assert.match(h.document.getElementById("settingsStatus").textContent, /已保存/);
});

test("merge restore sends full progress and refreshes only after a confirmed import", async () => {
  const imported = { ...row, id: "word-2", word: "world", reps: 8, interval: 10 };
  let rows = [row];
  let importRequest;
  let importCallback;
  const h = optionsFixture((message, callback) => {
    if (message.type === "LM_DATA_IMPORT") { importRequest = message; importCallback = callback; }
    else callback(message.type === "LM_VOCAB_LIST" ? { ok: true, vocab: rows } : { ok: true, settings });
  });
  await flush();
  const file = h.document.getElementById("importFile");
  const backup = { format: "linguamate-backup", version: 1, exportedAt: new Date().toISOString(), vocab: [imported], known: {} };
  file.files = [{ size: 100, text: async () => JSON.stringify(backup) }];
  file.emit("change"); await flush();
  h.document.getElementById("importMode").value = "merge";
  h.document.getElementById("importBackup").click(); await flush();
  assert.equal(importRequest.mode, "merge");
  assert.equal(importRequest.backup.vocab[0].reps, 8);
  assert.match(h.document.getElementById("vocabList").textContent, /hello/);
  assert.doesNotMatch(h.document.getElementById("vocabList").textContent, /world/);
  rows = [row, imported];
  importCallback({ ok: true, stats: { vocabCount: 2, knownCount: 0, mode: "merge" } }); await flush();
  assert.match(h.document.getElementById("vocabList").textContent, /world/);
  assert.match(h.document.getElementById("backupStatus").textContent, /恢复完成/);
});

test("reader debounces repeated word clicks and highlights only a confirmed saved word", async () => {
  let savedCallback;
  let adds = 0;
  const h = contextFixture((message, callback) => {
    if (message.type === "LM_GET_SETTINGS") callback({ ok: true, settings });
    else if (message.type === "LM_LOOKUP") callback({ ok: true, result: { translation: "你好" } });
    else if (message.type === "LM_VOCAB_ADD") { adds += 1; savedCallback = callback; }
  });
  h.context.window = h.context;
  h.context.lmMergeSettings = (raw) => raw;
  vm.runInContext(source("src/content/reader.js"), h.context);
  h.chrome.listener({ type: "LM_READER", text: "hello", mode: "lm-lookup" }, {}, () => {});
  await flush();
  const root = h.document.getElementById("lm-reader-root");
  const word = root.querySelector(".lm-reader-word");
  root.emit("click", { target: word }); root.emit("click", { target: word }); await flush();
  assert.equal(adds, 1);
  assert.equal(word.classList.contains("lm-reader-saved"), false);
  savedCallback({ ok: false, error: "保存失败" }); await flush();
  assert.equal(word.classList.contains("lm-reader-saved"), false);
  assert.match(root.querySelector(".lm-reader-status").textContent, /保存失败/);
  root.emit("click", { target: word }); await flush();
  savedCallback({ ok: true, item: row }); await flush();
  assert.equal(word.classList.contains("lm-reader-saved"), true);
  assert.match(root.querySelector(".lm-reader-status").textContent, /已将/);
});
