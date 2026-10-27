(() => {
  if (window.__linguaMateYoutube) return;
  window.__linguaMateYoutube = true;

  const state = {
    settings: lmMergeSettings(),
    videoId: "",
    title: "",
    tracks: [],
    cues: [],
    nativeCues: [],
    index: -1,
    activeIndex: -1,
    lastTickMs: null,
    vocab: [],
    known: {},
    tab: "subs",
    peeking: false,
    holdTimer: null,
    lastAutoPause: -1,
    playerReady: false,
    status: "loading",
    statusText: "",
    loadGen: 0,
    dictToken: 0
  };
  let hoverWord = null;
  let hoverTimer = 0;
  let hideTimer = 0;
  let captionRetry = 0;
  const captionCache = new Map();
  let learnGeneration = 0;
  let translationQueue = [];
  let translationWorkers = 0;
  const translationJobs = new Map();
  let translationObserver;

  const ui = {};

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function send(type, payload = {}) {
    return lmSendMessage(type, payload);
  }

  function toast(text) {
    lmNotify(text);
  }

  function videoEl() {
    return document.querySelector("video.html5-main-video, ytd-player video, video");
  }

  function playerBox() {
    return document.querySelector(".html5-video-player") || videoEl()?.parentElement;
  }

  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return url.searchParams.get("v") || "";
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function requestPage(type, data = {}, timeout = 8000) {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, timeout);
      function onMessage(event) {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== "linguamate-page" || msg.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(msg.data);
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "linguamate-content", type, requestId, data }, "*");
    });
  }

  function tokenize(text, lang) {
    const value = String(text || "");
    if (!value) return [];
    try {
      const segmenter = new Intl.Segmenter(lang || "en", { granularity: "word" });
      return Array.from(segmenter.segment(value)).map((part) => ({
        text: part.segment,
        word: part.isWordLike
      }));
    } catch (err) {
      return value.split(/(\s+)/).map((part) => ({
        text: part,
        word: /\p{L}|\p{N}/u.test(part)
      }));
    }
  }

  function renderWords(target, text, lang, interactive = true) {
    if (lang === "ja" && interactive && typeof lmJapaneseClient !== "undefined") {
      target.dataset.lmJapaneseLine = "1";
      const rendering = lmJapaneseClient.render(target, text || "", {
        lang, furigana: state.settings.japaneseFurigana,
        known: japaneseKnown, saved: japaneseSaved,
        onAnalyzed: () => { syncWordMarkers(); if (hoverWord && !hoverWord.isConnected) hideDict(); }
      });
      if (hoverWord && !hoverWord.isConnected) hideDict();
      return rendering;
    }
    if (typeof lmJapaneseClient !== "undefined") lmJapaneseClient.invalidate?.(target);
    delete target.dataset.lmJapaneseLine;
    target.innerHTML = "";
    if (!interactive) {
      target.textContent = text || "";
      return;
    }
    const saved = new Set(state.vocab.filter((item) => item.lang === lang).map((item) => item.word.trim().toLowerCase()));
    for (const token of tokenize(text, lang)) {
      if (!token.word) {
        target.appendChild(document.createTextNode(token.text));
        continue;
      }
      const span = document.createElement("span");
      span.className = "lm-word";
      span.textContent = token.text;
      span.dataset.word = token.text;
      span.dataset.lang = lang || state.settings.learningLang;
      const key = `${lang}:${lmNormalizeWord(token.text)}`;
      if (state.known[key]) span.classList.add("lm-known");
      if (saved.has(token.text.toLowerCase())) span.classList.add("lm-saved");
      else if (state.settings.highlightRare && !lmIsCommonWord(token.text, lang)) {
        span.classList.add("lm-rare");
      }
      target.appendChild(span);
    }
  }

  function japaneseIdentity(analysis) {
    return typeof lmJapaneseUi !== "undefined" && lmJapaneseUi.identity
      ? lmJapaneseUi.identity(analysis)
      : `ja:${analysis?.lemma || analysis?.surface || ""}`;
  }

  function japaneseKnown(analysis) {
    return typeof lmJapaneseUi !== "undefined" ? lmJapaneseUi.isKnown(analysis, state.known) : !!state.known[japaneseIdentity(analysis)];
  }

  let japaneseSavedSource = null;
  let japaneseSavedSize = -1;
  let japaneseSavedKeys = new Set();
  function japaneseSaved(analysis) {
    if (japaneseSavedSource !== state.vocab || japaneseSavedSize !== state.vocab.length) {
      japaneseSavedSource = state.vocab;
      japaneseSavedSize = state.vocab.length;
      japaneseSavedKeys = new Set();
      for (const item of state.vocab) {
        if (item.lang !== "ja") continue;
        const key = japaneseIdentity({ ...item.japanese, lemma: item.japanese?.lemma || item.word, surface: item.word });
        japaneseSavedKeys.add(key);
        if (key.includes("|entry=")) japaneseSavedKeys.add(key.slice(0, key.lastIndexOf("|entry=")) + "|entry=");
      }
    }
    return typeof lmJapaneseUi !== "undefined" ? lmJapaneseUi.isKnown(analysis, japaneseSavedKeys) : japaneseSavedKeys.has(japaneseIdentity(analysis));
  }

  function analysisForWord(element) {
    return element?.dataset.lang === "ja" && typeof lmJapaneseUi !== "undefined" ? lmJapaneseUi.tokenFrom(element) : null;
  }

  function invalidateJapaneseLines(root) {
    if (!root || typeof lmJapaneseClient === "undefined") return;
    root.querySelectorAll(".lm-cue-learning, .lm-cue-native, .lm-line-learning, .lm-line-native").forEach((line) => lmJapaneseClient.invalidate(line));
  }

  function ensureUi() {
    if (ui.root) return;
    const root = document.createElement("div");
    root.id = "lm-root";
    root.innerHTML = `
      <div class="lm-toolbar" id="lm-toolbar">
        <button data-act="toggle" title="启用/关闭">语伴</button>
        <select id="lm-learning"></select>
        <select id="lm-native"></select>
        <button data-act="autoPause" title="逐句暂停">逐句</button>
        <button data-act="listen" title="听写模式">听写</button>
        <button data-act="native" title="母语字幕">译文</button>
        <button data-act="nativeWords" title="译文里的词能否查词">译词</button>
        <button data-act="panel" title="侧栏">侧栏</button>
      </div>
      <div class="lm-subs" id="lm-subs">
        <div class="lm-line lm-line-learning" id="lm-learning-line"></div>
        <div class="lm-line lm-line-native" id="lm-native-line"></div>
      </div>
      <div class="lm-dict lm-hidden" id="lm-dict"></div>
    `;
    ui.root = root;
    ui.toolbar = $("#lm-toolbar", root);
    ui.subs = $("#lm-subs", root);
    ui.learningLine = $("#lm-learning-line", root);
    ui.nativeLine = $("#lm-native-line", root);
    ui.dict = $("#lm-dict", root);
    ui.bridge = document.createElement("div");
    ui.bridge.id = "lm-dict-bridge";
    ui.bridge.className = "lm-hidden";
    ui.learningSelect = $("#lm-learning", root);
    ui.nativeSelect = $("#lm-native", root);

    LM_LANGUAGES.forEach((lang) => {
      const opt1 = new Option(lang.native, lang.code);
      const opt2 = new Option(lang.native, lang.code);
      ui.learningSelect.add(opt1);
      ui.nativeSelect.add(opt2);
    });

    ui.toolbar.addEventListener("click", onToolbarClick);
    ui.learningSelect.addEventListener("change", async () => {
      if (await persist({ learningLang: ui.learningSelect.value })) loadCaptions(true);
    });
    ui.nativeSelect.addEventListener("change", async () => {
      if (await persist({ nativeLang: ui.nativeSelect.value })) loadCaptions(true);
    });

    ui.subs.addEventListener("contextmenu", (ev) => {
      const word = ev.target.closest(".lm-word");
      if (!word) return;
      ev.preventDefault();
      saveWord(word.dataset.word, cueForWord(word)?.text, null, word.dataset.lang, analysisForWord(word));
    });

    const panel = document.createElement("section");
    panel.className = "lm-panel";
    panel.id = "lm-panel";
    panel.innerHTML = `
      <div class="lm-panel-tabs">
        <button data-tab="subs" class="active">字幕</button>
        <button data-tab="words">生词</button>
        <button data-tab="learn">学习</button>
      </div>
      <div class="lm-panel-body" id="lm-panel-body"></div>
      <div class="lm-mini-help">悬停查词 · 右键收藏 · A 上一句 · S 重播 · D 下一句</div>
    `;
    ui.panel = panel;
    ui.panelBody = $("#lm-panel-body", panel);
    panel.addEventListener("click", (ev) => {
      const action = ev.target.closest("[data-caption-action]");
      if (action) {
        ev.stopPropagation();
        if (action.dataset.captionAction === "show-native") { persist({ showNative: true }); return; }
        const index = Number(action.closest("[data-index]")?.dataset.index);
        if (action.dataset.captionAction === "edit") editCaption(index);
        if (action.dataset.captionAction === "translate") queueTranslation(index, true);
        return;
      }
      if (ev.target.closest(".lm-caption-editor, .lm-caption-original")) return;
      if (ev.target.closest(".lm-word")) return;
      const tab = ev.target.closest("[data-tab]");
      if (tab) {
        state.tab = tab.dataset.tab;
        renderPanel();
        return;
      }
      const cue = ev.target.closest("[data-seek]");
      if (cue) seekTo(Number(cue.dataset.seek), true);
    });
    panel.addEventListener("contextmenu", (ev) => {
      const word = ev.target.closest(".lm-word");
      if (!word) return;
      ev.preventDefault();
      rememberCue(word);
      saveWord(word.dataset.word, cueForWord(word)?.text, null, word.dataset.lang, analysisForWord(word));
    });
    ui.phraseQuery = document.createElement("button");
    ui.phraseQuery.type = "button";
    ui.phraseQuery.className = "lm-phrase-query";
    ui.phraseQuery.hidden = true;
    ui.phraseQuery.addEventListener("mousedown", (event) => event.preventDefault());
    ui.phraseQuery.addEventListener("click", () => {
      const selection = ui.phraseSelection;
      if (selection) showDict(selection.anchor, selection);
      ui.phraseQuery.hidden = true;
    });
    document.documentElement.appendChild(ui.phraseQuery);
  }

  function rememberCue(wordEl) {
    const index = wordEl.closest("[data-index]")?.dataset.index;
    if (index == null || !state.cues[index]) return;
    state.index = Number(index);
  }

  function cueForWord(wordEl) {
    const index = wordEl.closest("[data-index]")?.dataset.index;
    if (index != null && state.cues[index]) return state.cues[index];
    return state.cues[state.index];
  }

  function mountUi() {
    if (!currentVideoId()) {
      invalidateJapaneseLines(ui.panel);
      invalidateJapaneseLines(ui.root);
      ui.panel?.remove();
      ui.root?.remove();
      if (ui.phraseQuery) ui.phraseQuery.hidden = true;
      return;
    }
    ensureUi();
    const box = playerBox();
    if (box && ui.root.parentElement !== box) {
      box.style.position = box.style.position || "relative";
      box.appendChild(ui.root);
    }
    placePanel();
    syncToolbar();
    applyCaptionVisibility();
    watchCaptionButton();
  }

  function retryCaptions() {
    if (state.cues.length) return;
    clearTimeout(captionRetry);
    captionRetry = setTimeout(() => loadCaptions(true), 350);
  }

  function watchCaptionButton() {
    const button = document.querySelector(".ytp-subtitles-button");
    if (!button || button.dataset.lmWatch === "1") return;
    button.dataset.lmWatch = "1";
    new MutationObserver(() => retryCaptions()).observe(button, {
      attributes: true,
      attributeFilter: ["aria-pressed"]
    });
  }

  function recommendationColumn() {
    if (document.fullscreenElement) return null;
    const flexy = document.querySelector("ytd-watch-flexy:not([hidden])");
    const secondary = flexy?.querySelector("#secondary") || null;
    if (!secondary || !secondary.isConnected) return null;
    const style = getComputedStyle(secondary);
    if (style.display === "none" || style.visibility === "hidden") return null;
    const box = secondary.getBoundingClientRect();
    if (box.width < 180 || box.height < 80) return null;
    return secondary;
  }

  function embedInColumn(secondary) {
    ui.panel.classList.remove("lm-docked");
    ui.panel.classList.add("lm-in-column");
    ui.panel.style.top = "";
    ui.panel.style.right = "";
    ui.panel.style.left = "";
    ui.panel.style.width = "";
    if (!secondary.contains(ui.panel)) secondary.prepend(ui.panel);
  }

  function coversRecommendations() {
    const secondary = document.getElementById("secondary");
    if (!secondary || !ui.panel.classList.contains("lm-docked")) return false;
    const column = secondary.getBoundingClientRect();
    const panel = ui.panel.getBoundingClientRect();
    if (column.width < 40 || column.height < 40) return false;
    const overlapX = Math.min(panel.right, column.right) - Math.max(panel.left, column.left);
    const overlapY = Math.min(panel.bottom, column.bottom) - Math.max(panel.top, column.top);
    return overlapX > 24 && overlapY > 24;
  }

  function placePanel() {
    if (!ui.panel) return;
    ui.root?.classList.remove("lm-floating-panel");
    if (!state.settings.panelOpen || !currentVideoId()) {
      if (ui.panel.isConnected) invalidateJapaneseLines(ui.panel);
      ui.panel.remove();
      return;
    }
    const secondary = recommendationColumn() || (coversRecommendations() ? document.querySelector("ytd-watch-flexy:not([hidden]) #secondary") : null);
    if (secondary) {
      embedInColumn(secondary);
      return;
    }
    ui.panel.classList.remove("lm-in-column", "lm-hidden");
    ui.panel.classList.add("lm-docked");
    const parent = document.fullscreenElement || document.documentElement;
    if (!ui.panel.isConnected || ui.panel.parentElement !== parent) parent.appendChild(ui.panel);
  }

  function syncToolbar() {
    if (!ui.toolbar) return;
    const map = {
      toggle: state.settings.enabled,
      autoPause: state.settings.autoPause,
      listen: state.settings.listenMode,
      native: state.settings.showNative,
      nativeWords: state.settings.nativeInteractive,
      panel: state.settings.panelOpen
    };
    ui.toolbar.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.classList.toggle("active", !!map[btn.dataset.act]);
      if (btn.dataset.act === "native") {
        btn.textContent = state.settings.showNative ? "译文：开" : "译文：关";
        btn.title = state.settings.showNative ? "隐藏全部译文" : "显示全部译文";
        btn.setAttribute("aria-pressed", String(state.settings.showNative));
      }
    });
    ui.learningSelect.value = state.settings.learningLang;
    ui.nativeSelect.value = state.settings.nativeLang;
    ui.subs.classList.toggle("lm-listen", state.settings.listenMode);
    ui.learningLine.style.fontSize = `${state.settings.fontSize}px`;
    ui.nativeLine.style.fontSize = `${Math.max(14, state.settings.fontSize - 4)}px`;
    ui.root.classList.toggle("lm-hidden", !state.settings.enabled);
    if (!state.settings.enabled && ui.phraseQuery) ui.phraseQuery.hidden = true;
    if (ui.panel) ui.panel.classList.toggle("lm-hidden", !state.settings.enabled || !state.settings.panelOpen);
    const video = videoEl();
    if (video && ui.clockVideo !== video) {
      ui.clockVideo?.removeEventListener("seeking", resetPlaybackClock);
      ui.clockVideo?.removeEventListener("seeked", resetPlaybackClock);
      ui.clockVideo?.removeEventListener("timeupdate", onTick);
      ui.clockVideo?.removeEventListener("seeked", onTick);
      video.addEventListener("seeking", resetPlaybackClock);
      video.addEventListener("seeked", resetPlaybackClock);
      video.addEventListener("timeupdate", onTick);
      video.addEventListener("seeked", onTick);
      ui.clockVideo = video;
    }
    if (video && state.settings.enabled && (ui.rateVideo !== video || ui.appliedRate !== state.settings.playbackRate)) {
      video.playbackRate = Number(state.settings.playbackRate) || 1;
      ui.rateVideo = video;
      ui.appliedRate = state.settings.playbackRate;
    }
  }

  function applyCaptionVisibility() {
    document.documentElement.classList.toggle(
      "lm-hide-yt-captions",
      !!(state.settings.enabled && state.settings.hideYoutubeCaptions)
    );
  }

  async function persist(patch) {
    if (ui.settingsBusy) return false;
    ui.settingsBusy = true;
    ui.toolbar.querySelectorAll("button, select").forEach((control) => { control.disabled = true; });
    lmNotify("正在保存设置…", "pending");
    const result = await send("LM_SET_SETTINGS", { settings: patch });
    ui.settingsBusy = false;
    ui.toolbar.querySelectorAll("button, select").forEach((control) => { control.disabled = false; });
    if (!result.ok) {
      syncToolbar();
      lmNotify(result.error || "设置保存失败，请重试", "error");
      return false;
    }
    state.settings = lmMergeSettings(result.settings || { ...state.settings, ...patch });
    if (patch.showNative === false) state.cues.forEach((cue) => { cue.translationRevealed = false; });
    syncToolbar();
    placePanel();
    applyCaptionVisibility();
    renderCurrent();
    if (state.tab === "subs") renderTranscript();
    lmNotify("设置已保存");
    return true;
  }

  async function onToolbarClick(ev) {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "toggle") await persist({ enabled: !state.settings.enabled });
    if (act === "autoPause") await persist({ autoPause: !state.settings.autoPause });
    if (act === "listen") await persist({ listenMode: !state.settings.listenMode });
    if (act === "native") await persist({ showNative: !state.settings.showNative });
    if (act === "nativeWords") await persist({ nativeInteractive: !state.settings.nativeInteractive });
    if (act === "panel") await persist({ panelOpen: !state.settings.panelOpen });
  }

  function parseEvents(data, options = {}) {
    const events = (data && data.events) || [];
    const rows = [];
    for (const event of events) {
      if (!event.segs) continue;
      const text = event.segs
        .map((seg) => seg.utf8 || "")
        .join("")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text === "\n") continue;
      const start = Number(event.tStartMs ?? 0);
      const duration = Number(event.dDurationMs ?? 1500);
      if (Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration > 0) rows.push({ start, end: start + duration, text });
    }
    return mergeCues(rows, options);
  }

  function japaneseCaptionText(text) {
    // ASR word separators are not Japanese word boundaries. Keep Latin word
    // spaces (New York), but join 気 象, 見て いきます and 31 号 before analysis.
    return String(text).replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々。、！？])\s+|\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}々。、！？])/gu, "");
  }

  function mergeCues(rows, options = {}) {
    // Display boundaries are the platform's timestamps, not sentence length.
    // Joining several ASR events used to hold the same caption for 8–12 seconds.
    const out = rows.map((original) => {
      const row = { ...original };
      if (options.japanese && options.asr) row.text = japaneseCaptionText(row.text);
      return row;
    }).sort((a, b) => a.start - b.start);
    // ASR durations include the rolling display window. A new cue replaces
    // that window; otherwise an older cue masks the current speech.
    if (options.asr) {
      for (let i = 0; i < out.length - 1; i += 1) {
        if (out[i + 1].start > out[i].start) out[i].end = Math.min(out[i].end, out[i + 1].start);
      }
    }
    return out;
  }

  function cleanCaption(value) {
    return String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseXml(xml, options = {}) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) return [];
    if (doc.documentElement.localName === "tt") return lmParseCaptionTrack(xml).cues;
    const rows = [];
    Array.from(doc.getElementsByTagName("text")).forEach((node) => {
      const start = parseFloat(node.getAttribute("start") || "0") * 1000;
      const dur = parseFloat(node.getAttribute("dur") || "1.5") * 1000;
      const text = cleanCaption(node.textContent);
      if (text && Number.isFinite(start) && start >= 0 && Number.isFinite(dur) && dur > 0) rows.push({ start, end: start + dur, text });
    });
    Array.from(doc.getElementsByTagName("p")).forEach((node) => {
      const start = parseFloat(node.getAttribute("t") || "0");
      const dur = parseFloat(node.getAttribute("d") || "1500");
      const text = cleanCaption(node.textContent);
      if (text && Number.isFinite(start) && start >= 0 && Number.isFinite(dur) && dur > 0) rows.push({ start, end: start + dur, text });
    });
    return mergeCues(rows, options);
  }

  function stampToMs(raw) {
    const parts = String(raw || "").trim().split(":");
    if (parts.length < 2) return 0;
    const seconds = parseFloat(parts.pop().replace(",", "."));
    const minutes = parseFloat(parts.pop());
    const hours = parts.length ? parseFloat(parts.pop()) : 0;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000;
  }

  function parseVtt(vtt) {
    const rows = [];
    vtt.replace(/\r/g, "").split(/\n\n+/).forEach((chunk) => {
      const lines = chunk.split("\n").filter(Boolean);
      const index = lines.findIndex((line) => line.includes("-->"));
      if (index < 0) return;
      const [startRaw, endRaw] = lines[index].split("-->");
      const text = cleanCaption(lines.slice(index + 1).join(" "));
      if (!text) return;
      const start = stampToMs(startRaw);
      const end = stampToMs(endRaw);
      rows.push({ start, end: end > start ? end : start + 1500, text });
    });
    return mergeCues(rows);
  }

  function parseCaptions(text, options = {}) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("WEBVTT")) return mergeCues(lmParseCaptionTrack(trimmed).cues, options);
    if (trimmed[0] === "<") return parseXml(trimmed, options);
    try {
      if (trimmed[0] === "{" || trimmed[0] === "[") return parseEvents(JSON.parse(trimmed), options);
    } catch (err) {
      return [];
    }
    return [];
  }

  async function fetchTrack(track, videoId, tlang) {
    if (!track || !track.baseUrl) return [];
    const result = await requestPage(
      "LM_FETCH_TRACK",
      {
        videoId,
        baseUrl: track.baseUrl,
        languageCode: track.languageCode,
        kind: track.kind || "",
        tlang: tlang || ""
      },
      14000
    );
    return parseCaptions(result && result.text, {
      japanese: /^ja(?:-|$)/i.test(tlang || track.languageCode), asr: track.kind === "asr"
    });
  }

  function pickTrack(tracks, lang, allowFallback) {
    const yt = lmYtCode(lang);
    const prefix = String(lang).split("-")[0];
    const matches = tracks.filter((track) => {
      const code = String(track.languageCode || "");
      return code === yt || code === lang || code.startsWith(prefix) || String(yt).startsWith(code);
    });
    const pool = matches.length ? matches : allowFallback ? tracks : [];
    return pool.find((track) => track.kind !== "asr") || pool[0] || null;
  }

  function cacheKey(videoId) {
    return `${videoId}|${state.settings.learningLang}|${state.settings.nativeLang}`;
  }

  function showReady() {
    state.status = "ready";
    state.statusText = "";
    renderPanel();
    renderCurrent();
  }

  async function loadCaptions(force) {
    if (!state.settings.enabled) return;
    const videoId = currentVideoId();
    if (!videoId) return;
    if (state.videoId !== videoId) {
      invalidateJapaneseLines(ui.panel);
      invalidateJapaneseLines(ui.root);
      hideDict();
    }
    const key = cacheKey(videoId);
    if (!force && videoId === state.videoId && state.cues.length) return;
    const gen = ++state.loadGen;
    for (const job of translationQueue) translationJobs.delete(job.key);
    translationQueue = [];
    translationObserver?.disconnect();
    const cached = captionCache.get(key);
    if (cached && !force) {
      state.videoId = videoId;
      state.title = document.title.replace(/ - YouTube$/, "");
      state.cues = cached.cues;
      state.nativeCues = cached.nativeCues;
      state.tracks = cached.tracks || [];
      state.learningTrack = cached.learningTrack;
      state.directTranslation = cached.directTranslation;
      state.nativeTrackLoading = false;
      showReady();
      return;
    }
    state.videoId = videoId;
    state.title = document.title.replace(/ - YouTube$/, "");
    if (!cached) {
      state.cues = [];
      state.nativeCues = [];
      state.index = -1;
      state.status = "loading";
      state.statusText = "";
      renderPanel();
    }

    const ping = await requestPage("LM_PING", {}, 700);
    if (gen !== state.loadGen) return;
    if (!ping) {
      state.status = "error";
      state.statusText = "字幕组件还没挂上。请在扩展管理页重新加载语伴，然后刷新这个 YouTube 页面。";
      renderPanel();
      return;
    }

    let info = null;
    let nudged = false;
    for (let i = 0; i < 30; i += 1) {
      info = await requestPage("LM_GET_TRACKS", {}, 700);
      if (gen !== state.loadGen) return;
      if (info && info.videoId === videoId && info.tracks && info.tracks.length) break;
      if (i === 4 && !nudged) {
        nudged = true;
        requestPage("LM_NUDGE_CC", { videoId }, 1800);
      }
      await sleep(80);
    }

    const tracks = (info && info.tracks) || [];
    state.tracks = tracks;
    if (!tracks.length) {
      state.status = "empty";
      state.statusText = "这个视频没有字幕轨道。请换一个带 CC 字幕的视频。";
      renderPanel();
      renderCurrent();
      return;
    }

    const learning = pickTrack(tracks, state.settings.learningLang, true) || tracks[0];
    const nativeExact = pickTrack(tracks, state.settings.nativeLang, false);
    state.learningTrack = learning;
    state.directTranslation = /^ja(?:-|$)/i.test(learning.languageCode);
    state.nativeTrackLoading = true;
    state.nativeCues = [];
    const learningCues = await fetchTrack(learning, videoId);
    if (gen !== state.loadGen) return;
    state.cues = learningCues;
    if (!state.cues.length) {
      state.status = "error";
      state.statusText = "已经找到字幕轨道，但还没有字幕正文。打开或关闭一次播放器的 CC，语伴会自动再读一次。";
      renderPanel();
      renderCurrent();
      return;
    }
    showReady();

    // One timed track provides translations for the whole video. Keep direct
    // translation for missing rows and explicit retries, rather than making
    // every short caption wait on a separate network request.
    const translated = nativeExact && nativeExact.baseUrl !== learning.baseUrl
      ? await fetchTrack(nativeExact, videoId)
      : await fetchTrack(learning, videoId, lmYtCode(state.settings.nativeLang));
    if (gen !== state.loadGen) return;
    state.nativeTrackLoading = false;
    installNativeTranslations(translated);
    captionCache.set(key, {
      cues: state.cues,
      nativeCues: state.nativeCues,
      tracks, learningTrack: learning, directTranslation: state.directTranslation
    });
    if (state.tab === "subs") renderTranscript();
    renderCurrent();
  }

  function alignCues(source, target) {
    if (!target.length) return [];
    return source.map((cue) => {
      const rows = target.filter((row) => row.start < cue.end && row.end > cue.start)
        .sort((a, b) => a.start - b.start);
      // Keep every overlapping translation. Do not invent a match across a
      // silent gap or assign the first subtitle in the video to missing rows.
      const texts = rows.map((row) => row.text).filter((text, index, all) => index === 0 || text !== all[index - 1]);
      return { start: cue.start, end: cue.end, text: texts.join(" ") };
    });
  }

  function installNativeTranslations(translated) {
    const aligned = alignCues(state.cues, translated);
    aligned.forEach((native, index) => {
      const cue = state.cues[index];
      // A late track must not undo a user's edited source or manual retranslation.
      if (native.text && !cue.translationRevealed && cue.originalText === undefined) {
        state.nativeCues[index] = { ...native, source: "视频字幕轨道" };
        cue.translationPending = false;
        cue.translationError = false;
        updateTranslationLine(index);
      }
    });
  }

  function translationVisible(cue) {
    return state.settings.showNative || cue?.translationRevealed === true;
  }

  function queueTranslation(index, force = false) {
    const cue = state.cues[index];
    if (!cue || !state.settings.enabled || (!force && (!state.settings.showNative || !state.directTranslation))) return;
    if (force) {
      // A direct request to translate must reveal its result even while the
      // user's global subtitle-translation preference is off.
      cue.translationRevealed = true;
      updateTranslationLine(index);
    }
    if (!force && state.nativeTrackLoading) return;
    if (!force && (state.nativeCues[index]?.text || cue.translationError)) return;
    const key = `${state.loadGen}|${index}|${cue.text}|${state.settings.nativeLang}`;
    if (translationJobs.has(key)) {
      const existing = translationJobs.get(key);
      if (force) existing.refresh = true;
      return;
    }
    const job = { key, index, cue, text: cue.text, gen: state.loadGen, refresh: force,
      from: state.learningTrack?.languageCode || state.settings.learningLang, to: state.settings.nativeLang };
    translationJobs.set(key, job);
    cue.translationPending = true;
    cue.translationError = false;
    if (force || index === state.activeIndex) translationQueue.unshift(job);
    else translationQueue.push(job);
    updateTranslationLine(index);
    drainTranslations();
  }

  async function drainTranslations() {
    if (translationWorkers >= 2 || !translationQueue.length) return;
    translationQueue.sort((a, b) => Number(b.refresh) - Number(a.refresh) ||
      Math.abs(a.index - state.activeIndex) - Math.abs(b.index - state.activeIndex));
    const job = translationQueue.shift();
    if (!state.settings.enabled || job.gen !== state.loadGen || state.cues[job.index] !== job.cue || job.text !== job.cue.text) {
      translationJobs.delete(job.key);
      drainTranslations();
      return;
    }
    if (!job.refresh && state.nativeCues[job.index]?.text) {
      job.cue.translationPending = false;
      translationJobs.delete(job.key);
      updateTranslationLine(job.index);
      drainTranslations();
      return;
    }
    translationWorkers += 1;
    const response = await send("LM_TRANSLATE", { text: job.text, from: job.from, to: job.to, refresh: job.refresh });
    translationWorkers -= 1;
    translationJobs.delete(job.key);
    if (state.settings.enabled && job.gen === state.loadGen && state.cues[job.index] === job.cue && job.text === job.cue.text && state.settings.nativeLang === job.to) {
      job.cue.translationPending = false;
      job.cue.translationError = (!response.ok || !response.result?.text) && (job.refresh || !state.nativeCues[job.index]?.text);
      if (response.ok && response.result?.text && (job.refresh || !state.nativeCues[job.index]?.text)) state.nativeCues[job.index] = {
        start: job.cue.start, end: job.cue.end, text: response.result.text, source: "整句机器翻译"
      };
      updateTranslationLine(job.index);
    }
    drainTranslations();
  }

  function updateTranslationLine(index) {
    const cue = state.cues[index];
    if (!cue) return;
    const native = state.nativeCues[index]?.text;
    const label = cue.translationPending ? "整句翻译中…" : cue.translationError ? "翻译失败，请点击重译" : state.nativeTrackLoading ? "正在读取译文…" : "";
    const row = ui.panelBody?.querySelector(`.lm-cue[data-index="${index}"]`);
    const retry = row?.querySelector('[data-caption-action="translate"]');
    if (retry) {
      retry.disabled = cue.translationPending === true;
      retry.textContent = cue.translationPending ? "翻译中…" : cue.translationError ? "重试翻译" : "整句重译";
      retry.title = cue.translationError ? "上次翻译失败，点击重试" : "翻译当前显示的完整原文";
    }
    const line = row?.querySelector(".lm-cue-native");
    if (line) {
      renderWords(line, native || label, state.settings.nativeLang, !!native && state.settings.nativeInteractive);
      line.hidden = !translationVisible(cue);
      line.setAttribute("aria-live", "polite");
    }
    if (state.activeIndex === index && ui.nativeLine) {
      renderWords(ui.nativeLine, native || label, state.settings.nativeLang, !!native && state.settings.nativeInteractive);
      ui.nativeLine.classList.toggle("lm-hidden", !translationVisible(cue) || !(native || label));
    }
  }

  function editCaption(index) {
    const cue = state.cues[index];
    const row = ui.panelBody?.querySelector(`.lm-cue[data-index="${index}"]`);
    if (!cue || !row || row.querySelector(".lm-caption-editor")) return;
    const form = document.createElement("form");
    form.className = "lm-caption-editor";
    form.innerHTML = '<label>校正日语原文<textarea maxlength="2000" aria-label="校正日语原文"></textarea></label><p>按听到的内容修改；保存后重新分词、注音和翻译。本页保留原字幕，可撤销。</p><button type="submit">应用并重译</button><button type="button" data-cancel>取消</button>';
    const input = form.querySelector("textarea");
    input.value = cue.text;
    form.querySelector("[data-cancel]").addEventListener("click", () => form.remove());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) { input.setCustomValidity("请输入字幕原文"); input.reportValidity(); return; }
      if (state.cues[index] !== cue) { form.remove(); return; }
      cue.originalText ??= cue.text;
      cue.text = text;
      cue.translationPending = false;
      cue.translationError = false;
      state.nativeCues[index] = null;
      hideDict();
      renderTranscript();
      renderCurrent();
      queueTranslation(index, true);
      toast("原文已更新，正在重新翻译");
    });
    input.addEventListener("input", () => input.setCustomValidity(""));
    row.append(form);
    input.focus();
  }

  function currentIndex(ms) {
    for (let i = state.cues.length - 1; i >= 0; i -= 1) {
      const cue = state.cues[i];
      if (ms >= cue.start && ms < cue.end) return i;
    }
    return -1;
  }

  function navigationIndex(ms) {
    let nearest = -1;
    for (let i = 0; i < state.cues.length; i += 1) {
      if (state.cues[i].start <= ms) nearest = i;
    }
    return nearest;
  }

  function renderCurrent() {
    if (!ui.learningLine) return;
    const video = videoEl();
    const idx = video ? currentIndex(video.currentTime * 1000) : -1;
    state.activeIndex = idx;
    state.index = idx >= 0 ? idx : video ? navigationIndex(video.currentTime * 1000) : -1;
    const cue = state.cues[idx];
    const native = state.nativeCues[idx];
    ui.learningLine.classList.toggle("lm-hidden", !state.settings.showLearning || !cue);
    ui.nativeLine.classList.toggle("lm-hidden", !translationVisible(cue) || !native);
    if (cue) renderWords(ui.learningLine, cue.text, state.settings.learningLang);
    if (native) renderWords(ui.nativeLine, native.text, state.settings.nativeLang, state.settings.nativeInteractive);
    if (idx >= 0) {
      for (let i = idx; i < Math.min(state.cues.length, idx + 4); i += 1) queueTranslation(i);
      updateTranslationLine(idx);
    }
    if (state.tab === "subs") highlightTranscript(idx);
  }

  function highlightTranscript(idx) {
    if (!ui.panelBody) return;
    ui.panelBody.querySelectorAll(".lm-cue").forEach((el, i) => {
      el.classList.toggle("active", i === idx);
    });
    const active = ui.panelBody.querySelector(".lm-cue.active");
    if (active && state.settings.autoPause === false) {
      const box = ui.panelBody.getBoundingClientRect();
      const row = active.getBoundingClientRect();
      if (row.top < box.top || row.bottom > box.bottom) {
        active.scrollIntoView({ block: "center" });
      }
    }
  }

  function renderPanel() {
    if (!ui.panel) return;
    if (state.tab !== "subs") translationObserver?.disconnect();
    ui.panel.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === state.tab);
    });
    if (state.tab === "subs") renderTranscript();
    if (state.tab === "words") renderWordsTab();
    if (state.tab === "learn") renderLearnTab();
  }

  function renderTranscript() {
    invalidateJapaneseLines(ui.panelBody);
    translationObserver?.disconnect();
    if (state.status === "loading" || state.status === "fetching") {
      ui.panelBody.innerHTML = `<div class="lm-empty">正在读取字幕…</div>`;
      return;
    }
    if (!state.cues.length) {
      ui.panelBody.innerHTML = `<div class="lm-empty">${escapeHtml(state.statusText || "当前视频没有可用字幕。")}</div><button class="lm-chip" id="lm-retry">重新读取字幕</button>`;
      ui.panelBody.querySelector("#lm-retry").addEventListener("click", () => loadCaptions(true));
      return;
    }
    const scroll = ui.panelBody.scrollTop;
    const fragment = document.createDocumentFragment();
    const japanese = /^ja(?:-|$)/i.test(state.learningTrack?.languageCode || state.settings.learningLang);
    if (japanese) {
      const notice = document.createElement("div");
      notice.className = "lm-caption-notice";
      notice.textContent = state.learningTrack?.kind === "asr"
        ? "日语自动字幕：可能有同音字、漏词和专名错误。查词异常时可校正原文，再整句重译。"
        : "日语字幕 · 可校正原文、查询词组或整句重译。";
      if (!state.settings.showNative) {
        const show = document.createElement("button");
        show.type = "button";
        show.dataset.captionAction = "show-native";
        show.textContent = "显示全部译文";
        notice.append(document.createTextNode(" 当前译文已关闭。"), show);
      }
      fragment.append(notice);
    }
    state.cues.forEach((cue, i) => {
      const row = document.createElement("div");
      row.className = `lm-cue${i === state.activeIndex ? " active" : ""}`;
      row.dataset.seek = String(cue.start);
      row.dataset.index = String(i);
      const time = document.createElement("div");
      time.className = "lm-cue-time";
      time.textContent = formatTime(cue.start);
      const learning = document.createElement("div");
      learning.className = "lm-cue-learning";
      renderWords(learning, cue.text, state.settings.learningLang);
      row.append(time, learning);
      const native = state.nativeCues[i]?.text || "";
      if (native || japanese) {
        const nativeLine = document.createElement("div");
        nativeLine.className = "lm-cue-native";
        renderWords(nativeLine, native || (cue.translationPending ? "整句翻译中…" : cue.translationError ? "翻译失败，请点击重译" : state.nativeTrackLoading ? "正在读取译文…" : ""), state.settings.nativeLang, !!native && state.settings.nativeInteractive);
        nativeLine.hidden = !translationVisible(cue);
        nativeLine.setAttribute("aria-live", "polite");
        row.append(nativeLine);
      }
      if (japanese) {
        const actions = document.createElement("div");
        actions.className = "lm-caption-actions";
        actions.innerHTML = '<button type="button" data-caption-action="edit">校正原文</button><button type="button" data-caption-action="translate">整句重译</button>';
        const retry = actions.querySelector('[data-caption-action="translate"]');
        retry.disabled = cue.translationPending === true;
        retry.textContent = cue.translationPending ? "翻译中…" : cue.translationError ? "重试翻译" : "整句重译";
        row.append(actions);
        if (cue.originalText !== undefined && cue.originalText !== cue.text) {
          const original = document.createElement("details");
          original.className = "lm-caption-original";
          const summary = document.createElement("summary");
          summary.textContent = "已校正 · 查看原字幕";
          const text = document.createElement("p");
          text.textContent = cue.originalText;
          const undo = document.createElement("button");
          undo.textContent = "恢复原字幕";
          undo.addEventListener("click", () => {
            cue.text = cue.originalText;
            delete cue.originalText;
            cue.translationError = false;
            cue.translationPending = false;
            state.nativeCues[i] = null;
            hideDict(); renderTranscript(); renderCurrent(); queueTranslation(i, true);
          });
          original.append(summary, text, undo);
          row.append(original);
        }
      }
      fragment.append(row);
    });
    ui.panelBody.replaceChildren(fragment);
    if (hoverWord && !hoverWord.isConnected) hideDict();
    ui.panelBody.scrollTop = scroll;
    if (state.directTranslation && state.settings.showNative) {
      translationObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) {
          queueTranslation(Number(entry.target.dataset.index));
          translationObserver.unobserve(entry.target);
        }
      }, { root: ui.panelBody, rootMargin: "150px" });
      ui.panelBody.querySelectorAll(".lm-cue").forEach((row) => translationObserver.observe(row));
    }
  }

  function langLabel(code) {
    const found = LM_LANGUAGES.find((item) => item.code === code);
    return found ? found.native : code || "其他";
  }

  function renderWordsTab() {
    invalidateJapaneseLines(ui.panelBody);
    const mine = state.vocab;
    if (!mine.length) {
      ui.panelBody.innerHTML = `<div class="lm-empty">还没有生词。点击字幕中的单词查阅，或右键直接收藏。</div>`;
      return;
    }
    const groups = new Map();
    mine.forEach((item) => {
      const key = item.lang || "und";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    ui.panelBody.innerHTML = Array.from(groups.entries())
      .map(([lang, items]) => {
        const rows = items
          .slice(0, 40)
          .map(
            (item) => `<div class="lm-vocab-item" data-id="${item.id}">
          <div><strong>${escapeHtml(item.word)}</strong><span>${escapeHtml(item.translation || "")}</span></div>
          <div><span>${escapeHtml(item.context || "")}</span></div>
        </div>`
          )
          .join("");
        return `<div class="lm-pos">${escapeHtml(langLabel(lang))} · ${items.length}</div>${rows}`;
      })
      .join("");
    ui.panelBody.querySelectorAll(".lm-vocab-item").forEach((el) => {
      el.addEventListener("click", () => {
        const item = state.vocab.find((row) => row.id === el.dataset.id);
        if (item) playPronunciation(item.lang === "ja" ? item.japanese?.baseReading || item.word : item.word, item.lang, state.settings.accent, "");
      });
      el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        const item = state.vocab.find((row) => row.id === el.dataset.id);
        if (item && item.videoUrl) {
          if (item.videoUrl.includes(state.videoId)) seekTo((item.time || 0) * 1000, true);
          else location.href = item.videoUrl;
        }
      });
    });
  }

  async function uniqueWords() {
    const map = new Map();
    if (state.settings.learningLang === "ja" && typeof lmJapaneseClient !== "undefined") {
      const cues = state.cues;
      for (let offset = 0; offset < cues.length; offset += 4) {
        const batch = cues.slice(offset, offset + 4);
        const analyses = await Promise.all(batch.map((cue) => lmJapaneseClient.analyze(cue.text)));
        if (state.cues !== cues || state.settings.learningLang !== "ja" || state.tab !== "learn") return [];
        analyses.forEach((tokens, index) => {
          const cue = batch[index];
          for (const token of tokens) {
            if (token.isWordLike === false || token.isWord === false || !/[\p{L}\p{N}]/u.test(token.surface || token.text || "")) continue;
            const word = token.lemma || token.surface || token.text;
            const key = japaneseIdentity(token);
            if (!map.has(key)) map.set(key, { key, word, count: 0, context: cue.text, time: cue.start, japanese: token });
            map.get(key).count += 1;
          }
        });
      }
      return Array.from(map.values()).sort((a, b) => b.count - a.count);
    }
    for (const cue of state.cues) {
      for (const token of tokenize(cue.text, state.settings.learningLang)) {
        if (!token.word) continue;
        const word = lmNormalizeWord(token.text);
        if (!word || word.length < 2) continue;
        if (!map.has(word)) map.set(word, { word, count: 0, context: cue.text, time: cue.start });
        map.get(word).count += 1;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }

  async function renderLearnTab() {
    invalidateJapaneseLines(ui.panelBody);
    const generation = ++learnGeneration;
    const lang = state.settings.learningLang;
    if (lang === "ja") ui.panelBody.innerHTML = '<div class="lm-empty" role="status">正在分析日语词形…</div>';
    let words;
    try { words = await uniqueWords(); }
    catch (_) {
      if (generation === learnGeneration && state.tab === "learn") {
        ui.panelBody.innerHTML = '<div class="lm-empty" role="alert">日语词形分析暂不可用，请重试。</div><button class="lm-chip" data-retry-analysis>重新分析</button>';
        ui.panelBody.querySelector("[data-retry-analysis]").addEventListener("click", renderLearnTab);
      }
      return;
    }
    if (generation !== learnGeneration || state.tab !== "learn" || state.settings.learningLang !== lang) return;
    const saved = new Set(state.vocab.map((item) => item.word.toLowerCase()));
    const knownCount = words.filter((item) => {
      if (lang === "ja") return japaneseKnown(item.japanese || { lemma: item.word });
      const key = `${state.settings.learningLang}:${item.word}`;
      return state.known[key] || lmIsCommonWord(item.word, state.settings.learningLang);
    }).length;
    const coverage = words.length ? Math.round((knownCount / words.length) * 100) : 0;
    const suggestions = words
      .filter((item) => lang === "ja"
        ? !japaneseSaved(item.japanese) && !japaneseKnown(item.japanese) && !item.japanese.grammar
        : !saved.has(item.word) && !state.known[`${lang}:${item.word}`] && !lmIsCommonWord(item.word, lang))
      .slice(0, 20);
    ui.panelBody.innerHTML = `
      <div class="lm-stat">
        <div><b>${coverage}%</b><span>词汇覆盖</span></div>
        <div><b>${words.length}</b><span>本集词种</span></div>
      </div>
      ${
        suggestions.length
          ? suggestions
              .map(
                (item, index) => `<div class="lm-learn-item">
                  <div><strong>${escapeHtml(item.word)}</strong><span>出现 ${item.count} 次</span></div>
                  <button class="lm-chip" data-save="${escapeHtml(item.word)}" data-suggestion="${index}" data-context="${escapeHtml(item.context)}">收藏</button>
                </div>`
              )
              .join("")
          : `<div class="lm-empty">没有明显的生词建议，或字幕尚未加载。</div>`
      }
    `;
    ui.panelBody.querySelectorAll("[data-save]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = suggestions[Number(btn.dataset.suggestion)];
        saveWord(btn.dataset.save, btn.dataset.context, null, lang, item?.japanese || null, item?.time);
      });
    });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function seekTo(ms, play) {
    const video = videoEl();
    if (!video) return;
    video.currentTime = Math.max(0, ms / 1000 + 0.01);
    state.lastTickMs = null;
    if (play) video.play().catch(() => {});
    else video.pause();
    renderCurrent();
  }

  function replayCurrent() {
    const cue = state.cues[state.index] || state.cues[currentIndex((videoEl()?.currentTime || 0) * 1000)];
    if (cue) seekTo(cue.start, true);
  }

  function jump(delta, pause) {
    const idx = Math.min(state.cues.length - 1, Math.max(0, state.index + delta));
    const cue = state.cues[idx];
    if (!cue) return;
    seekTo(cue.start, !pause);
    if (pause) videoEl()?.pause();
  }

  let currentAudio = null;

  function stopSpeech() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  function bytesFromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function voiceScore(voice) {
    const name = voice.name.toLowerCase();
    let score = 0;
    if (name.includes("google")) score += 6;
    if (name.includes("natural") || name.includes("neural") || name.includes("premium")) score += 8;
    if (name.includes("aria") || name.includes("jenny") || name.includes("libby") || name.includes("sonia")) score += 3;
    if (!voice.localService) score += 2;
    return score;
  }

  function speakNatural(text, lang) {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    const wanted = String(lang || "en-US").toLowerCase();
    const voices = window.speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith(wanted.slice(0, 5)));
    voices.sort((a, b) => voiceScore(b) - voiceScore(a));
    if (voices[0]) utter.voice = voices[0];
    utter.lang = lang || "en-US";
    utter.rate = 0.92;
    window.speechSynthesis.speak(utter);
  }

  function accentLang(lang, accent) {
    if (String(lang || "").toLowerCase().startsWith("en")) return accent === "uk" ? "en-GB" : "en-US";
    return lang || "en-US";
  }

  async function playPronunciation(word, lang, accent, audioUrl) {
    stopSpeech();
    const res = await send("LM_PRONOUNCE", {
      text: word,
      tl: accentLang(lang, accent),
      audioUrl: audioUrl || ""
    });
    if (res && res.audio) {
      const url = URL.createObjectURL(new Blob([bytesFromBase64(res.audio)], { type: res.mime || "audio/mpeg" }));
      currentAudio = new Audio(url);
      currentAudio.onended = () => URL.revokeObjectURL(url);
      try {
        await currentAudio.play();
        return;
      } catch (err) {
        URL.revokeObjectURL(url);
      }
    }
    speakNatural(word, accentLang(lang, accent));
  }

  function posLabel(pos) {
    const labels = {
      noun: "名词",
      verb: "动词",
      adjective: "形容词",
      adverb: "副词",
      pronoun: "代词",
      preposition: "介词",
      conjunction: "连词",
      interjection: "感叹词",
      determiner: "限定词",
      article: "冠词",
      numeral: "数词",
      "phrasal verb": "短语动词",
      idiom: "习语"
    };
    return labels[String(pos || "").toLowerCase()] || pos || "释义";
  }

  function renderDict(data, cue, from, sourceAnalysis = null) {
    const english = String(from || "").toLowerCase().startsWith("en");
    const japanese = from === "ja" ? data.japanese || sourceAnalysis : null;
    const savedWord = japanese?.lemma || data.word;
    const accent = state.settings.accent === "uk" ? "uk" : "us";
    const entries = data.entries || [];
    const entryHtml = entries.length
      ? entries
          .map((entry) => {
            const items = (entry.items || [])
              .map((item, index) => {
                const synonyms = (item.synonyms || []).filter(Boolean);
                return `<div class="lm-entry">
                  <div class="lm-gloss">${index + 1}. ${escapeHtml(item.gloss || item.definition || "暂无释义")}</div>
                  ${item.definition && item.gloss ? `<div class="lm-def">${escapeHtml(item.definition)}</div>` : ""}
                  ${item.example ? `<div class="lm-ex">例：${escapeHtml(item.example)}</div>` : ""}
                  ${synonyms.length ? `<div class="lm-syn">近义：${escapeHtml(synonyms.join("、"))}</div>` : ""}
                </div>`;
              })
              .join("");
            return `<div class="lm-pos">${escapeHtml(posLabel(entry.pos))} · ${escapeHtml(entry.pos || "")}</div>${items}`;
          })
          .join("")
      : `<div class="lm-dict-senses">${(data.senses || [])
          .map((sense) => `${escapeHtml(sense.pos)}：${escapeHtml((sense.words || []).join("、"))}`)
          .join("<br>") || escapeHtml(data.translation || "暂无释义")}</div>`;
    const accents = english
      ? `<div class="lm-accents">
          <button data-accent="us" class="${accent === "us" ? "active" : ""}">美式 US<span class="lm-ipa">${escapeHtml(data.phoneticUs || data.phonetic || "")}</span></button>
          <button data-accent="uk" class="${accent === "uk" ? "active" : ""}">英式 UK<span class="lm-ipa">${escapeHtml(data.phoneticUk || data.phonetic || "")}</span></button>
        </div>`
      : `<div class="lm-accents"><button data-accent="read">朗读<span class="lm-ipa">${escapeHtml(data.phonetic || "")}</span></button></div>`;
    ui.dict.innerHTML = `
      <div class="lm-dict-head">
        <div>
          <div class="lm-dict-word">${escapeHtml(data.word)}</div>
          <div class="lm-dict-trans">${escapeHtml(data.translation || "")}</div>
        </div>
        <div class="lm-dict-actions"><button data-known="1">${japanese && japaneseKnown(japanese) ? "已认识 · 点击取消" : "认识"}</button></div>
      </div>
      ${accents}
      ${japanese && typeof lmJapaneseUi !== "undefined" ? lmJapaneseUi.cardHtml(japanese) : ""}
      ${entryHtml}
      ${japanese && data.dictionarySource ? `<div class="lm-def">词典：${escapeHtml(data.dictionarySource)}${data.dictionaryDate ? ` · ${escapeHtml(data.dictionaryDate)}` : ""}</div>` : ""}
      ${japanese && data.translationSource ? `<div class="lm-def">译文来源：${escapeHtml(data.translationSource)}</div>` : ""}
      ${japanese && data.lookupNotice ? `<p class="lm-ja-note">${escapeHtml(data.lookupNotice)}</p>` : ""}
      <div class="lm-dict-context">${escapeHtml(cue?.text || "")}</div>
      <button class="lm-dict-save">加入生词本</button>
    `;
    ui.dict.querySelectorAll("[data-accent]").forEach((button) => {
      button.addEventListener("click", async () => {
        const chosen = button.dataset.accent === "uk" ? "uk" : "us";
        if (button.dataset.accent !== "read") {
          const response = await send("LM_SET_SETTINGS", { settings: { accent: chosen } });
          if (!response.ok) { lmNotify(response.error || "口音设置保存失败，请重试", "error"); return; }
          state.settings.accent = chosen;
          ui.dict.querySelectorAll("[data-accent]").forEach((item) => item.classList.toggle("active", item === button));
        }
        const audioUrl = chosen === "uk" ? data.audioUk : data.audioUs;
        playPronunciation(japanese?.baseReading || data.word, from, chosen, audioUrl);
      });
    });
    ui.dict.querySelector("[data-known]").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      const markKnown = japanese ? !japaneseKnown(japanese) : true;
      const result = await send("LM_MARK_KNOWN", { word: savedWord, lang: from, known: markKnown, ...(japanese ? { japanese: lmJapaneseClient.persistent(japanese) } : {}) });
      button.disabled = false;
      if (!result.ok) { lmNotify(result.error || "标记失败，请重试", "error"); return; }
      state.known = result.known;
      toast(markKnown ? "已标记为认识" : "已取消认识标记");
      if (japanese) button.textContent = markKnown ? "已认识 · 点击取消" : "认识";
      syncWordMarkers();
    });
    ui.vocabButton = lmBindVocabButton(ui.dict.querySelector(".lm-dict-save"), {
      word: savedWord,
      lang: from,
      japanese: japanese ? () => lmJapaneseClient.persistent(japanese) : null,
      send,
      createItem: () => ({
        word: savedWord,
        translation: data.translation || "",
        phonetic: data.phonetic || "",
        lang: from,
        nativeLang: state.settings.nativeLang,
        context: cue?.text || "",
        videoTitle: state.title,
        videoUrl: location.href,
        time: cue?.start != null ? cue.start / 1000 : videoEl()?.currentTime || 0,
        ...(japanese ? { japanese: lmJapaneseClient.persistent(japanese) } : {})
      }),
      onChange: ({ saved, item }) => {
        state.vocab = state.vocab.filter((row) => item?.id ? row.id !== item.id : row.lang !== from || row.word.trim().toLowerCase() !== savedWord.trim().toLowerCase());
        if (saved) state.vocab.unshift(item);
        syncWordMarkers();
        if (state.tab !== "subs") renderPanel();
        if (hoverWord?.isConnected) placeDict(hoverWord);
      }
    });
    if (hoverWord && hoverWord.isConnected) placeDict(hoverWord);
  }

  function placeDict(anchor) {
    if (!anchor || !ui.dict) return;
    if (ui.dict.parentElement !== document.documentElement) {
      document.documentElement.appendChild(ui.dict);
    }
    const margin = 8;
    const gap = 6;
    const word = anchor.getBoundingClientRect();
    const card = ui.dict.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let left = word.left;
    if (left + card.width > vw - margin) left = word.right - card.width;
    if (left + card.width > vw - margin) left = vw - card.width - margin;
    if (left < margin) left = margin;
    let top = word.bottom + gap;
    if (top + card.height > vh - margin) top = word.top - card.height - gap;
    if (top < margin) top = Math.max(margin, vh - card.height - margin);
    ui.dict.style.left = `${Math.round(left)}px`;
    ui.dict.style.top = `${Math.round(top)}px`;
    placeBridge(anchor);
  }

  function placeBridge(anchor) {
    if (!ui.bridge || !ui.dict || !anchor) return;
    if (ui.bridge.parentElement !== document.documentElement) {
      document.documentElement.appendChild(ui.bridge);
    }
    const word = anchor.getBoundingClientRect();
    const card = ui.dict.getBoundingClientRect();
    const pad = 16;
    const left = Math.min(word.left, card.left) - pad;
    const top = Math.min(word.top, card.top) - pad;
    const right = Math.max(word.right, card.right) + pad;
    const bottom = Math.max(word.bottom, card.bottom) + pad;
    ui.bridge.style.left = `${Math.round(left)}px`;
    ui.bridge.style.top = `${Math.round(top)}px`;
    ui.bridge.style.width = `${Math.round(Math.max(0, right - left))}px`;
    ui.bridge.style.height = `${Math.round(Math.max(0, bottom - top))}px`;
    ui.bridge.classList.remove("lm-hidden");
  }

  function dictOpen() {
    return !!(ui.dict && !ui.dict.classList.contains("lm-hidden") && hoverWord);
  }

  function inDictZone(node) {
    if (!node) return false;
    if (ui.dict && (node === ui.dict || ui.dict.contains(node))) return true;
    if (ui.bridge && (node === ui.bridge || ui.bridge.contains(node))) return true;
    if (hoverWord && (node === hoverWord || hoverWord.contains(node))) return true;
    return false;
  }

  function pointerInDictZone() {
    if (hoverWord && hoverWord.matches(":hover")) return true;
    if (ui.bridge && ui.bridge.matches(":hover")) return true;
    if (ui.dict && ui.dict.matches(":hover")) return true;
    return false;
  }

  function hideDict() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverWord = null;
    state.dictToken += 1;
    stopSpeech();
    if (ui.dict) ui.dict.classList.add("lm-hidden");
    if (ui.bridge) ui.bridge.classList.add("lm-hidden");
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (pointerInDictZone()) return;
      const hovered = document.querySelector(".lm-word:hover");
      if (hovered && (ui.subs?.contains(hovered) || ui.panel?.contains(hovered))) return;
      hideDict();
    }, 180);
  }

  function scheduleShow(wordEl) {
    if (!wordEl) return;
    if (hoverWord === wordEl && dictOpen()) {
      clearTimeout(hideTimer);
      return;
    }
    clearTimeout(hoverTimer);
    const delay = dictOpen() ? 480 : 40;
    hoverTimer = setTimeout(() => {
      if (!wordEl.isConnected || !wordEl.matches(":hover")) return;
      clearTimeout(hideTimer);
      showDict(wordEl);
    }, delay);
  }

  async function showDict(wordEl, selected = null) {
    if (!wordEl || !wordEl.isConnected) return;
    hoverWord = wordEl;
    rememberCue(wordEl);
    const word = selected?.surface || wordEl.dataset.word;
    const from = selected?.lang || wordEl.dataset.lang || state.settings.learningLang;
    const cue = selected?.context ? { ...(cueForWord(wordEl) || {}), text: selected.context } : cueForWord(wordEl);
    const analysis = from === "ja" && !selected?.isPhrase ? selected || analysisForWord(wordEl) : null;
    const token = ++state.dictToken;
    ui.dict.classList.remove("lm-hidden");
    ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-empty">正在查询…</div>`;
    placeDict(wordEl);
    const res = await send("LM_LOOKUP", {
      word,
      from,
      to: state.settings.nativeLang,
      context: cue?.text || "",
      ...(analysis ? { japanese: analysis } : {}),
      ...(selected?.isPhrase ? { isPhrase: true } : {})
    });
    if (token !== state.dictToken || hoverWord !== wordEl) return;
    if (!wordEl.isConnected) { hideDict(); return; }
    if (!res.ok) {
      ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-vocab-status" role="alert" data-error="true">${escapeHtml(res.error || "查询失败，请重试")}</div><button type="button" class="lm-chip" data-retry>重新查询</button>`;
      ui.dict.querySelector("[data-retry]").addEventListener("click", () => showDict(wordEl, selected));
      placeDict(wordEl);
      return;
    }
    const data = res.result || { word, translation: "", phonetic: "", senses: [], entries: [] };
    renderDict(data, cue, from, analysis);
    placeDict(wordEl);
  }

  function onWordHover(ev) {
    if (window.getSelection?.() && !window.getSelection().isCollapsed) return;
    if (inDictZone(ev.target) && ev.target !== hoverWord && !(hoverWord && hoverWord.contains(ev.target))) {
      clearTimeout(hideTimer);
      if (ui.dict && ui.dict.contains(ev.target)) return;
      if (ui.bridge && ui.bridge.contains(ev.target)) return;
    }
    const word = ev.target.closest && ev.target.closest(".lm-word");
    if (word && (ui.subs?.contains(word) || ui.panel?.contains(word))) {
      scheduleShow(word);
    }
  }

  function onWordLeave(ev) {
    const target = ev.target;
    const next = ev.relatedTarget;
    const leftWord = target.closest && target.closest(".lm-word");
    const leftCard = ui.dict && ui.dict.contains(target);
    const leftBridge = ui.bridge && (target === ui.bridge || ui.bridge.contains(target));
    if (!leftWord && !leftCard && !leftBridge) return;
    if (inDictZone(next)) return;
    scheduleHide();
  }

  function syncWordMarkers() {
    japaneseSavedSource = null;
    const saved = new Set(state.vocab.map((item) => `${item.lang}:${item.word.trim().toLowerCase()}`));
    for (const root of [ui.subs, ui.panel]) {
      root?.querySelectorAll(".lm-word").forEach((word) => {
        const lang = word.dataset.lang;
        if (lang === "ja" && typeof lmJapaneseUi !== "undefined") {
          const analysis = lmJapaneseUi.tokenFrom(word);
          const isSaved = japaneseSaved(analysis);
          word.classList.toggle("lm-saved", isSaved);
          word.classList.toggle("lm-known", japaneseKnown(analysis));
          word.classList.toggle("lm-rare", !isSaved && state.settings.highlightRare && analysis.common === false && !analysis.grammar);
          return;
        }
        const isSaved = saved.has(`${lang}:${word.dataset.word.trim().toLowerCase()}`);
        word.classList.toggle("lm-saved", isSaved);
        word.classList.toggle("lm-rare", !isSaved && state.settings.highlightRare && !lmIsCommonWord(word.dataset.word, lang));
        word.classList.toggle("lm-known", !!state.known[`${lang}:${lmNormalizeWord(word.dataset.word)}`]);
      });
    }
  }

  async function saveWord(word, context, lookup, lang = state.settings.learningLang, analysis = null, sourceTime = null) {
    lmNotify("正在加入生词本…", "pending");
    const cue = state.cues[state.index];
    const occurrence = { context: context || cue?.text || "", videoTitle: state.title, videoUrl: location.href, time: Number.isFinite(sourceTime) && sourceTime >= 0 ? sourceTime / 1000 : cue?.start != null ? cue.start / 1000 : videoEl()?.currentTime || 0 };
    let data = lookup;
    if (!data) {
      const res = await send("LM_LOOKUP", {
        word,
        from: lang,
        to: state.settings.nativeLang,
        context: occurrence.context,
        ...(analysis ? { japanese: analysis } : {})
      });
      data = res.result || { word, translation: "" };
    }
    const japanese = lang === "ja" ? data.japanese || analysis : null;
    const saved = await send("LM_VOCAB_ADD", {
      item: {
        word: japanese?.lemma || word,
        translation: data.translation,
        phonetic: data.phonetic,
        lang,
        nativeLang: state.settings.nativeLang,
        ...occurrence,
        ...(japanese ? { japanese: lmJapaneseClient.persistent(japanese) } : {})
      }
    });
    if (saved.ok && saved.item) {
      const idx = state.vocab.findIndex((row) => row.id === saved.item.id);
      if (idx >= 0) state.vocab[idx] = saved.item;
      else state.vocab.unshift(saved.item);
      toast(`已收藏 ${word}`);
      syncWordMarkers();
      ui.vocabButton?.refresh();
      if (state.tab !== "subs") renderPanel();
    } else {
      lmNotify(saved.error || "加入生词本失败，请重试", "error");
    }
  }

  function resetPlaybackClock() { state.lastTickMs = null; }

  function onTick() {
    if (!state.settings.enabled) return;
    const video = videoEl();
    if (!video) return;
    const ms = video.currentTime * 1000;
    const previous = state.cues[state.activeIndex];
    const elapsed = state.lastTickMs === null ? Infinity : ms - state.lastTickMs;
    if (state.settings.autoPause && !video.seeking && !state.peeking && !video.paused && previous && elapsed >= 0 && elapsed <= 1000 && state.lastTickMs < previous.end && ms >= previous.end) video.pause();
    state.lastTickMs = ms;
    if (currentIndex(ms) !== state.activeIndex) renderCurrent();
  }

  function isTyping(target) {
    const tag = (target && target.tagName) || "";
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable);
  }

  function onKeyDown(ev) {
    if (ev.key === "Escape") { hideDict(); if (ui.phraseQuery) ui.phraseQuery.hidden = true; return; }
    if (!state.settings.enabled || ev.ctrlKey || ev.altKey || ev.metaKey || isTyping(ev.target)) return;
    const key = ev.key.toLowerCase();
    if (!["a", "s", "d"].includes(key)) return;
    ev.preventDefault();
    ev.stopPropagation();
    state.peeking = ev.repeat;
    ui.subs.classList.add("lm-peek");
    if (key === "a") jump(-1, ev.repeat);
    if (key === "s") {
      replayCurrent();
      if (ev.repeat) videoEl()?.pause();
    }
    if (key === "d") jump(1, ev.repeat);
  }

  function onKeyUp(ev) {
    if (!state.settings.enabled || ev.ctrlKey || ev.altKey || ev.metaKey || isTyping(ev.target)) return;
    const key = ev.key.toLowerCase();
    if (!["a", "s", "d"].includes(key)) return;
    ui.subs.classList.remove("lm-peek");
    if (state.peeking) {
      state.peeking = false;
      videoEl()?.play().catch(() => {});
    }
  }

  function onDocClick(ev) {
    if (!ui.dict || ui.dict.classList.contains("lm-hidden")) return;
    if (ui.dict.contains(ev.target) || (ev.target.closest && ev.target.closest(".lm-word"))) return;
    hideDict();
  }

  function updatePhraseQuery() {
    if (!ui.phraseQuery) return;
    ui.phraseSelection = null;
    ui.phraseQuery.hidden = true;
    if (!state.settings.enabled || typeof lmJapaneseUi === "undefined") return;
    const selection = document.getSelection?.();
    if (!selection || selection.isCollapsed) return;
    for (const root of [ui.subs, ui.panel]) {
      const selected = lmJapaneseUi.selectionFrom(root, selection);
      if (!selected || selected.lang !== "ja") continue;
      const range = selection.getRangeAt(0);
      const first = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const anchor = first?.closest(".lm-word") || first;
      if (!anchor) continue;
      const line = anchor.closest(".lm-line, .lm-cue-learning, .lm-cue-native") || root;
      ui.phraseSelection = { ...selected, anchor, context: lmJapaneseUi.textWithoutReading(line) };
      ui.phraseQuery.textContent = `${selected.isPhrase ? "查询短语" : "查询单词"}：${selected.surface.length > 22 ? selected.surface.slice(0, 22) + "…" : selected.surface}`;
      const rect = range.getBoundingClientRect();
      ui.phraseQuery.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
      ui.phraseQuery.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 56))}px`;
      ui.phraseQuery.hidden = false;
      break;
    }
  }

  let storeGeneration = 0;
  async function refreshStore() {
    const generation = ++storeGeneration;
    const previous = state.settings;
    const [settingsRes, vocabRes] = await Promise.all([
      send("LM_GET_SETTINGS"),
      send("LM_VOCAB_LIST")
    ]);
    if (generation !== storeGeneration) return null;
    if (settingsRes.ok) state.settings = lmMergeSettings(settingsRes.settings);
    else lmNotify(settingsRes.error || "设置读取失败，请重试", "error");
    if (vocabRes.ok) {
      state.vocab = vocabRes.vocab;
      state.known = vocabRes.known;
    }
    return {
      reloadCaptions: previous.learningLang !== state.settings.learningLang || previous.nativeLang !== state.settings.nativeLang || (!previous.enabled && state.settings.enabled),
      hideNative: previous.showNative && !state.settings.showNative,
      settingsChanged: JSON.stringify(previous) !== JSON.stringify(state.settings)
    };
  }

  function applyStoredState(result) {
    if (!result) return;
    if (result.hideNative) state.cues.forEach((cue) => { cue.translationRevealed = false; });
    if (result.settingsChanged) {
      syncToolbar();
      placePanel();
      applyCaptionVisibility();
      state.lastTickMs = null;
      if (!state.settings.enabled) { state.loadGen += 1; hideDict(); }
      else {
        renderCurrent();
        if (state.tab === "subs" && !result.reloadCaptions) renderTranscript();
        if (result.reloadCaptions) loadCaptions(true);
      }
    }
    syncWordMarkers();
    if (state.tab !== "subs") renderPanel();
  }

  async function boot() {
    await refreshStore();
    mountUi();
    loadCaptions(true);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "linguamate-page" || msg.requestId) return;
    if (msg.type === "LM_READY" || msg.type === "LM_NAVIGATE") {
      mountUi();
      loadCaptions(true);
    }
    if (msg.type === "LM_CAPTIONS") retryCaptions();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes) refreshStore().then(applyStoredState);
    if (area === "local") refreshStore().then((result) => {
      // Applied through the same path as sync changes so a newer vocabulary
      // refresh cannot swallow an in-flight language or enable/disable update.
      applyStoredState(result);
      if (changes.vocab) ui.vocabButton?.refresh();
    });
  });

  document.addEventListener("yt-navigate-finish", () => mountUi());
  document.addEventListener("yt-page-data-updated", () => mountUi());
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("mouseover", onWordHover);
  document.addEventListener("mouseout", onWordLeave);
  document.addEventListener("mouseup", updatePhraseQuery);
  document.addEventListener("keyup", updatePhraseQuery);
  document.addEventListener("selectionchange", updatePhraseQuery);
  document.addEventListener("scroll", () => {
    if (!hoverWord || !ui.dict || ui.dict.classList.contains("lm-hidden")) return;
    if (!hoverWord.isConnected) {
      hideDict();
      return;
    }
    placeDict(hoverWord);
  }, true);
  setInterval(() => {
    mountUi();
    onTick();
  }, 250);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
