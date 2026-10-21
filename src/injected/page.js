(function () {
  const VERSION = 5;
  if (window.__linguaMateCleanup) window.__linguaMateCleanup();

  const cache = new Map();
  const bodies = new Map();
  const attempts = new Map();
  let pendingPot = null;
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  function videoIdFromLocation() {
    const url = new URL(location.href);
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
    return url.searchParams.get("v") || "";
  }

  function remember(raw) {
    if (!raw || String(raw).indexOf("timedtext") === -1) return;
    let url;
    try {
      url = new URL(String(raw), location.href);
    } catch (err) {
      return;
    }
    if (url.pathname.indexOf("timedtext") === -1 || !url.searchParams.get("pot")) return;
    const videoId = url.searchParams.get("v") || videoIdFromLocation();
    if (!videoId) return;
    const href = url.toString();
    const list = cache.get(videoId) || [];
    if (list.some((item) => item.href === href)) return;
    list.push({
      href,
      lang: url.searchParams.get("lang") || "",
      kind: url.searchParams.get("kind") || "",
      tlang: url.searchParams.get("tlang") || ""
    });
    cache.set(videoId, list);
  }

  function harvest() {
    try {
      performance.getEntriesByType("resource").forEach((entry) => remember(entry.name));
    } catch (err) {
      /* ignore */
    }
  }

  function bodyMissing(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed || trimmed === "{}" || trimmed === "[]") return true;
    if (trimmed.startsWith("WEBVTT")) return trimmed.indexOf("-->") === -1;
    if (trimmed[0] === "<") return !/<(text|p)\b/i.test(trimmed);
    if (trimmed[0] !== "{" && trimmed[0] !== "[") return true;
    try {
      const data = JSON.parse(trimmed);
      const events = data && data.events;
      if (!Array.isArray(events) || !events.length) return true;
      return !events.some((event) => Array.isArray(event.segs) && event.segs.some((seg) => String(seg.utf8 || "").trim()));
    } catch (err) {
      return true;
    }
  }

  function storeBody(rawUrl, text) {
    remember(rawUrl);
    if (bodyMissing(text)) return;
    let url;
    try {
      url = new URL(String(rawUrl), location.href);
    } catch (err) {
      return;
    }
    if (url.pathname.indexOf("timedtext") === -1) return;
    const videoId = url.searchParams.get("v") || videoIdFromLocation();
    if (!videoId) return;
    const entry = {
      href: url.toString(),
      lang: url.searchParams.get("lang") || "",
      kind: url.searchParams.get("kind") || "",
      tlang: url.searchParams.get("tlang") || "",
      text: String(text)
    };
    const list = bodies.get(videoId) || [];
    const index = list.findIndex((item) => item.lang === entry.lang && item.kind === entry.kind && item.tlang === entry.tlang);
    if (index >= 0) list[index] = entry;
    else list.push(entry);
    bodies.set(videoId, list.slice(-8));
    window.postMessage({
      source: "linguamate-page",
      type: "LM_CAPTIONS",
      videoId,
      lang: entry.lang
    }, "*");
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const response = originalFetch(input, init);
      if (url && String(url).indexOf("timedtext") !== -1) {
        response.then((res) => {
          res.clone().text().then((text) => storeBody(url, text)).catch(() => {});
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
    if (url && String(url).indexOf("timedtext") !== -1) {
      xhr.addEventListener("load", () => {
        try {
          if (xhr.responseType && xhr.responseType !== "text") return;
          storeBody(url, xhr.responseText || "");
        } catch (err) {
          remember(url);
        }
      });
    }
    return originalSend.apply(this, arguments);
  };

  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => remember(entry.name));
    });
    observer.observe({ type: "resource", buffered: true });
  } catch (err) {
    harvest();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findPlayer() {
    const nodes = [
      document.getElementById("movie_player"),
      document.querySelector("ytd-player #movie_player"),
      document.querySelector(".html5-video-player"),
      document.querySelector("#shorts-player")
    ];
    return nodes.find((node) => node && typeof node.getPlayerResponse === "function") || null;
  }

  function readResponse() {
    const player = findPlayer();
    try {
      const live = player && player.getPlayerResponse ? player.getPlayerResponse() : null;
      if (live && live.videoDetails && live.videoDetails.videoId) return live;
    } catch (err) {
      /* ignore */
    }
    return window.ytInitialPlayerResponse || null;
  }

  function trackName(track) {
    if (!track.name) return track.languageCode || "";
    if (track.name.simpleText) return track.name.simpleText;
    if (Array.isArray(track.name.runs)) return track.name.runs.map((run) => run.text || "").join("");
    return track.languageCode || "";
  }

  function getTracks() {
    harvest();
    const response = readResponse();
    const tracks = (((response || {}).captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
    return {
      videoId: (response && response.videoDetails && response.videoDetails.videoId) || "",
      tracks: tracks.map((track) => ({
        baseUrl: track.baseUrl || "",
        languageCode: track.languageCode || "",
        kind: track.kind || "",
        vssId: track.vssId || "",
        name: trackName(track)
      })),
      hasPot: ((cache.get((response && response.videoDetails && response.videoDetails.videoId) || videoIdFromLocation()) || []).length > 0)
    };
  }

  function captionsOn() {
    const button = document.querySelector(".ytp-subtitles-button");
    return !!(button && button.getAttribute("aria-pressed") === "true");
  }

  function toggleCaptions() {
    const player = findPlayer();
    const button = document.querySelector(".ytp-subtitles-button");
    try {
      if (player && typeof player.loadModule === "function") player.loadModule("captions");
    } catch (err) {
      /* ignore */
    }
    if (player && typeof player.toggleSubtitles === "function") {
      player.toggleSubtitles();
      return;
    }
    if (button) button.click();
  }

  async function forcePot(videoId) {
    if ((bodies.get(videoId) || []).length) return cache.get(videoId) || [];
    const count = attempts.get(videoId) || 0;
    if (count >= 2) return cache.get(videoId) || [];
    attempts.set(videoId, count + 1);
    if (!captionsOn()) toggleCaptions();
    const started = Date.now();
    while (Date.now() - started < 1600) {
      harvest();
      if ((bodies.get(videoId) || []).length) break;
      await sleep(80);
    }
    return cache.get(videoId) || [];
  }

  function potFor(videoId) {
    harvest();
    if ((cache.get(videoId) || []).length) return Promise.resolve(cache.get(videoId));
    if (!pendingPot) {
      pendingPot = forcePot(videoId).finally(() => {
        pendingPot = null;
      });
    }
    return pendingPot;
  }

  function sameLang(left, right) {
    const a = String(left || "").toLowerCase();
    const b = String(right || "").toLowerCase();
    if (!a || !b) return false;
    return a === b || a.split("-")[0] === b.split("-")[0];
  }

  function pickDonor(videoId, languageCode, kind, tlang) {
    const list = cache.get(videoId) || [];
    return (
      list.find((item) => sameLang(item.lang, languageCode) && (item.tlang || "") === (tlang || "") && (!kind || !item.kind || item.kind === kind)) ||
      list.find((item) => sameLang(item.lang, languageCode) && !(item.tlang || "")) ||
      list.find((item) => !(item.tlang || "")) ||
      list[0] ||
      null
    );
  }

  function withParams(rawUrl, donorUrl, tlang) {
    const dst = new URL(rawUrl, location.href);
    dst.searchParams.set("fmt", "json3");
    if (tlang) dst.searchParams.set("tlang", tlang);
    else dst.searchParams.delete("tlang");
    if (donorUrl) {
      const src = new URL(donorUrl, location.href);
      ["pot", "potc", "c", "cver", "cplayer", "cbr", "cbrver", "cos", "cosver", "cplatform"].forEach((key) => {
        const value = src.searchParams.get(key);
        if (value !== null && !dst.searchParams.has(key)) dst.searchParams.set(key, value);
      });
    }
    return dst.toString();
  }

  async function fetchText(url) {
    const response = await (originalFetch || window.fetch)(url, { credentials: "include" });
    if (!response || !response.ok) return "";
    return response.text();
  }

  function findBody(videoId, languageCode, kind, tlang) {
    const list = bodies.get(videoId) || [];
    const wanted = tlang || "";
    return (
      list.find((item) => sameLang(item.lang, languageCode) && (item.tlang || "") === wanted && (!kind || !item.kind || item.kind === kind)) ||
      (!wanted ? list.find((item) => sameLang(item.lang, languageCode) && !(item.tlang || "")) : null) ||
      null
    );
  }

  async function readTrack(data, videoId, tlang) {
    const donor = pickDonor(videoId, data.languageCode, data.kind, tlang);
    if (!data.baseUrl && !(donor && donor.href)) return "";
    const exact = donor && sameLang(donor.lang, data.languageCode) && (donor.tlang || "") === tlang;
    const url = exact ? withParams(donor.href, null, tlang) : withParams(data.baseUrl || donor.href, donor && donor.href, tlang);
    try {
      return await fetchText(url);
    } catch (err) {
      return "";
    }
  }

  async function fetchTrack(data) {
    const videoId = data.videoId || videoIdFromLocation();
    const tlang = data.tlang || "";
    const ready = findBody(videoId, data.languageCode, data.kind, tlang);
    if (ready) return { text: ready.text, bytes: ready.text.length };

    let text = await readTrack(data, videoId, tlang);
    if (!bodyMissing(text)) return { text, bytes: text.length };

    if (!tlang) {
      try {
        await potFor(videoId);
      } catch (err) {
        /* player toggle is optional */
      }
      const hit = findBody(videoId, data.languageCode, data.kind, "");
      if (hit) return { text: hit.text, bytes: hit.text.length };
      text = await readTrack(data, videoId, "");
      if (!bodyMissing(text)) return { text, bytes: text.length };
    }
    return { text: "", bytes: 0 };
  }

  function reply(requestId, data) {
    window.postMessage({ source: "linguamate-page", requestId, data }, "*");
  }

  function onMessage(event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "linguamate-content" || !msg.requestId) return;
    if (msg.type === "LM_PING") reply(msg.requestId, { ok: true, version: VERSION });
    if (msg.type === "LM_GET_TRACKS") reply(msg.requestId, getTracks());
    if (msg.type === "LM_NUDGE_CC") {
      const videoId = (msg.data && msg.data.videoId) || videoIdFromLocation();
      forcePot(videoId)
        .then(() => reply(msg.requestId, getTracks()))
        .catch(() => reply(msg.requestId, getTracks()));
    }
    if (msg.type === "LM_FETCH_TRACK") {
      fetchTrack(msg.data || {})
        .then((data) => reply(msg.requestId, data))
        .catch((err) => reply(msg.requestId, { text: "", bytes: 0, error: String(err && err.message ? err.message : err) }));
    }
  }

  function onNavigate() {
    window.postMessage({ source: "linguamate-page", type: "LM_NAVIGATE", href: location.href }, "*");
  }

  window.addEventListener("message", onMessage);
  document.addEventListener("yt-navigate-finish", onNavigate);
  window.__linguaMateCleanup = function () {
    window.removeEventListener("message", onMessage);
    document.removeEventListener("yt-navigate-finish", onNavigate);
    if (observer) observer.disconnect();
  };
  window.__linguaMatePage = VERSION;
  window.postMessage({ source: "linguamate-page", type: "LM_READY", href: location.href }, "*");
})();
