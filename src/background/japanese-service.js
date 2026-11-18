// Local morphology and dictionary data are loaded once, only when Japanese is used.
(() => {
  let tokenizerPromise;
  let dictionaryPromise;
  let compoundsPromise;
  const shards = new Map();
  const sentences = new Map();
  const baseReadings = new Map();
  const lexicalResults = new Map();
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

  function attachNounSuffix(base, suffix) {
    if (!base || base.end !== suffix.start || suffix.pos !== "名詞" || suffix.posDetail[0] !== "接尾") return null;
    if (suffix.lemma !== "用" && suffix.lemma !== "先") return null;
    const noun = base.pos === "名詞" && base.surface === base.lemma && base.isWordLike;
    const verbStem = suffix.lemma === "先" && base.pos === "動詞" &&
      base.parts.length === 1 && base.parts[0].form === "連用形";
    if (!noun && !verbStem) return null;
    // A stem contributes its surface (売り), not its verb lemma (売る).
    // The suffix may carry a copula: 交換用です has the headword 交換用.
    const surface = base.surface + suffix.surface;
    const combined = { ...suffix, surface, text: surface, lemma: base.surface + suffix.lemma,
      reading: base.reading && suffix.reading ? base.reading + suffix.reading : "",
      baseReading: base.reading && suffix.baseReading ? base.reading + suffix.baseReading : "",
      start: base.start, posDetail: ["一般"], parts: [...base.parts, ...suffix.parts],
      known: base.known && suffix.known, compound: true, nounSuffix: suffix.lemma };
    combined.termKey = lmJapanese.termKey(combined);
    return combined;
  }

  function joinCompounds(tokens, lexicon) {
    const output = [];
    const noun = (token) => token?.pos === "名詞" && /^[\p{Script=Han}々ヶヵ]+$/u.test(token.lemma);
    for (let i = 0; i < tokens.length; i += 1) {
      const first = tokens[i];
      let best = null;
      let form = first.lemma;
      if (lexicon && noun(first) && first.surface === first.lemma) {
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
      const unit = best ? best.token : first;
      const combined = !best && attachNounSuffix(output[output.length - 1], unit);
      if (combined) output[output.length - 1] = combined;
      else output.push(unit);
      if (best) i = best.end;
    }
    return output;
  }

  // The bundled IPADIC trie indexes all analyses of the exact spelling. Cache
  // immutable dictionary forms only; sentence-specific choices belong to tokens.
  const surfaceForms = new Map();
  function exactForms(analyzer, surface) {
    if (surfaceForms.has(surface)) return surfaceForms.get(surface);
    const dict = analyzer.token_info_dictionary;
    const id = analyzer.viterbi_builder.trie.lookup(surface);
    const forms = (dict.target_map[id] || []).map(wordId =>
      analyzer.formatter.formatEntry(wordId, 0, "KNOWN", dict.getFeatures(wordId).split(",")));
    return put(surfaceForms, surface, forms, 1500);
  }

  const stemFollowers = new Set(["抜く", "抜ける", "ぬく", "ぬける", "続ける", "つづける",
    "始める", "終える", "終わる", "直す", "切る", "きる", "尽くす", "出す", "合う"]);

  // Match a subject or object to explicitly marked arguments in JMdict,
  // not incidental words in examples or in an unrelated sense.
  function readingForArgument(dict, noun, particle, choices) {
    const keys = new Set();
    const sensesFor = token => matchingEntries(dict, token.basic_form, lmJapanese.baseReading(token)).flatMap(entry => entry.s);
    for (const sense of sensesFor(noun)) {
      if (!sense.p.includes("n")) continue;
      for (const gloss of sense.g) {
        const terms = [gloss.split(" (")[0], ...Array.from(gloss.matchAll(/\(([a-z -]+)\)/gi), m => m[1])];
        for (const term of terms) {
          const key = term.toLowerCase().trim();
          if (/^[a-z][a-z -]{2,30}$/.test(key) && !/^(something|anything|someone|person|thing|place|etc|abbr|esp)$/.test(key)) keys.add(key);
        }
      }
    }
    if (!keys.size) return null;
    const matches = [];
    for (const choice of choices) {
      if (!lmJapanese.baseReading(choice)) return null;
      const senses = sensesFor(choice);
      if (!senses.length) return null;
      const direct = particle === "を";
      const marker = direct ? /^to [a-z-]+ \((?:a |an |the )?([^()]+)\)$/i : /\(of ([^()]+)\)/i;
      const qualifiers = senses.filter(s => s.p.includes(direct ? "vt" : "vi")).flatMap(s => s.g)
        .map(gloss => marker.exec(gloss)?.[1]).filter(Boolean)
        .map(label => " " + label.toLowerCase().replace(/[^a-z]+/g, " ").trim() + " ");
      if (qualifiers.some(q => [...keys].some(k => q.includes(" " + k + " ")))) matches.push(choice);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  // Use the reading of a whole attested expression to choose among readings
  // for one of its tokens. The last verb can be inflected in the subtitle.
  function readingsInExpression(lexicon, tokens, index, choices) {
    if (!lexicon || choices.length < 2) return [];
    for (let size = Math.min(5, tokens.length); size >= 2; size--) {
      const supported = new Set();
      for (let start = Math.max(0, index - size + 1); start <= Math.min(index, tokens.length - size); start++) {
        const span = tokens.slice(start, start + size);
        if (span.some(t => !t.reading || t.pos === "記号")) continue;
        // A modifier can make an idiom literal, e.g. テレビの音を上げる.
        if (start === index && span[0].pos === "名詞" && tokens[start - 1]?.surface_form === "の") continue;
        const prefix = span.slice(0, -1).map(t => t.surface_form).join("");
        const last = span[size - 1];
        for (const choice of choices) {
          const final = index === start + size - 1 ? choice : last;
          const readings = lexicon[prefix + final.basic_form];
          if (!readings) continue;
          const pieces = span.map((original, i) => {
            const t = start + i === index ? choice : original;
            return i === size - 1 ? lmJapanese.baseReading(t) : indexKey(t.reading);
          });
          if (pieces.every(Boolean) && readings.some(r => indexKey(r) === pieces.join(""))) supported.add(choice);
        }
      }
      if (supported.size) return [...supported];
    }
    return [];
  }

  function compoundStems(analyzer, lexicon, forms, token, next) {
    const auxiliary = next?.pos === "助動詞" && /^(ます|たい)$/.test(next.basic_form);
    if (!auxiliary && next?.pos !== "動詞") return [];
    const stems = forms.filter(f => f.pos === "動詞" && f.conjugated_form === "連用形" && f.pos_detail_1 === "自立");
    if (!stems.length || auxiliary) return stems;
    const compound = token.surface_form + next.basic_form;
    const ending = lmJapanese.baseReading(next);
    const readings = new Set(exactForms(analyzer, compound).filter(f => f.pos === "動詞").map(f => indexKey(f.reading)));
    for (const r of lexicon?.[compound] || []) readings.add(indexKey(r));
    const attested = ending ? stems.filter(f => readings.has(indexKey(f.reading) + ending)) : [];
    if (attested.length) return attested;
    return stemFollowers.has(next.basic_form) && (token.pos === "動詞" || next.pos_detail_1 === "非自立") ? stems : [];
  }

  function resolveTokenReading(analyzer, dict, lexicon, tokens, index) {
    const token = tokens[index], next = tokens[index + 1];
    if (token.word_type !== "KNOWN" || !/^(名詞|動詞|形容詞)$/.test(token.pos) ||
        token.pos_detail_1 === "固有名詞" || !/\p{Script=Han}/u.test(token.surface_form)) return;
    const forms = exactForms(analyzer, token.surface_form);
    if (forms.length < 2) return;
    const stems = compoundStems(analyzer, lexicon, forms, token, next);
    const compatible = stems.length ? stems : forms.filter(f => f.pos === token.pos &&
      f.pos_detail_1 === token.pos_detail_1 && f.conjugated_form === token.conjugated_form &&
      (token.conjugated_form !== "連用タ接続" || !/^[てたでだ]/.test(next?.surface_form || "") ||
       /五段・[ガナバマ]行/.test(f.conjugated_type) === /五段・[ガナバマ]行/.test(token.conjugated_type)));
    const distinct = list => [...new Map(list.map(f => [f.basic_form + "|" + f.reading, f])).values()];
    let choices = distinct(compatible);
    // An attested expression can also disambiguate nominal uses across IPADIC
    // noun subclasses (生 in 生を受ける). Never borrow name-only readings.
    const commonNoun = !stems.length && token.pos === "名詞";
    const phraseForms = commonNoun ? distinct(forms.filter(f => f.pos === "名詞" &&
      f.pos_detail_1 !== "固有名詞" && f.basic_form === token.basic_form)) : choices;
    const supported = readingsInExpression(lexicon, tokens, index, phraseForms);
    if (supported.length) choices = supported;
    if (choices.length > 1 && dict && choices[0].pos === "動詞" &&
        tokens[index - 1]?.pos === "助詞" && /^[をが]$/.test(tokens[index - 1].surface_form) && tokens[index - 2]?.pos === "名詞") {
      const match = readingForArgument(dict, tokens[index - 2], tokens[index - 1].surface_form, choices);
      if (match) choices = [match];
    }
    const same = f => f.basic_form === token.basic_form && f.reading === token.reading && f.pos === token.pos;
    let choice = token;
    if (choices.length && !choices.some(same) && (supported.length || stems.length)) {
      const costs = analyzer.token_info_dictionary.dictionary;
      choice = choices.reduce((a, b) => costs.getShort(a.word_id + 4) <= costs.getShort(b.word_id + 4) ? a : b);
    } else if (choices.length === 1) {
      if (!same(choices[0])) choice = choices[0];
    }
    const resolved = choice === token ? token : { ...choice, word_position: token.word_position };
    if (commonNoun && supported.length && resolved.pos_detail_1 !== token.pos_detail_1) {
      resolved.pos_detail_1 = "一般";
      resolved.pos_detail_2 = resolved.pos_detail_3 = "*";
    }
    if (choices.length > 1) {
      resolved.otherReadings = [...new Set(choices.map(f => lmJapanese.toHiragana(f.reading)))]
        .filter(reading => reading !== lmJapanese.toHiragana(resolved.reading));
    }
    return resolved;
  }

  function applyContextualReadings(tokens, analyzer, dict, lexicon) {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const after = tokens[index + 1];
      if (token.surface_form !== "後") {
        tokens[index] = resolveTokenReading(analyzer, dict, lexicon, tokens, index) || token;
        continue;
      }
      const before = tokens[index - 1];
      // In a completed action followed by に／で, 「後」 means "afterward"
      // and is read あと. Limit this override to the explicit past auxiliary
      // pattern so other readings such as 後ほど／後ろ remain dictionary-led.
      const followsPastPredicate = before?.pos === "助動詞" && /^(?:た|だ)$/.test(before.basic_form || before.surface_form);
      const followedByPostposition = after?.pos === "助詞" && /^(?:に|で)$/.test(after.surface_form);
      if (followsPastPredicate && followedByPostposition) {
        token.reading = "アト";
        token.basic_reading = "アト";
      }
    }
    return tokens;
  }

  async function analyze(text) {
    if (typeof text !== "string" || text.length > 12000) throw new Error("invalid_japanese_text");
    if (!text) return [];
    if (sentences.has(text)) return sentences.get(text);
    const pending = (async () => {
      const [analyzer, dict, lexicon] = await Promise.all([tokenizer(), dictionary().catch(() => null), compounds().catch(() => null)]);
      const raw = applyContextualReadings(analyzer.tokenize(text), analyzer, dict, lexicon);
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

  function audioChoices(unit, analyzer) {
    const head = unit.parts?.[0];
    if (!head || unit.compound || unit.lemma !== head.lemma || !unit.reading?.startsWith(head.reading) ||
        !/\p{Script=Han}/u.test(head.surface)) return [unit];
    const choices = [unit];
    for (const form of exactForms(analyzer, head.surface)) {
      if (form.pos !== head.pos || form.basic_form !== head.lemma || form.conjugated_form !== (head.form || "*")) continue;
      if (form.pos_detail_1 === "固有名詞" && head.posDetail?.[0] !== "固有名詞") continue;
      const reading = lmJapanese.toHiragana(form.reading);
      const baseReading = lmJapanese.baseReading(form);
      if (!reading || !baseReading) continue;
      const whole = reading + unit.reading.slice(head.reading.length);
      if (choices.some(c => c.reading === whole)) continue;
      const changed = { ...unit, reading: whole, baseReading, audioReading: true,
        entryId: "", parts: [{ ...head, reading, baseReading }, ...unit.parts.slice(1)] };
      changed.termKey = lmJapanese.termKey(changed);
      choices.push(changed);
    }
    return choices;
  }

  const spokenKana = value => lmJapanese.toHiragana(value).replace(/[^ぁ-ゖー]/g, "").replace(/を/g, "お")
    .replace(/([おこごそぞとどのほぼぽもよろょ])う/g, "$1ー").replace(/([えけげせぜてでねへべぺめれ])い/g, "$1ー");

  async function audioReadings(text, heard) {
    if (typeof heard !== "string" || heard.length > 500 || typeof text !== "string" || text.length > 500) return null;
    if (/[^ぁ-ゖァ-ヶー\s]/u.test(heard)) return null;
    const kana = spokenKana(heard);
    if (kana.length < 3) return null;
    const [units, analyzer] = await Promise.all([analyze(text), tokenizer()]);
    // Accept a unique full-sentence path through dictionary pronunciations.
    // Unknown words, partial matches and ambiguous boundaries yield no change.
    let paths = new Map([[0, []]]);
    for (const unit of units) {
      const next = new Map();
      for (const candidate of audioChoices(unit, analyzer)) {
        let sound = candidate.reading || candidate.surface;
        if (candidate.pos === "助詞") sound = ({ "は":"わ", "へ":"え", "を":"お" })[candidate.surface] || sound;
        if (candidate.isWordLike && !/^[ぁ-ゖァ-ヶー]+$/u.test(sound)) return null;
        sound = spokenKana(sound);
        for (const [at, path] of paths) {
          if (!kana.startsWith(sound, at)) continue;
          const end = at + sound.length;
          next.set(end, next.has(end) || !path ? null : [...path, candidate]);
        }
      }
      paths = next;
      if (!paths.size) return null;
    }
    const tokens = paths.get(kana.length);
    return tokens?.some(t => t.audioReading) ? tokens : null;
  }

  async function resolveAnalysis(surface, context, hint) {
    const hintPhrase = hint && hint.isPhrase === true;
    const contextTokens = context && context.length <= 12000 ? await analyze(context) : [];
    if (Number.isInteger(hint?.partIndex) && typeof hint.groupSurface === "string") {
      let group = contextTokens.find(token => token.start === hint.groupStart && token.surface === hint.groupSurface);
      if (!group) group = (await analyze(hint.groupSurface)).find(token => token.surface === hint.groupSurface);
      if (group && hint.groupAudioReading) group = audioChoices(group, await tokenizer()).find(c => c.reading === hint.groupAudioReading) || group;
      const part = group?.parts?.[hint.partIndex];
      if (part && part.surface === surface) {
        return { ...part, text: surface, isWordLike: true, parts: [part], candidates: [],
          grammar: /^(助詞|助動詞)$/.test(part.pos), conjugation: { type: part.type, form: part.form, labels: [] } };
      }
    }
    const matches = contextTokens.filter((token) => token.isWordLike && token.surface === surface);
    let analysis = matches.find((token) => Number.isInteger(hint && hint.start) && token.start === hint.start);
    if (!analysis && hint && hint.baseReading) analysis = matches.find((token) => token.baseReading === hint.baseReading);
    if (!analysis && matches.length === 1) analysis = matches[0];
    if (analysis && hint?.audioReading) analysis = audioChoices(analysis, await tokenizer()).find(c => c.reading === hint.reading) || analysis;
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
    if (analysis.nounSuffix === "用") notes.push("接尾词「用（よう）」表示用途，如「交換用」指用来更换的。");
    if (analysis.nounSuffix === "先") notes.push("接尾词「先（さき）」可指动作涉及的对象或去处，如「売り先」指卖给谁。");
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
    const lexicalKey = JSON.stringify([analysis.lemma, analysis.baseReading, analysis.pos, analysis.posDetail]);
    const remembered = lexicalResults.get(lexicalKey);
    let dict = remembered?.dictionary || await dictionary().catch(() => null);
    let lexical = remembered?.lexical || (dict ? lexicalEntries(dict, analysis) : { entries: [], headword: analysis.lemma });
    if (!remembered) {
      // Commonness is a learning hint, not a filter on the meanings of a word.
      const [noun, verb] = analysis.parts || [];
      const extendedKey = noun?.pos === "名詞" && noun.posDetail?.[0] === "サ変接続" && verb?.lemma === "する" && analysis.lemma === noun.lemma + "する"
        ? noun.lemma : analysis.lemma;
      const extended = await extendedDictionary(extendedKey).catch(() => null);
      if (extended) {
        const complete = lexicalEntries(extended, analysis);
        if (complete.entries.length) { dict = extended; lexical = complete; }
      }
      // Retain only matched records, never an entire shard index. Returning to
      // a word after visiting other shards no longer decompresses it again.
      if (extended && dict && lexical.entries.length) put(lexicalResults, lexicalKey,
        { lexical, dictionary: { tags: dict.tags, date: dict.date } }, 300);
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
      /^en(?:-|$)/i.test(to) ? Promise.resolve(definitions) : staged ? Promise.resolve(definitions.map((definition) =>
        typeof cacheGet === "function" ? cacheGet(`t:en:${to}:${definition.replace(/\s+/g, " ").trim()}`)?.text || "" : "")) : bounded(translateLines(definitions.slice(0, 6), "en", to), [])
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
        analysis.nounSuffix ? "词典未单列这个复合词。可点选组成部分，或展开「词形与语法」查看接尾词的用法。" :
        translated.text ? "未找到匹配词条；当前仅有机器译文，不代表它是正确的日语词。自动字幕可能识别错字或漏词，请结合整句核对，必要时校正原文。" : "未找到匹配词条，在线翻译暂不可用。请核对原字幕是否识别有误，也可划选完整词组查询。"
    };
  }

  globalThis.lmJapaneseService = { analyze, lookup, matchingEntries, audioReadings };
})();
