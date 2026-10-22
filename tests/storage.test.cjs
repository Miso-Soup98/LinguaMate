const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/background/service-worker.js"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function harness(initial = {}) {
  const data = { local: { vocab: [], known: {}, ...clone(initial.local || {}) }, sync: { ...clone(initial.sync || {}) } };
  const writes = [];
  const failures = { local: [], sync: [] };
  const readFailures = { local: [], sync: [] };
  let listener;
  let holdWrite;
  let blockedWrite;
  const storage = Object.fromEntries(["local", "sync"].map((area) => [area, {
    async get(defaults) {
      await nextTurn();
      const failure = readFailures[area].shift();
      if (failure) throw new Error(failure);
      return clone({ ...defaults, ...data[area] });
    },
    async set(patch) {
      writes.push({ area, patch: clone(patch) });
      if (holdWrite) {
        blockedWrite = holdWrite;
        holdWrite = null;
        await blockedWrite.promise;
      }
      await nextTurn();
      const failure = failures[area].shift();
      if (failure) throw new Error(failure);
      Object.assign(data[area], clone(patch));
    }
  }]));
  vm.runInNewContext(source, {
    chrome: {
      storage,
      runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
      contextMenus: { onClicked: { addListener() {} } }
    },
    console, URLSearchParams, Intl
  });
  return {
    data, writes, failures, readFailures,
    send(message) { return new Promise((resolve) => { assert.equal(listener(message, {}, (response) => resolve(clone(response))), true); }); },
    blockNextWrite() {
      let release;
      holdWrite = { promise: new Promise((resolve) => { release = resolve; }) };
      return { release, async untilBlocked() { while (!blockedWrite) await nextTurn(); } };
    }
  };
}

function row(word, overrides = {}) {
  return {
    id: `id-${word}`, word, lang: "en", nativeLang: "zh-CN", translation: "词义", phonetic: "",
    context: "Original sentence", videoTitle: "Episode", videoUrl: "https://www.youtube.com/watch?v=test",
    time: 12.5, status: "learning", reps: 4, interval: 12, ease: 2.7, due: 2000000000000,
    createdAt: 1000000000000, updatedAt: 1100000000000, ...overrides
  };
}

function backup(vocab = [], known = {}) {
  return { format: "linguamate-backup", version: 1, exportedAt: "2026-10-22T12:00:00.000Z", vocab, known };
}

test("simultaneous adds from many tabs all survive and a read waits for them", async () => {
  const h = harness();
  const adds = Array.from({ length: 30 }, (_, i) => h.send({ type: "LM_VOCAB_ADD", item: { word: `word-${i}`, lang: "en" } }));
  const read = h.send({ type: "LM_VOCAB_LIST" });
  assert.ok((await Promise.all(adds)).every((response) => response.ok));
  assert.equal((await read).vocab.length, 30);
  assert.equal(new Set(h.data.local.vocab.map((item) => item.word)).size, 30);
});

