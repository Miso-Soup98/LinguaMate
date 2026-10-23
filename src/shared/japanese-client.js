// Content-script bridge. Subtitle rendering is immediate; dictionary analysis
// arrives separately and never replaces a user's active hover or selection.
var lmJapaneseClient = (() => {
  const cache = new Map();
  const inflight = new Map();
  const targets = new WeakMap();
  const waiting = new Map();
  const visibleTargets = new WeakMap();
  const jobs = [];
  let activeJobs = 0;
  let observer;
  let flushTimer = 0;
  const isJapanese = (lang) => String(lang || "").toLowerCase().split(/[-_]/)[0] === "ja";

  function drain() {
    jobs.sort((left, right) => Number(right.priority) - Number(left.priority));
    while (activeJobs < 4 && jobs.length) {
      const job = jobs.shift();
      activeJobs += 1;
      Promise.resolve().then(() => lmSendMessage("LM_JA_ANALYZE", { text: job.input }, 30000)).then(job.resolve, job.reject).finally(() => { activeJobs -= 1; drain(); });
    }
  }

  function analyze(text, priority = true) {
    const input = String(text || "");
    if (!input) return Promise.resolve([]);
    if (cache.has(input)) return Promise.resolve(cache.get(input));
    if (inflight.has(input)) {
      if (priority) { const queued = jobs.find((job) => job.input === input); if (queued) queued.priority = true; }
      return inflight.get(input);
    }
    const request = new Promise((resolve, reject) => { jobs.push({ input, priority, resolve, reject }); drain(); }).then((response) => {
      if (!response?.ok || !Array.isArray(response.tokens)) throw new Error(response?.error || "日语分析暂不可用");
      const tokens = response.tokens;
      if (tokens.map((token) => token.surface || token.text || "").join("") !== input) throw new Error("日语分析结果不完整");
      cache.set(input, tokens);
      if (cache.size > 400) cache.delete(cache.keys().next().value);
      return tokens;
    }).finally(() => inflight.delete(input));
    inflight.set(input, request);
    return request;
  }

  function deferUntilVisible(target, entry, start) {
    if (typeof IntersectionObserver !== "function" || !target.matches(".lm-cue-learning, .lm-cue-native") || target.closest(".lm-cue.active") || cache.has(entry.input)) {
      start(true);
      return;
    }
    if (!observer) observer = new IntersectionObserver((changes) => {
      for (const change of changes) {
        const pending = visibleTargets.get(change.target);
        if (!pending) continue;
        if (change.target.isConnected === false) invalidate(change.target);
        else if (change.isIntersecting) pending(false);
      }
    }, { rootMargin: "250px" });
    const trigger = (priority = true) => {
      if (targets.get(target) !== entry) return;
      observer.unobserve(target);
      visibleTargets.delete(target);
      for (const event of ["pointerenter", "mouseenter", "focusin", "mouseup"]) target.removeEventListener(event, interactive);
      entry.cleanup = null;
      start(priority === true);
    };
    const interactive = () => trigger(true);
    entry.cleanup = () => {
      observer.unobserve(target); visibleTargets.delete(target);
      for (const event of ["pointerenter", "mouseenter", "focusin", "mouseup"]) target.removeEventListener(event, interactive);
    };
    visibleTargets.set(target, trigger);
    for (const event of ["pointerenter", "mouseenter", "focusin", "mouseup"]) target.addEventListener(event, interactive);
    observer.observe(target);
  }

  function persistent(analysis) {
    if (!analysis || typeof analysis !== "object" || !analysis.lemma) return undefined;
    const result = {};
    for (const key of ["lemma", "reading", "baseReading", "pos", "surface", "entryId"]) {
      if (typeof analysis[key] === "string" && analysis[key] && analysis[key] !== "*") result[key] = analysis[key];
    }
    const conjugation = lmJapaneseUi.display(analysis.conjugation);
    if (conjugation) result.conjugation = conjugation;
    return result;
  }

  function fallback(text) {
    try {
      return Array.from(new Intl.Segmenter("ja", { granularity: "word" }).segment(text)).map((part) => ({ surface: part.segment, isWordLike: part.isWordLike }));
    } catch (_) {
      return Array.from(text).map((surface) => ({ surface, isWordLike: /[\p{L}\p{N}]/u.test(surface) }));
    }
  }

  function applyMarkers(target, tokens, options) {
    const words = Array.from(target.querySelectorAll(".lm-word"));
    let index = 0;
    for (const token of tokens) {
      if (token.isWord === false || token.isWordLike === false || !/[\p{L}\p{N}]/u.test(token.surface || token.text || "")) continue;
      const word = words[index++];
      if (!word) continue;
      const saved = lmJapaneseUi.isKnown(token, options.saved);
      word.classList.toggle("lm-saved", saved);
      word.classList.toggle("lm-known", lmJapaneseUi.isKnown(token, options.known));
    }
    return words;
  }

  function busy(target) {
    if (target.querySelector(".lm-word:hover")) return true;
    const document = target.ownerDocument;
    if (Array.from(document.querySelectorAll?.(".lm-dict") || []).some((card) => !card.classList.contains("lm-hidden"))) return true;
    const selection = document.getSelection?.();
    return !!(selection && !selection.isCollapsed && (target.contains(selection.anchorNode) || target.contains(selection.focusNode)));
  }

  function queue(target, apply) {
    waiting.set(target, apply);
    if (flushTimer) return;
    flushTimer = setTimeout(function flush() {
      flushTimer = 0;
      for (const [element, finish] of waiting) {
        if (element.isConnected === false) waiting.delete(element);
        else if (!busy(element)) { waiting.delete(element); finish(); }
      }
      if (waiting.size) flushTimer = setTimeout(flush, 220);
    }, 220);
  }

  function render(target, text, options = {}) {
    const input = String(text || "");
    if (!isJapanese(options.lang || "ja")) { invalidate(target); return Promise.resolve([]); }
    const key = JSON.stringify([input, options.lang || "ja", options.furigana || "unknown"]);
    const previous = targets.get(target);
    if (previous?.key === key) {
      previous.options = options;
      applyMarkers(target, previous.tokens, options);
      return previous.promise;
    }
    invalidate(target);
    const entry = { key, input, options, tokens: cache.get(input) || fallback(input), promise: null };
    targets.set(target, entry);
    lmJapaneseUi.renderWords(target, entry.tokens, options);
    applyMarkers(target, entry.tokens, options);
    target.dataset.japaneseState = cache.has(input) ? "ready" : "pending";
    target.setAttribute("title", cache.has(input) ? "拖选相邻词可查询词组" : "正在载入日语词典；可继续查词");
    entry.promise = new Promise((resolve) => {
      entry.resolve = resolve;
      deferUntilVisible(target, entry, (priority) => {
        if (entry.started) return;
        entry.started = true;
        analyze(input, priority).then((tokens) => {
          if (targets.get(target) !== entry) return tokens;
          const finish = () => {
            if (targets.get(target) !== entry || target.isConnected === false) return;
            const alreadyRendered = entry.tokens === tokens;
            entry.tokens = tokens;
            if (!alreadyRendered) lmJapaneseUi.renderWords(target, tokens, entry.options);
            const words = applyMarkers(target, tokens, entry.options);
            target.dataset.japaneseState = "ready";
            target.setAttribute("title", "拖选相邻词可查询词组");
            try { entry.options.onAnalyzed?.(tokens, words); } catch (_) { /* a page callback cannot invalidate completed analysis */ }
          };
          if (busy(target)) queue(target, finish);
          else finish();
          return tokens;
        }).catch(() => {
          if (targets.get(target) === entry) {
            target.dataset.japaneseState = "unavailable";
            target.setAttribute("title", "日语词典暂不可用；保留原文查词，刷新页面后重试");
          }
          return entry.tokens;
        }).then(resolve);
      });
    });
    return entry.promise;
  }

  function invalidate(target) {
    const entry = targets.get(target);
    entry?.cleanup?.();
    entry?.resolve?.(entry.tokens);
    targets.delete(target); waiting.delete(target);
  }
  return { analyze, render, persistent, invalidate };
})();
