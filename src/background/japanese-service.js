// Local morphology and dictionary data are loaded once, only when Japanese is used.
(() => {
  let tokenizerPromise;
  let dictionaryPromise;
  let compoundsPromise;
  const shards = new Map();
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

  async function readDictionaryFile(name) {
    const response = await fetch(chrome.runtime.getURL(`src/vendor/jmdict/extended/${name}.json.gz`));
    if (!response.ok) throw new Error("japanese_dictionary_unavailable");
    return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();
  }

  function compounds() {
    if (!compoundsPromise) compoundsPromise = readDictionaryFile("compounds")
      .catch((error) => { compoundsPromise = null; throw error; });
    return compoundsPromise;
  }

  function extendedDictionary(word) {
    let hash = 0;
    const key = indexKey(word);
    for (let i = 0; i < key.length; i += 1) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) >>> 0;
    const bucket = String(hash % 32).padStart(2, "0");
    if (!shards.has(bucket)) {
      const pending = readDictionaryFile(bucket).then((data) => {
        const index = new Map();
        for (const entry of data.words) for (const form of new Set([...entry.k, ...entry.r.map((r) => r.t)].map(indexKey))) {
          if (!index.has(form)) index.set(form, []);
          index.get(form).push(entry);
        }
        return { index, tags: data.tags, date: data.date, extended: true };
      }).catch((error) => { shards.delete(bucket); throw error; });
      // Bound memory: the full dictionary stays compressed on disk. Only the
      // few lookup buckets used most recently are retained in the worker.
      put(shards, bucket, pending, 4);
    }
    return shards.get(bucket);
  }

  function joinCompounds(tokens, lexicon) {
    if (!lexicon) return tokens;
    const output = [];
    const noun = (token) => token?.pos === "名詞" && /^[\p{Script=Han}々ヶヵ]+$/u.test(token.lemma);
    for (let i = 0; i < tokens.length; i += 1) {
      const first = tokens[i];
      let best = null;
      let form = first.lemma;
      if (noun(first) && first.surface === first.lemma) {
        for (let j = i + 1; j < Math.min(tokens.length, i + 6); j += 1) {
          const last = tokens[j];
          if (!noun(last) || tokens[j - 1].end !== last.start || form.length + last.lemma.length > 16) break;
          form += last.lemma;
          const readings = lexicon[form];
          if (readings?.length) {
            const parts = tokens.slice(i, j + 1);
            const inferred = parts.map((part) => part.baseReading).join("");
            const possible = readings.map(lmJapanese.toHiragana);
            const reading = possible.includes(inferred) ? inferred : possible.length === 1 ? possible[0] : "";
            const surface = parts.map((part) => part.surface).join("");
            const tail = last.reading.startsWith(last.baseReading) ? last.reading.slice(last.baseReading.length) : "";
            best = { end: j, token: { ...last, surface, text: surface, lemma: form,
              reading: reading ? reading + tail : "", baseReading: reading, start: first.start,
              parts: parts.flatMap((part) => part.parts), compound: true, common: false } };
            best.token.termKey = lmJapanese.termKey(best.token);
          }
          if (last.surface !== last.lemma) break;
        }
      }
      output.push(best ? best.token : first);
      if (best) i = best.end;
    }
    return output;
  }

  async function analyze(text) {
    if (typeof text !== "string" || text.length > 12000) throw new Error("invalid_japanese_text");
    if (!text) return [];
    if (sentences.has(text)) return sentences.get(text);
    const pending = (async () => {
      const [analyzer, dict, lexicon] = await Promise.all([tokenizer(), dictionary().catch(() => null), compounds().catch(() => null)]);
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
      return joinCompounds(lmJapanese.analyzeTokens(raw, text), lexicon).map((token) => ({
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

  function grammarNotes(analysis) {
    const notes = [];
    if (analysis.pos === "助詞") {
      const particles = {
        "から": "から：可表示起点（从……）、来源，也可接在句子后说明原因（因为……）。名词＋から不应和前面的名词当作一个词。",
        "まで": "まで：表示时间、地点或范围的终点，常译为“到……为止”。",
        "を": "を：通常标记动作的对象，也可表示经过、离开的地点；读作「お」。",
        "に": "に：可标记时间、到达点、对象、存在地点或变化结果，需看前后谓语。",
        "で": "で：可表示动作发生地点、工具、方式、材料或原因。",
        "は": "は：提示话题或对比，作为助词读作「わ」。",
        "が": "が：可标记主语，也可连接句子表示转折或铺垫。",
        "の": "の：可连接名词表示所属、修饰，也可把前面的动作或句子名词化。",
        "と": "と：可表示并列、共同参与者、引用内容；接句子时也可表示条件。"
      };
      if (particles[analysis.lemma]) notes.push(particles[analysis.lemma]);
    }
    const surface = analysis.surface;
    if (/(?:て|で)(?:いき|行き|いく|行く|いっ|行っ)/.test(surface)) notes.push("～ていく：表示动作向前推进、离开当前地点，或变化从现在持续下去；具体解释取决于原句。見る＋ていく在讲解中常表示“接下来看看／逐步来看”。");
    if (/(?:て|で)(?:き|来|くる)/.test(surface)) notes.push("～てくる：表示朝当前地点移动，或变化持续到现在；不能只按独立动词“来”翻译。");
    if (analysis.conjugation?.labels?.includes("礼貌体")) notes.push("ます／です是礼貌表达；查词和复习使用辞书形，字幕保留实际活用。");
    return notes;
  }

  async function lookup(word, to, context, hint, staged = false) {
    const surface = normalized(word).trim();
    if (!surface || surface.length > 500) throw new Error("invalid_word");
    const analysis = await resolveAnalysis(surface, String(context || ""), hint);
    let dict = await dictionary().catch(() => null);
    let lexical = dict ? lexicalEntries(dict, analysis) : { entries: [], headword: analysis.lemma };
    // Commonness is a learning hint, not a filter on the meanings of a word.
    const [noun, verb] = analysis.parts || [];
    const extendedKey = noun?.pos === "名詞" && noun.posDetail?.[0] === "サ変接続" && verb?.lemma === "する" && analysis.lemma === noun.lemma + "する"
      ? noun.lemma : analysis.lemma;
    const extended = await extendedDictionary(extendedKey).catch(() => null);
    if (extended) {
      const complete = lexicalEntries(extended, analysis);
      if (complete.entries.length) { dict = extended; lexical = complete; }
    }
    const records = lexical.entries;
    const chosen = records;
    const entries = chosen.flatMap((record) => record.s.map((sense, index) => ({
      pos: sense.p.map((tag) => dict.tags[tag] || tag).join(" / "),
      posLabel: [...new Set(sense.p.map((tag) => /^v/.test(tag) ? (tag === "vi" ? "自动词" : tag === "vt" ? "他动词" : "动词") :
        /^adj/.test(tag) ? "形容词" : /^n(?:-|$)/.test(tag) ? "名词" : tag === "adv" ? "副词" : tag === "prt" ? "助词" : tag === "exp" ? "固定表达" : dict.tags[tag] || tag))].join(" / "),
      entryId: record.id,
      senseId: `${record.id}:${index}`,
      reading: record.r.map((reading) => lmJapanese.toHiragana(reading.t)).join(" / "),
      items: [{ definition: sense.g.join("; "), usage: (sense.i || []).join("; "), example: "", synonyms: [] }]
    })));
    // The dictionary is authoritative for lexical meanings. Online text is
    // labelled separately and never treated as a structured dictionary entry.
    const definitions = entries.map((entry) => entry.items[0].definition);
    const [translated, glosses] = await Promise.all([
      definitions.length ? Promise.resolve({ text: "" }) : bounded(translateText(analysis.surface, "ja", to), { text: "" }),
      /^en(?:-|$)/i.test(to) ? Promise.resolve(definitions) : staged ? Promise.resolve([]) : bounded(translateLines(definitions.slice(0, 6), "en", to), [])
    ]);
    entries.forEach((entry, index) => { entry.items[0].gloss = glosses[index] || ""; });
    if (chosen.length === 1) analysis.entryId = String(chosen[0].id);
    if (!analysis.baseReading && chosen.length === 1 && chosen[0].r.length === 1) {
      analysis.baseReading = lmJapanese.toHiragana(chosen[0].r[0].t) + (lexical.headword !== analysis.lemma ? "する" : "");
    }
    analysis.termKey = lmJapanese.termKey(analysis);
    analysis.grammarNotes = grammarNotes(analysis);
    const dictionaryTranslation = glosses[0] || definitions[0] || "";
    return {
      word: surface, translation: dictionaryTranslation || translated.text || "", phonetic: analysis.baseReading || analysis.reading,
      senses: [], entries, japanese: analysis, context: context || "",
      dictionarySource: dict ? "JMdict / EDRDG" : "", dictionaryUrl: "https://www.edrdg.org/jmdict/j_jmdict.html",
      dictionaryDate: dict ? dict.date : "", dictionaryAvailable: Boolean(dict),
      dictionaryHeadword: lexical.headword,
      dictionaryMatched: records.length > 0, dictionaryAlternatives: Math.max(0, records.length - chosen.length),
      translationSource: definitions.length ? (/^en(?:-|$)/i.test(to) || !staged && !glosses[0] ? "词典原始英文释义" : "词典释义的机器翻译") : translated.text ? "在线翻译" : "",
      lookupNotice: !dict ? (translated.text ? "本地词典暂时无法载入；目前仅显示在线译文，可刷新页面后重试。" : "本地词典暂时无法载入，在线翻译也未返回结果，请刷新页面后重试。") : records.length ?
        (lexical.headword !== analysis.lemma ? `「${analysis.lemma}」参考「${lexical.headword}」的する用法。` : "") + "词典义项不等于本句含义。可对照原句译文，选择本句义项收藏；更多义项展开后翻译。" :
        translated.text ? "未找到匹配词条；当前仅有机器译文，不代表它是正确的日语词。自动字幕可能识别错字或漏词，请结合整句核对，必要时校正原文。" : "未找到匹配词条，在线翻译暂不可用。请核对原字幕是否识别有误，也可划选完整词组查询。"
    };
  }

  globalThis.lmJapaneseService = { analyze, lookup, matchingEntries };
})();
