const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const bind = vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "../src/shared/vocab-button.js"), "utf8") + "\nlmBindVocabButton;"
);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const elements = [];
  const doc = {
    createElement() {
      const attributes = new Map();
      const classes = new Set();
      const listeners = new Map();
      const element = {
        ownerDocument: doc,
        dataset: {},
        textContent: "",
        disabled: false,
        children: [],
        classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name); },
        appendChild(child) { child.parentElement = this; this.children.push(child); },
        addEventListener(type, fn) { listeners.set(type, fn); },
        click() { return listeners.get("click")({ preventDefault() {} }); }
      };
      elements.push(element);
      return element;
    }
  };
  const parent = doc.createElement("div");
  const button = doc.createElement("button");
  parent.appendChild(button);
  const calls = [];
  const changes = [];
  const overrides = options.overrides || {};
  let items = options.items || [];
  let nextId = 1;
  const send = async (type, payload) => {
    calls.push({ type, payload });
    const override = overrides[type]?.shift();
    if (override) return typeof override === "function" ? override(payload) : override;
    if (type === "LM_VOCAB_LIST") return { ok: true, vocab: items.slice() };
    if (type === "LM_VOCAB_ADD") {
      const item = { ...payload.item, id: `created-${nextId++}` };
      items.push(item);
      return { ok: true, item };
    }
    if (type === "LM_VOCAB_DELETE") {
      items = items.filter((item) => item.id !== payload.id);
      return { ok: true };
    }
    throw new Error(`unexpected_message:${type}`);
  };
  const binding = bind(button, {
    word: options.word || "hello",
    lang: options.lang || "en",
    send,
    createItem: options.createItem || (() => ({ translation: "你好", context: "Hello world" })),
    onChange: options.onChange || ((change) => changes.push(change))
  });
  return {
    button, binding, calls, changes, overrides,
    get status() { return parent.children[1]; },
    get items() { return items; },
    set items(value) { items = value; },
    mutations() { return calls.filter((call) => call.type !== "LM_VOCAB_LIST"); }
  };
}

async function loaded(options) {
  const h = harness(options);
  await h.binding.ready;
  return h;
}

test("initial read renders an accessible unsaved button and live status", async () => {
  const h = await loaded();
  assert.equal(h.button.textContent, "加入生词本");
  assert.equal(h.button.getAttribute("aria-pressed"), "false");
  assert.equal(h.button.getAttribute("aria-busy"), "false");
  assert.equal(h.button.dataset.vocabState, "unsaved");
  assert.equal(h.status.getAttribute("role"), "status");
  assert.equal(h.status.getAttribute("aria-live"), "polite");
  assert.equal(h.button.disabled, false);
});

test("one click confirms addition, and the next confirms removal using the stored id", async () => {
  const h = await loaded({ word: " Hello " });
  await h.button.click();
  assert.equal(h.items.length, 1);
  assert.equal(h.items[0].word, "Hello");
  assert.equal(h.items[0].lang, "en");
  assert.equal(h.items[0].translation, "你好");
  assert.equal(h.button.textContent, "已加入生词本 · 点击移除");
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  assert.equal(h.status.textContent, "已加入生词本");
  const addedId = h.items[0].id;
  await h.button.click();
  assert.equal(h.items.length, 0);
  assert.equal(h.button.textContent, "加入生词本");
  assert.equal(h.status.textContent, "已从生词本移除");
  assert.equal(h.status.dataset.error, "false");
  assert.equal(h.changes[1].saved, false);
  assert.equal(h.changes[1].item.id, addedId, "removal callback retains the removed item for page highlighting");
  assert.deepEqual(h.calls.map((call) => call.type), [
    "LM_VOCAB_LIST", "LM_VOCAB_LIST", "LM_VOCAB_ADD", "LM_VOCAB_LIST", "LM_VOCAB_DELETE"
  ]);
  assert.equal(h.mutations()[1].payload.id, addedId);
});

test("saved membership matches trimmed case-insensitive words and language, preserving other languages", async () => {
  const h = await loaded({
    lang: "en-US",
    items: [
      { id: "french", word: "hello", lang: "fr" },
      { id: "english", word: " HELLO ", lang: "EN-us" }
    ]
  });
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  await h.button.click();
  assert.deepEqual(h.items.map((item) => item.id), ["french"]);
  assert.equal(h.mutations()[0].payload.id, "english");
});

