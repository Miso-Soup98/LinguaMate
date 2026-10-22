(() => {
  if (window.__linguaMateReader) {
    window.__linguaMateReaderReady = true;
    return;
  }
  window.__linguaMateReader = true;

  const send = (type, payload = {}) => lmSendMessage(type, payload);
  let openVersion = 0;

  function tokenize(text, lang) {
    try {
      const segmenter = new Intl.Segmenter(lang || "en", { granularity: "word" });
      return Array.from(segmenter.segment(text));
    } catch (err) {
      return String(text).split(/(\s+)/).map((segment) => ({ segment, isWordLike: /\p{L}/u.test(segment) }));
    }
  }

  function extractArticle() {
    const article = document.querySelector("article, main, [role='main']");
    const source = article || document.body;
    return (source.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000);
  }

  async function openReader(text, mode) {
    const version = ++openVersion;
    const settingsRes = await send("LM_GET_SETTINGS");
    if (version !== openVersion) return;
    if (settingsRes.ok !== true || !settingsRes.settings) {
      lmNotify(settingsRes.error || "读取设置失败，请刷新页面后重试", "error");
      return;
    }
    const settings = lmMergeSettings(settingsRes.settings);
    const content =
      (text && text.trim()) ||
      (mode === "lm-lookup" ? window.getSelection().toString() : extractArticle());
    if (!content) { lmNotify("没有找到可阅读的文本，请先选择文字", "error"); return; }

    document.getElementById("lm-reader-root")?.remove();
    const root = document.createElement("div");
    root.id = "lm-reader-root";
    root.innerHTML = `
      <div class="lm-reader-card">
        <div class="lm-reader-top">
          <strong>语伴阅读</strong>
          <div>
            <button data-act="speak">朗读</button>
            <button data-act="close">关闭</button>
          </div>
        </div>
        <div class="lm-reader-text" id="lm-reader-text"></div>
        <div class="lm-reader-status" role="status" aria-live="polite"></div>
        <div class="lm-reader-trans" id="lm-reader-trans">正在翻译…</div>
      </div>
    `;
    document.documentElement.appendChild(root);
    const status = root.querySelector(".lm-reader-status");
    const pendingWords = new Set();
    const savedWords = new Set();
    let wordVersion = 0;

    const textBox = root.querySelector("#lm-reader-text");
    for (const part of tokenize(content, settings.learningLang)) {
      if (!part.isWordLike) {
        textBox.appendChild(document.createTextNode(part.segment));
        continue;
      }
      const span = document.createElement("span");
      span.className = "lm-reader-word";
      span.textContent = part.segment;
      textBox.appendChild(span);
    }

    root.addEventListener("click", async (ev) => {
      if (ev.target.dataset.act === "close") { openVersion += 1; root.remove(); }
      if (ev.target.dataset.act === "speak") {
        try {
          const utter = new SpeechSynthesisUtterance(content.slice(0, 600));
          utter.lang = settings.learningLang;
          speechSynthesis.speak(utter);
        } catch (_) { lmReportStatus(status, "朗读不可用，请检查浏览器语音设置", "error"); }
      }
      const word = ev.target.closest(".lm-reader-word");
      if (word) {
        const key = word.textContent.trim().toLocaleLowerCase(settings.learningLang);
        if (pendingWords.has(key)) return;
        if (savedWords.has(key)) { lmReportStatus(status, `「${word.textContent}」已加入生词本`, "success"); return; }
        const requestVersion = ++wordVersion;
        pendingWords.add(key);
        word.setAttribute("aria-busy", "true");
        lmReportStatus(status, `正在查询并收藏「${word.textContent}」…`, "pending");
        const res = await send("LM_LOOKUP", {
          word: word.textContent,
          from: settings.learningLang,
          to: settings.nativeLang,
          context: content.slice(0, 180)
        });
        if (res.ok !== true || !res.result) {
          pendingWords.delete(key);
          word.removeAttribute("aria-busy");
          if (root.isConnected && requestVersion === wordVersion) lmReportStatus(status, res.error || "查词失败，请点击单词重试", "error");
          return;
        }
        const data = res.result || {};
        if (!root.isConnected) { pendingWords.delete(key); return; }
        const saved = await send("LM_VOCAB_ADD", {
          item: {
            word: word.textContent,
            translation: data.translation,
            phonetic: data.phonetic,
            lang: settings.learningLang,
            nativeLang: settings.nativeLang,
            context: content.slice(0, 180),
            videoTitle: document.title,
            videoUrl: location.href
          }
        });
        pendingWords.delete(key);
        word.removeAttribute("aria-busy");
        if (!root.isConnected) return;
        if (saved.ok !== true || !saved.item) {
          if (requestVersion === wordVersion) lmReportStatus(status, saved.error || "加入生词本失败，请点击单词重试", "error");
          return;
        }
        savedWords.add(key);
        textBox.querySelectorAll(".lm-reader-word").forEach((span) => {
          if (span.textContent.trim().toLocaleLowerCase(settings.learningLang) === key) span.classList.add("lm-reader-saved");
        });
        if (requestVersion === wordVersion) lmReportStatus(status, `已将「${word.textContent}」加入生词本`, "success");
      }
    });

    if (mode === "lm-lookup" && content.split(/\s+/).length <= 8) {
      const res = await send("LM_LOOKUP", {
        word: content,
        from: "auto",
        to: settings.nativeLang,
        context: ""
      });
      if (!root.isConnected) return;
      root.querySelector("#lm-reader-trans").textContent = res.ok === true ? res.result?.translation || "没有查到释义" : res.error || "查词失败，请关闭后重试";
      if (res.ok !== true) lmReportStatus(status, res.error || "查词失败，请关闭后重试", "error");
      return;
    }

    const translated = await send("LM_TRANSLATE", {
      text: content.slice(0, 4500),
      from: "auto",
      to: settings.nativeLang
    });
    if (!root.isConnected) return;
    root.querySelector("#lm-reader-trans").textContent = translated.ok === true ? translated.result?.text || "没有获得译文" : translated.error || "翻译失败，请关闭后重试";
    if (translated.ok !== true) lmReportStatus(status, translated.error || "翻译失败，请关闭后重试", "error");
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "LM_READER") {
      openReader(message.text, message.mode);
      sendResponse({ ok: true });
    }
    return true;
  });
})();