test("deduplication trims words, normalizes language and case, and preserves review progress", async () => {
  const original = row(" Hello ", { id: "keep-id" });
  const h = harness({ local: { vocab: [original] } });
  const results = await Promise.all([
    h.send({ type: "LM_VOCAB_ADD", item: { word: "hello", lang: "EN", translation: "你好" } }),
    h.send({ type: "LM_VOCAB_ADD", item: { word: " HELLO ", context: "New sentence" } })
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(h.data.local.vocab.length, 1);
  const saved = h.data.local.vocab[0];
  for (const field of ["id", "status", "reps", "interval", "ease", "due", "createdAt"]) assert.equal(saved[field], original[field]);
  assert.equal(saved.translation, "你好");
  assert.equal(saved.context, "New sentence");
});

test("queued updates, deletes and known changes never restore old snapshots", async () => {
  const h = harness({ local: { vocab: [row("one"), row("two")] } });
  const responses = await Promise.all([
    h.send({ type: "LM_VOCAB_UPDATE", id: "id-one", patch: { reps: 5, interval: 20, status: "known" } }),
    h.send({ type: "LM_VOCAB_DELETE", id: "id-two" }),
    h.send({ type: "LM_VOCAB_ADD", item: { word: "three" } }),
    h.send({ type: "LM_MARK_KNOWN", word: " THREE ", lang: "EN", known: true }),
    h.send({ type: "LM_MARK_KNOWN", word: "other", lang: "en", known: true })
  ]);
  assert.ok(responses.every((response) => response.ok));
  assert.deepEqual(h.data.local.vocab.map((item) => item.word), ["three", "one"]);
  assert.equal(h.data.local.vocab.find((item) => item.word === "one").reps, 5);
  assert.equal(h.data.local.vocab.find((item) => item.word === "three").status, "known");
  assert.deepEqual(h.data.local.known, { "en:one": true, "en:three": true, "en:other": true });
});

test("list and export cannot observe a pending write as completed", async () => {
  const h = harness();
  const blocked = h.blockNextWrite();
  const add = h.send({ type: "LM_VOCAB_ADD", item: { word: "pending" } });
  await blocked.untilBlocked();
  let finished = false;
  const read = h.send({ type: "LM_VOCAB_LIST" }).then((value) => { finished = true; return value; });
  const exported = h.send({ type: "LM_DATA_EXPORT" });
  await nextTurn();
  assert.equal(finished, false);
  assert.equal(h.data.local.vocab.length, 0);
  blocked.release();
  assert.equal((await add).ok, true);
  assert.equal((await read).vocab[0].word, "pending");
  assert.equal((await exported).data.vocab[0].word, "pending");
});

test("a rejected write reports the error and the queue recovers without phantom success", async () => {
  const h = harness({ local: { vocab: [row("kept")] } });
  h.failures.local.push("QUOTA_BYTES exceeded");
  const results = await Promise.all([
    h.send({ type: "LM_VOCAB_DELETE", id: "id-kept" }),
    h.send({ type: "LM_VOCAB_ADD", item: { word: "next" } }),
    h.send({ type: "LM_VOCAB_LIST" })
  ]);
  assert.deepEqual(results[0], { ok: false, error: "QUOTA_BYTES exceeded" });
  assert.equal(results[1].ok, true);
  assert.deepEqual(results[2].vocab.map((item) => item.word), ["next", "kept"]);
});

test("mastery and relearning update both vocab and known in a single committed write", async () => {
  const h = harness({ local: { vocab: [row("hello")] } });
  await h.send({ type: "LM_VOCAB_UPDATE", id: "id-hello", patch: { status: "known" } });
  assert.equal(h.writes.length, 1);
  assert.deepEqual(Object.keys(h.writes[0].patch).sort(), ["known", "vocab"]);
  assert.equal(h.data.local.known["en:hello"], true);
  h.failures.local.push("disk_error");
  assert.equal((await h.send({ type: "LM_MARK_KNOWN", word: "hello", lang: "en", known: false })).ok, false);
  assert.equal(h.data.local.vocab[0].status, "known");
  assert.equal(h.data.local.known["en:hello"], true);
  await h.send({ type: "LM_MARK_KNOWN", word: "hello", lang: "en", known: false });
  assert.equal(h.data.local.vocab[0].status, "learning");
  assert.equal(h.data.local.known["en:hello"], undefined);
});

test("invalid vocab requests are rejected before writing", async () => {
  const h = harness({ local: { vocab: [row("one"), row("two")] } });
  const invalid = [
    { type: "LM_VOCAB_ADD" },
    { type: "LM_VOCAB_ADD", item: { word: "   " } },
    { type: "LM_VOCAB_ADD", item: { word: "word", time: -1 } },
    { type: "LM_VOCAB_UPDATE", id: "id-one", patch: { id: "different" } },
    { type: "LM_VOCAB_UPDATE", id: "id-one", patch: { reps: -1 } },
    { type: "LM_VOCAB_UPDATE", id: "id-one", patch: { word: "TWO" } },
    { type: "LM_VOCAB_UPDATE", id: "id-one", patch: { status: "invalid" } },
    { type: "LM_VOCAB_UPDATE", id: "missing", patch: { reps: 1 } },
    { type: "LM_MARK_KNOWN", word: " ", lang: "en" },
    { type: "LM_MARK_KNOWN", word: "one", lang: "en", known: "false" },
    null
  ];
  for (const message of invalid) assert.equal((await h.send(message)).ok, false, JSON.stringify(message));
  assert.equal(h.writes.length, 0);
  assert.equal(h.data.local.vocab.length, 2);
});

test("settings validate the entire patch and keep simultaneous partial changes", async () => {
  const h = harness();
  const valid = await Promise.all([
    h.send({ type: "LM_SET_SETTINGS", settings: { enabled: false, learningLang: "JA" } }),
    h.send({ type: "LM_SET_SETTINGS", settings: { fontSize: 30, playbackRate: 1.25 } }),
    h.send({ type: "LM_GET_SETTINGS" })
  ]);
  assert.ok(valid.every((response) => response.ok));
  assert.equal(valid[2].settings.enabled, false);
  assert.equal(valid[2].settings.learningLang, "ja");
  assert.equal(valid[2].settings.fontSize, 30);
  assert.equal(valid[2].settings.playbackRate, 1.25);
  const invalid = [null, { enabled: "false" }, { enabled: true, secret: "value" }, { fontSize: 100 },
    { fontSize: 22.2 }, { playbackRate: Infinity }, { playbackRate: 0 }, { accent: "au" }, { learningLang: "invalid code" }];
  const before = clone(h.data.sync);
  for (const settings of invalid) assert.equal((await h.send({ type: "LM_SET_SETTINGS", settings })).ok, false);
  assert.deepEqual(h.data.sync, before);
});

test("failed sync saves surface errors and later settings writes still succeed", async () => {
  const h = harness({ sync: { fontSize: "bad", enabled: true, secret: "do-not-export" } });
  assert.equal((await h.send({ type: "LM_GET_SETTINGS" })).settings.fontSize, 22);
  h.failures.sync.push("sync_unavailable");
  const failed = await h.send({ type: "LM_SET_SETTINGS", settings: { enabled: false } });
  assert.equal(failed.error, "sync_unavailable");
  assert.equal(h.data.sync.enabled, true);
  assert.equal((await h.send({ type: "LM_SET_SETTINGS", settings: { enabled: false } })).ok, true);
  assert.equal(h.data.sync.enabled, false);
});

test("storage read failures are reported, leave saved data intact and do not poison the queue", async () => {
  const h = harness({ local: { vocab: [row("keep")] }, sync: { enabled: true } });
  h.readFailures.local.push("local_read_failed");
  assert.deepEqual(await h.send({ type: "LM_VOCAB_ADD", item: { word: "failed" } }), { ok: false, error: "local_read_failed" });
  assert.equal(h.writes.length, 0);
  assert.equal((await h.send({ type: "LM_VOCAB_LIST" })).vocab[0].word, "keep");
  h.readFailures.sync.push("sync_read_failed");
  assert.deepEqual(await h.send({ type: "LM_SET_SETTINGS", settings: { enabled: false } }), { ok: false, error: "sync_read_failed" });
  assert.equal(h.data.sync.enabled, true);
  assert.equal((await h.send({ type: "LM_SET_SETTINGS", settings: { enabled: false } })).ok, true);
});

test("JSON backup round trips every learning field and omits unrelated local and sync data", async () => {
  const source = harness({ local: { vocab: [row("日本語", { lang: "ja" })], known: { "de:haus": true }, privateToken: "secret" }, sync: { apiKey: "secret" } });
  const exported = await source.send({ type: "LM_DATA_EXPORT" });
  assert.equal(exported.ok, true);
  assert.deepEqual(Object.keys(exported.data).sort(), ["exportedAt", "format", "known", "version", "vocab"]);
  assert.equal(JSON.stringify(exported).includes("secret"), false);
  const destination = harness();
  const result = await destination.send({ type: "LM_DATA_IMPORT", backup: JSON.parse(JSON.stringify(exported.data)), mode: "replace" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats, { vocabCount: 1, knownCount: 1, mode: "replace" });
  assert.deepEqual(destination.data.local.vocab, source.data.local.vocab);
  assert.deepEqual(destination.data.local.known, source.data.local.known);
  assert.equal(destination.writes.length, 1);
});

test("merge preserves current identities and review progress, imports new cards, and repairs id collisions", async () => {
  const existing = row("hello", { id: "original", reps: 10, status: "learning" });
  const h = harness({ local: { vocab: [existing], known: { "en:other": true } } });
  const result = await h.send({ type: "LM_DATA_IMPORT", mode: "merge", backup: backup([
    row(" HELLO ", { id: "backup-id", reps: 0, status: "known" }),
    row("new", { id: "original", reps: 7 })
  ], { "en:hello": true, "JA: 猫 ": true }) });
  assert.equal(result.ok, true);
  assert.deepEqual(h.data.local.vocab[0], existing);
  assert.equal(h.data.local.vocab[1].reps, 7);
  assert.notEqual(h.data.local.vocab[1].id, "original");
  assert.deepEqual(h.data.local.known, { "en:other": true, "ja:猫": true });
});

test("replacement removes omitted learning data but preserves unrelated storage", async () => {
  const h = harness({ local: { vocab: [row("old")], known: { "en:old": true }, privateToken: "untouched" } });
  const result = await h.send({ type: "LM_DATA_IMPORT", mode: "replace", backup: backup([row("new", { status: "known" })]) });
  assert.equal(result.ok, true);
  assert.deepEqual(h.data.local.vocab.map((item) => item.word), ["new"]);
  assert.deepEqual(h.data.local.known, { "en:new": true });
  assert.equal(h.data.local.privateToken, "untouched");
});

test("merge retains known words even when their first imported card is marked learning", async () => {
  const h = harness({ local: { known: { "ja:猫": true } } });
  const result = await h.send({ type: "LM_DATA_IMPORT", mode: "merge", backup: backup([row("猫", { lang: "ja" })]) });
  assert.equal(result.ok, true);
  assert.equal(h.data.local.vocab[0].status, "known");
  assert.equal(h.data.local.vocab[0].reps, 4);
  assert.equal(h.data.local.known["ja:猫"], true);
});

test("malformed and incompatible backups cannot partially replace stored data", async () => {
  const h = harness({ local: { vocab: [row("keep")], known: { "en:keep": true } } });
  const invalid = [
    null, [], {}, { ...backup(), version: 2 }, { ...backup(), format: "other" },
    { ...backup(), exportedAt: "not-a-date" }, { ...backup(), unexpected: true },
    backup([row("ok"), row("bad", { due: -1 })]), backup([row("ok", { ease: "2.5" })]),
    backup([row("same"), row(" SAME ")]), backup([row("one"), row("two", { id: "id-one" })]),
    backup([], { "en:word": "true" }), backup([], { "word": true }), backup([], { "en: ": true }),
    backup([row("one", { unexpected: "value" })])
  ];
  const before = clone(h.data.local);
  for (const data of invalid) {
    assert.equal((await h.send({ type: "LM_DATA_IMPORT", backup: data, mode: "replace" })).ok, false, JSON.stringify(data));
    assert.deepEqual(h.data.local, before);
  }
  assert.equal((await h.send({ type: "LM_DATA_IMPORT", backup: backup(), mode: "bad" })).ok, false);
  assert.equal(h.writes.length, 0);
});

test("a failed restore retains the previous database and does not block subsequent use", async () => {
  const h = harness({ local: { vocab: [row("keep")], known: { "en:keep": true } } });
  const before = clone(h.data.local);
  h.failures.local.push("storage_full");
  const result = await h.send({ type: "LM_DATA_IMPORT", backup: backup([row("new")]), mode: "replace" });
  assert.deepEqual(result, { ok: false, error: "storage_full" });
  assert.deepEqual(h.data.local, before);
  assert.equal((await h.send({ type: "LM_VOCAB_ADD", item: { word: "after" } })).ok, true);
  assert.deepEqual(h.data.local.vocab.map((item) => item.word), ["after", "keep"]);
});

test("restore shares the queue with tab mutations and keeps subsequent changes", async () => {
  const h = harness({ local: { vocab: [row("old")] } });
  const results = await Promise.all([
    h.send({ type: "LM_DATA_IMPORT", backup: backup([row("restored")]), mode: "replace" }),
    h.send({ type: "LM_VOCAB_ADD", item: { word: "after-import" } }),
    h.send({ type: "LM_VOCAB_UPDATE", id: "id-restored", patch: { reps: 8 } }),
    h.send({ type: "LM_VOCAB_LIST" })
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.deepEqual(results[3].vocab.map((item) => item.word), ["after-import", "restored"]);
  assert.equal(results[3].vocab[1].reps, 8);
});
