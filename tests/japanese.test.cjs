const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/shared/japanese.js"), "utf8"), context);
const jp = context.lmJapanese;
const copy = (value) => JSON.parse(JSON.stringify(value));
const t = (surface, lemma, reading, pos = "動詞", detail = "自立", type = "一段", form = "基本形", extra = {}) => ({
  surface_form: surface, basic_form: lemma, reading, pos, pos_detail_1: detail, pos_detail_2: "*", pos_detail_3: "*",
  conjugated_type: type, conjugated_form: form, word_type: "KNOWN", ...extra
});
const aux = (surface, lemma, reading, type = "特殊・タ", form = "基本形") => t(surface, lemma, reading, "助動詞", "*", type, form);
const particle = (surface, detail = "格助詞", reading = surface) => t(surface, surface, reading, "助詞", detail, "*", "*");
const noun = (surface, reading, detail = "一般") => t(surface, surface, reading, "名詞", detail, "*", "*");
const analyze = (tokens, text = tokens.map((token) => token.surface_form).join("")) => copy(jp.analyzeTokens(tokens, text));

test("polite negative past is one learning unit whose identity is the dictionary entry", () => {
  const [word] = analyze([t("食べ", "食べる", "タベ", "動詞", "自立", "一段", "連用形"),
    aux("ませ", "ます", "マセ", "特殊・マス", "未然形"), aux("ん", "ん", "ン", "不変化型"),
    aux("でし", "です", "デシ", "特殊・デス", "連用形"), aux("た", "た", "タ")]);
  assert.equal(word.surface, "食べませんでした");
  assert.equal(word.lemma, "食べる");
  assert.equal(word.reading, "たべませんでした");
  assert.equal(word.baseReading, "たべる");
  assert.deepEqual(word.conjugation.labels, ["礼貌体", "否定", "过去 / 完了"]);
  assert.equal(word.termKey, analyze([t("食べる", "食べる", "タベル")])[0].termKey);
});

test("godan sound changes preserve 飲む, 行く, 書く, and 話す rather than saving stems", () => {
  for (const [surface, lemma, reading, expected] of [["飲ん", "飲む", "ノン", "のむ"], ["行っ", "行く", "イッ", "いく"],
    ["書い", "書く", "カイ", "かく"], ["話し", "話す", "ハナシ", "はなす"]]) {
    const [word] = analyze([t(surface, lemma, reading, "動詞", "自立", "五段・マ行", "連用タ接続"), aux("た", "た", "タ")]);
    assert.equal(word.lemma, lemma);
    assert.equal(word.baseReading, expected);
    assert.equal(word.conjugation.labels[0], "过去 / 完了");
  }
});

test("suru nouns and irregular kuru use explicit dictionary readings when suffix replacement is insufficient", () => {
  const [study] = analyze([noun("勉強", "ベンキョウ", "サ変接続"), t("し", "する", "シ", "動詞", "自立", "サ変・スル", "連用形", { basic_reading: "スル" }), aux("た", "た", "タ")]);
  assert.equal(study.lemma, "勉強する");
  assert.equal(study.baseReading, "べんきょうする");
  assert.equal(study.pos, "動詞");
  assert.deepEqual(study.conjugation.labels, ["过去 / 完了"]);
  const [came] = analyze([t("来", "来る", "キ", "動詞", "自立", "カ変・来ル", "連用形", { basic_reading: "クル" }), aux("た", "た", "タ")]);
  assert.equal(came.baseReading, "くる");
  // Without a dictionary reading, 来→来る cannot safely reuse キ as its stem.
  const [unresolved] = analyze([t("来", "来る", "キ", "動詞", "自立", "カ変・来ル", "連用形")]);
  assert.equal(unresolved.baseReading, "");
});

test("adjective past negative stays tied to 高い and retains both suffixes", () => {
  const [word] = analyze([t("高く", "高い", "タカク", "形容詞", "自立", "形容詞・アウオ段", "連用テ接続"),
    aux("なかっ", "ない", "ナカッ", "特殊・ナイ", "連用タ接続"), aux("た", "た", "タ")]);
  assert.equal(word.lemma, "高い");
  assert.equal(word.baseReading, "たかい");
  assert.deepEqual(word.conjugation.labels, ["否定", "过去 / 完了"]);
});

