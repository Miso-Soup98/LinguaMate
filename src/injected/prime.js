function linguaMateInstallPrimeHook() {
  if (window.__linguaMatePrime) return;
  window.__linguaMatePrime = true;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  let playbackUrl = "";
  let envelope = "";
  let preferredLang = "en";
  let pulling = null;
  const trackLanguages = new Map();
  let availableTracks = [];
  let pendingTracks = [];
  let lastManifestMessage = null;
  let sessionScope = "";
  let sessionGeneration = 0;

  function playbackScope() {
    const url = new URL(location.href);
    return url.pathname + ["gti", "titleId", "asin"].map((key) => `|${key}=${url.searchParams.get(key) || ""}`).join("");
  }

  function requestSession() {
    const scope = playbackScope();
    if (scope !== sessionScope) {
      sessionScope = scope;
      sessionGeneration += 1;
      availableTracks = [];
      pendingTracks = [];
      lastManifestMessage = null;
      trackLanguages.clear();
      playbackUrl = envelope = "";
      pulling = null;
    }
    return { scope, generation: sessionGeneration, adAtRequest: adIndicatorVisible() };
  }

  function isCurrentSession(session) {
    const current = requestSession();
    return session && session.scope === current.scope && session.generation === current.generation;
  }

  function isPlaybackUrl(url) {
    return /GetVodPlaybackResources|GetPlaybackResources/i.test(String(url || ""));
  }

  function isManifest(url, contentType) {
    return /\.mpd(?:[?#]|$)/i.test(String(url || "")) || /application\/dash\+xml/i.test(String(contentType || ""));
  }

  function adIndicatorVisible() {
    return Array.from(document.querySelectorAll(".atvwebplayersdk-adtimeindicator-text, .atvwebplayersdk-ad-timer")).some((element) => {
      if (!element.isConnected || !String(element.textContent || "").trim()) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        if (node.hidden) return false;
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      }
      return true;
    });
  }

  function publishTimeline(url, text, session) {
    if (text.length > 5000000 || !isCurrentSession(session)) return;
    const adActive = !!(session.adAtRequest || adIndicatorVisible());
    let parsed;
    let message;
    try {
      parsed = lmPrimeManifest.parse(text, { adActive });
    } catch (err) {
      // A page Trusted Types policy can reject DOMParser even though the
      // extension's isolated world may parse the same XML safely.
      message = { source: "linguamate-prime", type: "LM_PRIME_MPD", role: "content", scope: session.scope, adActive, text: text.slice(0, 5000000), url: String(url || "") };
    }
    if (!message && !parsed) return;
    if (!message) message = { source: "linguamate-prime", type: "LM_PRIME_TIMELINE", role: "content", scope: session.scope, duration: parsed.duration, end: parsed.duration, breaks: parsed.breaks, url: String(url || "") };
    if (!isCurrentSession(session)) return;
    // MAIN starts before the content listener. Replay on its first pull, while
    // retaining an existing programme message throughout later ad playback.
    if (!lastManifestMessage || !adActive) lastManifestMessage = message;
    window.postMessage(message, "*");
  }

  function rememberEnvelope(url, body, session) {
    if (!isCurrentSession(session)) return;
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

  function publish(url, text, lang = trackLanguages.get(String(url)) || "", role = "unknown", session) {
    if (!isCurrentSession(session)) return;
    const body = String(text || "").trim();
    if (body.length < 20) return;
    const lower = body.slice(0, 80).toLowerCase();
    if (lower.startsWith("<tt") || lower.startsWith("<?xml") || lower.startsWith("webvtt") || body.indexOf("<tt") !== -1) {
      window.postMessage({ source: "linguamate-prime", type: "LM_TRACK", lang, role, scope: session.scope, url: String(url || ""), text: body.slice(0, 2000000) }, "*");
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

  async function fetchText(url, session) {
    const attempts = [
      { credentials: "omit", mode: "cors" },
      { credentials: "include", mode: "cors" }
    ];
    for (const options of attempts) {
      if (!isCurrentSession(session)) return "";
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

  async function loadTrackList(tracks, session) {
    if (!isCurrentSession(session)) return;
    const want = preferredLang.toLowerCase().split("-")[0];
    const ranked = tracks.slice().sort((a, b) => {
      const aMatch = a.lang.toLowerCase().startsWith(want) ? 0 : 1;
      const bMatch = b.lang.toLowerCase().startsWith(want) ? 0 : 1;
      return aMatch - bMatch;
    });
    const chosen = ranked.find((item) => item.lang.toLowerCase().split(/[-_]/)[0] === want) || ranked.find((item) => !item.lang);
    if (!chosen) return;
    const text = await fetchText(chosen.url, session);
    if (preferredLang.toLowerCase().split("-")[0] === want) publish(chosen.url, text, chosen.lang, "content", session);
  }

  async function harvestJson(text, session) {
    // Ad playback resources may contain their own subtitle tracks. Keep the
    // programme's cached list so a language change never switches to an ad.
    if (!isCurrentSession(session)) return;
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
    if (unique.length) {
      if (session.adAtRequest || adIndicatorVisible()) {
        // The programme's first resource response can arrive during pre-roll.
        // Retain it without fetching an unverified ad-time candidate. Existing
        // programme tracks always take priority over ad-time resources.
        if (!availableTracks.length && !pendingTracks.length) pendingTracks = unique;
        return;
      }
      availableTracks = unique;
      pendingTracks = [];
      unique.forEach((track) => trackLanguages.set(track.url, track.lang));
      await loadTrackList(unique, session);
    }
  }

  function inspect(url, text, contentType, session) {
    if (!isCurrentSession(session)) return;
    const body = String(text || "");
    const type = String(contentType || "").toLowerCase();
    if (!body.trim()) return;
    if (isManifest(url, type) || /^\s*(?:<\?xml[^>]*>\s*)?<(?:[\w.-]+:)?MPD(?:\s|>)/.test(body)) {
      publishTimeline(url, body, session);
      return;
    }
    if (body.trim().startsWith("<") || body.trim().startsWith("WEBVTT") || type.indexOf("ttml") !== -1 || type.indexOf("xml") !== -1) {
      publish(url, body, undefined, "unknown", session);
    }
    if (isPlaybackUrl(url) || body.indexOf("subtitleUrls") !== -1 || body.indexOf("timedTextUrls") !== -1) {
      harvestJson(body, session);
    }
  }

  async function pullTracks() {
    const session = requestSession();
    if (pulling || !playbackUrl || !envelope) return;
    pulling = session;
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
      inspect(playbackUrl, await response.text(), response.headers.get("content-type"), session);
    } catch (err) {
      /* the player may not have started yet */
    } finally {
      if (pulling === session) pulling = null;
    }
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const session = requestSession();
      rememberEnvelope(url, init && init.body, session);
      const response = originalFetch(input, init);
      response.then((res) => {
        const contentType = res.headers.get("content-type") || "";
        const interesting = isPlaybackUrl(url) || isManifest(url, contentType) || /ttml|dfxp|vtt|timedtext|subtitle|caption/i.test(String(url || "")) || /xml|ttml|vtt/i.test(contentType);
        if (!interesting) return;
        res.clone().text().then((text) => inspect(url, text, contentType, session)).catch(() => {});
      }).catch(() => {});
      return response;
    };
  }

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lmUrl = url;
    this.__lmSession = requestSession();
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const session = xhr.__lmSession;
    rememberEnvelope(xhr.__lmUrl, body, session);
    xhr.addEventListener("load", () => {
      try {
        const contentType = xhr.getResponseHeader("content-type") || "";
        let text = "";
        if (!xhr.responseType || xhr.responseType === "text") text = xhr.responseText || "";
        else if (xhr.responseType === "json") text = JSON.stringify(xhr.response || "");
        else if (xhr.responseType === "arraybuffer" && xhr.response) text = new TextDecoder().decode(xhr.response);
        else if (xhr.responseType === "blob" && xhr.response) {
          xhr.response.text().then((value) => inspect(xhr.__lmUrl, value, contentType, session)).catch(() => {});
          return;
        } else return;
        const interesting = isPlaybackUrl(xhr.__lmUrl) || isManifest(xhr.__lmUrl, contentType) || /ttml|dfxp|vtt|timedtext|subtitle|caption/i.test(`${xhr.__lmUrl} ${contentType} ${text.slice(0, 200)}`);
        if (interesting) inspect(xhr.__lmUrl, text, contentType, session);
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
    const session = requestSession();
    if (msg.lang) preferredLang = String(msg.lang);
    if (lastManifestMessage) window.postMessage(lastManifestMessage, "*");
    if (!availableTracks.length && pendingTracks.length && !adIndicatorVisible()) {
      availableTracks = pendingTracks;
      pendingTracks = [];
      availableTracks.forEach((track) => trackLanguages.set(track.url, track.lang));
    }
    if (availableTracks.length) loadTrackList(availableTracks, session);
    else if (adIndicatorVisible()) return;
    else pullTracks();
  });
}

// The manifest installs this file in MAIN world at document_start. Install
// directly so the page's inline-script CSP cannot disable network observation.
linguaMateInstallPrimeHook();
