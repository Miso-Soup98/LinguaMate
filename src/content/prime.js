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
    known: {},
    token: 0,
    fullTrack: false,
    trackClock: "content",
    adActive: false,
    followTranscript: true,
    statusText: "正在等待播放器提供字幕…"
  };

  const ui = {};
  let hideTimer = 0;
  let hoverWord = null;
  let hoverTimer = 0;
  let lookupToken = 0;
  const playback = { timeline: lmPrimeTimeline.create(), manifest: false, scope: "", last: null, ad: null, pendingTrack: null, pendingTimeline: null };

  function elementVisible(element) {
    if (!element?.isConnected) return false;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      // Prime marks its rendered video aria-hidden to keep it out of the
      // accessibility tree. That attribute does not change visual visibility.
      if (node.hidden || node.getAttribute("hidden") !== null) return false;
      const style = typeof getComputedStyle === "function" ? getComputedStyle(node) : node.style;
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0") return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hasAdIndicator() {
    // Current Prime players render the countdown as a standalone span, with
    // no .atvwebplayersdk-ad-timer wrapper (including on Amazon Japan).
    return Array.from(document.querySelectorAll(".atvwebplayersdk-adtimeindicator-text, .atvwebplayersdk-ad-timer, .atvwebplayersdk-ad-timer-remaining-time"))
      .some((node) => elementVisible(node) && String(node.textContent || "").trim());
  }

  function playbackScope() {
    const url = new URL(location.href);
    return url.pathname + ["gti", "titleId", "asin"].map((key) => `|${key}=${url.searchParams.get(key) || ""}`).join("");
  }

  function checkPlaybackSession() {
    const scope = playbackScope();
    if (playback.scope && scope !== playback.scope) {
      playback.timeline.reset();
      playback.manifest = false;
      playback.last = playback.ad = playback.pendingTrack = playback.pendingTimeline = null;
      state.adActive = false;
      state.lastTickMs = null;
      state.lastLive = "";
      state.token += 1;
      state.cues = [];
      state.native = [];
      state.index = state.activeIndex = -1;
      state.fullTrack = false;
      state.statusText = "视频已切换，正在读取字幕…";
      if (ui.panelBody) renderPanel();
      hideDict();
    }
    playback.scope = scope;
  }

  function syncAdUi() {
    document.documentElement.classList.toggle("lm-prime-captions", state.settings.enabled && !state.adActive);
    if (!ui.subs) return;
    ui.subs.classList.toggle("lm-hidden", state.adActive);
    ui.panel?.classList.toggle("lm-prime-ad-playing", state.adActive);
    if (ui.adStatus) {
      ui.adStatus.hidden = !state.adActive;
      ui.adStatus.textContent = playback.ad?.exit ? "正在恢复正片字幕…" : "广告播放中，正片字幕已暂停";
    }
    if (state.adActive) {
      state.peeking = false;
      ui.subs.classList.remove("lm-peek");
      hideDict();
      if (ui.phraseButton) ui.phraseButton.hidden = true;
    }
  }

  function installTimeline(message, video = videoEl()) {
    if (message.scope && message.scope !== playback.scope) return false;
    if (!Array.isArray(message.breaks) || message.breaks.length > 2000) return false;
    const duration = message.duration;
    if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0)) return false;
    const expected = state.adActive ? playback.ad?.duration : Number(video?.duration) * 1000 || playback.last?.duration;
    if (typeof duration === "number" && Number.isFinite(expected) && expected > 0 && Math.abs(duration - expected) > 2000) {
      // An independent advertisement has its own short MPD. Never let that
      // replace a programme timeline; a programme manifest arriving before the
      // video source is ready can be retried once its duration becomes known.
      if (!playback.manifest || (message.breaks.length && duration >= expected)) playback.pendingTimeline = message;
      return false;
    }
    if (state.adActive && !message.breaks.length && playback.manifest) return false;
    const knownBreaks = playback.timeline.breaks();
    if (!playback.timeline.setBreaks(message.breaks)) return false;
    // The hook replays cached MPDs on subtitle pulls. An MPD without ad
    // periods must not erase ads already observed in this programme session.
    // For an overlapping interval, prefer the manifest's exact boundaries.
    for (const part of knownBreaks) {
      if (!message.breaks.some((current) => part.start < current.end && part.end > current.start)) {
        playback.timeline.addBreak(part.start, part.end);
      }
    }
    playback.manifest = true;
    playback.pendingTimeline = null;
    state.lastTickMs = null;
    return true;
  }

  function contentTimeMs(video = videoEl()) {
    checkPlaybackSession();
    if (!video) return playback.last?.content || 0;
    const raw = Math.max(0, Number(video.currentTime) * 1000 || 0);
    const source = String(video.currentSrc || video.src || "");
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const duration = Number.isFinite(video.duration) ? video.duration * 1000 : playback.last?.duration;
    if (!state.adActive && !hasAdIndicator() && playback.pendingTimeline) installTimeline(playback.pendingTimeline, video);
    const inTimelineAd = playback.timeline.breaks().some((part) => raw >= part.start && raw < part.end);
    const advertised = hasAdIndicator() || inTimelineAd;
    if (advertised && !state.adActive) {
      const previous = playback.last;
      playback.ad = {
        video: previous?.video || video, source: previous?.source ?? source,
        duration: previous?.duration ?? duration,
        start: previous && previous.video === video && source === previous.source && raw >= previous.raw && raw - previous.raw <= 1500 ? raw : previous?.raw ?? raw,
        content: previous?.content ?? playback.timeline.toContent(raw), lastRaw: raw, lastAt: now,
        continuous: !video.seeking && (!previous || (previous.video === video && previous.source === source && raw >= previous.raw && raw - previous.raw <= Math.max(0, now - previous.at) * Math.max(1, Number(video.playbackRate) || 1) + 1500)), exit: null
      };
      state.adActive = true;
      state.lastTickMs = null;
      state.lastLive = "";
    }
    if (state.adActive) {
      const ad = playback.ad;
      const allowedAdvance = Math.max(0, now - ad.lastAt) * Math.max(1, Number(video.playbackRate) || 1) + 1500;
      if (video.seeking || video !== ad.video || source !== ad.source || raw < ad.lastRaw - 50 || raw - ad.lastRaw > allowedAdvance) ad.continuous = false;
      ad.lastRaw = raw;
      ad.lastAt = now;
      if (advertised) ad.exit = null;
      else if (!ad.exit || ad.exit.video !== video || ad.exit.source !== source || raw < ad.exit.raw - 50) ad.exit = { at: now, raw, video, source };
      // Wait through the short gap between ad clips and source restoration.
      // Keep the first stable resume timestamp, rather than subtracting the
      // post-ad debounce time or the time a paused/buffering ad spent on screen.
      if (ad.exit && now - ad.exit.at >= 400) {
        const covered = playback.timeline.breaks().some((part) => ad.start <= part.end + 500 && ad.exit.raw >= part.start - 500);
        if (!covered && ad.continuous && ad.exit.raw > ad.start) playback.timeline.addBreak(ad.start, ad.exit.raw);
        state.adActive = false;
        state.lastTickMs = null;
        ui.rateVideo = null;
        playback.ad = null;
        if (playback.pendingTimeline) installTimeline(playback.pendingTimeline, video);
        const pending = playback.pendingTrack;
        playback.pendingTrack = null;
        const scope = playback.scope;
        if (pending) queueMicrotask(() => { if (playbackScope() === scope) applyTrack(pending.text, pending.lang); });
        queueMicrotask(() => { if (!state.fullTrack) requestTrack(); });
      } else {
        syncAdUi();
        return ad.content;
      }
    }
    const content = playback.timeline.toContent(raw);
    playback.last = { video, source, raw, content, duration, at: now };
    syncAdUi();
    return content;
  }

  function subtitleTimeMs(video = videoEl()) {
    const content = contentTimeMs(video);
    return state.trackClock === "media" && video && !state.adActive ? video.currentTime * 1000 : content;
  }

  function send(type, payload = {}) {
    return lmSendMessage(type, payload);
  }

  function videoEl() {
    const videos = Array.from(document.querySelectorAll("video")).filter(elementVisible);
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
    ui.panel.innerHTML = `<div class="lm-panel-tabs"><button type="button" class="active" data-act="panel">字幕</button><button type="button" class="lm-prime-follow active" data-act="follow" aria-pressed="true" title="自动跟随当前字幕；向上滚动可暂停">跟随中</button></div><div class="lm-prime-ad-status" role="status" aria-live="polite" hidden></div><div class="lm-panel-body" tabindex="0" aria-label="字幕列表"></div><div class="lm-mini-help">停留查词 · 向上滚动暂停跟随 · A / S / D 切换字幕</div>`;
    ui.adStatus = ui.panel.querySelector(".lm-prime-ad-status");
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
      saveWord(word.dataset.word, cue?.text, null, word.dataset.lang, japaneseForWord(word));
    });
    root.addEventListener("contextmenu", (ev) => {
      const word = ev.target.closest(".lm-word");
      if (!word) return;
      ev.preventDefault();
      saveWord(word.dataset.word, state.cues[state.activeIndex]?.text, null, word.dataset.lang, japaneseForWord(word));
    });
    ui.phraseButton = document.createElement("button");
    ui.phraseButton.type = "button";
    ui.phraseButton.className = "lm-phrase-query";
    ui.phraseButton.hidden = true;
    ui.phraseButton.addEventListener("mousedown", (ev) => ev.preventDefault());
    ui.phraseButton.addEventListener("click", () => {
      const selection = ui.phraseSelection;
      if (!selection?.anchor?.isConnected) return;
      ui.phraseButton.hidden = true;
      ui.phraseSelection = null;
      ui.phraseActive = true;
      showDict(selection.anchor, selection);
    });
    document.documentElement.appendChild(ui.phraseButton);
    document.addEventListener("mouseup", onPhraseSelection);
    document.addEventListener("mousedown", (ev) => {
      if (ev.target === ui.phraseButton || ui.dict?.contains(ev.target)) return;
      ui.phraseButton.hidden = true;
      ui.phraseSelection = null;
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
    contentTimeMs();
    const video = videoEl();
    if (!state.adActive && video && ui.clockVideo !== video) {
      ui.clockVideo?.removeEventListener("seeking", resetPlaybackClock);
      ui.clockVideo?.removeEventListener("seeked", resetPlaybackClock);
      video.addEventListener("seeking", resetPlaybackClock);
      video.addEventListener("seeked", resetPlaybackClock);
      ui.clockVideo = video;
    }
    if (enabled && !state.adActive && video && (ui.rateVideo !== video || ui.appliedRate !== state.settings.playbackRate)) {
      video.playbackRate = Number(state.settings.playbackRate) || 1;
      ui.rateVideo = video;
      ui.appliedRate = state.settings.playbackRate;
    }
    if (!enabled) { hideDict(); if (ui.phraseButton) ui.phraseButton.hidden = true; }
  }

  function requestTrack() {
    if (!state.settings.enabled || state.adActive || hasAdIndicator()) return;
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
    if (ui.panelBody && !ui.panelBody.childElementCount) {
      renderPanel();
      renderCurrent();
    }
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
    if (languageMatches(lang, "ja")) lang = "ja";
    const key = JSON.stringify([text, lang, interactive, state.settings.japaneseFurigana]);
    if (target._lmWordsKey === key) return;
    target._lmWordsKey = key;
    lmJapaneseClient.invalidate(target);
    target.replaceChildren();
    if (!interactive) {
      target.textContent = text || "";
      return;
    }
    if (languageMatches(lang, "ja")) {
      lmJapaneseClient.render(target, text, {
        lang,
        furigana: state.settings.japaneseFurigana,
        known: (analysis) => lmJapaneseUi.isKnown(analysis, state.known),
        saved: isSavedJapanese,
        onAnalyzed: () => { syncWordMarkers(); followCurrentCue(); }
      });
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

  function japaneseForWord(word) {
    return languageMatches(word?.dataset.lang, "ja") ? lmJapaneseUi.tokenFrom(word) : undefined;
  }

  function isSavedJapanese(analysis) {
    const normalize = (value) => String(value || "").normalize("NFKC").trim().toLowerCase();
    const kana = (value) => normalize(value).replace(/[ァ-ヶ]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) - 0x60));
    return state.vocab.some((item) => {
      if (!languageMatches(item.lang, "ja")) return false;
      if (!item.japanese) return [analysis.lemma, analysis.surface].some((word) => word && normalize(item.word) === normalize(word));
      if (normalize(item.japanese.lemma || item.word) !== normalize(analysis.lemma || analysis.surface)) return false;
      const storedReading = kana(item.japanese.baseReading || item.japanese.reading);
      const currentReading = kana(analysis.baseReading || analysis.reading);
      if ((storedReading || currentReading) && storedReading !== currentReading) return false;
      return !item.japanese.entryId || !analysis.entryId || item.japanese.entryId === analysis.entryId;
    });
  }

  function onPhraseSelection(ev) {
    if (!state.settings.enabled || state.adActive || ev.target === ui.phraseButton || ui.dict?.contains(ev.target)) return;
    const selected = [ui.subs, ui.panel].map((root) => lmJapaneseUi.selectionFrom(root, document.getSelection?.())).find((item) => item && item.isPhrase && languageMatches(item.lang, "ja"));
    if (!selected) { ui.phraseButton.hidden = true; ui.phraseSelection = null; return; }
    const selection = document.getSelection();
    const node = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
    const anchor = node?.closest(".lm-word") || node?.querySelector(".lm-word");
    if (!anchor || !isPrimeWord(anchor)) return;
    hideDict();
    const cue = state.cues[Number(anchor.closest("[data-index]")?.dataset.index ?? state.activeIndex)];
    ui.phraseSelection = { ...selected, anchor, context: cue?.text || "" };
    ui.phraseButton.textContent = `查询词组：${selected.surface.length > 20 ? selected.surface.slice(0, 20) + "…" : selected.surface}`;
    ui.phraseButton.hidden = false;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const button = ui.phraseButton.getBoundingClientRect();
    ui.phraseButton.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - button.width - 8))}px`;
    ui.phraseButton.style.top = `${Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - button.height - 8))}px`;
  }

  function syncWordMarkers() {
    const saved = new Set(state.vocab.map((item) => `${item.lang}:${item.word.trim().toLowerCase()}`));
    for (const root of [ui.subs, ui.panel]) {
      root?.querySelectorAll(".lm-word").forEach((word) => {
        const japanese = japaneseForWord(word);
        const isSaved = japanese ? isSavedJapanese(japanese) : saved.has(`${word.dataset.lang}:${word.dataset.word.trim().toLowerCase()}`);
        word.classList.toggle("lm-saved", isSaved);
        word.classList.toggle("lm-known", japanese && lmJapaneseUi.isKnown(japanese, state.known));
        const rare = japanese ? japanese.common === false && !japanese.grammar : !lmIsCommonWord(word.dataset.word, word.dataset.lang);
        word.classList.toggle("lm-rare", !isSaved && !!state.settings.highlightRare && rare);
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
    const ms = subtitleTimeMs(video);
    if (state.adActive) return;
    const idx = video ? currentIndex(ms) : -1;
    state.activeIndex = idx;
    state.index = idx >= 0 ? idx : video ? navigationIndex(ms) : -1;
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
    // A programme track can arrive before the player adds a video element.
    // Keep its data until mount creates the UI instead of aborting startup.
    if (!ui.panelBody) return;
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
    contentTimeMs(video);
    if (!video || state.adActive) return;
    const target = state.trackClock === "media" ? ms : playback.timeline.toMedia(Math.max(0, ms));
    if (!Number.isFinite(target)) return;
    video.currentTime = Math.max(0, target / 1000 + 0.01);
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
    contentTimeMs(video);
    if (!state.settings.enabled || state.adActive || !video || !video.textTracks || state.fullTrack) return;
    const candidates = Array.from(video.textTracks).filter((track) => languageMatches(track.language, state.settings.learningLang));
    candidates.sort((a, b) => Number(b.mode === "showing") - Number(a.mode === "showing"));
    const chosen = candidates.find((track) => cuesFromTextTrack(track).length);
    if (!chosen) return;
    const best = cuesFromTextTrack(chosen);
    state.fullTrack = true;
    state.trackClock = "media";
    state.token += 1;
    state.cues = best;
    state.trackLang = chosen.language || state.settings.learningLang;
    state.native = [];
    renderPanel();
    renderCurrent();
    translateCues(best, state.token);
  }

  function scrapeLiveCaption() {
    const now = contentTimeMs();
    if (!state.settings.enabled || state.adActive || state.fullTrack) return;
    state.trackClock = "content";
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
      if (state.lastLive && previous && now > previous.start) previous.end = Math.min(previous.end, now);
      state.lastLive = "";
      return;
    }
    if (text === state.lastLive) {
      const current = state.cues[state.cues.length - 1];
      if (current && now >= current.start) current.end = Math.max(current.end, now + 500);
      return;
    }
    state.lastLive = text;
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
    contentTimeMs();
    if (!state.settings.enabled || state.adActive) return;
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
    state.trackClock = "content";
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

  async function showDict(wordEl, phrase = null) {
    contentTimeMs();
    if (!state.settings.enabled || state.adActive || !wordEl?.isConnected) return;
    hoverWord = wordEl;
    const token = ++lookupToken;
    const word = phrase?.surface || wordEl.dataset.word;
    const from = wordEl.dataset.lang || state.settings.learningLang;
    const japaneseHint = languageMatches(from, "ja") ? phrase ? { surface: word, isPhrase: !phrase.lookupForm } : japaneseForWord(wordEl) : undefined;
    ui.dict.classList.remove("lm-hidden");
    if (ui.dict.parentElement !== document.documentElement) document.documentElement.appendChild(ui.dict);
    ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-empty">正在查询…</div>`;
    placeDict(wordEl);
    const cue = state.cues[Number(wordEl.closest("[data-index]")?.dataset.index ?? state.index)];
    const context = phrase?.context || cue?.text || "";
    const res = await send("LM_LOOKUP", { word, from, to: state.settings.nativeLang, context, staged: true, ...(japaneseHint ? { japanese: japaneseHint } : {}) });
    if (token !== lookupToken || hoverWord !== wordEl) return;
    if (!wordEl.isConnected) {
      hideDict();
      return;
    }
    if (!res.ok) {
      ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-vocab-status" role="alert" data-error="true">${escapeHtml(res.error || "查询失败，请重试")}</div><button type="button" class="lm-chip" data-retry>重新查询</button>`;
      ui.dict.querySelector("[data-retry]").addEventListener("click", () => showDict(wordEl, phrase));
      placeDict(wordEl);
      return;
    }
    const data = res.result || { word, translation: "" };
    const japanese = languageMatches(from, "ja") ? data.japanese || (phrase ? { surface: word, lemma: word, pos: "词组" } : japaneseHint) : undefined;
    const persistentJapanese = lmJapaneseClient.persistent(japanese);
    const saveForm = persistentJapanese?.lemma || word;
    const detailed = (/^en(?:-|$)/i.test(from) || japanese) && typeof lmWordCard !== "undefined";
    const entries = (data.entries || []).map((entry) => {
      const items = (entry.items || []).map((item, index) => `<div class="lm-entry"><div class="lm-gloss">${index + 1}. ${japanese && item.gloss ? "译文：" : ""}${escapeHtml(item.gloss || item.definition || "")}</div>${japanese && item.definition && item.gloss && item.definition !== item.gloss ? `<div class="lm-def">原文释义：${escapeHtml(item.definition)}</div>` : ""}${item.example ? `<div class="lm-ex">例：${escapeHtml(item.example)}</div>` : ""}</div>`).join("");
      return `<div class="lm-pos">${escapeHtml(entry.pos || "")}</div>${items}`;
    }).join("");
    ui.dict.innerHTML = `
      <div class="lm-dict-head"><div><div class="lm-dict-word">${escapeHtml(data.word || word)}</div>${detailed && data.entries?.length ? '<div class="lm-card-muted">词典首义 · 更多含义见下方</div>' : ""}<div class="lm-dict-trans">${escapeHtml(data.translation || "")}</div></div></div>
      ${String(from).toLowerCase().startsWith("en") ? `<div class="lm-accents">
        <button type="button" data-accent="us">美式<span class="lm-ipa">${escapeHtml(data.phoneticUs || data.phonetic || "")}</span></button>
        <button type="button" data-accent="uk">英式<span class="lm-ipa">${escapeHtml(data.phoneticUk || data.phonetic || "")}</span></button>
      </div>` : `<div class="lm-accents"><button type="button" data-accent="read">朗读<span class="lm-ipa">${escapeHtml(data.phonetic || "")}</span></button></div>`}
      ${japanese ? `<details class="lm-card-morphology"><summary>词形与语法 · ${escapeHtml(japanese.lemma || word)}</summary>${lmJapaneseUi.cardHtml(japanese)}</details>` : ""}
      ${detailed ? lmWordCard.html(data, context, from) : `${entries || `<div class="lm-dict-trans">${escapeHtml(data.translation || "暂无释义")}</div>`}<div class="lm-dict-context">${escapeHtml(context)}</div>`}
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
      word: saveForm,
      lang: from,
      japanese: persistentJapanese,
      send,
      createItem: () => ({
        word: saveForm,
        translation: data.translation || "",
        phonetic: data.phonetic || "",
        lang: from,
        nativeLang: state.settings.nativeLang,
        context,
        ...(persistentJapanese ? { japanese: persistentJapanese } : {}),
        videoTitle: document.title,
        videoUrl: location.href,
        time: contentTimeMs() / 1000
      }),
      onChange: ({ saved, item }) => {
        state.vocab = state.vocab.filter((row) => row.id !== item?.id);
        if (saved) state.vocab.unshift(item);
        syncWordMarkers();
        if (hoverWord?.isConnected && dictOpen()) placeDict(hoverWord);
      }
    });
    if (detailed) {
      const vocabButton = ui.vocabButton;
      lmWordCard.bind(ui.dict, {
        data, context, from, to: state.settings.nativeLang, send,
        isCurrent: () => token === lookupToken,
        onSaveMeaning: (meaning) => vocabButton.saveMeaning(meaning),
        onQuery: (surface) => showDict(wordEl, { surface, context, lookupForm: true }),
        onResize: () => { if (wordEl.isConnected && dictOpen()) placeDict(wordEl); }
      });
    }
    placeDict(wordEl);
  }

  function hideDict() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverWord = null;
    ui.phraseActive = false;
    lookupToken += 1;
    ui.dict?.classList.add("lm-hidden");
  }

  function isPrimeWord(word) {
    return !!(state.settings.enabled && !state.adActive && word && (ui.subs?.contains(word) || ui.panel?.contains(word)));
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
      if (ui.dict?.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
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
    if (ui.phraseActive || ui.phraseSelection || ui.phraseButton?.contains(ev.target)) return;
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
    if (ui.phraseButton) ui.phraseButton.hidden = true;
    ui.phraseSelection = null;
  }

  async function saveWord(word, context, lookup, lang = state.trackLang || state.settings.learningLang, japaneseHint) {
    if (languageMatches(lang, "ja")) lang = "ja";
    lmNotify("正在加入生词本…", "pending");
    const data = lookup || (await send("LM_LOOKUP", {
      word,
      from: lang,
      to: state.settings.nativeLang,
      context: context || "",
      ...(japaneseHint ? { japanese: japaneseHint } : {})
    })).result || {};
    const japanese = languageMatches(lang, "ja") ? lmJapaneseClient.persistent(data.japanese || japaneseHint) : undefined;
    const saveForm = japanese?.lemma || word;
    const saved = await send("LM_VOCAB_ADD", {
      item: {
        word: saveForm,
        translation: data.translation || "",
        phonetic: data.phonetic || "",
        lang,
        nativeLang: state.settings.nativeLang,
        context: context || "",
        ...(japanese ? { japanese } : {}),
        videoTitle: document.title,
        videoUrl: location.href,
        time: contentTimeMs() / 1000
      }
    });
    if (saved.ok && saved.item) {
      state.vocab = state.vocab.filter((item) => item.id !== saved.item.id);
      state.vocab.unshift(saved.item);
      syncWordMarkers();
      ui.vocabButton?.refresh();
      lmNotify(`已加入生词本：${saveForm}`);
    } else {
      lmNotify(saved.error || "加入生词本失败，请重试", "error");
    }
  }

  function isTyping(target) {
    const tag = target?.tagName || "";
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
  }

  function onKeyDown(ev) {
    if (!state.settings.enabled || !ui.subs || ev.ctrlKey || ev.altKey || ev.metaKey || isTyping(ev.target) || !state.cues.length) return;
    contentTimeMs();
    if (state.adActive) return;
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
    contentTimeMs();
    if (state.peeking && state.settings.enabled && !state.adActive) videoEl()?.play().catch(() => {});
    state.peeking = false;
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);

  function resetPlaybackClock() {
    state.lastTickMs = null;
    if (playback.ad) playback.ad.continuous = false;
  }

  function onTick() {
    const video = videoEl();
    if (!video) return;
    const wasAd = state.adActive;
    const ms = subtitleTimeMs(video);
    if (!state.settings.enabled || state.adActive) return;
    if (wasAd) syncSettings();
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
    checkPlaybackSession();
    if (msg.scope && msg.scope !== playback.scope) return;
    if (msg.type === "LM_PRIME_MPD" && msg.role === "content" && typeof msg.text === "string" && msg.text.length <= 5000000) {
      // Page Trusted Types may prohibit DOMParser in MAIN world. Parse the
      // observed XML in the extension's isolated world using the same parser.
      try {
        const manifest = lmPrimeManifest.parse(msg.text, { adActive: msg.adActive === true });
        if (manifest && installTimeline({ ...msg, ...manifest })) renderCurrent();
      } catch (_) { /* keep the observed ad clock if the manifest is unusable */ }
    }
    if (msg.type === "LM_PRIME_TIMELINE" && installTimeline(msg)) renderCurrent();
    if (msg.type === "LM_TRACK") {
      mount();
      contentTimeMs();
      if (state.adActive) {
        if (msg.role === "content" && !state.fullTrack) playback.pendingTrack = { text: msg.text, lang: msg.lang };
        return;
      }
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
    if (area === "local" && (changes.vocab || changes.known)) {
      if (changes.vocab) state.vocab = changes.vocab.newValue || [];
      if (changes.known) state.known = changes.known.newValue || {};
      syncWordMarkers();
      ui.vocabButton?.refresh();
    }
  });

  async function boot() {
    const [res, vocab] = await Promise.all([send("LM_GET_SETTINGS"), send("LM_VOCAB_LIST")]);
    if (res.settings) state.settings = lmMergeSettings(res.settings);
    if (vocab.ok) { state.vocab = vocab.vocab; state.known = vocab.known || {}; }
    if (!res.ok) lmNotify(res.error || "设置读取失败，请刷新页面重试", "error");
    mount();
    requestTrack();
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
      contentTimeMs();
      syncTextTracks();
      scrapeLiveCaption();
      onTick();
    }, 250);
  }

  boot();
})();
