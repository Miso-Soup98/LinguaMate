// Bind one word card to the persistent vocabulary list. All state belongs to this
// button, so a slow response cannot change a newer card for another word.
function lmBindVocabButton(button, { word, lang, send, createItem, onChange, japanese }) {
  const boundWord = String(word || "").trim();
  const boundLang = String(lang || "und").trim();
  const normalize = (value) => String(value || "").normalize("NFC").trim().toLowerCase();
  const languageKey = (value) => /^ja(?:-|$)/i.test(value || "") ? "ja" : normalize(value || "und");
  const kana = (value) => normalize(value).normalize("NFKC").replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60));
  const analysis = () => {
    const value = typeof japanese === "function" ? japanese() : japanese;
    return /^ja(?:-|$)/i.test(boundLang) && value && typeof value === "object" ? value : null;
  };
  function matches(item) {
    if (!item || languageKey(item.lang) !== languageKey(boundLang)) return false;
    const target = analysis();
    if (!target?.lemma) return normalize(item.word) === normalize(boundWord);
    const lemma = normalize(target.lemma);
    const surface = normalize(target.surface || boundWord);
    if (!item.japanese) return [lemma, surface].includes(normalize(item.word));
    if (normalize(item.japanese.lemma || item.word) !== lemma) return false;
    const targetReading = kana(target.baseReading || target.reading);
    const storedReading = kana(item.japanese.baseReading || item.japanese.reading);
    if (targetReading !== storedReading) return false;
    return !target.entryId || !item.japanese.entryId || target.entryId === item.japanese.entryId;
  }
  const status = (button.ownerDocument || document).createElement("div");
  status.className = "lm-vocab-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  button.parentElement.appendChild(status);
  button.type = "button";

  let savedItem = null;
  let known = false;
  let busy = false;
  let refreshQueued = false;
  let pending = Promise.resolve(false);

  function report(message, tone = "") {
    if (typeof lmReportStatus === "function") lmReportStatus(status, message, tone || "success");
    status.textContent = message;
    status.dataset.tone = tone;
    status.dataset.error = String(tone === "error");
  }

  function render() {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    button.setAttribute("aria-pressed", String(known && !!savedItem));
    button.classList.toggle("lm-vocab-saved", known && !!savedItem);
    button.dataset.vocabState = busy ? "loading" : !known ? "error" : savedItem ? "saved" : "unsaved";
    button.textContent = busy
      ? "正在处理…"
      : !known
        ? "重试读取生词本"
        : savedItem
          ? "已加入生词本 · 点击移除"
          : "加入生词本";
  }

  async function readLatest() {
    try {
      const response = await send("LM_VOCAB_LIST");
      if (!response || response.ok !== true || !Array.isArray(response.vocab)) {
        throw new Error("vocabulary_list_failed");
      }
      savedItem = response.vocab.find(matches) || null;
      known = true;
    } catch (error) {
      known = false;
      throw error;
    }
  }

  function run(task, onSuccess) {
    if (busy) return pending;
    busy = true;
    render();
    pending = (async () => {
      let succeeded = false;
      try {
        succeeded = await task();
        return succeeded;
      } finally {
        // Storage changes can arrive while the first list snapshot or a write
        // is in flight. Re-read after that work instead of losing the update.
        while (refreshQueued) {
          refreshQueued = false;
          try {
            await readLatest();
          } catch (_) {
            report("读取生词本失败，请点击按钮重试", "error");
          }
        }
        busy = false;
        render();
        if (succeeded && onSuccess) onSuccess();
      }
    })();
    return pending;
  }

  function refresh(showResult = false) {
    if (busy) {
      refreshQueued = true;
      return pending;
    }
    const preserveStatus = known && !showResult;
    return run(async () => {
      if (!preserveStatus) report("正在读取生词本…", "pending");
      try {
        await readLatest();
        if (!preserveStatus) report(showResult ? savedItem ? "已在生词本中" : "尚未加入生词本" : "");
        return true;
      } catch (_) {
        report("读取生词本失败，请点击按钮重试", "error");
        return false;
      }
    });
  }

  function notifyChange(item = savedItem) {
    // A page refresh callback must never make a successful storage operation
    // appear to have failed. It receives this card's immutable result snapshot.
    if (typeof onChange !== "function") return;
    try {
      Promise.resolve(onChange({ saved: !!savedItem, item })).catch(() => {});
    } catch (_) {}
  }

  function toggle() {
    if (busy) return pending;
    // When the last read failed, this click only recovers the known state. The
    // user can then choose an action based on the restored button label.
    if (!known) return refresh(true);
    const desiredSaved = !savedItem;
    const previousItem = savedItem;
    let changedItem = previousItem;
    return run(async () => {
      report("正在更新生词本…", "pending");
      try {
        await readLatest();
        changedItem = savedItem || previousItem;
        if (desiredSaved && !savedItem) {
          const item = Object.assign({}, await createItem(), { word: boundWord, lang: boundLang });
          const response = await send("LM_VOCAB_ADD", { item });
          if (!response || response.ok !== true || !response.item) throw new Error("vocabulary_add_failed");
          savedItem = response.item;
          changedItem = savedItem;
        } else if (!desiredSaved && savedItem) {
          if (!savedItem.id) throw new Error("vocabulary_id_missing");
          const response = await send("LM_VOCAB_DELETE", { id: savedItem.id });
          if (!response || response.ok !== true) throw new Error("vocabulary_delete_failed");
          savedItem = null;
        }
        report(desiredSaved ? "已加入生词本" : "已从生词本移除", "success");
        return true;
      } catch (_) {
        report(known ? "操作失败，请重试" : "读取生词本失败，请点击按钮重试", "error");
        return false;
      }
    }, () => notifyChange(savedItem || changedItem));
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    return toggle();
  });
  const ready = refresh();
  return { ready, refresh, get pending() { return pending; } };
}
