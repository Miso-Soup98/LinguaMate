(() => {
  if (window.__linguaMatePrimeUi) return;
  window.__linguaMatePrimeUi = true;

  const state = {
    settings: lmMergeSettings(),
    cues: [],
    native: [],
    index: -1,
    activeIndex: -1,
    trackLang: "",
    lastTickMs: null,
    peeking: false,
    vocab: [],
    token: 0,
    fullTrack: false,
    followTranscript: true,
    statusText: "正在等待播放器提供字幕…"
  };

  const ui = {};
  let hideTimer = 0;
  let hoverWord = null;
  let hoverTimer = 0;
  let lookupToken = 0;

  function send(type, payload = {}) {
    return lmSendMessage(type, payload);
  }

  function videoEl() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || null;
  }

  function ensureUi() {
    if (ui.root) return;
    const root = document.createElement("div");
    root.id = "lm-root";
    root.className = "lm-prime-root";
    root.innerHTML = `
      <div class="lm-toolbar">
        <button type="button" class="active" data-act="panel">语伴</button>
        <span class="lm-mini-help">在播放器里打开要学习的字幕</span>
      </div>
      <div class="lm-subs" id="lm-subs">
        <div class="lm-line lm-line-learning lm-hidden" id="lm-learning-line"></div>
        <div class="lm-line lm-line-native lm-hidden" id="lm-native-line"></div>
      </div>
      <div class="lm-dict lm-hidden" id="lm-dict"></div>
    `;
    ui.root = root;
    ui.toolbar = root.querySelector(".lm-toolbar");
    ui.toolbar.classList.add("lm-prime-toolbar");
    ui.subs = root.querySelector("#lm-subs");
    ui.learningLine = root.querySelector("#lm-learning-line");
    ui.nativeLine = root.querySelector("#lm-native-line");
    ui.dict = root.querySelector("#lm-dict");
    ui.panel = document.createElement("section");
    ui.panel.className = "lm-panel lm-prime-panel";
    ui.panel.innerHTML = `<div class="lm-panel-tabs"><button type="button" class="active" data-act="panel">字幕</button><button type="button" class="lm-prime-follow active" data-act="follow" aria-pressed="true" title="自动跟随当前字幕；向上滚动可暂停">跟随中</button></div><div class="lm-panel-body" tabindex="0" aria-label="字幕列表"></div><div class="lm-mini-help">停留查词 · 向上滚动暂停跟随 · A / S / D 切换字幕</div>`;
    ui.panelBody = ui.panel.querySelector(".lm-panel-body");
    ui.followButton = ui.panel.querySelector("[data-act='follow']");
    ui.cueRows = [];
    ui.panelBody.addEventListener("scroll", onTranscriptScroll);
    root.querySelector("[data-act='panel']").addEventListener("click", togglePanel);
    ui.panel.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-act='follow']")) {
        setTranscriptFollow(!state.followTranscript);
        return;
      }
      if (ev.target.closest("[data-act='panel']")) {
        togglePanel();
        return;
      }
      const word = ev.target.closest(".lm-word");
      if (word) return;
      const row = ev.target.closest("[data-seek]");
      if (row) seekTo(Number(row.dataset.seek), true);
    });
    ui.panel.addEventListener("contextmenu", (ev) => {
      const word = ev.target.closest(".lm-word");
      if (!word) return;
      ev.preventDefault();
      const cue = state.cues[Number(word.closest("[data-index]")?.dataset.index ?? state.index)];
      saveWord(word.dataset.word, cue?.text, null, word.dataset.lang);
    });
    document.addEventListener("mouseover", onHover);
    document.addEventListener("mouseout", onLeave);
    window.addEventListener("scroll", onDictViewportChange, true);
    window.addEventListener("resize", onDictViewportChange);
    makeDraggable(ui.toolbar, ui.toolbar, "lmPrimeToolbar");
    makeDraggable(ui.panel.querySelector(".lm-panel-tabs"), ui.panel, "lmPrimePanel");
    restoreDrag(ui.toolbar, "lmPrimeToolbar");
    restoreDrag(ui.panel, "lmPrimePanel");
  }

  function makeDraggable(handle, target, key) {
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(".lm-word, .lm-panel-body, .lm-mini-help, [data-act='follow']")) return;
      ev.preventDefault();
      const rect = target.getBoundingClientRect();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const originX = rect.left;
      const originY = rect.top;
      let moved = false;
      target.style.width = `${rect.width}px`;
      handle.setPointerCapture(ev.pointerId);
      const move = (event) => {
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) < 5) return;
        moved = true;
        target.classList.add("lm-dragging");
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);
        const left = Math.min(maxLeft, Math.max(0, originX + dx));
        const top = Math.min(maxTop, Math.max(0, originY + dy));
        target.style.left = `${Math.round(left)}px`;
        target.style.top = `${Math.round(top)}px`;
        target.style.right = "auto";
        target.style.bottom = "auto";
      };
      const up = () => {
        if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        target.classList.remove("lm-dragging");
        if (!moved) return;
        target.dataset.suppressClick = "1";
        try {
          chrome.storage.local.set({
            [key]: { left: target.style.left, top: target.style.top }
          });
        } catch (err) {
          /* extension was reloaded */
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    handle.addEventListener("click", (ev) => {
      if (target.dataset.suppressClick !== "1") return;
      ev.preventDefault();
      ev.stopPropagation();
      target.dataset.suppressClick = "";
    }, true);
  }

  function restoreDrag(target, key) {
    if (!chrome.storage?.local) return;
    chrome.storage.local.get(key, (stored) => {
      const pos = stored && stored[key];
      if (!pos || !pos.left || !pos.top) return;
      target.style.left = pos.left;
      target.style.top = pos.top;
      target.style.right = "auto";
      if (target === ui.panel) clampPanelPosition();
    });
  }

  function clampPanelPosition() {
    if (!ui.panel?.isConnected) return;
    const rect = ui.panel.getBoundingClientRect();
    const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - rect.width));
    const top = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - rect.height));
    if (left !== rect.left) {
      ui.panel.style.left = `${Math.round(left)}px`;
      ui.panel.style.right = "auto";
    }
    if (top !== rect.top) ui.panel.style.top = `${Math.round(top)}px`;
  }

  async function togglePanel() {
    if (ui.panelSaving) return;
    ui.panelSaving = true;
    const open = !state.settings.panelOpen;
    const result = await send("LM_SET_SETTINGS", { settings: { panelOpen: open } });
    ui.panelSaving = false;
    if (!result.ok) {
      lmNotify(result.error || "字幕栏设置保存失败，请重试", "error");
      return;
    }
    applySettings(result.settings || { ...state.settings, panelOpen: open });
    lmNotify(open ? "字幕栏已展开" : "字幕栏已收起");
    clampPanelPosition();
    followCurrentCue();
  }

  function syncSettings() {
    if (!ui.root) return;
    const enabled = state.settings.enabled;
    ui.root.classList.toggle("lm-hidden", !enabled);
    ui.toolbar.classList.toggle("lm-hidden", !enabled);
    ui.panel.classList.toggle("lm-hidden", !enabled);
    ui.panel.classList.toggle("lm-collapsed", !state.settings.panelOpen);
    ui.subs.classList.toggle("lm-listen", !!state.settings.listenMode);
    ui.learningLine.style.fontSize = `${state.settings.fontSize}px`;
    ui.nativeLine.style.fontSize = `${Math.max(14, state.settings.fontSize - 4)}px`;
    document.documentElement.classList.toggle("lm-prime-captions", enabled);
    const video = videoEl();
    if (video && ui.clockVideo !== video) {
      ui.clockVideo?.removeEventListener("seeking", resetPlaybackClock);
      ui.clockVideo?.removeEventListener("seeked", resetPlaybackClock);
      video.addEventListener("seeking", resetPlaybackClock);
      video.addEventListener("seeked", resetPlaybackClock);
      ui.clockVideo = video;
    }
    if (enabled && video && (ui.rateVideo !== video || ui.appliedRate !== state.settings.playbackRate)) {
      video.playbackRate = Number(state.settings.playbackRate) || 1;
      ui.rateVideo = video;
      ui.appliedRate = state.settings.playbackRate;
    }
    if (!enabled) hideDict();
  }

  function requestTrack() {
    if (!state.settings.enabled) return;
    window.postMessage({ source: "linguamate-content", type: "LM_PRIME_PULL", lang: state.settings.learningLang }, "*");
  }

  function applySettings(settings) {
    const previous = state.settings;
    state.settings = lmMergeSettings(settings);
    const languageChanged = previous.learningLang !== state.settings.learningLang;
    const translationChanged = previous.nativeLang !== state.settings.nativeLang;
    if (languageChanged) {
      state.token += 1;
      state.cues = [];
      state.native = [];
      state.index = state.activeIndex = -1;
      state.trackLang = "";
      state.fullTrack = false;
      state.lastLive = "";
      state.statusText = "语言已切换，正在读取对应字幕…";
      hideDict();
      requestTrack();
    } else if (translationChanged) {
      state.token += 1;
      state.native = [];
      hideDict();
    }
    state.lastTickMs = null;
    mount();
    if (ui.panelBody) {
      renderPanel();
      renderCurrent();
      syncWordMarkers();
    }
    if (state.settings.enabled && state.cues.length && (translationChanged || (!previous.enabled && state.settings.enabled))) {
      state.token += 1;
      translateCues(state.cues, state.token);
    }
  }

  function setTranscriptFollow(enabled) {
    state.followTranscript = enabled;
    ui.followButton.classList.toggle("active", enabled);
    ui.followButton.setAttribute("aria-pressed", String(enabled));
    ui.followButton.textContent = enabled ? "跟随中" : "继续跟随";
    if (enabled) followCurrentCue();
  }

  function onTranscriptScroll() {
    const body = ui.panelBody;
    const previous = ui.panelScrollTop ?? body.scrollTop;
    ui.panelScrollTop = body.scrollTop;
    if (body.scrollTop < previous - 1) {
      setTranscriptFollow(false);
    } else if (!state.followTranscript && body.scrollHeight - body.clientHeight - body.scrollTop <= 24) {
      setTranscriptFollow(true);
    }
  }

  function followCurrentCue() {
    if (!state.followTranscript || ui.panel?.classList.contains("lm-collapsed")) return;
    const row = ui.cueRows?.[state.index];
    if (!row || !ui.panelBody.clientHeight) return;
    const body = ui.panelBody.getBoundingClientRect();
    const cue = row.getBoundingClientRect();
    let delta = 0;
    if (cue.height > body.height - 16) {
      if (cue.top < body.top + 8 || cue.top > body.bottom - 8) delta = cue.top - body.top - 8;
    } else if (cue.top < body.top + 8) delta = cue.top - body.top - 8;
    else if (cue.bottom > body.bottom - 8) delta = cue.bottom - body.bottom + 8;
    if (delta) ui.panelBody.scrollTop += delta;
    ui.panelScrollTop = ui.panelBody.scrollTop;
  }

  function placeOverlay() {
    const video = videoEl();
    if (!video || !ui.root) return;
    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) {
      ui.root.classList.add("lm-hidden");
      return;
    }
    if (!state.settings.enabled) return;
    ui.root.classList.remove("lm-hidden");
    ui.root.style.left = `${Math.max(0, rect.left)}px`;
    ui.root.style.top = `${Math.max(0, rect.top)}px`;
    ui.root.style.width = `${Math.min(rect.width, window.innerWidth - Math.max(0, rect.left))}px`;
    ui.root.style.height = `${Math.min(rect.height, window.innerHeight - Math.max(0, rect.top))}px`;
  }

  function mount() {
    if (!videoEl()) {
      for (const target of [ui.root, ui.toolbar, ui.panel]) target?.classList.add("lm-hidden");
      document.documentElement.classList.remove("lm-prime-captions");
      hideDict();
      return;
    }
    ensureUi();
    if (ui.root && ui.root.parentElement !== document.documentElement) document.documentElement.appendChild(ui.root);
    if (ui.toolbar && ui.toolbar.parentElement !== document.documentElement) document.documentElement.appendChild(ui.toolbar);
    if (ui.panel && ui.panel.parentElement !== document.documentElement) document.documentElement.appendChild(ui.panel);
    clampPanelPosition();
    syncSettings();
    placeOverlay();
    if (!state.cues.length && ui.panelBody && !ui.panelBody.childElementCount) renderPanel();
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function parseTrack(text) {
    return lmParseCaptionTrack(text);
  }

  function tokenize(text, lang) {
    try {
      return Array.from(new Intl.Segmenter(lang || "en", { granularity: "word" }).segment(text)).map((part) => ({
        text: part.segment,
        word: part.isWordLike
      }));
    } catch (err) {
      return String(text || "").split(/(\s+)/).map((part) => ({ text: part, word: /\p{L}|\p{N}/u.test(part) }));
    }
  }

  function renderWords(target, text, lang, interactive = true) {
    const key = JSON.stringify([text, lang, interactive]);
    if (target._lmWordsKey === key) return;
    target._lmWordsKey = key;
    target.replaceChildren();
    if (!interactive) {
      target.textContent = text || "";
      return;
    }
    const saved = new Set(state.vocab.filter((item) => item.lang === lang).map((item) => item.word.trim().toLowerCase()));
    tokenize(text, lang).forEach((token) => {
      if (!token.word) {
        target.appendChild(document.createTextNode(token.text));
        return;
      }
      const span = document.createElement("span");
      span.className = "lm-word";
      span.textContent = token.text;
      span.dataset.word = token.text;
      span.dataset.lang = lang || state.settings.learningLang;
      const isSaved = saved.has(token.text.trim().toLowerCase());
      span.classList.toggle("lm-saved", isSaved);
      span.classList.toggle("lm-rare", !isSaved && !!state.settings.highlightRare && !lmIsCommonWord(token.text, span.dataset.lang));
      target.appendChild(span);
    });
  }

  function syncWordMarkers() {
    const saved = new Set(state.vocab.map((item) => `${item.lang}:${item.word.trim().toLowerCase()}`));
    for (const root of [ui.subs, ui.panel]) {
      root?.querySelectorAll(".lm-word").forEach((word) => {
        const isSaved = saved.has(`${word.dataset.lang}:${word.dataset.word.trim().toLowerCase()}`);
        word.classList.toggle("lm-saved", isSaved);
        word.classList.toggle("lm-rare", !isSaved && !!state.settings.highlightRare && !lmIsCommonWord(word.dataset.word, word.dataset.lang));
      });
    }
  }

  function currentIndex(ms) {
    for (let i = 0; i < state.cues.length; i += 1) {
      if (ms >= state.cues[i].start && ms < state.cues[i].end) return i;
    }
    return -1;
  }

  function navigationIndex(ms) {
    let nearest = -1;
    state.cues.forEach((cue, i) => {
      if (cue.start <= ms) nearest = i;
    });
    return nearest;
  }

  function renderCurrent() {
    if (!ui.learningLine) return;
    const video = videoEl();
    const idx = video ? currentIndex(video.currentTime * 1000) : -1;
    state.activeIndex = idx;
    state.index = idx >= 0 ? idx : video ? navigationIndex(video.currentTime * 1000) : -1;
    const cue = state.cues[idx];
    const native = state.native[idx] || "";
    ui.learningLine.classList.toggle("lm-hidden", !state.settings.showLearning || !cue);
    ui.nativeLine.classList.toggle("lm-hidden", !state.settings.showNative || !native);
    if (cue) renderWords(ui.learningLine, cue.text, state.trackLang || state.settings.learningLang);
    if (native) renderWords(ui.nativeLine, native, state.settings.nativeLang, state.settings.nativeInteractive);
    if (hoverWord && (!hoverWord.isConnected || hoverWord.closest(".lm-hidden"))) hideDict();
    else if (dictOpen()) placeDict(hoverWord);
    const active = ui.cueRows[idx];
    if (ui.activeRow !== active) {
      ui.activeRow?.classList.remove("active");
      active?.classList.add("active");
      ui.activeRow = active;
      followCurrentCue();
    }
  }

  function renderPanel() {
    if (!state.cues.length) {
      ui.panelBody.innerHTML = `<div class="lm-empty">${escapeHtml(state.statusText)}</div>`;
      ui.cueRows = [];
      ui.activeRow = null;
      ui.panelScrollTop = ui.panelBody.scrollTop;
      if (hoverWord && !hoverWord.isConnected) hideDict();
      return;
    }
    const scroll = ui.panelBody.scrollTop;
    if (!ui.cueRows.length) ui.panelBody.replaceChildren();
    state.cues.forEach((cue, i) => {
      let row = ui.cueRows[i];
      if (!row) {
        row = document.createElement("div");
        row.className = "lm-cue";
        const time = document.createElement("div");
        time.className = "lm-cue-time";
        const learning = document.createElement("div");
        learning.className = "lm-cue-learning";
        row.append(time, learning);
        ui.cueRows.push(row);
        ui.panelBody.appendChild(row);
      }
      row.classList.toggle("active", i === state.activeIndex);
      row.dataset.seek = String(cue.start);
      row.dataset.index = String(i);
      row.querySelector(".lm-cue-time").textContent = formatTime(cue.start);
      renderWords(row.querySelector(".lm-cue-learning"), cue.text, state.trackLang || state.settings.learningLang);
      let native = row.querySelector(".lm-cue-native");
      if (state.native[i]) {
        if (!native) {
          native = document.createElement("div");
          native.className = "lm-cue-native";
          row.appendChild(native);
        }
        renderWords(native, state.native[i], state.settings.nativeLang, state.settings.nativeInteractive);
      } else {
        native?.remove();
      }
    });
    while (ui.cueRows.length > state.cues.length) ui.cueRows.pop().remove();
    ui.activeRow = ui.cueRows[state.activeIndex];
    ui.panelBody.scrollTop = scroll;
    ui.panelScrollTop = ui.panelBody.scrollTop;
    if (hoverWord && (!hoverWord.isConnected || hoverWord.closest(".lm-hidden"))) hideDict();
    else if (dictOpen()) placeDict(hoverWord);
    followCurrentCue();
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function seekTo(ms, play) {
    const video = videoEl();
    if (!video) return;
    video.currentTime = Math.max(0, ms / 1000 + 0.01);
    state.lastTickMs = null;
    if (play) video.play().catch(() => {});
    else video.pause();
    renderCurrent();
    setTranscriptFollow(true);
  }

  async function translateCues(cues, token) {
    state.native = new Array(cues.length).fill("");
    const size = 30;
    for (let start = 0; start < cues.length; start += size) {
      if (token !== state.token || !state.settings.enabled) return;
      const slice = cues.slice(start, start + size);
      const packed = slice.map((cue, index) => `[${start + index}] ${cue.text}`).join("\n");
      const res = await send("LM_TRANSLATE", { text: packed, from: "auto", to: state.settings.nativeLang });
      if (token !== state.token || !state.settings.enabled) return;
      const translated = res.result?.text || "";
      const pattern = /\[(\d+)\]\s*([\s\S]*?)(?=\s*\[\d+\]|$)/g;
      translated.replace(pattern, (_, index, line) => {
        const target = Number(index);
        if (target >= start && target < start + slice.length) state.native[target] = line.replace(/\s+/g, " ").trim();
        return "";
      });
      renderPanel();
      renderCurrent();
    }
  }

  function cuesFromTextTrack(track) {
    if (!track || !track.cues || !track.cues.length) return [];
    return Array.from(track.cues).map((cue) => ({
      start: cue.startTime * 1000,
      end: cue.endTime * 1000,
      text: String(cue.text || "").replace(/\n+/g, " ").trim()
    })).filter((cue) => cue.text);
  }

  function syncTextTracks() {
    const video = videoEl();
    if (!state.settings.enabled || !video || !video.textTracks || state.fullTrack) return;
    const candidates = Array.from(video.textTracks).filter((track) => languageMatches(track.language, state.settings.learningLang));
    candidates.sort((a, b) => Number(b.mode === "showing") - Number(a.mode === "showing"));
    const chosen = candidates.find((track) => cuesFromTextTrack(track).length);
    if (!chosen) return;
    const best = cuesFromTextTrack(chosen);
    state.fullTrack = true;
    state.token += 1;
    state.cues = best;
    state.trackLang = chosen.language || state.settings.learningLang;
    state.native = [];
    renderPanel();
    renderCurrent();
    translateCues(best, state.token);
  }

  function scrapeLiveCaption() {
    if (!state.settings.enabled || state.fullTrack) return;
    const nodes = document.querySelectorAll("[class*='captions-text'], [class*='CaptionsText']");
    const parts = [];
    nodes.forEach((node) => {
      if (node.closest("#lm-root, .lm-prime-panel, .lm-dict, .lm-toolbar")) return;
      const text = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (text) parts.push(text);
    });
    const text = parts.join(" ");
    if (!text) {
      const previous = state.cues[state.cues.length - 1];
      const now = (videoEl()?.currentTime || 0) * 1000;
      if (state.lastLive && previous && now > previous.start) previous.end = Math.min(previous.end, now);
      state.lastLive = "";
      return;
    }
    if (text === state.lastLive) {
      const current = state.cues[state.cues.length - 1];
      const now = (videoEl()?.currentTime || 0) * 1000;
      if (current && now >= current.start) current.end = Math.max(current.end, now + 500);
      return;
    }
    state.lastLive = text;
    const now = (videoEl()?.currentTime || 0) * 1000;
    const prev = state.cues[state.cues.length - 1];
    if (prev && now - prev.start < 8000) prev.end = now;
    state.cues.push({ start: now, end: now + 4000, text });
    state.statusText = "已从画面字幕开始记录。完整字幕会在拿到字幕文件后补上。";
    renderPanel();
    renderCurrent();
  }

  function languageMatches(actual, expected) {
    return !!actual && String(actual).toLowerCase().split(/[-_]/)[0] === String(expected).toLowerCase().split(/[-_]/)[0];
  }

  function applyTrack(text, language = "") {
    if (!state.settings.enabled) return;
    let parsed;
    try {
      parsed = parseTrack(text);
    } catch (err) {
      state.statusText = "字幕文件已下载，但格式无法解析。";
      renderPanel();
      return;
    }
    const lang = parsed.lang || language;
    if (lang && !languageMatches(lang, state.settings.learningLang)) return;
    if (!parsed.cues.length) {
      if (!state.cues.length) {
        state.statusText = "字幕文件未包含可用时间轴，正在尝试读取画面字幕。";
        renderPanel();
      }
      return;
    }
    state.fullTrack = true;
    state.token += 1;
    state.cues = parsed.cues;
    state.trackLang = lang || state.settings.learningLang;
    state.native = [];
    renderPanel();
    renderCurrent();
    translateCues(parsed.cues, state.token);
  }

  function placeDict(anchor) {
    const word = anchor.getBoundingClientRect();
    const card = ui.dict.getBoundingClientRect();
    const margin = 8;
    let left = word.left;
    if (left + card.width > window.innerWidth - margin) left = window.innerWidth - card.width - margin;
    if (left < margin) left = margin;
    let top = word.bottom + 6;
    if (top + card.height > window.innerHeight - margin) top = Math.max(margin, word.top - card.height - 6);
    ui.dict.style.left = `${Math.round(left)}px`;
    ui.dict.style.top = `${Math.round(top)}px`;
  }

  async function showDict(wordEl) {
    if (!state.settings.enabled || !wordEl?.isConnected) return;
    hoverWord = wordEl;
    const token = ++lookupToken;
    const word = wordEl.dataset.word;
    const from = wordEl.dataset.lang || state.settings.learningLang;
    ui.dict.classList.remove("lm-hidden");
    if (ui.dict.parentElement !== document.documentElement) document.documentElement.appendChild(ui.dict);
    ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-empty">正在查询…</div>`;
    placeDict(wordEl);
    const cue = state.cues[Number(wordEl.closest("[data-index]")?.dataset.index ?? state.index)];
    const res = await send("LM_LOOKUP", { word, from, to: state.settings.nativeLang, context: cue?.text || "" });
    if (token !== lookupToken || hoverWord !== wordEl) return;
    if (!wordEl.isConnected) {
      hideDict();
      return;
    }
    if (!res.ok) {
      ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-vocab-status" role="alert" data-error="true">${escapeHtml(res.error || "查询失败，请重试")}</div><button type="button" class="lm-chip" data-retry>重新查询</button>`;
      ui.dict.querySelector("[data-retry]").addEventListener("click", () => showDict(wordEl));
      placeDict(wordEl);
      return;
    }
    const data = res.result || { word, translation: "" };
    const entries = (data.entries || []).map((entry) => {
      const items = (entry.items || []).map((item, index) => `<div class="lm-entry"><div class="lm-gloss">${index + 1}. ${escapeHtml(item.gloss || item.definition || "")}</div>${item.example ? `<div class="lm-ex">例：${escapeHtml(item.example)}</div>` : ""}</div>`).join("");
      return `<div class="lm-pos">${escapeHtml(entry.pos || "")}</div>${items}`;
    }).join("");
    ui.dict.innerHTML = `
      <div class="lm-dict-head"><div><div class="lm-dict-word">${escapeHtml(data.word || word)}</div><div class="lm-dict-trans">${escapeHtml(data.translation || "")}</div></div></div>
      ${String(from).toLowerCase().startsWith("en") ? `<div class="lm-accents">
        <button type="button" data-accent="us">美式<span class="lm-ipa">${escapeHtml(data.phoneticUs || data.phonetic || "")}</span></button>
        <button type="button" data-accent="uk">英式<span class="lm-ipa">${escapeHtml(data.phoneticUk || data.phonetic || "")}</span></button>
      </div>` : `<div class="lm-accents"><button type="button" data-accent="read">朗读<span class="lm-ipa">${escapeHtml(data.phonetic || "")}</span></button></div>`}
      ${entries || `<div class="lm-dict-trans">${escapeHtml(data.translation || "暂无释义")}</div>`}
      <div class="lm-dict-context">${escapeHtml(cue?.text || "")}</div>
      <button type="button" class="lm-dict-save">加入生词本</button>
    `;
    ui.dict.querySelectorAll("[data-accent]").forEach((button) => {
      button.addEventListener("click", () => send("LM_PRONOUNCE", {
        text: word,
        tl: String(from).toLowerCase().startsWith("en") ? button.dataset.accent === "uk" ? "en-GB" : "en-US" : from,
        audioUrl: button.dataset.accent === "uk" ? data.audioUk : data.audioUs
      }).then((clip) => {
        if (!clip?.audio) { lmNotify(clip?.error || "未能播放读音，请重试", "error"); return; }
        const binary = atob(clip.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: clip.mime || "audio/mpeg" }));
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play().catch(() => { URL.revokeObjectURL(url); lmNotify("未能播放读音，请重试", "error"); });
      }));
    });
    ui.vocabButton = lmBindVocabButton(ui.dict.querySelector(".lm-dict-save"), {
      word,
      lang: from,
      send,
      createItem: () => ({
        word,
        translation: data.translation || "",
        phonetic: data.phonetic || "",
        lang: from,
        nativeLang: state.settings.nativeLang,
        context: cue?.text || "",
        videoTitle: document.title,
        videoUrl: location.href,
        time: videoEl()?.currentTime || 0
      }),
      onChange: ({ saved, item }) => {
        state.vocab = state.vocab.filter((row) => row.lang !== from || row.word.trim().toLowerCase() !== word.trim().toLowerCase());
        if (saved) state.vocab.unshift(item);
        syncWordMarkers();
        if (hoverWord?.isConnected && dictOpen()) placeDict(hoverWord);
      }
    });
    placeDict(wordEl);
  }

  function hideDict() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverWord = null;
    lookupToken += 1;
    ui.dict?.classList.add("lm-hidden");
  }

  function isPrimeWord(word) {
    return !!(state.settings.enabled && word && (ui.subs?.contains(word) || ui.panel?.contains(word)));
  }

  function dictOpen() {
    return !!(hoverWord && ui.dict && !ui.dict.classList.contains("lm-hidden"));
  }

  function inDictZone(node) {
    return !!(node && (ui.dict?.contains(node) || hoverWord?.contains(node)));
  }

  function scheduleShow(wordEl) {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    if (hoverWord === wordEl && dictOpen()) return;
    // Require a deliberate pause, and keep the current card while crossing words.
    const delay = dictOpen() ? 480 : 300;
    hoverTimer = setTimeout(() => {
      if (!wordEl.isConnected || !wordEl.matches(":hover")) return;
      showDict(wordEl);
    }, delay);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (ui.dict?.matches(":hover") || hoverWord?.matches(":hover")) return;
      if (isPrimeWord(document.querySelector(".lm-word:hover"))) return;
      hideDict();
    }, 180);
  }

  function onHover(ev) {
    if (ui.dict?.contains(ev.target)) {
      clearTimeout(hoverTimer);
      clearTimeout(hideTimer);
      return;
    }
    const word = ev.target.closest?.(".lm-word");
    if (isPrimeWord(word)) scheduleShow(word);
  }

  function onLeave(ev) {
    const word = ev.target.closest?.(".lm-word");
    if (!isPrimeWord(word) && !ui.dict?.contains(ev.target)) return;
    const next = ev.relatedTarget;
    if (word && word.contains(next)) return;
    clearTimeout(hoverTimer);
    if (inDictZone(next)) return;
    scheduleHide();
  }

  function onDictViewportChange(ev) {
    if (ev.type === "scroll" && ui.dict?.contains(ev.target)) return;
    hideDict();
  }

  async function saveWord(word, context, lookup, lang = state.trackLang || state.settings.learningLang) {
    lmNotify("正在加入生词本…", "pending");
    const data = lookup || (await send("LM_LOOKUP", {
      word,
      from: lang,
      to: state.settings.nativeLang,
      context: context || ""
    })).result || {};
    const saved = await send("LM_VOCAB_ADD", {
      item: {
        word,
        translation: data.translation || "",
        phonetic: data.phonetic || "",
        lang,
        nativeLang: state.settings.nativeLang,
        context: context || "",
        videoTitle: document.title,
        videoUrl: location.href,
        time: videoEl()?.currentTime || 0
      }
    });
    if (saved.ok && saved.item) {
      state.vocab = state.vocab.filter((item) => item.id !== saved.item.id);
      state.vocab.unshift(saved.item);
      syncWordMarkers();
      ui.vocabButton?.refresh();
      lmNotify(`已加入生词本：${word}`);
    } else {
      lmNotify(saved.error || "加入生词本失败，请重试", "error");
    }
  }

  function isTyping(target) {
    const tag = target?.tagName || "";
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
  }

  function onKeyDown(ev) {
    if (!state.settings.enabled || ev.ctrlKey || ev.altKey || ev.metaKey || isTyping(ev.target) || !state.cues.length) return;
    const key = ev.key.toLowerCase();
    if (!["a", "s", "d"].includes(key)) return;
    ev.preventDefault();
    state.peeking = !!ev.repeat;
    ui.subs.classList.add("lm-peek");
    const idx = Math.min(state.cues.length - 1, Math.max(0, state.index + (key === "a" ? -1 : key === "d" ? 1 : 0)));
    const cue = key === "s" ? state.cues[Math.max(0, state.index)] : state.cues[idx];
    if (cue) seekTo(cue.start, !ev.repeat);
    if (ev.repeat) videoEl()?.pause();
  }

  function onKeyUp(ev) {
    if (ev.ctrlKey || ev.altKey || ev.metaKey || isTyping(ev.target) || !["a", "s", "d"].includes(ev.key.toLowerCase())) return;
    ui.subs?.classList.remove("lm-peek");
    if (state.peeking && state.settings.enabled) videoEl()?.play().catch(() => {});
    state.peeking = false;
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);

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
    renderCurrent();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "linguamate-prime") return;
    if (msg.type === "LM_TRACK") {
      mount();
      applyTrack(msg.text, msg.lang);
    }
  });

  let settingsGeneration = 0;
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "sync") {
      const generation = ++settingsGeneration;
      const response = await send("LM_GET_SETTINGS");
      if (generation === settingsGeneration && response.ok) applySettings(response.settings);
      else if (!response.ok) lmNotify(response.error || "设置读取失败，请重试", "error");
    }
    if (area === "local" && changes.vocab) {
      state.vocab = changes.vocab.newValue || [];
      syncWordMarkers();
      ui.vocabButton?.refresh();
    }
  });

  async function boot() {
    const [res, vocab] = await Promise.all([send("LM_GET_SETTINGS"), send("LM_VOCAB_LIST")]);
    if (res.settings) state.settings = lmMergeSettings(res.settings);
    if (vocab.ok) state.vocab = vocab.vocab;
    if (!res.ok) lmNotify(res.error || "设置读取失败，请刷新页面重试", "error");
    mount();
    setInterval(mount, 1000);
    setInterval(() => {
      if (!state.fullTrack) requestTrack();
    }, 3000);
    window.addEventListener("scroll", placeOverlay, true);
    window.addEventListener("resize", () => {
      placeOverlay();
      clampPanelPosition();
      followCurrentCue();
    });
    setInterval(() => {
      placeOverlay();
      syncTextTracks();
      scrapeLiveCaption();
      if (state.cues.length) onTick();
    }, 250);
  }

  boot();
})();
