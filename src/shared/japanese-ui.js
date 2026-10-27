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
      span.dataset.surface = surface;
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
    return { surface: text(data.surface) || text(data.word), lemma: text(data.lemma), reading: reading(data.reading), baseReading: reading(data.baseReading), pos: text(data.pos), conjugation: text(data.conjugation), entryId: text(data.entryId), common: data.common === "true" ? true : data.common === "false" ? false : null, grammar: data.grammar === "true", candidates, ambiguous: data.ambiguous === "true" };
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
    const candidates = Array.isArray(analysis.candidates) ? analysis.candidates.filter((item) => item && typeof item === "object") : [];
    const alternatives = candidates.length > 1 ? `<div class="lm-ja-candidates"><div class="lm-pos">可能的词条 / 活用</div><ul>${candidates.map((item) => `<li>${escape([text(item.lemma) || text(item.word), reading(item.baseReading) || reading(item.reading), display(item.pos), display(item.conjugation), text(item.interpretation)].filter(Boolean).join(" · "))}</li>`).join("")}</ul></div>` : "";
    const uncertain = analysis.ambiguous === true || analysis.conjugation?.ambiguous === true || candidates.length > 1;
    const note = uncertain ? '<p class="lm-ja-note">存在多个候选，请结合原句确认；当前结果未自动判定语境含义。</p>' : "";
    const grammar = Array.isArray(analysis.grammarNotes) ? analysis.grammarNotes.map((value) => `<p class="lm-ja-note">${escape(value)}</p>`).join("") : "";
    return rows.length || alternatives || grammar ? `<section class="lm-ja-analysis" lang="ja"><dl>${rows.join("")}</dl>${grammar}${alternatives}${note}</section>` : "";
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

  return { renderWords, cardHtml, selectionFrom, tokenFrom, textWithoutReading, identity, isKnown, display };
})();
