// Shared, accessible operation feedback and a bounded runtime message bridge.
(() => {
  if (globalThis.lmSendMessage && globalThis.lmNotify && globalThis.lmReportStatus) return;
  function report(target, message, tone = "success") {
    if (!target) return;
    target.dataset.tone = tone;
    target.dataset.error = String(tone === "error");
    target.setAttribute("role", tone === "error" ? "alert" : "status");
    target.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    target.setAttribute("aria-atomic", "true");
    target.textContent = String(message || "");
  }

  let toastTimer;
  function notify(message, tone = "success") {
    if (typeof document === "undefined") return;
    let toast = document.getElementById("lm-feedback-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "lm-feedback-toast";
      toast.className = "lm-feedback-toast";
    }
    (document.fullscreenElement || document.documentElement).appendChild(toast);
    report(toast, message, tone);
    clearTimeout(toastTimer);
    toast.hidden = false;
    if (tone !== "pending") toastTimer = setTimeout(() => { toast.hidden = true; }, tone === "error" ? 6500 : 3500);
    return toast;
  }

  function failureMessage(error) {
    const value = String(error?.message || error || "");
    if (/context invalidated|extension context|receiving end|message port|connection|runtime/i.test(value)) {
      return "语伴连接已中断，请刷新页面后重试";
    }
    if (/quota|max_write|storage/i.test(value)) return "保存失败，存储空间或写入次数已达上限，请稍后重试";
    if (/missing_item/i.test(value)) return "该生词已不存在，请重新打开生词本";
    if (/[\u3400-\u9fff]/.test(value)) return value;
    return "操作失败，请稍后重试";
  }

  function send(type, payload = {}, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      };
      timer = setTimeout(() => finish({ ok: false, error: "操作超时，请稍后重试" }), timeoutMs);
      try {
        if (typeof chrome === "undefined" || !chrome.runtime?.id) {
          finish({ ok: false, error: "语伴连接已中断，请刷新页面后重试" });
          return;
        }
        chrome.runtime.sendMessage(Object.assign({}, payload, { type }), (response) => {
          const error = chrome.runtime.lastError;
          if (error) finish({ ok: false, error: failureMessage(error) });
          else if (!response || typeof response !== "object") finish({ ok: false, error: "语伴没有响应，请重试" });
          else if (response.ok !== true) finish(Object.assign({}, response, { ok: false, error: failureMessage(response.error) }));
          else finish(response);
        });
      } catch (error) {
        finish({ ok: false, error: failureMessage(error) });
      }
    });
  }

  globalThis.lmReportStatus = report;
  globalThis.lmNotify = notify;
  globalThis.lmSendMessage = send;
})();
