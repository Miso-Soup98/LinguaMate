const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function harness({ offline = false } = {}) {
  const reads = [];
  const context = vm.createContext({
    setTimeout, clearTimeout, Response, DecompressionStream,
    chrome: { runtime: { getURL: (filename) => `chrome-extension://fixture/${filename}` } },
    fetch: async (url) => {
      reads.push(url);
      const filename = url.replace(/^chrome-extension:\/\/fixture\//, "").replace(/^\//, "");
      if (offline && filename.includes("jmdict")) throw new Error("offline fixture");
      return new Response(fs.readFileSync(path.join(root, filename)));
    },
    translateText: async (word) => ({ text: `译文:${word}` }),
    translateLines: async (lines) => lines.map((line) => `译义:${line}`)
  });
  for (const file of ["vendor/kuromoji/kuromoji", "shared/japanese", "background/japanese-service"]) {
    vm.runInContext(fs.readFileSync(path.join(root, `src/${file}.js`), "utf8"), context);
  }
  return { service: context.lmJapaneseService, reads, context };
}

test("local service lazily loads real bundled data once and analyzes complete Japanese captions", async () => {
  const { service, reads } = harness();
  assert.equal(reads.length, 0);
  const [first, second] = await Promise.all([service.analyze("猫が駅で食べませんでした。"), service.analyze("雨が降った。")]);
  assert.equal(first.map((token) => token.text).join(""), "猫が駅で食べませんでした。");
  const word = first.find((token) => token.lemma === "食べる");
  assert.equal(word.surface, "食べませんでした");
  assert.equal(word.baseReading, "たべる");
  assert.equal(word.common, true);
  assert.ok(first.some((token) => token.lemma === "猫" && token.isWordLike));
  assert.ok(second.some((token) => token.lemma === "雨" && token.isWordLike));
  assert.equal(reads.filter((url) => url.includes("base.dat.gz")).length, 1);
  const before = reads.length;
  await service.analyze("猫が駅で食べませんでした。");
  assert.equal(reads.length, before);
});

test("lookup uses the contextual dictionary form, real dictionary meanings and base reading", async () => {
  const { service } = harness();
  const card = await service.lookup("来なかった", "zh-CN", "彼は昨日来なかった。", {});
  assert.equal(card.word, "来なかった");
  assert.equal(card.japanese.lemma, "来る");
  assert.equal(card.japanese.baseReading, "くる");
  assert.match(card.translation, /来る/);
  assert.ok(card.entries.some((entry) => /come/.test(entry.items[0].definition)));
  assert.ok(card.entries.every((entry) => entry.items[0].gloss.startsWith("译义:")));
  assert.match(card.dictionarySource, /JMdict/);
  assert.equal(card.dictionaryMatched, true);
});

test("range lookup keeps a full phrase and never saves it as its first word", async () => {
  const { service } = harness();
  const card = await service.lookup("行かなければならない", "en", "明日行かなければならない。", { isPhrase: true });
  assert.equal(card.japanese.lemma, "行かなければならない");
  assert.equal(card.japanese.isPhrase, true);
  assert.ok(card.japanese.parts.length > 1);
  assert.equal(card.japanese.baseReading, "");
});

test("inflected homographs keep their contextual stem reading instead of a new isolated lemma reading", async () => {
  const { service } = harness();
  const units = await service.analyze("空いている席に座った。空いた時間。");
  const empty = units.filter((token) => token.lemma === "空く");
  assert.equal(empty.length, 2);
  assert.ok(empty.every((token) => token.baseReading === "あく"));
  const card = await service.lookup("空いた", "en", "空いた時間。", {});
  assert.equal(card.japanese.baseReading, "あく");
  assert.ok(card.entries.every((entry) => entry.reading === "あく"));
});

test("suru predicates use the noun's documented verbal senses without losing their learning lemma", async () => {
  const { service } = harness();
  for (const surface of ["勉強した", "運動した", "結婚した", "電話した"]) {
    const tokens = await service.analyze(surface);
    const card = await service.lookup(surface, "en", "", {});
    assert.equal(tokens[0].common, true, surface);
    assert.equal(card.dictionaryMatched, true, surface);
    assert.equal(card.japanese.lemma, surface.slice(0, -2) + "する");
    assert.equal(card.dictionaryHeadword, surface.slice(0, -2));
    assert.ok(card.entries.length);
    assert.ok(card.entries.every((entry) => /suru/.test(entry.pos)));
  }
});

test("known adjective morphology prioritizes adjective senses over unrelated homographs", async () => {
  const { service } = harness();
  const card = await service.lookup("よくなかった", "en", "結果はよくなかった。", {});
  assert.equal(card.japanese.lemma, "よい");
  assert.match(card.entries[0].pos, /adjective/);
  assert.match(card.entries[0].items[0].definition, /good|fine|nice/);
});

test("negative na-adjective and copula chains use the head's dictionary entry", async () => {
  const { service } = harness();
  for (const [surface, lemma] of [["きれいじゃなかった", "きれい"], ["好きじゃない", "好き"], ["元気じゃありません", "元気"], ["静かではない", "静か"]]) {
    const card = await service.lookup(surface, "en", "", {});
    assert.equal(card.japanese.lemma, lemma, surface);
    assert.ok(card.japanese.conjugation.labels.includes("否定"), surface);
    assert.equal(card.dictionaryMatched, true, surface);
    assert.ok(card.entries.length, surface);
  }
});

test("dictionary matching respects headword-specific readings and sense restrictions", () => {
  const { service } = harness();
  const entry = { id: "fixture", k: ["甲", "乙"], r: [{ t: "こう", a: ["甲"] }, { t: "おつ", a: ["乙"] }],
    s: [{ k: ["甲"], r: ["こう"], g: ["first"] }, { k: ["乙"], r: ["おつ"], g: ["second"] }] };
  const dict = { index: new Map([["甲", [entry]], ["乙", [entry]], ["こう", [entry]]]) };
  assert.equal(service.matchingEntries(dict, "甲", "こう")[0].s.length, 1);
  assert.equal(service.matchingEntries(dict, "甲", "おつ").length, 0);
  assert.equal(service.matchingEntries(dict, "乙", "おつ")[0].s[0].g[0], "second");
  assert.equal(service.matchingEntries(dict, "こう", "")[0].s.length, 1, "kana lookup must not leak a sense restricted to another spelling/reading");
  assert.equal(service.matchingEntries(dict, "こう", "")[0].r.length, 1);
});

test("dictionary failure still permits local morphology and labels a translation-only lookup", async () => {
  const { service } = harness({ offline: true });
  const tokens = await service.analyze("食べた");
  assert.equal(tokens[0].lemma, "食べる");
  const card = await service.lookup("食べた", "zh-CN", "", {});
  assert.equal(card.dictionaryAvailable, false);
  assert.equal(card.entries.length, 0);
  assert.equal(card.translationSource, "在线翻译");
});

test("complete lookup failure reports unavailability without claiming a translation was returned", async () => {
  const { service, context } = harness({ offline: true });
  context.translateText = async () => { throw new Error("offline"); };
  const card = await service.lookup("食べた", "zh-CN", "", {});
  assert.equal(card.translation, "");
  assert.equal(card.translationSource, "");
  assert.equal(card.dictionarySource, "");
  assert.match(card.lookupNotice, /未返回结果/);
});

test("oversized messages are rejected before any dictionary allocation", async () => {
  const { service, reads } = harness();
  await assert.rejects(service.analyze("猫".repeat(12001)), /invalid_japanese_text/);
  await assert.rejects(service.lookup("猫".repeat(501), "en", "", {}), /invalid_word/);
  assert.equal(reads.length, 0);
});
