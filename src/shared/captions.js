(() => {
  // All cue times returned by this parser are milliseconds, regardless of source.
  const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  function number(value) {
    if (typeof value !== "number" && typeof value !== "string") return NaN;
    if (typeof value === "string" && !value.trim()) return NaN;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : NaN;
  }

  function clock(value, rates = {}) {
    if (typeof value !== "string") return NaN;
    const raw = value.trim();
    const offset = raw.match(/^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/);
    if (offset) {
      const factors = { h: 3600000, m: 60000, s: 1000, ms: 1, f: 1000 / rates.frameRate, t: 1000 / rates.tickRate };
      const result = Number(offset[1]) * factors[offset[2]];
      return Number.isFinite(result) ? result : NaN;
    }
    const match = raw.match(/^(?:(\d+):)?(\d{2}):(\d{2})(?:[.,](\d+))?$/);
    if (match) {
      const hours = Number(match[1] || 0);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      if (minutes >= 60 || seconds >= 60) return NaN;
      return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(`0.${match[4] || 0}`) * 1000;
    }
    const frames = raw.match(/^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/);
    if (!frames || !Number.isFinite(rates.frameRate)) return NaN;
    const minutes = Number(frames[2]);
    const seconds = Number(frames[3]);
    const frame = Number(frames[4]);
    if (minutes >= 60 || seconds >= 60 || frame >= rates.frameRate) return NaN;
    const subframe = Number(frames[5] || 0);
    if (subframe >= rates.subFrameRate) return NaN;
    return ((Number(frames[1]) * 60 + minutes) * 60 + seconds + (frame + subframe / rates.subFrameRate) / rates.frameRate) * 1000;
  }

  function normalize(cues) {
    return cues.filter((cue) => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function elements(root, name) {
    const found = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 1 && (!name || node.localName === name)) found.push(node);
      Array.from(node.childNodes || []).forEach(walk);
    };
    walk(root);
    return found;
  }

  function attr(node, name) {
    return Array.from(node.attributes || []).find((item) => item.localName === name)?.value ?? null;
  }

  function xmlText(node) {
    if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || "";
    if (node.localName === "br") return " ";
    return Array.from(node.childNodes || []).map(xmlText).join("");
  }

  function parseXml(text) {
    if (typeof DOMParser === "undefined") return { lang: "", cues: [] };
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const root = doc.documentElement;
    if (!root || elements(doc, "parsererror").length) return { lang: "", cues: [] };
    const language = (node) => node.getAttribute("xml:lang") || node.getAttribute("lang") || "";
    let lang = language(root);
    const frameRate = number(attr(root, "frameRate") ?? 30);
    const multiplier = (attr(root, "frameRateMultiplier") || "1 1").trim().split(/\s+/).map(Number);
    const subFrameRate = number(attr(root, "subFrameRate") ?? 1);
    const effectiveFrameRate = multiplier.length === 2 && multiplier[0] > 0 && multiplier[1] > 0 ? frameRate * multiplier[0] / multiplier[1] : NaN;
    const tickRate = number(attr(root, "tickRate") ?? (attr(root, "frameRate") === null ? 1 : effectiveFrameRate * subFrameRate));
    const rates = { frameRate: effectiveFrameRate > 0 ? effectiveFrameRate : NaN, subFrameRate: subFrameRate > 0 ? subFrameRate : NaN, tickRate: tickRate > 0 ? tickRate : NaN };
    const cues = [];
    const walk = (node, parent) => {
      if (node.nodeType !== 1) return;
      let context = parent;
      if (["tt", "body", "div", "p"].includes(node.localName)) {
        const begin = node.getAttribute("begin");
        const end = node.getAttribute("end");
        const dur = node.getAttribute("dur");
        const start = parent.start + (begin === null ? 0 : clock(begin, rates));
        const explicitEnd = end === null ? Infinity : parent.start + clock(end, rates);
        const durationEnd = dur === null ? Infinity : start + clock(dur, rates);
        context = { start, end: Math.min(parent.end, explicitEnd, durationEnd) };
        if (!Number.isFinite(start) || Number.isNaN(context.end) || start < 0 || context.end <= start) return;
      }
      if (node.localName === "p") {
        if (!lang) {
          let ancestor = node;
          while (ancestor?.nodeType === 1 && !lang) { lang = language(ancestor); ancestor = ancestor.parentNode; }
        }
        cues.push({ start: context.start, end: context.end, text: cleanText(xmlText(node)) });
        return;
      }
      Array.from(node.childNodes || []).forEach((child) => walk(child, context));
    };
    walk(root, { start: 0, end: Infinity });
    return { lang, cues: normalize(cues) };
  }

  function decodeEntities(text) {
    const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "\u200e", rlm: "\u200f" };
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (whole, entity) => {
      if (entity[0] !== "#") return entities[entity.toLowerCase()] ?? whole;
      const value = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "\ufffd";
    });
  }

  function parseVtt(text) {
    const blocks = text.replace(/\r\n?/g, "\n").split(/\n[\t ]*\n/);
    const cues = [];
    let lang = "";
    for (const [index, block] of blocks.entries()) {
      const lines = block.split("\n");
      if (index === 0 && /^WEBVTT(?:[\t ]|$)/.test(lines[0])) {
        lang = lines.slice(1).map((line) => line.match(/^Language:\s*(\S+)\s*$/i)?.[1]).find(Boolean) || "";
        continue;
      }
      if (/^(NOTE|STYLE|REGION)(?:[\t ]|$)/.test(lines[0])) continue;
      const timingIndex = lines[0]?.includes("-->") ? 0 : 1;
      const match = lines[timingIndex]?.match(/^\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(?:[\t ]+.*)?$/);
      if (!match) continue;
      const start = clock(match[1]);
      const end = clock(match[2]);
      // Remove VTT markup before decoding so escaped literal brackets stay text.
      const content = lines.slice(timingIndex + 1).join(" ").replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "");
      cues.push({ start, end, text: cleanText(decodeEntities(content)) });
    }
    return { lang, cues: normalize(cues) };
  }

  function parseJson(text) {
    const data = JSON.parse(text);
    const list = data?.timedtext?.text ?? data?.cues ?? data?.subtitles ?? (Array.isArray(data) ? data : []);
    const cues = (Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object").map((item) => {
      const start = number(item.start ?? item.begin);
      const end = item.end != null ? number(item.end) : item.dur != null ? start + number(item.dur) : start + 1500;
      return { start, end, text: cleanText(item.content ?? item.text) };
    });
    return { lang: typeof data?.lang === "string" ? data.lang : "", cues: normalize(cues) };
  }

  globalThis.lmParseCaptionTrack = (value) => {
    const text = String(value ?? "").replace(/^\uFEFF/, "").trim();
    try {
      if (text.startsWith("<")) return parseXml(text);
      if (/^WEBVTT(?:[\t \r\n]|$)/.test(text)) return parseVtt(text);
      if (/^(?:\{|\[)/.test(text)) return parseJson(text);
    } catch (_) {
      // Malformed network responses must not break subtitle capture.
    }
    return { lang: "", cues: [] };
  };
})();