test("initial reads and pending mutations block duplicate clicks and competing refreshes", async () => {
  const readGate = deferred();
  const addGate = deferred();
  const addStarted = deferred();
  const h = harness({
    overrides: {
      LM_VOCAB_LIST: [() => readGate.promise],
      LM_VOCAB_ADD: [() => { addStarted.resolve(); return addGate.promise; }]
    }
  });
  assert.equal(h.button.disabled, true);
  const ignored = h.button.click();
  assert.equal(ignored, h.binding.ready);
  readGate.resolve({ ok: true, vocab: [] });
  await h.binding.ready;
  const adding = h.button.click();
  assert.equal(h.button.disabled, true);
  assert.equal(h.binding.refresh(), adding);
  assert.equal(h.button.click(), adding);
  await addStarted.promise;
  assert.equal(h.mutations().length, 1);
  assert.notEqual(h.button.dataset.vocabState, "saved", "success must wait for the server acknowledgement");
  assert.equal(h.changes.length, 0);
  const confirmed = { id: "confirmed", word: "hello", lang: "en" };
  h.items = [confirmed];
  addGate.resolve({ ok: true, item: confirmed });
  await adding;
  assert.equal(h.changes.length, 1);
  assert.equal(h.button.dataset.vocabState, "saved");
  assert.equal(h.button.disabled, false);
});

test("async item construction is guarded and preserves this card's word and language", async () => {
  const itemGate = deferred();
  const h = await loaded({ createItem: () => itemGate.promise });
  const adding = h.button.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.button.click(), adding);
  itemGate.resolve({ word: "newer-card", lang: "fr", context: "captured context" });
  await adding;
  assert.equal(h.items[0].word, "hello");
  assert.equal(h.items[0].lang, "en");
  assert.equal(h.items[0].context, "captured context");
  assert.equal(h.mutations().length, 1);
});

test("failed addition leaves the button unsaved, announces failure, and allows a retry", async () => {
  const h = await loaded({ overrides: { LM_VOCAB_ADD: [{ ok: false, error: "storage_failed" }] } });
  await h.button.click();
  assert.equal(h.items.length, 0);
  assert.equal(h.button.getAttribute("aria-pressed"), "false");
  assert.equal(h.status.textContent, "操作失败，请重试");
  assert.equal(h.status.dataset.error, "true");
  assert.equal(h.changes.length, 0);
  assert.equal(h.button.disabled, false);
  await h.button.click();
  assert.equal(h.items.length, 1);
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  assert.equal(h.status.dataset.error, "false");
});

test("failed removal retains the confirmed saved state and can be retried", async () => {
  const h = await loaded({
    items: [{ id: "saved", word: "hello", lang: "en" }],
    overrides: { LM_VOCAB_DELETE: [() => { throw new Error("disconnected"); }] }
  });
  await h.button.click();
  assert.equal(h.items.length, 1);
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  assert.equal(h.status.dataset.error, "true");
  assert.equal(h.changes.length, 0);
  await h.button.click();
  assert.equal(h.items.length, 0);
  assert.equal(h.button.getAttribute("aria-pressed"), "false");
});

test("a failed initial read offers read-only recovery before any removal", async () => {
  const h = await loaded({
    items: [{ id: "saved", word: "hello", lang: "en" }],
    overrides: { LM_VOCAB_LIST: [{ ok: false }] }
  });
  assert.equal(h.button.textContent, "重试读取生词本");
  assert.equal(h.status.dataset.error, "true");
  await h.button.click();
  assert.equal(h.button.textContent, "已加入生词本 · 点击移除");
  assert.equal(h.mutations().length, 0, "retrying an unknown state must never delete a saved word");
  await h.button.click();
  assert.equal(h.items.length, 0);
});

