(() => {
  // Media timestamps include inserted ads; subtitle timestamps describe content.
  // All values are milliseconds. setBreaks replaces the complete interval list,
  // while addBreak adds an observed interval to the currently known timeline.
  const validTime = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const validBreak = (interval) => interval && typeof interval === "object" && !Array.isArray(interval)
    && validTime(interval.start) && validTime(interval.end) && interval.end > interval.start;

  function merge(intervals) {
    const sorted = intervals.map(({ start, end }) => ({ start, end }))
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const result = [];
    for (const interval of sorted) {
      const previous = result[result.length - 1];
      if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
      else result.push(interval);
    }
    return result;
  }

  function create() {
    let intervals = [];
    return {
      setBreaks(value) {
        // A malformed manifest must not erase a previously usable timeline.
        if (!Array.isArray(value) || !Array.from(value).every(validBreak)) return false;
        intervals = merge(value);
        return true;
      },
      addBreak(start, end) {
        if (!validBreak({ start, end })) return false;
        intervals = merge([...intervals, { start, end }]);
        return true;
      },
      toContent(mediaMs) {
        if (!validTime(mediaMs)) return NaN;
        let removed = 0;
        for (const interval of intervals) {
          if (mediaMs < interval.start) break;
          // The content clock stands still throughout an inserted ad.
          if (mediaMs < interval.end) return interval.start - removed;
          removed += interval.end - interval.start;
        }
        return Math.max(0, mediaMs - removed);
      },
      toMedia(contentMs) {
        if (!validTime(contentMs)) return NaN;
        let removed = 0;
        for (const interval of intervals) {
          if (contentMs < interval.start - removed) break;
          // At the shared content boundary, seek past the whole ad interval.
          removed += interval.end - interval.start;
        }
        const result = contentMs + removed;
        return Number.isFinite(result) ? result : NaN;
      },
      reset() { intervals = []; },
      breaks() { return intervals.map(({ start, end }) => ({ start, end })); }
    };
  }

  globalThis.lmPrimeTimeline = { create };
})();
