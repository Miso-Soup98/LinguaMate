// Shared presentation only. Dictionary analysis and disambiguation stay in the
// background; a missing reading must never be filled with a guessed reading.
var lmJapaneseUi = (() => {
  const modes = new Set(["all", "unknown", "hover", "off"]);
  const text = (value) => typeof value === "string" ? value : "";
  const escape = (value) => text(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const display = (value) => {
    if (Array.isArray(value)) return value.map(display).filter(Boolean).join(" · ");
    if (value && typeof value === "object") return [value.type, value.form, ...(Array.isArray(value.labels) ? value.labels : [])].map(display).filter(Boolean).join(" · ");
    return text(value) === "*" ? "" : text(value);
  };
  const normalized = (value) => text(value).normalize("NFKC").trim().toLowerCase();
  const reading = (value) => { const result = text(value).trim(); return result && result !== "*" ? result : ""; };
  const readingKey = (value) => normalized(value).replace(/[ァ-ヶ]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) - 0x60));

  function identity(token) {
    const base = `ja:${text(token?.lemma || token?.word || token?.surface).normalize("NFC").trim().toLowerCase()}`;
    const kana = readingKey(token?.baseReading || token?.reading);
    const entry = text(token?.entryId);
    return kana || entry ? `${base}|reading=${encodeURIComponent(kana)}|entry=${encodeURIComponent(entry)}` : base;
  }

  function isKnown(token, known) {
    const keys = [token.lemma, token.surface].filter(Boolean).map(normalized);
    if (typeof known === "function") return !!known(token);
    const has = (key) => known?.has ? known.has(key) : !!known?.[key];
    if (has(identity(token))) return true;
    const detailedPrefix = identity({ ...token, entryId: "" });
    if (detailedPrefix.includes("|reading=")) {
      const prefix = detailedPrefix.slice(0, detailedPrefix.lastIndexOf("|entry=")) + "|entry=";
      const targetEntry = text(token.entryId);
      if (Array.from(known?.keys ? known.keys() : Object.keys(known || {})).some((key) => String(key).startsWith(prefix) && has(key) && (!targetEntry || key === prefix))) return true;
    }
    return keys.some((key) => has(key) || has(`ja:${key}`));
  }

  function renderWords(target, tokens, options = {}) {
    const document = target.ownerDocument;
    const fragment = document.createDocumentFragment();
    const mode = modes.has(options.furigana) ? options.furigana : "unknown";
    const words = [];
    for (const source of Array.isArray(tokens) ? tokens : []) {
      const token = source && typeof source === "object" ? source : { surface: String(source || "") };
      const surface = text(token.surface) || text(token.text);
      if (!surface) continue;
      const wordlike = token.isWord !== false && token.isWordLike !== false && /[\p{L}\p{N}]/u.test(surface);
      if (!wordlike) { fragment.appendChild(document.createTextNode(surface)); continue; }
      const span = document.createElement("span");
      span.className = "lm-word word lm-ja-word";
      span.dataset.word = surface;
      if (token.audioReading) span.dataset.audioReading = "true";
      span.dataset.surface = surface;
      if (Number.isInteger(token.start)) span.dataset.start = String(token.start);
      span.dataset.lang = options.lang || "ja";
      span.dataset.lemma = text(token.lemma);
      span.dataset.reading = reading(token.reading);
      span.dataset.baseReading = reading(token.baseReading);
      span.dataset.pos = display(token.pos);
      span.dataset.conjugation = display(token.conjugation);
      span.dataset.entryId = text(token.entryId);
      span.dataset.common = token.common === true ? "true" : token.common === false ? "false" : "unknown";
      span.dataset.grammar = String(token.grammar === true);
      // Preserve candidates for an explicit lookup without putting ruby text
      // into the word or using a candidate as a confirmed dictionary entry.
      if (Array.isArray(token.candidates) && token.candidates.length) span.dataset.candidates = JSON.stringify(token.candidates);
      if (token.ambiguous === true || token.conjugation?.ambiguous === true) span.dataset.ambiguous = "true";
      span.dataset.furigana = mode;
      const known = isKnown({ ...token, surface }, options.known);
      span.classList.toggle("lm-known", known);
      const kana = span.dataset.reading;
      const showReading = mode !== "off" && /[\p{Script=Han}々〆ヵヶ]/u.test(surface) && kana && kana !== surface;
      if (showReading) {
        const ruby = document.createElement("ruby");
        ruby.className = "lm-ja-ruby";
        ruby.appendChild(document.createTextNode(surface));
        const rt = document.createElement("rt");
        rt.textContent = kana;
        rt.setAttribute("aria-hidden", "true");
        ruby.appendChild(rt);
        span.appendChild(ruby);
      } else span.textContent = surface;
      fragment.appendChild(span);
      words.push(span);
    }
    target.replaceChildren(fragment);
    return words;
  }

  function tokenFrom(element) {
    const data = element?.dataset || {};
    let candidates = [];
    try { const parsed = JSON.parse(data.candidates || "[]"); if (Array.isArray(parsed)) candidates = parsed; } catch (_) {}
    return { ...(data.audioReading === "true" ? { audioReading: true } : {}), ...(data.start !== undefined ? { start: Number(data.start) } : {}), surface: text(data.surface) || text(data.word), lemma: text(data.lemma), reading: reading(data.reading), baseReading: reading(data.baseReading), pos: text(data.pos), conjugation: text(data.conjugation), entryId: text(data.entryId), common: data.common === "true" ? true : data.common === "false" ? false : null, grammar: data.grammar === "true", candidates, ambiguous: data.ambiguous === "true" };
  }

  function bindGroup(card, group, selectedIndex, choose) {
    if (!group || group.isPhrase || !(group.parts?.length > 1)) return;
    const nav = card.ownerDocument.createElement("div");
    nav.className = "lm-group-parts";
    nav.setAttribute("role", "group");
    nav.setAttribute("aria-label", "整组与组成部分");
    function button(label, index, title) {
      const el = card.ownerDocument.createElement("button");
      el.type = "button";
      el.textContent = label;
      el.title = title;
      el.setAttribute("aria-pressed", String(index === selectedIndex));
      el.onclick = event => { event.stopPropagation(); if (index !== selectedIndex) choose(index); };
      nav.appendChild(el);
    }
    button("整组 · " + group.surface, -1, group.lemma);
    group.parts.forEach((part, index) => button(part.surface, index,
      [part.lemma, part.reading, part.pos].filter(Boolean).join(" · ")));
    card.querySelector(".lm-dict-head")?.after(nav);
  }

  function cardHtml(analysis) {
    if (!analysis || typeof analysis !== "object") return "";
    const rows = [];
    const add = (label, value) => { const safe = display(value); if (safe) rows.push(`<div class="lm-ja-detail"><dt>${label}</dt><dd>${escape(safe)}</dd></div>`); };
    add("字幕形式", analysis.surface);
    add("辞书形", analysis.lemma);
    add("假名", reading(analysis.reading));
    if (analysis.baseReading && analysis.baseReading !== analysis.reading) add("原形读音", reading(analysis.baseReading));
    add("词性", analysis.pos);
    add("活用", analysis.conjugation);
    for (const part of analysis.parts || []) {
      if (part.otherReadings?.length) add("「" + escape(part.surface) + "」的其他可能读音", part.otherReadings);
    }
    const candidates = Array.isArray(analysis.candidates) ? analysis.candidates.filter((item) => item && typeof item === "object") : [];
    const alternatives = candidates.length > 1 ? `<div class="lm-ja-candidates"><div class="lm-pos">可能的词条 / 活用</div><ul>${candidates.map((item) => `<li>${escape([text(item.lemma) || text(item.word), reading(item.baseReading) || reading(item.reading), display(item.pos), display(item.conjugation), text(item.interpretation)].filter(Boolean).join(" · "))}</li>`).join("")}</ul></div>` : "";
    const uncertain = analysis.ambiguous === true || analysis.conjugation?.ambiguous === true || candidates.length > 1;
    const note = uncertain ? '<p class="lm-ja-note">存在多个候选，请结合原句确认；当前结果未自动判定语境含义。</p>' : "";
    const grammar = Array.isArray(analysis.grammarNotes) ? analysis.grammarNotes.map((value) => `<p class="lm-ja-note">${escape(value)}</p>`).join("") : "";
    return rows.length || alternatives || grammar ? `<section class="lm-ja-analysis" lang="ja"><dl>${rows.join("")}</dl>${grammar}${alternatives}${note}</section>` : "";
  }

  function pronunciationHtml(analysis, data, hasCue) {
    const beats = typeof lmJapanese !== "undefined" ? lmJapanese.moras(data?.kana) : [];
    const pitch = Array.isArray(data?.pitch) ? data.pitch.filter(n => Number.isInteger(n) && n >= 0 && n <= beats.length) : [];
    const diagrams = pitch.map(number => {
      const high = beats.map((_, i) => number === 1 ? i === 0 : i > 0 && (number === 0 || i < number));
      const tail = number === 0;
      const heights = [...high, tail];
      const contour = [...beats, "＋助词"].map((beat, i) => {
        const transition = heights[i] === heights[i + 1] || i === beats.length ? "" : heights[i] ? " lm-pitch-drop" : " lm-pitch-rise";
        return `<span class="lm-pitch-beat ${heights[i] ? "lm-pitch-high" : "lm-pitch-low"}${transition}">${escape(beat)}</span>`;
      }).join("");
      return `<div class="lm-pitch-pattern"><b>[${number}]</b><span class="lm-pitch-contour" role="img" aria-label="${escape(beats.map((beat, i) => beat + (high[i] ? "高" : "低")).join("、") + (tail ? "，后接助词高" : "，后接助词低"))}">${contour}</span></div>`;
    }).join("");
    const source = data?.nativeRecording
      ? '<a target="_blank" rel="noopener noreferrer" href="https://github.com/tofugu/japanese-vocabulary-pronunciation-audio">Tofugu / WaniKani · CC BY-SA 4.0</a>'
      : "";
    const kana = data?.kana || analysis?.baseReading;
    return `<section class="lm-ja-pronunciation">
      <div class="lm-accents">
        <button type="button" data-accent="read">${source ? "真人录音" : "合成朗读"}${kana ? `<span class="lm-ipa" lang="ja">${escape(kana)}</span>` : ""}</button>
        ${hasCue ? '<button type="button" data-ja-original>回听视频原句</button>' : ""}
      </div>
      <div class="lm-ja-audio-status" role="status"></div>
      ${source ? `<div class="lm-ja-audio-credit">${source}</div>` : ""}
      ${diagrams ? `<div class="lm-pitch" title="数字表示在哪一拍后降调，0 表示后接助词也不降">
        <div>东京式辞书形重音 <a target="_blank" rel="noopener noreferrer" href="https://github.com/mifunetoshiro/kanjium">Kanjium</a></div>
        ${diagrams}
      </div>` : ""}
    </section>`;
  }

  let speechVersion = 0;
  let disposeSpeech;
  function stopPronunciation() {
    speechVersion++;
    disposeSpeech?.();
    disposeSpeech = null;
  }

  function bindPronunciation(container, { analysis, data, word, send, isCurrent, replay }) {
    const root = container.querySelector(".lm-ja-pronunciation");
    if (!root) return;
    const status = root.querySelector(".lm-ja-audio-status");
    root.querySelector("[data-ja-original]")?.addEventListener("click", () => {
      stopPronunciation();
      status.textContent = "";
      replay?.();
    });
    root.querySelector('[data-accent="read"]').addEventListener("click", async () => {
      stopPronunciation();
      const version = speechVersion;
      const active = () => version === speechVersion && root.isConnected && isCurrent();
      const spoken = data?.speechText || analysis?.baseReading || analysis?.lemma || word;
      async function play(clip) {
        if (!clip?.audio || !active()) return false;
        let url, player;
        try {
          const bytes = Uint8Array.from(atob(clip.audio), char => char.charCodeAt(0));
          url = URL.createObjectURL(new Blob([bytes], { type: clip.mime || "audio/mpeg" }));
          player = new Audio(url);
          const release = () => {
            URL.revokeObjectURL(url);
            if (disposeSpeech === stop) disposeSpeech = null;
          };
          const stop = () => { player.pause(); release(); };
          disposeSpeech = stop;
          player.onended = release;
          player.onerror = release;
          await player.play();
          return active();
        } catch (_) {
          if (url) URL.revokeObjectURL(url);
          return false;
        }
      }
      if (data?.nativeRecording) {
        status.textContent = "正在加载真人录音…";
        const clip = await send("LM_JA_RECORDING", { word: data.word, kana: data.kana });
        if (await play(clip)) { status.textContent = ""; return; }
        if (!active()) return;
      }
      status.textContent = "合成朗读";
      const engine = window.speechSynthesis;
      const voices = engine?.getVoices?.().filter(voice => /^ja(?:-|$)/i.test(voice.lang)) || [];
      const enhanced = voices.find(voice => /natural|neural|premium|enhanced/i.test(voice.name));
      function speak(voice, onError) {
        if (!active() || !voice) return false;
        try {
          const utterance = new SpeechSynthesisUtterance(spoken);
          utterance.lang = "ja-JP";
          utterance.voice = voice;
          utterance.rate = 0.95;
          utterance.onerror = () => { if (active()) onError(); };
          utterance.onend = () => { if (active()) disposeSpeech = null; };
          disposeSpeech = () => engine.cancel();
          engine.speak(utterance);
          return true;
        } catch (_) { return false; }
      }
      const failed = () => { status.textContent = "未能播放日语读音，请重试"; };
      async function synthesize() {
        const clip = await send("LM_PRONOUNCE", { text: spoken, tl: "ja" });
        if (await play(clip)) return;
        if (active() && !speak(voices.find(voice => voice !== enhanced), failed)) failed();
      }
      if (!speak(enhanced, synthesize)) await synthesize();
    });
  }

  function textWithoutReading(node) {
    if (!node) return "";
    if (["rt", "rp"].includes(node.localName)) return "";
    if (node.nodeType === 3) return node.textContent || "";
    return Array.from(node.childNodes || node.children || []).map(textWithoutReading).join("");
  }

  function selectionFrom(root, selection) {
    if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    let range;
    try { range = selection.getRangeAt(0); } catch (_) { return null; }
    if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const elementOf = (node) => node.nodeType === 1 ? node : node.parentElement;
    const start = elementOf(range.startContainer);
    const end = elementOf(range.endContainer);
    if (start?.closest("rt, rp") || end?.closest("rt, rp")) return null;
    const lineSelector = ".lm-line, .lm-cue-learning, .lm-cue-native, [data-lm-japanese-line]";
    const firstLine = start?.closest(lineSelector) || root;
    const lastLine = end?.closest(lineSelector) || root;
    if (firstLine !== lastLine) return null;
    let surface;
    try { surface = textWithoutReading(range.cloneContents()).replace(/\s+/g, " ").trim(); } catch (_) { return null; }
    if (!surface || surface.length > 200 || !/[\p{L}\p{N}]/u.test(surface)) return null;
    const selected = Array.from(firstLine.querySelectorAll(".lm-word")).filter((word) => {
      try { return range.intersectsNode(word); } catch (_) { return false; }
    });
    if (new Set(selected.map((word) => word.closest(lineSelector) || root)).size > 1) return null;
    const tokens = selected.map(tokenFrom);
    const fullWord = tokens.length === 1 && surface === tokens[0].surface;
    return { ...(fullWord ? tokens[0] : {}), text: surface, surface, tokens, isPhrase: !fullWord, lang: selected[0]?.dataset.lang || "ja" };
  }

  return { renderWords, bindGroup, cardHtml, pronunciationHtml, bindPronunciation, stopPronunciation, selectionFrom, tokenFrom, textWithoutReading, identity, isKnown, display };
})();
