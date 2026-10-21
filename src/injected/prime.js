(function () {
  if (window.__linguaMatePrime) return;
  window.__linguaMatePrime = true;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  let playbackUrl = "";
  let envelope = "";
  let preferredLang = "en";
  let pulling = false;

  function isPlaybackUrl(url) {
    return /GetVodPlaybackResources|GetPlaybackResources/i.test(String(url || ""));
  }

  function rememberEnvelope(url, body) {
    if (isPlaybackUrl(url)) playbackUrl = String(url);
    const raw = typeof body === "string" ? body : "";
    if (!raw || raw.indexOf("playbackEnvelope") === -1) return;
    try {
      const data = JSON.parse(raw);
      const found = data && data.globalParameters && data.globalParameters.playbackEnvelope;
      if (found) envelope = found;
    } catch (err) {
      const match = raw.match(/"playbackEnvelope"\s*:\s*"((?:\\.|[^"\\])+)"/);
      if (!match) return;
      try {
        envelope = JSON.parse(`"${match[1]}"`);
      } catch (parseErr) {
        envelope = match[1];
      }
    }
  }

  function publish(url, text) {
    const body = String(text || "").trim();
    if (body.length < 20) return;
    const lower = body.slice(0, 80).toLowerCase();
    if (lower.startsWith("<tt") || lower.startsWith("<?xml") || lower.startsWith("webvtt") || body.indexOf("<tt") !== -1) {
      window.postMessage({ source: "linguamate-prime", type: "LM_TRACK", url: String(url || ""), text: body.slice(0, 2000000) }, "*");
    }
  }

  function collectTracks(node, found, depth) {
    if (!node || depth > 10) return;
    if (Array.isArray(node)) {
      node.forEach((item) => collectTracks(item, found, depth + 1));
      return;
    }
    if (typeof node !== "object") return;
    const url = node.url || node.URL || node.uri || node.href || node.ttmlUrl || node.dfxpUrl;
    if (typeof url === "string" && /^https?:\/\//.test(url)) {
      found.push({
        url,
        lang: String(node.languageCode || node.language || node.locale || "")
      });
    }
    Object.keys(node).forEach((key) => {
      if (/subtitle|caption|timedtext|ttml|dfxp/i.test(key) || depth < 4) collectTracks(node[key], found, depth + 1);
    });
  }

  async function fetchText(url) {
    const attempts = [
      { credentials: "omit", mode: "cors" },
      { credentials: "include", mode: "cors" }
    ];
    for (const options of attempts) {
      try {
        const response = await (originalFetch || fetch)(url, options);
        if (!response.ok) continue;
        const text = await response.text();
        if (text && text.trim().length > 20) return text;
      } catch (err) {
        /* try the next credential mode */
      }
    }
    return "";
  }

  async function loadTrackList(tracks) {
    const want = preferredLang.toLowerCase().split("-")[0];
    const ranked = tracks.slice().sort((a, b) => {
      const aMatch = a.lang.toLowerCase().startsWith(want) ? 0 : 1;
      const bMatch = b.lang.toLowerCase().startsWith(want) ? 0 : 1;
      return aMatch - bMatch;
    });
    const chosen = ranked.find((item) => item.lang.toLowerCase().startsWith(want)) || ranked[0];
    if (!chosen) return;
    const text = await fetchText(chosen.url);
    publish(chosen.url, text);
  }

  async function harvestJson(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return;
    }
    const tracks = [];
    collectTracks(data, tracks, 0);
    const unique = [];
    const seen = new Set();
    tracks.forEach((item) => {
      if (seen.has(item.url)) return;
      seen.add(item.url);
      unique.push(item);
    });
    if (unique.length) await loadTrackList(unique);
  }

  function inspect(url, text, contentType) {
    const body = String(text || "");
    const type = String(contentType || "").toLowerCase();
    if (!body.trim()) return;
    if (body.trim().startsWith("<") || body.trim().startsWith("WEBVTT") || type.indexOf("ttml") !== -1 || type.indexOf("xml") !== -1) {
      publish(url, body);
    }
    if (isPlaybackUrl(url) || body.indexOf("subtitleUrls") !== -1 || body.indexOf("timedTextUrls") !== -1) {
      harvestJson(body);
    }
  }

  async function pullTracks() {
    if (pulling || !playbackUrl || !envelope) return;
    pulling = true;
    try {
      const response = await (originalFetch || fetch)(playbackUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalParameters: {
            deviceCapabilityFamily: "WebPlayer",
            playbackEnvelope: envelope
          },
          timedTextUrlsRequest: {
            supportedTimedTextFormats: ["TTMLv2", "DFXP", "WEBVTT"]
          }
        })
      });
      inspect(playbackUrl, await response.text(), response.headers.get("content-type"));
    } catch (err) {
      /* the player may not have started yet */
    } finally {
      pulling = false;
    }
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      rememberEnvelope(url, init && init.body);
      const response = originalFetch(input, init);
      response.then((res) => {
        const contentType = res.headers.get("content-type") || "";
        const interesting = isPlaybackUrl(url) || /ttml|dfxp|vtt|timedtext|subtitle|caption/i.test(String(url || "")) || /xml|ttml|vtt/i.test(contentType);
        if (!interesting) return;
        res.clone().text().then((text) => inspect(url, text, contentType)).catch(() => {});
      }).catch(() => {});
      return response;
    };
  }

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lmUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    rememberEnvelope(xhr.__lmUrl, body);
    xhr.addEventListener("load", () => {
      try {
        if (xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== "") return;
        const contentType = xhr.getResponseHeader("content-type") || "";
        const interesting = isPlaybackUrl(xhr.__lmUrl) || /ttml|dfxp|vtt|timedtext|subtitle|caption/i.test(String(xhr.__lmUrl || "")) || /xml|ttml|vtt/i.test(contentType);
        if (interesting) inspect(xhr.__lmUrl, xhr.responseText || "", contentType);
      } catch (err) {
        /* ignore binary payloads */
      }
    });
    return originalSend.apply(this, arguments);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "linguamate-content" || msg.type !== "LM_PRIME_PULL") return;
    if (msg.lang) preferredLang = String(msg.lang);
    pullTracks();
  });
})();
