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
    const content = (
      (text && text.trim()) ||
      (mode === "lm-lookup" ? window.getSelection().toString() : extractArticle())).slice(0, 8000);
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
    const japaneseSaved = new Set();
    let wordVersion = 0;
    const japanese = /^ja(?:-|$)/i.test(settings.learningLang);
    const japaneseReady = japanese && typeof lmJapaneseClient !== "undefined" && typeof lmJapaneseUi !== "undefined";
    const originalText = (node) => japaneseReady ? lmJapaneseUi.textWithoutReading(node) : node.textContent || "";
    const termKey = (token) => typeof lmJapanese !== "undefined" ? lmJapanese.termKey(token) : lmJapaneseUi.identity(token);
    const wordIdentity = (node) => japaneseReady ? termKey(lmJapaneseUi.tokenFrom(node)) : originalText(node).trim().toLocaleLowerCase(settings.learningLang);
    function wordContext(node) {
      let offset = 0;
      for (const child of textBox.childNodes || textBox.children || []) { if (child === node) break; offset += originalText(child).length; }
      return content.slice(Math.max(0, offset - 70), Math.min(content.length, offset + originalText(node).length + 110)).trim();
    }

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
    if (japaneseReady) {
      const learning = await send("LM_VOCAB_LIST");
      if (!root.isConnected) return;
      const rows = learning.ok === true && Array.isArray(learning.vocab) ? learning.vocab.filter((item) => /^ja(?:-|$)/i.test(item.lang || "")) : [];
      rows.forEach((item) => japaneseSaved.add(item.japanese ? termKey(item.japanese) : `ja:${item.word}`));
      const known = new Set(rows.filter((item) => item.status === "known").map((item) => item.japanese ? termKey(item.japanese) : `ja:${item.word}`));
      for (const [key, value] of Object.entries(learning.known || {})) if (value === true) known.add(key);
      const markWords = () => textBox.querySelectorAll(".lm-word").forEach((span) => span.classList.add("lm-reader-word"));
      lmJapaneseClient.render(textBox, content, { lang: settings.learningLang, furigana: settings.japaneseFurigana, saved: japaneseSaved, known, onAnalyzed: markWords });
      markWords();
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
        const surface = originalText(word).trim();
        const key = wordIdentity(word);
        const occurrence = japaneseReady ? `${key}|surface=${surface}` : key;
        if (pendingWords.has(key)) return;
        if (savedWords.has(occurrence)) { lmReportStatus(status, `「${surface}」已加入生词本`, "success"); return; }
        const hint = japaneseReady ? lmJapaneseUi.tokenFrom(word) : undefined;
        const context = wordContext(word);
        const requestVersion = ++wordVersion;
        pendingWords.add(key);
        word.setAttribute("aria-busy", "true");
        lmReportStatus(status, `正在查询并收藏「${surface}」…`, "pending");
        const res = await send("LM_LOOKUP", {
          word: surface,
          from: settings.learningLang,
          to: settings.nativeLang,
          context,
          ...(hint ? { japanese: hint } : {})
        });
        if (res.ok !== true || !res.result) {
          pendingWords.delete(key);
          word.removeAttribute("aria-busy");
          if (root.isConnected && requestVersion === wordVersion) lmReportStatus(status, res.error || "查词失败，请点击单词重试", "error");
          return;
        }
        const data = res.result || {};
        const analysis = japaneseReady ? lmJapaneseClient.persistent(data.japanese || hint) : undefined;
        if (!root.isConnected) { pendingWords.delete(key); return; }
        const saved = await send("LM_VOCAB_ADD", {
          item: {
            word: analysis?.lemma || surface,
            translation: data.translation || "",
            phonetic: data.phonetic || "",
            lang: settings.learningLang,
            nativeLang: settings.nativeLang,
            context,
            videoTitle: document.title,
            videoUrl: location.href,
            ...(analysis ? { japanese: { ...analysis, surface } } : {})
          }
        });
        pendingWords.delete(key);
        word.removeAttribute("aria-busy");
        if (!root.isConnected) return;
        if (saved.ok !== true || !saved.item) {
          if (requestVersion === wordVersion) lmReportStatus(status, saved.error || "加入生词本失败，请点击单词重试", "error");
          return;
        }
        savedWords.add(occurrence);
        const savedKey = japaneseReady && saved.item.japanese ? termKey(saved.item.japanese) : key;
        if (japaneseReady) japaneseSaved.add(savedKey);
        textBox.querySelectorAll(".lm-reader-word").forEach((span) => {
          if (wordIdentity(span) === savedKey || wordIdentity(span) === key) span.classList.add("lm-reader-saved");
        });
        if (requestVersion === wordVersion) lmReportStatus(status, `已将「${surface}」加入生词本`, "success");
      }
    });

    if (mode === "lm-lookup" && content.length <= 200 && content.split(/\s+/).length <= 8) {
      const res = await send("LM_LOOKUP", {
        word: content,
        from: japanese ? settings.learningLang : "auto",
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