test("a failed click-time read never mutates and requires read-only recovery", async () => {
  const h = await loaded();
  h.overrides.LM_VOCAB_LIST = [() => { throw new Error("storage_unavailable"); }];
  await h.button.click();
  assert.equal(h.button.textContent, "重试读取生词本");
  assert.equal(h.mutations().length, 0);
  await h.button.click();
  assert.equal(h.button.textContent, "加入生词本");
  assert.equal(h.mutations().length, 0);
  await h.button.click();
  assert.equal(h.items.length, 1);
});

test("an unsaved button never deletes a word already added by another card", async () => {
  const h = await loaded();
  h.items = [{ id: "added-elsewhere", word: "hello", lang: "en" }];
  await h.button.click();
  assert.equal(h.items.length, 1);
  assert.equal(h.mutations().length, 0);
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  assert.equal(h.status.textContent, "已加入生词本");
  assert.equal(h.changes[0].item.id, "added-elsewhere");
});

test("a saved button never re-adds a word already removed by another card", async () => {
  const h = await loaded({ items: [{ id: "removed-elsewhere", word: "hello", lang: "en" }] });
  h.items = [];
  await h.button.click();
  assert.equal(h.items.length, 0);
  assert.equal(h.mutations().length, 0);
  assert.equal(h.button.getAttribute("aria-pressed"), "false");
  assert.equal(h.status.textContent, "已从生词本移除");
  assert.equal(h.changes[0].saved, false);
  assert.equal(h.changes[0].item.id, "removed-elsewhere");
});

test("refresh picks up external changes without causing a vocabulary mutation", async () => {
  const h = await loaded();
  h.items = [{ id: "external", word: "hello", lang: "en" }];
  await h.binding.refresh();
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  h.items = [];
  await h.binding.refresh();
  assert.equal(h.button.getAttribute("aria-pressed"), "false");
  assert.equal(h.mutations().length, 0);
});

test("a refresh during initialization re-reads after the obsolete snapshot resolves", async () => {
  const readGate = deferred();
  const h = harness({ overrides: { LM_VOCAB_LIST: [() => readGate.promise] } });
  h.items = [{ id: "newer-storage", word: "hello", lang: "en" }];
  assert.equal(h.binding.refresh(), h.binding.ready);
  readGate.resolve({ ok: true, vocab: [] });
  await h.binding.ready;
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  assert.equal(h.calls.filter((call) => call.type === "LM_VOCAB_LIST").length, 2);
  assert.equal(h.mutations().length, 0);
});

test("queued and later storage refreshes preserve confirmed success feedback", async () => {
  const addGate = deferred();
  const addStarted = deferred();
  const h = await loaded({
    overrides: { LM_VOCAB_ADD: [() => { addStarted.resolve(); return addGate.promise; }] }
  });
  const adding = h.button.click();
  await addStarted.promise;
  const item = { id: "confirmed", word: "hello", lang: "en" };
  h.items = [item];
  assert.equal(h.binding.refresh(), adding);
  addGate.resolve({ ok: true, item });
  await adding;
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  assert.equal(h.status.textContent, "已加入生词本");
  await h.binding.refresh();
  assert.equal(h.status.textContent, "已加入生词本");
  assert.equal(h.status.dataset.error, "false");
  assert.equal(h.mutations().length, 1);
});

test("a slow old card response updates only its own button and immutable word snapshot", async () => {
  const gate = deferred();
  const oldCard = await loaded({ overrides: { LM_VOCAB_ADD: [() => gate.promise] } });
  const adding = oldCard.button.click();
  const newCard = await loaded({ word: "different" });
  gate.resolve({ ok: true, item: { id: "old", word: "hello", lang: "en" } });
  await adding;
  assert.equal(oldCard.button.getAttribute("aria-pressed"), "true");
  assert.equal(newCard.button.getAttribute("aria-pressed"), "false");
  assert.equal(newCard.status.textContent, "");
  assert.equal(newCard.changes.length, 0);
  assert.equal(oldCard.changes[0].item.word, "hello");
});

test("a page callback failure cannot turn an acknowledged addition into a failure", async () => {
  const h = await loaded({ onChange: () => { throw new Error("page_already_closed"); } });
  await h.button.click();
  assert.equal(h.items.length, 1);
  assert.equal(h.button.getAttribute("aria-pressed"), "true");
  assert.equal(h.status.textContent, "已加入生词本");
  assert.equal(h.status.dataset.error, "false");
});
