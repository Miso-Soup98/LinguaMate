(function () {
  if (window.__linguaMatePrime) return;
  window.__linguaMatePrime = true;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  function isCaptionUrl(raw) {
    const url = String(raw || "").toLowerCase();
    return (
      url.indexOf("timedtext") !== -1 ||
      url.indexOf("ttml") !== -1 ||
      url.indexOf(".dfxp") !== -1 ||
      url.indexOf("imsc") !== -1
    );
  }

  function publish(url, text) {
    const body = String(text || "").trim();
    if (body.length < 20) return;
    if (body[0] !== "<" && body[0] !== "{") return;
    window.postMessage({
      source: "linguamate-prime",
      type: "LM_TRACK",
      url: String(url || ""),
      text: body.slice(0, 2000000)
    }, "*");
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const response = originalFetch(input, init);
      if (isCaptionUrl(url)) {
        response.then((res) => {
          res.clone().text().then((text) => publish(url, text)).catch(() => {});
        }).catch(() => {});
      }
      return response;
    };
  }

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lmUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    const url = xhr.__lmUrl;
    if (isCaptionUrl(url)) {
      xhr.addEventListener("load", () => {
        try {
          if (xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== "") return;
          publish(url, xhr.responseText || "");
        } catch (err) {
          /* ignore binary subtitle payloads */
        }
      });
    }
    return originalSend.apply(this, arguments);
  };
})();
