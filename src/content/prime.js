(() => {
  if (window.__linguaMatePrimeUi) return;
  window.__linguaMatePrimeUi = true;

  const state = {
    settings: lmMergeSettings(),
    cues: [],
    native: [],
    index: -1,
    vocab: [],
    token: 0
  };

  const ui = {};
  let hideTimer = 0;
  let hoverWord = null;

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ type }, payload), (res) => resolve(res || {}));
    });
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
    ui.subs = root.querySelector("#lm-subs");
    ui.learningLine = root.querySelector("#lm-learning-line");
    ui.nativeLine = root.querySelector("#lm-native-line");
    ui.dict = root.querySelector("#lm-dict");
    ui.panel = document.createElement("section");
    ui.panel.className = "lm-panel lm-prime-panel";
    ui.panel.innerHTML = `<div class="lm-panel-tabs"><button type="button" class="active" data-act="panel">字幕</button></div><div class="lm-panel-body"></div><div class="lm-mini-help">悬停查词 · 右键收藏 · A 上一句 · S 重播 · D 下一句</div>`;
    ui.panelBody = ui.panel.querySelector(".lm-panel-body");
    root.querySelector("[data-act='panel']").addEventListener("click", togglePanel);
    ui.panel.addEventListener("click", (ev) => {
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
      saveWord(word.dataset.word);
    });
    document.addEventListener("mouseover", onHover);
    document.addEventListener("mouseout", onLeave);
    makeDraggable(root.querySelector(".lm-toolbar"), root.querySelector(".lm-toolbar"), "lmPrimeToolbar");
    makeDraggable(ui.panel.querySelector(".lm-panel-tabs"), ui.panel, "lmPrimePanel");
    restoreDrag(root.querySelector(".lm-toolbar"), "lmPrimeToolbar");
    restoreDrag(ui.panel, "lmPrimePanel");
  }

  function makeDraggable(handle, target, key) {
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(".lm-word, .lm-panel-body, .lm-mini-help")) return;
      const rect = target.getBoundingClientRect();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const originX = rect.left;
      const originY = rect.top;
      let moved = false;
      const move = (event) => {
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        target.classList.add("lm-dragging");
        const left = Math.min(window.innerWidth - 48, Math.max(0, originX + dx));
        const top = Math.min(window.innerHeight - 40, Math.max(0, originY + dy));
        target.style.left = `${Math.round(left)}px`;
        target.style.top = `${Math.round(top)}px`;
        target.style.right = "auto";
        target.style.bottom = "auto";
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        target.classList.remove("lm-dragging");
        if (!moved) return;
        target.dataset.suppressClick = "1";
        chrome.storage.local.set({
          [key]: { left: target.style.left, top: target.style.top }
        });
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
    chrome.storage.local.get(key, (stored) => {
      const pos = stored && stored[key];
      if (!pos || !pos.left || !pos.top) return;
      target.style.left = pos.left;
      target.style.top = pos.top;
      target.style.right = "auto";
    });
  }

  function togglePanel() {
    ui.panel.classList.toggle("lm-collapsed");
  }

  function placeOverlay() {
    const video = videoEl();
    if (!video || !ui.root) return;
    const rect = video.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) {
      ui.root.classList.add("lm-hidden");
      return;
    }
    ui.root.classList.remove("lm-hidden");
    ui.root.style.left = `${Math.max(0, rect.left)}px`;
    ui.root.style.top = `${Math.max(0, rect.top)}px`;
    ui.root.style.width = `${Math.min(rect.width, window.innerWidth - Math.max(0, rect.left))}px`;
    ui.root.style.height = `${Math.min(rect.height, window.innerHeight - Math.max(0, rect.top))}px`;
  }

  function mount() {
    if (!videoEl()) return;
    ensureUi();
    if (ui.root.parentElement !== document.documentElement) document.documentElement.appendChild(ui.root);
    if (ui.panel.parentElement !== document.documentElement) document.documentElement.appendChild(ui.panel);
    document.documentElement.classList.add("lm-prime-captions");
    ui.learningLine.style.fontSize = `${state.settings.fontSize || 22}px`;
    ui.nativeLine.style.fontSize = `${Math.max(14, (state.settings.fontSize || 22) - 4)}px`;
    placeOverlay();
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function parseClock(value) {
    const raw = String(value || "").trim();
    if (!raw) return 0;
    if (/ms$/.test(raw)) return parseFloat(raw);
    if (/s$/.test(raw)) return parseFloat(raw) * 1000;
    const parts = raw.split(":");
    if (parts.length >= 3) {
      const hours = parseFloat(parts[0]) || 0;
      const minutes = parseFloat(parts[1]) || 0;
      const seconds = parseFloat(parts[2].replace(",", ".")) || 0;
      return ((hours * 60 + minutes) * 60 + seconds) * 1000;
    }
    const numeric = parseFloat(raw);
    return Number.isFinite(numeric) ? numeric * 1000 : 0;
  }

  function localNameNodes(root, name) {
    const found = [];
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.localName === name) found.push(node);
      Array.from(node.children || []).forEach(walk);
    };
    walk(root);
    return found;
  }

  function parseTrack(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith("<")) {
      const doc = new DOMParser().parseFromString(trimmed, "text/xml");
      const lang = doc.documentElement?.getAttribute("xml:lang") || doc.documentElement?.getAttribute("lang") || "";
      const cues = localNameNodes(doc, "p").map((node) => {
        const start = parseClock(node.getAttribute("begin"));
        const endAttr = node.getAttribute("end");
        const end = endAttr ? parseClock(endAttr) : start + parseClock(node.getAttribute("dur") || "2s");
        const line = (node.textContent || "").replace(/\s+/g, " ").trim();
        return { start, end: end > start ? end : start + 1500, text: line };
      }).filter((cue) => cue.text);
      return { lang, cues };
    }
    if (trimmed.startsWith("{")) {
      const data = JSON.parse(trimmed);
      const list = data.timedtext?.text || data.cues || data.subtitles || [];
      const cues = (Array.isArray(list) ? list : []).map((item) => ({
        start: Number(item.start || item.begin || 0),
        end: Number(item.end || item.start + 1500 || 0),
        text: String(item.content || item.text || "").replace(/\s+/g, " ").trim()
      })).filter((cue) => cue.text);
      return { lang: data.lang || "", cues };
    }
    return { lang: "", cues: [] };
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

  function renderWords(target, text, lang) {
    target.replaceChildren();
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
      target.appendChild(span);
    });
  }

  function currentIndex(ms) {
    for (let i = 0; i < state.cues.length; i += 1) {
      if (ms >= state.cues[i].start && ms < state.cues[i].end + 80) return i;
    }
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
    state.index = idx;
    const cue = state.cues[idx];
    const native = state.native[idx] || "";
    ui.learningLine.classList.toggle("lm-hidden", !cue);
    ui.nativeLine.classList.toggle("lm-hidden", !native);
    if (cue) renderWords(ui.learningLine, cue.text, state.settings.learningLang);
    if (native) renderWords(ui.nativeLine, native, state.settings.nativeLang);
    ui.panelBody.querySelectorAll(".lm-cue").forEach((el, i) => el.classList.toggle("active", i === idx));
  }

  function renderPanel() {
    if (!state.cues.length) {
      ui.panelBody.innerHTML = `<div class="lm-empty">还没有读到字幕。请在 Amazon 播放器里打开你要学习的字幕语言，语伴会自动接上，不用刷新页面。</div>`;
      return;
    }
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
      if (state.native[i]) {
        const native = document.createElement("div");
        native.className = "lm-cue-native";
        native.textContent = state.native[i];
        row.append(native);
      }
      fragment.append(row);
    });
    ui.panelBody.replaceChildren(fragment);
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function seekTo(ms, play) {
    const video = videoEl();
    if (!video) return;
    video.currentTime = Math.max(0, ms / 1000 + 0.01);
    if (play) video.play().catch(() => {});
    else video.pause();
    renderCurrent();
  }

  async function translateCues(cues, token) {
    state.native = new Array(cues.length).fill("");
    const size = 30;
    for (let start = 0; start < cues.length; start += size) {
      if (token !== state.token) return;
      const slice = cues.slice(start, start + size);
      const packed = slice.map((cue, index) => `[${start + index}] ${cue.text}`).join("\n");
      const res = await send("LM_TRANSLATE", { text: packed, from: "auto", to: state.settings.nativeLang });
      const translated = res.result?.text || "";
      const pattern = /\[(\d+)\]\s*([\s\S]*?)(?=\s*\[\d+\]|$)/g;
      translated.replace(pattern, (_, index, line) => {
        state.native[Number(index)] = line.replace(/\s+/g, " ").trim();
        return "";
      });
      renderPanel();
      renderCurrent();
    }
  }

  function applyTrack(text) {
    let parsed;
    try {
      parsed = parseTrack(text);
    } catch (err) {
      return;
    }
    if (!parsed.cues.length) return;
    state.token += 1;
    state.cues = parsed.cues;
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
    hoverWord = wordEl;
    const word = wordEl.dataset.word;
    const from = wordEl.dataset.lang || state.settings.learningLang;
    ui.dict.classList.remove("lm-hidden");
    if (ui.dict.parentElement !== document.documentElement) document.documentElement.appendChild(ui.dict);
    ui.dict.innerHTML = `<div class="lm-dict-word">${escapeHtml(word)}</div><div class="lm-empty">正在查询…</div>`;
    placeDict(wordEl);
    const cue = state.cues[Number(wordEl.closest("[data-index]")?.dataset.index ?? state.index)];
    const res = await send("LM_LOOKUP", { word, from, to: state.settings.nativeLang, context: cue?.text || "" });
    if (hoverWord !== wordEl) return;
    const data = res.result || { word, translation: "" };
    const entries = (data.entries || []).map((entry) => {
      const items = (entry.items || []).map((item, index) => `<div class="lm-entry"><div class="lm-gloss">${index + 1}. ${escapeHtml(item.gloss || item.definition || "")}</div>${item.example ? `<div class="lm-ex">例：${escapeHtml(item.example)}</div>` : ""}</div>`).join("");
      return `<div class="lm-pos">${escapeHtml(entry.pos || "")}</div>${items}`;
    }).join("");
    ui.dict.innerHTML = `
      <div class="lm-dict-head"><div><div class="lm-dict-word">${escapeHtml(data.word || word)}</div><div class="lm-dict-trans">${escapeHtml(data.translation || "")}</div></div></div>
      <div class="lm-accents">
        <button type="button" data-accent="us">美式<span class="lm-ipa">${escapeHtml(data.phoneticUs || data.phonetic || "")}</span></button>
        <button type="button" data-accent="uk">英式<span class="lm-ipa">${escapeHtml(data.phoneticUk || data.phonetic || "")}</span></button>
      </div>
      ${entries || `<div class="lm-dict-trans">${escapeHtml(data.translation || "暂无释义")}</div>`}
      <div class="lm-dict-context">${escapeHtml(cue?.text || "")}</div>
      <button type="button" class="lm-dict-save">加入生词本</button>
    `;
    ui.dict.querySelectorAll("[data-accent]").forEach((button) => {
      button.addEventListener("click", () => send("LM_PRONOUNCE", {
        text: word,
        tl: button.dataset.accent === "uk" ? "en-GB" : "en-US",
        audioUrl: button.dataset.accent === "uk" ? data.audioUk : data.audioUs
      }).then((clip) => {
        if (!clip?.audio) return;
        const binary = atob(clip.audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        new Audio(URL.createObjectURL(new Blob([bytes], { type: clip.mime || "audio/mpeg" }))).play();
      }));
    });
    ui.dict.querySelector(".lm-dict-save").addEventListener("click", () => saveWord(word, cue?.text, data));
    placeDict(wordEl);
  }

  function hideDict() {
    hoverWord = null;
    ui.dict?.classList.add("lm-hidden");
  }

  function onHover(ev) {
    const word = ev.target.closest?.(".lm-word");
    if (!word) {
      if (ui.dict?.contains(ev.target)) clearTimeout(hideTimer);
      return;
    }
    clearTimeout(hideTimer);
    if (hoverWord !== word) showDict(word);
  }

  function onLeave(ev) {
    const next = ev.relatedTarget;
    if (next && (ui.dict?.contains(next) || next.closest?.(".lm-word") === hoverWord)) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (ui.dict?.matches(":hover") || hoverWord?.matches(":hover")) return;
      hideDict();
    }, 200);
  }

  async function saveWord(word, context, lookup) {
    const data = lookup || (await send("LM_LOOKUP", {
      word,
      from: state.settings.learningLang,
      to: state.settings.nativeLang,
      context: context || ""
    })).result || {};
    await send("LM_VOCAB_ADD", {
      item: {
        word,
        translation: data.translation || "",
        phonetic: data.phonetic || "",
        lang: state.settings.learningLang,
        nativeLang: state.settings.nativeLang,
        context: context || "",
        videoTitle: document.title,
        videoUrl: location.href,
        time: videoEl()?.currentTime || 0
      }
    });
  }

  function isTyping(target) {
    const tag = target?.tagName || "";
    return tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable;
  }

  document.addEventListener("keydown", (ev) => {
    if (isTyping(ev.target) || !state.cues.length) return;
    const key = ev.key.toLowerCase();
    if (!["a", "s", "d"].includes(key)) return;
    ev.preventDefault();
    const idx = Math.min(state.cues.length - 1, Math.max(0, state.index + (key === "a" ? -1 : key === "d" ? 1 : 0)));
    const cue = key === "s" ? state.cues[Math.max(0, state.index)] : state.cues[idx];
    if (cue) seekTo(cue.start, !ev.repeat);
    if (ev.repeat) videoEl()?.pause();
  }, true);

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "linguamate-prime" || msg.type !== "LM_TRACK") return;
    mount();
    applyTrack(msg.text);
  });

  async function boot() {
    const res = await send("LM_GET_SETTINGS");
    if (res.settings) state.settings = lmMergeSettings(res.settings);
    mount();
    setInterval(mount, 1000);
    setInterval(() => {
      if (state.cues.length) return;
      window.postMessage({
        source: "linguamate-content",
        type: "LM_PRIME_PULL",
        lang: state.settings.learningLang
      }, "*");
    }, 3000);
    window.addEventListener("scroll", placeOverlay, true);
    window.addEventListener("resize", placeOverlay);
    setInterval(() => {
      placeOverlay();
      if (state.cues.length) renderCurrent();
    }, 250);
  }

  boot();
})();
