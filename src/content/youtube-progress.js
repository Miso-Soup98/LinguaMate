// Remember just the playback position for a reload in this tab.
const lmYoutubeProgress = (() => {
  const key = "linguamate.youtube.reload";
  const openingSeconds = 4;
  const initialUrl = new URL(location.href);
  const timestamp = ["t", "start", "time_continue", "end"].some(name => initialUrl.searchParams.has(name)) ||
    /^#(?:t=|\d)/i.test(initialUrl.hash);
  let pending;
  let checkpoint = null;
  let readyAt = null;

  if (initialUrl.pathname === "/watch" && !timestamp && performance.getEntriesByType("navigation")[0]?.type === "reload") {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key));
      if (saved?.videoId === initialUrl.searchParams.get("v") && Number.isFinite(saved.time) && saved.time >= 2) pending = saved;
    } catch (_) { /* storage can be blocked */ }
  }

  function skip() { pending = null; }

  function observe(video, videoId) {
    if (location.pathname !== "/watch") videoId = "";
    if (checkpoint?.videoId !== videoId) checkpoint = null;
    if (pending && pending.videoId !== videoId) skip();
    if (!videoId || !video || video.readyState < 1 ||
        video.closest(".ad-showing, .ad-interrupting, .ytp-live:not(.ytp-live-recorded)") ||
        !Number.isFinite(video.duration)) {
      readyAt = null;
      return;
    }
    if (pending) {
      if (video.currentTime >= openingSeconds || Math.abs(video.currentTime - pending.time) <= 1) {
        skip();
      } else {
        // Give the player a chance to restore its own position first.
        readyAt ??= performance.now();
        if (video.seeking || performance.now() - readyAt < 1000) return;
        const time = pending.time;
        if (time < video.duration) {
          const ranges = video.seekable;
          let seekable = false;
          for (let i = 0; i < ranges.length; i++) {
            if (time >= ranges.start(i) && time <= ranges.end(i)) { seekable = true; break; }
          }
          if (!seekable && performance.now() - readyAt < 5000) return;
          skip();
          if (seekable) {
            try {
              video.currentTime = time;
              checkpoint = { videoId, time };
            } catch (_) { /* the stream changed */ }
          }
        } else skip();
      }
    }
    if (!video.seeking) {
      checkpoint = video.ended || video.currentTime < 2 ? null : { videoId, time: video.currentTime };
    }
  }

  function save(videoId) {
    const position = pending || checkpoint;
    try {
      if (location.pathname === "/watch" && position?.videoId === videoId) sessionStorage.setItem(key, JSON.stringify(position));
      else sessionStorage.removeItem(key);
    } catch (_) { /* storage can be blocked */ }
  }

  return { observe, save, skip };
})();