test("られる preserves possible, passive and honorific interpretations without selecting one", () => {
  const [word] = analyze([t("食べ", "食べる", "タベ", "動詞", "自立", "一段", "未然形"), t("られる", "られる", "ラレル", "動詞", "接尾")]);
  assert.equal(word.lemma, "食べる");
  assert.equal(word.conjugation.ambiguous, true);
  assert.deepEqual(word.candidates.map((candidate) => candidate.interpretation), ["可能", "被动", "尊敬"]);
  assert.match(word.conjugation.labels[0], /依语境/);
});

test("causative passive and desire preserve the complete chain", () => {
  const [word] = analyze([t("食べ", "食べる", "タベ", "動詞", "自立", "一段", "未然形"),
    t("させ", "させる", "サセ", "動詞", "接尾", "一段", "未然形"), t("られ", "られる", "ラレ", "動詞", "接尾", "一段", "連用形"),
    aux("たく", "たい", "タク", "特殊・タイ", "連用テ接続"), aux("ない", "ない", "ナイ", "特殊・ナイ")]);
  assert.equal(word.surface, "食べさせられたくない");
  assert.equal(word.lemma, "食べる");
  assert.ok(word.conjugation.labels.includes("使役"));
  assert.ok(word.conjugation.labels.includes("愿望"));
  assert.ok(word.conjugation.labels.includes("否定"));
});

test("ている, ちゃった and んだ are grouped without consuming sentence particles", () => {
  const [progressive, end] = analyze([t("食べ", "食べる", "タベ", "動詞", "自立", "一段", "連用形"), particle("て", "接続助詞"),
    t("い", "いる", "イ", "動詞", "非自立", "一段", "連用形"), aux("た", "た", "タ"), particle("ね", "終助詞")]);
  assert.equal(progressive.surface, "食べていた");
  assert.ok(progressive.conjugation.labels.includes("持续 / 状态"));
  assert.equal(end.surface, "ね");
  const [contracted] = analyze([t("食べ", "食べる", "タベ", "動詞", "自立", "一段", "連用形"),
    t("ちゃっ", "ちゃう", "チャッ", "動詞", "非自立", "五段・ワ行促音便", "連用タ接続"), aux("た", "た", "タ")]);
  assert.equal(contracted.surface, "食べちゃった");
  assert.ok(contracted.conjugation.labels.includes("てしまう的口语缩约"));
  const [explanatory] = analyze([t("行く", "行く", "イク", "動詞", "自立", "五段・カ行促音便"), noun("ん", "ン", "非自立"), aux("だ", "だ", "ダ", "特殊・ダ")]);
  assert.equal(explanatory.surface, "行くんだ");
  assert.ok(explanatory.conjugation.labels.includes("解释语气（のだ / んだ）"));
});

test("てる contraction is marked but an independent verb and a lone の stay independent", () => {
  const units = analyze([t("食べ", "食べる", "タベ", "動詞", "自立", "一段", "連用形"),
    t("て", "てる", "テ", "動詞", "非自立", "一段", "連用形"), aux("た", "た", "タ"), particle("の", "終助詞"),
    t("見る", "見る", "ミル")]);
  assert.equal(units[0].surface, "食べてた");
  assert.ok(units[0].conjugation.labels.includes("ている的口语缩约"));
  assert.deepEqual(units.slice(1).map((unit) => unit.surface), ["の", "見る"]);
});

test("particles and one-character content words remain learnable; copula morphology is attached", () => {
  const units = analyze([noun("猫", "ネコ"), particle("が", "格助詞", "ガ"), noun("駅", "エキ"),
    aux("でし", "です", "デシ", "特殊・デス", "連用形"), aux("た", "た", "タ")]);
  assert.deepEqual(units.map((unit) => unit.surface), ["猫", "が", "駅でした"]);
  assert.ok(units.every((unit) => unit.isWordLike));
  assert.equal(units[1].grammar, true);
  assert.equal(units[0].grammar, false);
  assert.deepEqual(units[2].conjugation.labels, ["礼貌体", "过去 / 完了"]);
});

