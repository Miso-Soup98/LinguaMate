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
  const captionCache = new Map();

  const ui = {};

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ type }, payload), (res) => {
        resolve(res || { ok: false, error: "no_response" });
      });
    });
  }

  function toast(text) {
    let el = $(".lm-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "lm-toast";
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
    el.classList.remove("lm-hidden");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add("lm-hidden"), 1600);
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

  function renderWords(target, text, lang) {
    target.innerHTML = "";
    const saved = new Set(state.vocab.map((item) => item.word.toLowerCase()));
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
    ui.learningSelect = $("#lm-learning", root);
    ui.nativeSelect = $("#lm-native", root);

    LM_LANGUAGES.forEach((lang) => {
      const opt1 = new Option(lang.native, lang.code);
      const opt2 = new Option(lang.native, lang.code);
      ui.learningSelect.add(opt1);
      ui.nativeSelect.add(opt2);
    });

    ui.toolbar.addEventListener("click", onToolbarClick);
    ui.learningSelect.addEventListener("change", () => {
      persist({ learningLang: ui.learningSelect.value });
      loadCaptions(true);
    });
    ui.nativeSelect.addEventListener("change", () => {
      persist({ nativeLang: ui.nativeSelect.value });
      loadCaptions(true);
    });

    ui.subs.addEventListener("contextmenu", (ev) => {
      const word = ev.target.closest(".lm-word");
      if (!word) return;
      ev.preventDefault();
      saveWord(word.dataset.word);
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
      saveWord(word.dataset.word, cueForWord(word)?.text);
    });
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
    ensureUi();
    const box = playerBox();
    if (box && ui.root.parentElement !== box) {
      box.style.position = box.style.position || "relative";
      box.appendChild(ui.root);
    }
    placePanel();
    syncToolbar();
    applyCaptionVisibility();
  }

  function placePanel() {
    if (!ui.panel) return;
    const secondary = document.getElementById("secondary");
    if (secondary && state.settings.panelOpen) {
      secondary.classList.add("lm-has-panel");
      if (!secondary.contains(ui.panel)) secondary.prepend(ui.panel);
      ui.root.classList.remove("lm-floating-panel");
    } else if (state.settings.panelOpen) {
      ui.root.classList.add("lm-floating-panel");
      if (!ui.root.contains(ui.panel)) ui.root.appendChild(ui.panel);
    } else {
      ui.panel.remove();
    }
  }

  function syncToolbar() {
    if (!ui.toolbar) return;
    const map = {
      toggle: state.settings.enabled,
      autoPause: state.settings.autoPause,
      listen: state.settings.listenMode,
      native: state.settings.showNative,
      panel: state.settings.panelOpen
    };
    ui.toolbar.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.classList.toggle("active", !!map[btn.dataset.act]);
    });
    ui.learningSelect.value = state.settings.learningLang;
    ui.nativeSelect.value = state.settings.nativeLang;
    ui.subs.classList.toggle("lm-listen", state.settings.listenMode);
    ui.learningLine.style.fontSize = `${state.settings.fontSize}px`;
    ui.nativeLine.style.fontSize = `${Math.max(14, state.settings.fontSize - 4)}px`;
    ui.root.classList.toggle("lm-hidden", !state.settings.enabled);
    if (ui.panel) ui.panel.classList.toggle("lm-hidden", !state.settings.enabled || !state.settings.panelOpen);
    const video = videoEl();
    if (video && state.settings.enabled) video.playbackRate = Number(state.settings.playbackRate) || 1;
  }

  function applyCaptionVisibility() {
    document.documentElement.classList.toggle(
      "lm-hide-yt-captions",
      !!(state.settings.enabled && state.settings.hideYoutubeCaptions)
    );
  }

  async function persist(patch) {
    state.settings = lmMergeSettings(Object.assign({}, state.settings, patch));
    syncToolbar();
    placePanel();
    applyCaptionVisibility();
    renderCurrent();
    await send("LM_SET_SETTINGS", { settings: patch });
  }

  async function onToolbarClick(ev) {
    const btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "toggle") await persist({ enabled: !state.settings.enabled });
    if (act === "autoPause") await persist({ autoPause: !state.settings.autoPause });
    if (act === "listen") await persist({ listenMode: !state.settings.listenMode });
    if (act === "native") await persist({ showNative: !state.settings.showNative });
    if (act === "panel") await persist({ panelOpen: !state.settings.panelOpen });
  }

  function parseEvents(data) {
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
      rows.push({
        start: event.tStartMs || 0,
        end: (event.tStartMs || 0) + (event.dDurationMs || 1500),
        text
      });
    }
    return mergeCues(rows);
  }

  function mergeCues(rows) {
    const out = [];
    for (const row of rows) {
      const prev = out[out.length - 1];
      if (
        prev &&
        row.start - prev.end < 700 &&
        prev.text.length + row.text.length < 90 &&
        !/[.!?。！？]$/.test(prev.text)
      ) {
        prev.text = `${prev.text} ${row.text}`.replace(/\s+/g, " ").trim();
        prev.end = Math.max(prev.end, row.end);
      } else {
        out.push(Object.assign({}, row));
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

  function parseXml(xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const rows = [];
    Array.from(doc.getElementsByTagName("text")).forEach((node) => {
      const start = parseFloat(node.getAttribute("start") || "0") * 1000;
      const dur = parseFloat(node.getAttribute("dur") || "1.5") * 1000;
      const text = cleanCaption(node.textContent);
      if (text) rows.push({ start, end: start + dur, text });
    });
    Array.from(doc.getElementsByTagName("p")).forEach((node) => {
      const start = parseFloat(node.getAttribute("t") || "0");
      const dur = parseFloat(node.getAttribute("d") || "1500");
      const text = cleanCaption(node.textContent);
      if (text) rows.push({ start, end: start + dur, text });
    });
    return mergeCues(rows);
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

  function parseCaptions(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("WEBVTT")) return parseVtt(trimmed);
    if (trimmed[0] === "<") return parseXml(trimmed);
    try {
      if (trimmed[0] === "{" || trimmed[0] === "[") return parseEvents(JSON.parse(trimmed));
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
    return parseCaptions(result && result.text);
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
    const videoId = currentVideoId();
    if (!videoId) return;
    const key = cacheKey(videoId);
    if (!force && videoId === state.videoId && state.cues.length) return;
    const cached = captionCache.get(key);
    if (cached && !force) {
      state.videoId = videoId;
      state.title = document.title.replace(/ - YouTube$/, "");
      state.cues = cached.cues;
      state.nativeCues = cached.nativeCues;
      state.tracks = cached.tracks || [];
      showReady();
      return;
    }
    const gen = ++state.loadGen;
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
    state.cues = await fetchTrack(learning, videoId);
    if (gen !== state.loadGen) return;
    if (!state.cues.length) {
      state.status = "error";
      state.statusText = "已经找到字幕轨道，但 YouTube 没有返回字幕正文。请先点播放器的 CC 打开字幕，再刷新页面。";
      renderPanel();
      renderCurrent();
      return;
    }
    showReady();

    const translated = nativeExact && nativeExact.baseUrl !== learning.baseUrl
      ? await fetchTrack(nativeExact, videoId)
      : await fetchTrack(learning, videoId, lmYtCode(state.settings.nativeLang));
    if (gen !== state.loadGen) return;
    state.nativeCues = translated.length ? alignCues(state.cues, translated) : [];
    captionCache.set(key, {
      cues: state.cues,
      nativeCues: state.nativeCues,
      tracks
    });
    if (state.tab === "subs") renderTranscript();
    renderCurrent();
  }

  function alignCues(source, target) {
    if (!target.length) return [];
    return source.map((cue) => {
      const mid = (cue.start + cue.end) / 2;
      let best = target[0];
      let score = Infinity;
      for (const row of target) {
        const dist = Math.abs((row.start + row.end) / 2 - mid);
        if (dist < score) {
          score = dist;
          best = row;
        }
      }
      return { start: cue.start, end: cue.end, text: best.text };
    });
  }

  function currentIndex(ms) {
    for (let i = 0; i < state.cues.length; i += 1) {
      const cue = state.cues[i];
      if (ms >= cue.start && ms < cue.end + 80) return i;
    }
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
    state.index = idx;
    const cue = state.cues[idx];
    const native = state.nativeCues[idx];
    ui.learningLine.classList.toggle("lm-hidden", !state.settings.showLearning || !cue);
    ui.nativeLine.classList.toggle("lm-hidden", !state.settings.showNative || !native);
    if (cue) renderWords(ui.learningLine, cue.text, state.settings.learningLang);
    if (native) renderWords(ui.nativeLine, native.text, state.settings.nativeLang);
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
    ui.panel.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === state.tab);
    });
    if (state.tab === "subs") renderTranscript();
    if (state.tab === "words") renderWordsTab();
    if (state.tab === "learn") renderLearnTab();
  }

  function renderTranscript() {
    if (state.status === "loading" || state.status === "fetching") {
      ui.panelBody.innerHTML = `<div class="lm-empty">正在读取字幕…</div>`;
      return;
    }
    if (!state.cues.length) {
      ui.panelBody.innerHTML = `<div class="lm-empty">${escapeHtml(state.statusText || "当前视频没有可用字幕。")}</div>`;
      return;
    }
    const scroll = ui.panelBody.scrollTop;
    const fragment = document.createDocumentFragment();
    state.cues.forEach((cue, i) => {
      const row = document.createElement("div");
      row.className = `lm-cue${i === state.index ? " active" : ""}`;
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
      if (native) {
        const nativeLine = document.createElement("div");
        nativeLine.className = "lm-cue-native";
        renderWords(nativeLine, native, state.settings.nativeLang);
        row.append(nativeLine);
      }
      fragment.append(row);
    });
    ui.panelBody.replaceChildren(fragment);
    ui.panelBody.scrollTop = scroll;
  }

  function renderWordsTab() {
    const mine = state.vocab;
    if (!mine.length) {
      ui.panelBody.innerHTML = `<div class="lm-empty">还没有生词。点击字幕中的单词查阅，或右键直接收藏。</div>`;
      return;
    }
    ui.panelBody.innerHTML = mine
      .slice(0, 80)
      .map(
        (item) => `<div class="lm-vocab-item" data-id="${item.id}">
          <div><strong>${escapeHtml(item.word)}</strong><span>${escapeHtml(item.translation || "")}</span></div>
          <div><span>${escapeHtml(item.context || "")}</span></div>
        </div>`
      )
      .join("");
    ui.panelBody.querySelectorAll(".lm-vocab-item").forEach((el) => {
      el.addEventListener("click", () => {
        const item = state.vocab.find((row) => row.id === el.dataset.id);
        if (item) playPronunciation(item.word, item.lang, state.settings.accent, "");
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

  function uniqueWords() {
    const map = new Map();
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

  function renderLearnTab() {
    const words = uniqueWords();
    const saved = new Set(state.vocab.map((item) => item.word.toLowerCase()));
    const knownCount = words.filter((item) => {
      const key = `${state.settings.learningLang}:${item.word}`;
      return state.known[key] || saved.has(item.word) || lmIsCommonWord(item.word, state.settings.learningLang);
    }).length;
    const coverage = words.length ? Math.round((knownCount / words.length) * 100) : 0;
    const suggestions = words
      .filter((item) => !saved.has(item.word) && !lmIsCommonWord(item.word, state.settings.learningLang))
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
                (item) => `<div class="lm-learn-item">
                  <div><strong>${escapeHtml(item.word)}</strong><span>出现 ${item.count} 次</span></div>
                  <button class="lm-chip" data-save="${escapeHtml(item.word)}" data-context="${escapeHtml(item.context)}">收藏</button>
                </div>`
              )
              .join("")
          : `<div class="lm-empty">没有明显的生词建议，或字幕尚未加载。</div>`
      }
    `;
    ui.panelBody.querySelectorAll("[data-save]").forEach((btn) => {
      btn.addEventListener("click", () => saveWord(btn.dataset.save, btn.dataset.context));
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
    if (play) video.play().catch(() => {});
    else video.pause();
    renderCurrent();
  }

  function replayCurrent() {
    const cue = state.cues[state.index] || state.cues[currentIndex((videoEl()?.currentTime || 0) * 1000)];
    if (cue) seekTo(cue.start, true);
  }

  function jump(delta, pause) {
    const idx = Math.min(state.cues.length - 1, Math.max(0, (state.index < 0 ? 0 : state.index) + delta));
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

  function renderDict(data, cue, from) {
    const english = String(from || "").toLowerCase().startsWith("en");
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
        <div class="lm-dict-actions"><button data-known="1">认识</button></div>
      </div>
      ${accents}
      ${entryHtml}
      <div class="lm-dict-context">${escapeHtml(cue?.text || "")}</div>
      <button class="lm-dict-save">加入生词本</button>
    `;
    ui.dict.querySelectorAll("[data-accent]").forEach((button) => {
      button.addEventListener("click", async () => {
        const chosen = button.dataset.accent === "uk" ? "uk" : "us";
        if (button.dataset.accent !== "read") {
          state.settings.accent = chosen;
          ui.dict.querySelectorAll("[data-accent]").forEach((item) => item.classList.toggle("active", item === button));
          await send("LM_SET_SETTINGS", { settings: { accent: chosen } });
        }
        const audioUrl = chosen === "uk" ? data.audioUk : data.audioUs;
        playPronunciation(data.word, from, chosen, audioUrl);
      });
    });
    ui.dict.querySelector("[data-known]").addEventListener("click", async () => {
      await send("LM_MARK_KNOWN", { word: data.word, lang: state.settings.learningLang, known: true });
      state.known[`${state.settings.learningLang}:${lmNormalizeWord(data.word)}`] = true;
      toast("已标记为认识");
      renderCurrent();
    });
    ui.dict.querySelector(".lm-dict-save").addEventListener("click", () => saveWord(data.word, cue?.text, data));
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
  }

  function hideDict() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoverWord = null;
    state.dictToken += 1;
    stopSpeech();
    if (ui.dict) ui.dict.classList.add("lm-hidden");
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (hoverWord && hoverWord.matches(":hover")) return;
      if (ui.dict && ui.dict.matches(":hover")) return;
      hideDict();
    }, 160);
  }

  function scheduleShow(wordEl) {
    clearTimeout(hideTimer);
    if (hoverWord === wordEl && ui.dict && !ui.dict.classList.contains("lm-hidden")) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showDict(wordEl), 60);
  }

  async function showDict(wordEl) {
    if (!wordEl || !wordEl.isConnected) return;
    hoverWord = wordEl;
    rememberCue(wordEl);
    const word = wordEl.dataset.word;
    const from = wordEl.dataset.lang || state.settings.learningLang;
    const cue = cueForWord(wordEl);
    const token = ++state.dictToken;
    ui.dict.classList.remove("lm-hidden");
    ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-empty">正在查询…</div>`;
    placeDict(wordEl);
    const res = await send("LM_LOOKUP", {
      word,
      from,
      to: state.settings.nativeLang,
      context: cue?.text || ""
    });
    if (token !== state.dictToken || hoverWord !== wordEl) return;
    const data = res.result || { word, translation: "", phonetic: "", senses: [], entries: [] };
    renderDict(data, cue, from);
    placeDict(wordEl);
  }

  function onWordHover(ev) {
    const word = ev.target.closest && ev.target.closest(".lm-word");
    if (word && (ui.subs?.contains(word) || ui.panel?.contains(word))) {
      scheduleShow(word);
      return;
    }
    if (ui.dict && ui.dict.contains(ev.target)) clearTimeout(hideTimer);
  }

  function onWordLeave(ev) {
    const target = ev.target;
    const next = ev.relatedTarget;
    const leftWord = target.closest && target.closest(".lm-word");
    const leftCard = ui.dict && ui.dict.contains(target);
    if (!leftWord && !leftCard) return;
    if (next && ((leftWord && leftWord.contains(next)) || (ui.dict && ui.dict.contains(next)) || (next.closest && next.closest(".lm-word")))) {
      return;
    }
    scheduleHide();
  }

  async function saveWord(word, context, lookup) {
    const cue = state.cues[state.index];
    let data = lookup;
    if (!data) {
      const res = await send("LM_LOOKUP", {
        word,
        from: state.settings.learningLang,
        to: state.settings.nativeLang,
        context: context || cue?.text || ""
      });
      data = res.result || { word, translation: "" };
    }
    const saved = await send("LM_VOCAB_ADD", {
      item: {
        word,
        translation: data.translation,
        phonetic: data.phonetic,
        lang: state.settings.learningLang,
        nativeLang: state.settings.nativeLang,
        context: context || cue?.text || "",
        videoTitle: state.title,
        videoUrl: location.href,
        time: videoEl()?.currentTime || 0
      }
    });
    if (saved.item) {
      const idx = state.vocab.findIndex((row) => row.id === saved.item.id);
      if (idx >= 0) state.vocab[idx] = saved.item;
      else state.vocab.unshift(saved.item);
      toast(`已收藏 ${word}`);
      renderCurrent();
      if (state.tab !== "subs") renderPanel();
    }
  }

  function onTick() {
    if (!state.settings.enabled) return;
    const video = videoEl();
    if (!video) return;
    const idx = currentIndex(video.currentTime * 1000);
    if (idx !== state.index) {
      renderCurrent();
      if (state.settings.autoPause && idx > state.lastAutoPause && !state.peeking && !video.paused) {
        state.lastAutoPause = idx;
        video.pause();
      }
    }
  }

  function isTyping(target) {
    const tag = (target && target.tagName) || "";
    return tag === "INPUT" || tag === "TEXTAREA" || (target && target.isContentEditable);
  }

  function onKeyDown(ev) {
    if (!state.settings.enabled || isTyping(ev.target)) return;
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
    if (!state.settings.enabled || isTyping(ev.target)) return;
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

  async function refreshStore() {
    const [settingsRes, vocabRes] = await Promise.all([
      send("LM_GET_SETTINGS"),
      send("LM_VOCAB_LIST")
    ]);
    if (settingsRes.settings) state.settings = lmMergeSettings(settingsRes.settings);
    state.vocab = vocabRes.vocab || [];
    state.known = vocabRes.known || {};
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
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes) refreshStore().then(() => syncToolbar());
    if (area === "local") refreshStore().then(() => renderPanel());
  });

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("mouseover", onWordHover);
  document.addEventListener("mouseout", onWordLeave);
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
