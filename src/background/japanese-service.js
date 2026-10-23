// Local morphology and dictionary data are loaded once, only when Japanese is used.
(() => {
  let tokenizerPromise;
  let dictionaryPromise;
  const sentences = new Map();
  const baseReadings = new Map();
  const normalized = (text) => String(text || "").normalize("NFC");
  const indexKey = (text) => lmJapanese.toHiragana(normalized(text).normalize("NFKC"));
  const put = (map, key, value, limit) => {
    if (map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
  };

  function tokenizer() {
    if (!tokenizerPromise) {
      tokenizerPromise = new Promise((resolve, reject) => {
        // An absolute extension path avoids Browserify path.join corrupting a URL.
        kuromoji.builder({ dicPath: "/src/vendor/kuromoji/dict/" }).build((error, value) => error ? reject(error) : resolve(value));
      }).catch((error) => { tokenizerPromise = null; throw error; });
    }
    return tokenizerPromise;
  }

  function dictionary() {
    if (!dictionaryPromise) {
      dictionaryPromise = (async () => {
        const response = await fetch(chrome.runtime.getURL("src/vendor/jmdict/common.json.gz"));
        if (!response.ok) throw new Error("japanese_dictionary_unavailable");
        const data = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();
        const index = new Map();
        for (const entry of data.words) {
          const keys = new Set([...entry.k, ...entry.r.map((reading) => reading.t)].map(indexKey));
          for (const key of keys) {
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(entry);
          }
        }
        return { index, tags: data.tags, date: data.date };
      })().catch((error) => { dictionaryPromise = null; throw error; });
    }
    return dictionaryPromise;
  }

  async function analyze(text) {
    if (typeof text !== "string" || text.length > 12000) throw new Error("invalid_japanese_text");
    if (!text) return [];
    if (sentences.has(text)) return sentences.get(text);
    const pending = (async () => {
      const [analyzer, dict] = await Promise.all([tokenizer(), dictionary().catch(() => null)]);
      const raw = analyzer.tokenize(text);
      for (const token of raw) {
        const lemma = token.basic_form;
        // Preserve the contextual reading of dictionary forms such as 生/なま.
        if (!lemma || lemma === "*" || lemma === token.surface_form) continue;
        const inferredReading = lmJapanese.baseReading(token);
        if (inferredReading) { token.basic_reading = inferredReading; continue; }
        if (!baseReadings.has(lemma)) {
          const base = analyzer.tokenize(lemma);
          const reading = base.map((part) => part.surface_form).join("") === lemma && base.every((part) => part.reading)
            ? base.map((part) => part.reading).join("") : "";
          put(baseReadings, lemma, reading, 3000);
        }
        token.basic_reading = baseReadings.get(lemma);
      }
      return lmJapanese.analyzeTokens(raw, text).map((token) => ({
        ...token,
        common: dict ? lexicalEntries(dict, token).entries.length > 0 : null
      }));
    })();
    put(sentences, text, pending, 400);
    try { return await pending; } catch (error) { sentences.delete(text); throw error; }
  }

  function matchingEntries(dict, word, reading) {
    const key = indexKey(word);
    const wantedReading = indexKey(reading);
    return (dict.index.get(key) || []).map((entry) => {
      const writtenForms = entry.k.filter((form) => indexKey(form) === key);
      const written = writtenForms.length > 0;
      const allowed = entry.r.filter((item) => (!wantedReading || indexKey(item.t) === wantedReading) &&
        (written ? item.a.includes("*") || writtenForms.some((form) => item.a.includes(form)) : indexKey(item.t) === key));
      if (!allowed.length) return null;
      const possibleForms = written ? writtenForms : entry.k;
      const senses = entry.s.filter((sense) => allowed.some((item) => {
        if (!sense.r.includes("*") && !sense.r.includes(item.t)) return false;
        if (!possibleForms.length) return sense.k.includes("*");
        return possibleForms.some((form) => (sense.k.includes("*") || sense.k.includes(form)) && (item.a.includes("*") || item.a.includes(form)));
      }));
      return senses.length ? { ...entry, r: allowed, s: senses } : null;
    }).filter(Boolean);
  }

  function lexicalEntries(dict, analysis) {
    const direct = matchingEntries(dict, analysis.lemma, analysis.baseReading);
    if (direct.length) return { entries: prioritizePartsOfSpeech(direct, analysis), headword: analysis.lemma };
    const [noun, verb] = analysis.parts || [];
    // JMdict stores many suru predicates under the noun's vs sense. This is a
    // dictionary relation supported by the morphological parts, not a suffix
    // rule applied to arbitrary strings ending in する.
    if (noun?.pos === "名詞" && noun.posDetail?.[0] === "サ変接続" && verb?.pos === "動詞" && verb.lemma === "する" && analysis.lemma === noun.lemma + "する") {
      const entries = matchingEntries(dict, noun.lemma, noun.baseReading).map((entry) => ({
        ...entry, s: entry.s.filter((sense) => sense.p.some((tag) => /^vs(?:-|$)/.test(tag)))
      })).filter((entry) => entry.s.length);
      return { entries, headword: noun.lemma };
    }
    return { entries: [], headword: analysis.lemma };
  }

  function prioritizePartsOfSpeech(entries, analysis) {
    const wanted = analysis.pos === "形容詞" ? /^adj-i(?:x|$)/ : analysis.pos === "動詞" ? /^v/ :
      analysis.pos === "名詞" && analysis.posDetail?.[0] === "形容動詞語幹" ? /^adj-na$/ :
      analysis.pos === "名詞" ? /^(n(?:-|$)|pn$|num$)/ : analysis.pos === "副詞" ? /^adv/ :
      analysis.pos === "助詞" ? /^prt$/ : analysis.pos === "助動詞" ? /^aux/ : null;
    if (!wanted) return entries;
    const score = (sense) => Number(sense.p.some((tag) => wanted.test(tag)));
    // Morphology can prioritize homographs, but it cannot prove a single
    // meaning. Keep remaining dictionary alternatives visible after the match.
    return entries.map((entry) => ({ ...entry, s: [...entry.s].sort((left, right) => score(right) - score(left)) }))
      .sort((left, right) => score(right.s[0]) - score(left.s[0]));
  }

  async function resolveAnalysis(surface, context, hint) {
    const hintPhrase = hint && hint.isPhrase === true;
    const contextTokens = context && context.length <= 12000 ? await analyze(context) : [];
    const matches = contextTokens.filter((token) => token.isWordLike && token.surface === surface);
    let analysis = matches.find((token) => Number.isInteger(hint && hint.start) && token.start === hint.start);
    if (!analysis && hint && hint.baseReading) analysis = matches.find((token) => token.baseReading === hint.baseReading);
    if (!analysis && matches.length === 1) analysis = matches[0];
    const units = analysis ? [analysis] : await analyze(surface);
    if (!hintPhrase && units.length === 1 && units[0].isWordLike) return { ...units[0] };
    // A range lookup keeps the whole phrase. A partial word is never assigned a
    // neighbouring word's dictionary form or reading.
    return {
      surface, text: surface, lemma: surface, reading: "", baseReading: "", pos: "短语 / 选区",
      isPhrase: true, isWordLike: true, conjugation: { labels: [], ambiguous: false },
      parts: units, candidates: [], grammar: false,
      termKey: lmJapanese.termKey(surface)
    };
  }

  const bounded = (promise, fallback, delay = 7000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), delay);
    Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });

  async function lookup(word, to, context, hint) {
    const surface = normalized(word).trim();
    if (!surface || surface.length > 500) throw new Error("invalid_word");
    const analysis = await resolveAnalysis(surface, String(context || ""), hint);
    const dict = await dictionary().catch(() => null);
    const lexical = dict ? lexicalEntries(dict, analysis) : { entries: [], headword: analysis.lemma };
    const records = lexical.entries;
    const chosen = records.slice(0, 4);
    const entries = chosen.flatMap((record) => record.s.slice(0, 3).map((sense) => ({
      pos: sense.p.map((tag) => dict.tags[tag] || tag).join(" / "),
      entryId: record.id,
      reading: record.r.map((reading) => lmJapanese.toHiragana(reading.t)).join(" / "),
      items: [{ definition: sense.g.slice(0, 5).join("; "), example: "", synonyms: [] }]
    }))).slice(0, 6);
    // The dictionary is authoritative for lexical meanings. Online text is
    // labelled separately and never treated as a structured dictionary entry.
    const definitions = entries.map((entry) => entry.items[0].definition);
    const [translated, glosses] = await Promise.all([
      bounded(translateText(analysis.lemma, "ja", to), { text: "" }),
      /^en(?:-|$)/i.test(to) ? Promise.resolve(definitions) : bounded(translateLines(definitions, "en", to), [])
    ]);
    entries.forEach((entry, index) => { entry.items[0].gloss = glosses[index] || ""; });
    if (chosen.length === 1) analysis.entryId = String(chosen[0].id);
    if (!analysis.baseReading && chosen.length === 1 && chosen[0].r.length === 1) {
      analysis.baseReading = lmJapanese.toHiragana(chosen[0].r[0].t) + (lexical.headword !== analysis.lemma ? "する" : "");
    }
    analysis.termKey = lmJapanese.termKey(analysis);
    return {
      word: surface, translation: translated.text || definitions[0] || "", phonetic: analysis.baseReading || analysis.reading,
      senses: [], entries, japanese: analysis, context: context || "",
      dictionarySource: dict ? "JMdict（常用词） / EDRDG" : "", dictionaryUrl: "https://www.edrdg.org/jmdict/j_jmdict.html",
      dictionaryDate: dict ? dict.date : "", dictionaryAvailable: Boolean(dict),
      dictionaryHeadword: lexical.headword,
      dictionaryMatched: records.length > 0, dictionaryAlternatives: Math.max(0, records.length - chosen.length),
      translationSource: translated.text ? "在线翻译" : "",
      lookupNotice: !dict ? (translated.text ? "本地词典暂时无法载入；目前仅显示在线译文，可刷新页面后重试。" : "本地词典暂时无法载入，在线翻译也未返回结果，请刷新页面后重试。") : records.length ?
        (lexical.headword !== analysis.lemma ? `「${analysis.lemma}」参考「${lexical.headword}」的する用法。` : "") + "词典列出可能义项，请结合字幕语境判断。" :
        translated.text ? "常用词词典未收录此项；译文来自在线翻译，可能需要结合语境核实。" : "常用词词典未收录此项，在线翻译暂不可用，请稍后重试。"
    };
  }

  globalThis.lmJapaneseService = { analyze, lookup, matchingEntries };
})();