test("nominal negative copulas preserve their lexical head without swallowing ordinary particles", () => {
  const [contracted, finalParticle] = analyze([noun("好き", "スキ", "形容動詞語幹"), particle("じゃ", "副助詞", "ジャ"),
    aux("ない", "ない", "ナイ", "特殊・ナイ"), particle("か", "終助詞", "カ")]);
  assert.equal(contracted.surface, "好きじゃない");
  assert.equal(contracted.lemma, "好き");
  assert.equal(contracted.baseReading, "すき");
  assert.ok(contracted.conjugation.labels.includes("否定"));
  assert.equal(finalParticle.surface, "か");
  const [formal] = analyze([noun("静か", "シズカ", "形容動詞語幹"), aux("で", "だ", "デ", "特殊・ダ", "連用形"),
    particle("は", "係助詞", "ハ"), t("ない", "ない", "ナイ", "形容詞", "自立", "形容詞・アウオ段")]);
  assert.equal(formal.surface, "静かではない");
  assert.equal(formal.lemma, "静か");
  assert.ok(formal.conjugation.labels.includes("否定"));
  assert.deepEqual(analyze([noun("静か", "シズカ", "形容動詞語幹"), particle("に"), t("なっ", "なる", "ナッ", "動詞", "自立", "五段・ラ行", "連用タ接続"), aux("た", "た", "タ")]).map((unit) => unit.surface), ["静か", "に", "なった"]);
  assert.deepEqual(analyze([noun("猫", "ネコ"), particle("じゃ", "副助詞", "ジャ"), noun("魚", "サカナ")]).map((unit) => unit.surface), ["猫", "じゃ", "魚"]);
});

test("homographs with different dictionary readings have distinct identities and category differences do not fragment entries", () => {
  const [raw, life, verb] = [noun("生", "ナマ"), noun("生", "セイ"), t("生", "生", "ナマ")].map((token) => analyze([token])[0]);
  assert.notEqual(raw.termKey, life.termKey);
  assert.equal(raw.termKey, verb.termKey);
  assert.equal(jp.termKey(raw), raw.termKey);
  assert.notEqual(jp.termKey("橋"), jp.termKey("箸"));
});

test("unknown kanji has no invented reading and gaps, emoji and punctuation retain UTF-16 offsets", () => {
  const text = "😀 猫、\n謎語ZZ";
  const result = analyze([noun("猫", "ネコ"), t("、", "、", "、", "記号", "読点", "*", "*"),
    t("謎語ZZ", "*", undefined, "名詞", "一般", "*", "*", { word_type: "UNKNOWN" })], text);
  assert.equal(result.map((unit) => unit.text).join(""), text);
  assert.equal(result.find((unit) => unit.surface === "猫").start, 3);
  assert.equal(result.find((unit) => unit.surface === "猫").end, 4);
  const unknown = result[result.length - 1];
  assert.equal(unknown.reading, "");
  assert.equal(unknown.baseReading, "");
  assert.equal(unknown.known, false);
  for (const unit of result) assert.equal(text.slice(unit.start, unit.end), unit.surface);
});

test("whitespace never joins predicates and a malformed token stream preserves source text", () => {
  assert.deepEqual(analyze([t("食べ", "食べる", "タベ"), aux("た", "た", "タ")], "食べ た").map((unit) => unit.surface), ["食べ", " ", "た"]);
  assert.equal(analyze([], "まだ解析中")[0].surface, "まだ解析中");
  assert.equal(analyze([null, { surface_form: "不存在" }], "元の文").map((unit) => unit.surface).join(""), "元の文");
});

test("kana normalization and lookup helpers do not normalize away lexical spelling", () => {
  assert.equal(jp.toHiragana("ベンキョウ"), "べんきょう");
  assert.equal(jp.lookupForm({ surface: "食べた", lemma: "食べる" }), "食べる");
  assert.equal(jp.isJapanese("こんにちは"), true);
  assert.equal(jp.isJapanese("日本語"), true);
  assert.equal(jp.isJapanese("hello"), false);
});

