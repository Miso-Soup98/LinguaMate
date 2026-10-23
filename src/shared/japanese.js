// Learning units built from IPADIC analyses. This is deliberately a postprocessor:
// the dictionary, rather than a kana suffix guesser, chooses each lexical entry.
(() => {
  const clean = (value) => value && value !== "*" ? String(value).normalize("NFC") : "";
  const kana = (value) => clean(value).replace(/[ァ-ヶ]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) - 0x60));
  const japanese = (value) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(String(value || ""));
  const isKana = (value) => /^[ぁ-ゖァ-ヶー]+$/u.test(value);
  const lexical = (token) => /^(動詞|形容詞)$/.test(token.pos);
  const normalized = (value) => String(value || "").normalize("NFC").trim();

  function baseReading(token) {
    const explicit = kana(token.basic_reading || token.baseReading);
    if (explicit) return explicit;
    const surface = clean(token.surface_form);
    const lemma = clean(token.basic_form) || surface;
    const reading = kana(token.reading);
    if (!reading) return "";
    if (surface === lemma) return reading;
    if (/^(カ変|サ変|ラ変)/.test(clean(token.conjugated_type))) return "";
    // An inflected kana ending can be replaced only when the shared written
    // stem and dictionary reading agree. No kanji pronunciation is invented.
    let shared = 0;
    while (shared < surface.length && surface[shared] === lemma[shared]) shared += 1;
    const from = kana(surface.slice(shared));
    const to = kana(lemma.slice(shared));
    if (shared > 0 && (!from || isKana(from)) && (!to || isKana(to)) && reading.endsWith(from)) {
      return reading.slice(0, from ? -from.length : undefined) + to;
    }
    return "";
  }

  function part(token) {
    return {
      surface: clean(token.surface_form), lemma: clean(token.basic_form) || clean(token.surface_form),
      reading: kana(token.reading), baseReading: baseReading(token),
      pos: clean(token.pos), posDetail: [token.pos_detail_1, token.pos_detail_2, token.pos_detail_3].map(clean).filter(Boolean),
      type: clean(token.conjugated_type), form: clean(token.conjugated_form),
      known: token.word_type !== "UNKNOWN"
    };
  }

  function termKey(input) {
    const item = typeof input === "string" ? { surface: input, lemma: input } : input || {};
    const lemma = normalized(item.lemma || item.word || item.surface || item.text).toLowerCase();
    if (!lemma) return "";
    const reading = kana(normalized(item.baseReading || item.reading).normalize("NFKC")).trim();
    const entryId = normalized(item.entryId);
    // This identity is also used by persistent vocabulary and mastery records.
    // The lexical spelling remains part of it even for homophones.
    return reading || entryId ? `ja:${lemma}|reading=${encodeURIComponent(reading)}|entry=${encodeURIComponent(entryId)}` : `ja:${lemma}`;
  }

  function adjacent(a, b) { return a && b && a.end === b.start; }

  function canAppend(group, next, after) {
    if (!adjacent(group[group.length - 1], next)) return false;
    const head = group[0].analysis;
    const last = group[group.length - 1].analysis;
    const token = next.analysis;
    const hasVerb = group.some((item) => item.analysis.pos === "動詞");
    const hasPredicate = hasVerb || group.some((item) => item.analysis.pos === "形容詞" || item.analysis.pos === "助動詞");
    const nominal = head.pos === "名詞";
    const negativeAfter = after && adjacent(next, after) && /^(ない|ある)$/.test(after.analysis.lemma)
      && /^(形容詞|助動詞)$/.test(after.analysis.pos);
    const copulaBridge = last.pos === "助詞" && (last.surface === "じゃ" && last.posDetail[0] === "副助詞"
      || last.surface === "は" && group.length > 1 && group[group.length - 2].analysis.pos === "助動詞"
      && group[group.length - 2].analysis.lemma === "だ" && group[group.length - 2].analysis.surface === "で");
    // Nominal / な-adjective negatives use particles that must stay independent
    // elsewhere. Join them only when an actual copula-negative chain follows.
    if (nominal && token.pos === "助詞" && negativeAfter) {
      if (token.surface === "じゃ" && token.posDetail[0] === "副助詞") return true;
      if (token.surface === "は" && last.pos === "助動詞" && last.lemma === "だ" && last.surface === "で") return true;
    }
    if (nominal && copulaBridge && token.pos === "形容詞" && token.lemma === "ない") return true;
    if (token.pos === "助動詞") {
      // Avoid absorbing sentence-final か/ね (particles) or another lexical word.
      return hasPredicate || /^(名詞|副詞|連体詞)$/.test(head.pos);
    }
    if (lexical(token) && /^(非自立|接尾)$/.test(token.posDetail[0]) && hasPredicate) {
      const connective = last.pos === "助詞" && /^(て|で)$/.test(last.surface);
      const contraction = /^(ちゃう|じゃう|ちまう|じまう)$/.test(token.lemma);
      const progressiveContraction = /^(てる|でる)$/.test(token.lemma);
      const inflection = token.posDetail[0] === "接尾" && /^(れる|られる|せる|させる)$/.test(token.lemma);
      return connective || contraction || progressiveContraction || inflection;
    }
    if (token.pos === "助詞" && token.posDetail[0] === "接続助詞" && /^(て|で|ば|ちゃ|じゃ)$/.test(token.surface) && hasPredicate) return true;
    // Explanatory んだ/のです belongs to the preceding predicate, while a
    // standalone の and other nouns remain separate learning units.
    if (/^(ん|の)$/.test(token.surface) && /^(名詞|助詞)$/.test(token.pos) && hasPredicate
      && after && adjacent(next, after) && after.analysis.pos === "助動詞" && /^(だ|です)$/.test(after.analysis.lemma)) return true;
    return false;
  }

  function labelsFor(parts) {
    const labels = [];
    const add = (label) => { if (!labels.includes(label)) labels.push(label); };
    let ambiguous = false;
    const candidates = [];
    for (let i = 1; i < parts.length; i += 1) {
      const p = parts[i];
      const basic = p.lemma;
      if (p.pos === "助動詞" || p.pos === "動詞" && p.posDetail[0] === "接尾") {
        if (/^(ます|です)$/.test(basic)) add("礼貌体");
        else if (/^(ない|ぬ|ん)$/.test(basic)) add("否定");
        else if (/^(た|だ)$/.test(basic) && /特殊・タ/.test(p.type)) add(p.form === "仮定形" ? "条件（たら）" : "过去 / 完了");
        else if (basic === "たい") add("愿望");
        else if (/^(せる|させる)$/.test(basic)) add("使役");
        else if (/^(れる|られる)$/.test(basic)) {
          add(basic === "られる" ? "可能 / 被动 / 尊敬（依语境判断）" : "被动 / 尊敬（依语境判断）");
          ambiguous = true;
          for (const interpretation of basic === "られる" ? ["可能", "被动", "尊敬"] : ["被动", "尊敬"]) candidates.push({ interpretation });
        } else if (/^(う|よう)$/.test(basic)) add("意志 / 推量");
        else if (basic === "そうだ") { add("样态 / 传闻（依语境判断）"); ambiguous = true; }
      }
      if (p.pos === "形容詞" && basic === "ない") add("否定");
      if (/^(て|で)$/.test(p.surface) && p.pos === "助詞") add("て形连接");
      if (p.surface === "ば" && p.pos === "助詞") add("条件（ば）");
      if (/^(ちゃ|じゃ)$/.test(p.surface) && p.pos === "助詞") add(p.posDetail[0] === "副助詞" ? "判断句口语缩约（では→じゃ）" : "ては / では的口语缩约");
      if (/^(いる|おる)$/.test(basic) && p.pos === "動詞") add("持续 / 状态");
      if (/^(てる|でる)$/.test(basic)) add("ている的口语缩约");
      if (/^(しまう|ちゃう|じゃう|ちまう|じまう)$/.test(basic)) add(/^(ちゃう|じゃう|ちまう|じまう)$/.test(basic) ? "てしまう的口语缩约" : "完了 / 遗憾");
      if (/^(おく)$/.test(basic) && p.pos === "動詞") add("预先准备");
      if (/^(みる)$/.test(basic) && p.pos === "動詞") add("尝试");
      if (/^(ん|の)$/.test(p.surface) && /^(名詞|助詞)$/.test(p.pos) && parts[i + 1] && /^(だ|です)$/.test(parts[i + 1].lemma)) add("解释语气（のだ / んだ）");
    }
    return { labels, ambiguous, candidates };
  }

  function learningUnit(group) {
    const parts = group.map((entry) => entry.analysis);
    const head = parts[0];
    let lemma = head.lemma;
    let reading = head.baseReading;
    let pos = head.pos;
    let type = head.type;
    let start = 1;
    // サ変接続 nouns are lexicalized together with する; keep the dictionary's
    // noun reading and the actual する analysis rather than treating し alone.
    if (head.pos === "名詞" && head.posDetail[0] === "サ変接続" && parts[1] && parts[1].pos === "動詞" && parts[1].lemma === "する") {
      lemma += "する";
      reading = head.baseReading && parts[1].baseReading ? head.baseReading + parts[1].baseReading : "";
      pos = "動詞";
      type = parts[1].type;
      start = 2;
    }
    const details = labelsFor([parts[start - 1], ...parts.slice(start)]);
    if (pos === "名詞" && parts.length > 1 && parts.some((p) => p.pos === "助動詞" && /^(だ|です|ない|ある)$/.test(p.lemma)
      || p.pos === "助詞" && p.surface === "じゃ" && p.posDetail[0] === "副助詞")) type = "判断句（名词 / な形容词）";
    const surface = group.map((entry) => entry.analysis.surface).join("");
    const allReadings = parts.every((p) => p.reading);
    const result = {
      text: surface, surface, lemma, reading: allReadings ? parts.map((p) => p.reading).join("") : "", baseReading: reading,
      pos, posDetail: head.posDetail,
      conjugation: { type, form: parts[start - 1].form, labels: details.labels, ambiguous: details.ambiguous },
      candidates: details.candidates, grammar: /^(助詞|助動詞)$/.test(pos),
      isWordLike: !/^(記号|フィラー)$/.test(pos) && /[\p{Letter}\p{Number}]/u.test(surface),
      known: parts.every((p) => p.known), start: group[0].start, end: group[group.length - 1].end, parts
    };
    result.termKey = termKey(result);
    return result;
  }

  function analyzeTokens(rawTokens, originalText) {
    const source = String(originalText ?? (Array.isArray(rawTokens) ? rawTokens.map((t) => clean(t.surface_form)).join("") : ""));
    const entries = [];
    let cursor = 0;
    // Locate surfaces in the original UTF-16 string. kuromoji's word_position
    // uses code points and restarts after some punctuation, so it cannot be
    // used directly for DOM text offsets, emoji, or omitted whitespace.
    for (const token of Array.isArray(rawTokens) ? rawTokens : []) {
      if (!token || !clean(token.surface_form)) continue;
      const analysis = part(token);
      const found = source.indexOf(analysis.surface, cursor);
      if (found < cursor) continue;
      if (found > cursor) entries.push({ start: cursor, end: found, analysis: { surface: source.slice(cursor, found), lemma: source.slice(cursor, found), reading: "", baseReading: "", pos: "記号", posDetail: [], type: "", form: "", known: false } });
      entries.push({ start: found, end: found + analysis.surface.length, analysis });
      cursor = found + analysis.surface.length;
    }
    if (cursor < source.length) entries.push({ start: cursor, end: source.length, analysis: { surface: source.slice(cursor), lemma: source.slice(cursor), reading: "", baseReading: "", pos: "記号", posDetail: [], type: "", form: "", known: false } });
    const result = [];
    for (let index = 0; index < entries.length;) {
      const group = [entries[index++]];
      // A noun plus する is the only content-word compound joined here. Other
      // compounds remain dictionary segments, preserving proper names.
      if (group[0].analysis.pos === "名詞" && group[0].analysis.posDetail[0] === "サ変接続"
        && entries[index] && adjacent(group[0], entries[index]) && entries[index].analysis.pos === "動詞" && entries[index].analysis.lemma === "する") group.push(entries[index++]);
      while (entries[index] && canAppend(group, entries[index], entries[index + 1])) group.push(entries[index++]);
      result.push(learningUnit(group));
    }
    return result;
  }

  globalThis.lmJapanese = Object.freeze({
    analyzeTokens, termKey, baseReading, toHiragana: kana, isJapanese: japanese,
    lookupForm: (value) => normalized(typeof value === "string" ? value : value && (value.lemma || value.surface || value.text)),
    conjugationLabel: (value) => value && value.conjugation ? value.conjugation.labels.join(" · ") : ""
  });
})();
