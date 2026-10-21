(() => {
  if (window.__linguaMateReader) {
    window.__linguaMateReaderReady = true;
    return;
  }
  window.__linguaMateReader = true;

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          resolve({});
          return;
        }
        chrome.runtime.sendMessage(Object.assign({ type }, payload), (res) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          resolve(res || {});
        });
      } catch (err) {
        resolve({});
      }
    });
  }

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
    const settingsRes = await send("LM_GET_SETTINGS");
    const settings = lmMergeSettings(settingsRes.settings);
    const content =
      (text && text.trim()) ||
      (mode === "lm-lookup" ? window.getSelection().toString() : extractArticle());
    if (!content) return;

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
        <div class="lm-reader-trans" id="lm-reader-trans">正在翻译…</div>
      </div>
    `;
    document.documentElement.appendChild(root);

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
      if (ev.target.dataset.act === "close") root.remove();
      if (ev.target.dataset.act === "speak") {
        const utter = new SpeechSynthesisUtterance(content.slice(0, 600));
        utter.lang = settings.learningLang;
        speechSynthesis.speak(utter);
      }
      const word = ev.target.closest(".lm-reader-word");
      if (word) {
        const res = await send("LM_LOOKUP", {
          word: word.textContent,
          from: settings.learningLang,
          to: settings.nativeLang,
          context: content.slice(0, 180)
        });
        const data = res.result || {};
        await send("LM_VOCAB_ADD", {
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
        word.style.color = "#f4c56d";
      }
    });

    if (mode === "lm-lookup" && content.split(/\s+/).length <= 8) {
      const res = await send("LM_LOOKUP", {
        word: content,
        from: "auto",
        to: settings.nativeLang,
        context: ""
      });
      root.querySelector("#lm-reader-trans").textContent = res.result?.translation || "没有查到释义";
      return;
    }

    const translated = await send("LM_TRANSLATE", {
      text: content.slice(0, 4500),
      from: "auto",
      to: settings.nativeLang
    });
    root.querySelector("#lm-reader-trans").textContent = translated.result?.text || "翻译失败";
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "LM_READER") {
      openReader(message.text, message.mode);
      sendResponse({ ok: true });
    }
    return true;
  });
})();