test("bundled IPADIC actually produces complete learning units for inflections and common colloquial chains", async () => {
  // Use the shipping browser build, dictionary and decompressor so a synthetic
  // token fixture cannot conceal a mismatch in IPADIC's real POS categories.
  const root = path.resolve(__dirname, "..");
  const tokenizerContext = vm.createContext({
    setTimeout, clearTimeout,
    fetch: async (filename) => ({
      ok: true,
      arrayBuffer: async () => {
        const bytes = fs.readFileSync(path.join(root, filename));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    })
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/vendor/kuromoji/kuromoji.js"), "utf8"), tokenizerContext);
  const tokenizer = await new Promise((resolve, reject) => tokenizerContext.kuromoji.builder({ dicPath: "src/vendor/kuromoji/dict/" })
    .build((error, value) => error ? reject(error) : resolve(value)));
  const dictionaryAnalyze = (text) => {
    const tokens = tokenizer.tokenize(text);
    for (const token of tokens) {
      if (token.surface_form === token.basic_form || !token.basic_form || token.basic_form === "*") continue;
      const inferred = jp.baseReading(token);
      if (inferred) { token.basic_reading = inferred; continue; }
      const base = tokenizer.tokenize(token.basic_form);
      if (base.map((item) => item.surface_form).join("") === token.basic_form && base.every((item) => item.reading)) {
        token.basic_reading = base.map((item) => item.reading).join("");
      }
    }
    return analyze(tokens, text);
  };
  const expected = [
    ["食べませんでした", "食べる", "たべる", "否定"],
    ["飲んだ", "飲む", "のむ", "过去 / 完了"],
    ["勉強しなかった", "勉強する", "べんきょうする", "否定"],
    ["来なかった", "来る", "くる", "否定"],
    ["高くなかった", "高い", "たかい", "否定"],
    ["食べられる", "食べる", "たべる", "可能 / 被动 / 尊敬（依语境判断）"],
    ["殴られた", "殴る", "なぐる", "被动 / 尊敬（依语境判断）"],
    ["読ませた", "読む", "よむ", "使役"],
    ["食べちゃった", "食べる", "たべる", "てしまう的口语缩约"],
    ["飲んじゃった", "飲む", "のむ", "てしまう的口语缩约"],
    ["食べてたんだ", "食べる", "たべる", "解释语气（のだ / んだ）"],
    ["遊んでみた", "遊ぶ", "あそぶ", "尝试"],
    ["食べなくちゃ", "食べる", "たべる", "ては / では的口语缩约"]
  ];
  for (const [text, lemma, reading, label] of expected) {
    const units = dictionaryAnalyze(text);
    assert.equal(units.length, 1, `${text}: should retain the complete auxiliary chain`);
    assert.equal(units[0].surface, text);
    assert.equal(units[0].lemma, lemma);
    assert.equal(units[0].baseReading, reading);
    assert.ok(units[0].conjugation.labels.includes(label), `${text}: missing ${label}`);
  }
  const plain = dictionaryAnalyze("食べる")[0];
  assert.equal(dictionaryAnalyze("食べませんでした")[0].termKey, plain.termKey);
  assert.equal(dictionaryAnalyze("食べてたんだ")[0].termKey, plain.termKey);
  const passive = dictionaryAnalyze("食べさせられたくない")[0];
  assert.equal(passive.surface, "食べさせられたくない");
  assert.ok(passive.conjugation.labels.includes("使役"));
  assert.ok(passive.conjugation.labels.includes("愿望"));
  const oneCharacter = dictionaryAnalyze("猫が駅に行く");
  assert.deepEqual(oneCharacter.map((unit) => unit.surface), ["猫", "が", "駅", "に", "行く"]);
  assert.ok(oneCharacter.every((unit) => unit.isWordLike));
  assert.equal(dictionaryAnalyze("走れる")[0].lemma, "走れる", "do not manufacture an underlying godan verb for an independent dictionary entry");
  const emptySeat = dictionaryAnalyze("空いている席と空いた時間");
  const openForms = emptySeat.filter((unit) => unit.lemma === "空く");
  assert.equal(openForms.length, 2);
  assert.ok(openForms.every((unit) => unit.baseReading === "あく"), "a bare lemma lookup selecting すく must not override the observed あい stem");
  for (const [text, lemma, reading] of [["きれいじゃなかった", "きれい", "きれい"], ["好きじゃない", "好き", "すき"],
    ["元気じゃありません", "元気", "げんき"], ["静かではない", "静か", "しずか"]]) {
    const units = dictionaryAnalyze(text);
    assert.equal(units.length, 1, text);
    assert.equal(units[0].surface, text);
    assert.equal(units[0].lemma, lemma);
    assert.equal(units[0].baseReading, reading);
    assert.ok(units[0].conjugation.labels.includes("否定"), `${text}: copula must retain negation`);
  }
  assert.deepEqual(dictionaryAnalyze("静かになった").map((unit) => unit.surface), ["静か", "に", "なった"]);
});
