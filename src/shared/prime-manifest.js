(() => {
  function durationMs(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^PT(?=\d)(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
    if (!match) return null;
    const result = (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
    return Number.isFinite(result) && result < 1e12 ? result : null;
  }

  function parse(text, { adActive = false } = {}) {
    // Only a complete, static presentation describes the earlier ad breaks.
    if (typeof text !== "string" || text.length > 5000000 || /<!DOCTYPE/i.test(text)) return null;
    // Page Trusted Types may reject DOMParser. Let the caller forward the raw
    // manifest to the extension's isolated world, using this same parser there.
    const documentXml = new DOMParser().parseFromString(text, "application/xml");
    const mpd = documentXml.documentElement;
    if (!mpd || mpd.localName !== "MPD" || documentXml.getElementsByTagName("parsererror").length || mpd.getAttribute("type") === "dynamic") return null;
    const periods = Array.from(mpd.children).filter((node) => node.localName === "Period");
    if (!periods.length || periods.length > 2000) return null;
    const descriptors = new Set(["Descriptor", "EssentialProperty", "SupplementalProperty", "Role"]);
    const segments = periods.map((period) => ({
      start: period.hasAttribute("start") ? durationMs(period.getAttribute("start")) : null,
      duration: period.hasAttribute("duration") ? durationMs(period.getAttribute("duration")) : null,
      explicitStart: period.hasAttribute("start"),
      explicitDuration: period.hasAttribute("duration"),
      ad: Array.from(period.getElementsByTagName("*")).some((node) =>
        (descriptors.has(node.localName) && /^(?:Ad|Draper)$/.test(node.getAttribute("value") || "")) ||
        (node.localName === "BaseURL" && /\/interstitial\//i.test(node.textContent || "")))
    }));
    const hasAds = segments.some((segment) => segment.ad);
    const hasContent = segments.some((segment) => !segment.ad);
    if (!hasContent || (adActive && !hasAds)) return null;
    if (segments.some((segment) => (segment.explicitStart && segment.start === null) || (segment.explicitDuration && segment.duration === null))) return null;
    if (segments[0].start === null) segments[0].start = 0;
    // A partial VOD manifest starting later cannot account for earlier ads.
    if (segments[0].start !== 0) return null;
    for (let i = 1; i < segments.length; i += 1) {
      const previous = segments[i - 1];
      if (segments[i].start === null && previous.duration !== null) segments[i].start = previous.start + previous.duration;
      if (segments[i].start === null) return null;
    }
    const presentationEnd = mpd.hasAttribute("mediaPresentationDuration") ? durationMs(mpd.getAttribute("mediaPresentationDuration")) : null;
    if (mpd.hasAttribute("mediaPresentationDuration") && presentationEnd === null) return null;
    const breaks = [];
    let duration = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const nextStart = i + 1 < segments.length ? segments[i + 1].start : presentationEnd;
      const end = segment.duration !== null ? segment.start + segment.duration : nextStart;
      if (end === null || end <= segment.start || (nextStart !== null && Math.abs(end - nextStart) > 10)) return null;
      if (segment.ad) breaks.push({ start: segment.start, end });
      duration = end;
    }
    return { breaks, duration };
  }

  globalThis.lmPrimeManifest = { parse };
})();
