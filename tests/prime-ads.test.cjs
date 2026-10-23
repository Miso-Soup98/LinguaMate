const test = require("node:test");
const assert = require("node:assert/strict");
const { primeHarness } = require("./prime-harness.cjs");

function indicator(h, parent = h.document.documentElement) {
  const node = h.document.createElement("div");
  node.className = "atvwebplayersdk-adtimeindicator-text";
  node.textContent = "広告 0:30";
  parent.append(node);
  return node;
}
function message(h, data) { h.window.emit("message", { source: h.window, data: { source: "linguamate-prime", ...data } }); }
function finish(h, marker, seconds) {
  marker?.remove();
  h.prime.onTick();
  h.advance(401);
  h.video.currentTime += seconds === undefined ? .401 : seconds;
  h.prime.onTick();
}
function at(h, seconds) { h.video.currentTime = seconds; h.prime.onTick(); }

test("a same-video ad freezes subtitle progress, restores native captions, and resumes on content time", async () => {
  const h = primeHarness({ settings: { autoPause: true, playbackRate: .75 } });
  h.cues(50); at(h, 10);
  const { prime: p } = h;
  const oldRow = p.ui.activeRow;
  const oldIndex = p.state.activeIndex;
  const oldScroll = p.ui.panelBody.scrollTop;
  await p.showDict(p.ui.learningLine.querySelector(".lm-word"));
  const marker = indicator(h);
  p.onTick();
  assert.equal(p.state.adActive, true);
  assert.equal(p.ui.adStatus.hidden, false);
  assert.equal(p.ui.subs.classList.contains("lm-hidden"), true);
  assert.equal(p.ui.dict.classList.contains("lm-hidden"), true);
  assert.equal(h.document.documentElement.classList.contains("lm-prime-captions"), false);
  h.video.playbackRate = 1; h.advance(30000); at(h, 40);
  p.syncSettings();
  assert.equal(h.video.playbackRate, 1, "study playback rate is not applied to advertisements");
  assert.equal(p.ui.activeRow, oldRow);
  assert.equal(p.state.activeIndex, oldIndex);
  assert.equal(p.ui.panelBody.scrollTop, oldScroll);
  assert.equal(h.video.pauseCalls, 0, "an ad cannot trigger sentence auto-pause");
  finish(h, marker);
  assert.equal(p.state.adActive, false);
  assert.deepEqual(JSON.parse(JSON.stringify(p.playback.timeline.breaks())), [{ start: 10000, end: 40000 }]);
  assert.equal(p.contentTimeMs(), 10401);
  assert.equal(p.state.activeIndex, 5);
  assert.equal(p.ui.subs.classList.contains("lm-hidden"), false);
  assert.equal(h.document.documentElement.classList.contains("lm-prime-captions"), true);
  assert.equal(h.video.playbackRate, .75, "the study rate is restored only after the ad ends");
});

test("multiple ads preserve correct subtitle jumps before, between and after ad breaks", () => {
  const h = primeHarness(); h.cues(90); at(h, 10);
  let marker = indicator(h); h.prime.onTick(); h.advance(30000); at(h, 40); finish(h, marker);
  at(h, 50); marker = indicator(h); h.prime.onTick(); h.advance(15000); at(h, 65); finish(h, marker);
  for (const [content, media] of [[4000, 4.01], [16000, 46.01], [22000, 67.01]]) {
    h.prime.seekTo(content, false);
    assert.equal(h.video.currentTime, media);
    assert.ok(Math.abs(h.prime.contentTimeMs() - content - 10) < 1e-6);
  }
});

test("an empty parsed manifest does not disable observed continuous ad compensation", () => {
  const h = primeHarness(); h.cues(30); at(h, 10);
  message(h, { type: "LM_PRIME_TIMELINE", breaks: [] });
  const marker = indicator(h); h.prime.onTick(); h.advance(30000); at(h, 40); finish(h, marker);
  assert.equal(h.prime.contentTimeMs(), 10401);
});

test("an independent short advertising manifest cannot replace the programme's timeline", () => {
  const h = primeHarness(); h.cues(90); at(h, 5);
  message(h, { type: "LM_PRIME_TIMELINE", role: "content", duration: 3600000, breaks: [{ start: 10000, end: 40000 }] });
  const marker = indicator(h); h.prime.onTick();
  message(h, { type: "LM_PRIME_TIMELINE", role: "content", duration: 30000, breaks: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.prime.playback.timeline.breaks())), [{ start: 10000, end: 40000 }]);
  marker.remove();
});

test("a programme manifest received before its video duration is ready is deferred safely", () => {
  const h = primeHarness();
  message(h, { type: "LM_PRIME_TIMELINE", role: "content", duration: 3700000, breaks: [{ start: 10000, end: 40000 }] });
  assert.equal(h.prime.playback.timeline.breaks().length, 0);
  h.video.duration = 3700;
  h.prime.contentTimeMs();
  assert.equal(h.prime.playback.timeline.breaks().length, 1);
});

test("known MPD boundaries hide ads without a visible countdown and do not double-count a DOM observation", () => {
  const h = primeHarness(); h.cues(90);
  message(h, { type: "LM_PRIME_TIMELINE", breaks: [{ start: 10000, end: 40000 }, { start: 60000, end: 75000 }] });
  at(h, 9.75); at(h, 10.25);
  assert.equal(h.prime.state.adActive, true);
  h.advance(30000); at(h, 40.25); finish(h, null);
  assert.equal(h.prime.contentTimeMs(), 10651);
  assert.equal(h.prime.playback.timeline.breaks()[0].end, 40000, "authoritative boundary is retained exactly");
  h.prime.seekTo(40000, true);
  assert.equal(h.video.currentTime, 85.01);
});

test("paused or buffering ads remove elapsed media rather than wall-clock time", () => {
  const h = primeHarness(); h.cues(40); at(h, 10);
  const marker = indicator(h); h.prime.onTick();
  h.advance(30000); at(h, 25);
  h.video.paused = true; h.advance(60000); h.prime.onTick();
  h.video.paused = false; h.advance(15000); at(h, 40);
  finish(h, marker);
  assert.equal(h.prime.contentTimeMs(), 10401);
});

test("the short gap between two ad clips remains one frozen break", () => {
  const h = primeHarness(); h.cues(50); at(h, 10);
  const marker = indicator(h); h.prime.onTick(); h.advance(10000); at(h, 20);
  marker.hidden = true; h.prime.onTick(); h.advance(200);
  assert.equal(h.prime.state.adActive, true);
  marker.hidden = false; at(h, 20.2); h.advance(19800); at(h, 40); finish(h, marker);
  assert.equal(h.prime.contentTimeMs(), 10401);
});

test("an independent ad video never contributes its local clock to the programme", () => {
  const h = primeHarness(); h.cues(90); at(h, 100);
  const adVideo = h.document.createElement("video");
  Object.assign(adVideo, { currentTime: 0, currentSrc: "blob:ad", paused: false, clientWidth: 1200, clientHeight: 700 });
  const marker = indicator(h); h.video.hidden = true; h.document.documentElement.append(adVideo);
  h.prime.onTick(); h.advance(30000); adVideo.currentTime = 30; h.prime.onTick();
  assert.equal(h.prime.contentTimeMs(), 100000);
  adVideo.remove(); h.video.hidden = false; finish(h, marker);
  assert.equal(h.prime.playback.timeline.breaks().length, 0);
  assert.equal(h.prime.contentTimeMs(), 100401);
});

test("same-video ad clock reset and restored source do not produce a false offset", () => {
  const h = primeHarness(); h.cues(90); at(h, 100);
  const marker = indicator(h); h.video.currentSrc = "blob:ad"; at(h, 0);
  h.advance(30000); at(h, 30);
  h.video.currentSrc = "blob:programme"; at(h, 100); finish(h, marker);
  assert.equal(h.prime.playback.timeline.breaks().length, 0);
  assert.equal(h.prime.contentTimeMs(), 100401);
});

test("a pre-roll that resets the same video clock before content starts is not subtracted again", () => {
  const h = primeHarness(); h.cues(50);
  const marker = indicator(h); h.prime.onTick(); h.advance(30000); at(h, 30);
  marker.remove(); h.prime.onTick(); h.advance(100); at(h, 0);
  h.advance(401); at(h, .401);
  assert.equal(h.prime.state.adActive, false);
  assert.equal(h.prime.playback.timeline.breaks().length, 0);
  at(h, 35); assert.equal(h.prime.contentTimeMs(), 35000);
});

test("hidden ancestors and empty ad templates do not pause content or select a hidden video", () => {
  const h = primeHarness(); h.cues(20);
  const parent = h.document.createElement("div"); parent.style.display = "none"; h.document.documentElement.append(parent);
  indicator(h, parent);
  const hiddenVideo = h.document.createElement("video"); hiddenVideo.clientWidth = 5000; hiddenVideo.clientHeight = 5000; parent.append(hiddenVideo);
  const empty = indicator(h); empty.textContent = "";
  at(h, 2.5);
  assert.equal(h.prime.videoEl(), h.video);
  assert.equal(h.prime.state.adActive, false);
  assert.equal(h.prime.state.activeIndex, 1);
});

test("advertising cannot add live captions, replace a native track, or consume study seek shortcuts", () => {
  const h = primeHarness(); h.cues(30); at(h, 10);
  const original = h.prime.state.cues;
  const marker = indicator(h); h.prime.onTick();
  const caption = h.document.createElement("div"); caption.className = "captions-text"; caption.textContent = "An advertisement"; h.document.documentElement.append(caption);
  h.video.textTracks = [{ language: "en", mode: "showing", cues: [{ startTime: 0, endTime: 5, text: "Ad captions" }] }];
  h.prime.scrapeLiveCaption(); h.prime.syncTextTracks();
  message(h, { type: "LM_TRACK", text: "WEBVTT\n\n00:00.000 --> 00:03.000\nAd caption", lang: "en" });
  const event = h.key("keydown", "d"); h.prime.seekTo(0, true);
  assert.equal(h.prime.state.cues, original);
  assert.equal(h.prime.state.cues.length, 30);
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.video.currentTime, 10);
  assert.equal(h.video.playCalls, 0);
  marker.remove();
});

test("a programme track arriving during a pre-roll is queued and restored when the ad ends", async () => {
  const h = primeHarness(); const marker = indicator(h); h.prime.onTick();
  message(h, { type: "LM_TRACK", role: "content", text: "WEBVTT\n\n00:00.000 --> 00:03.000\nProgramme subtitle", lang: "en" });
  assert.equal(h.prime.state.cues.length, 0);
  h.advance(30000); at(h, 30); finish(h, marker); await h.flush();
  assert.equal(h.prime.state.cues[0].text, "Programme subtitle");
  assert.equal(h.prime.state.activeIndex, 0);
});

test("explicit seeks or discontinuous forward jumps during an ad are never counted as advertising duration", () => {
  for (const seeking of [true, false]) {
    const h = primeHarness(); h.cues(90); at(h, 10);
    const marker = indicator(h); h.prime.onTick();
    h.video.seeking = seeking; h.video.emit("seeking"); at(h, 100);
    h.video.seeking = false; h.video.emit("seeked"); finish(h, marker);
    assert.equal(h.prime.playback.timeline.breaks().length, 0);
    assert.equal(h.prime.contentTimeMs(), 100401);
  }
});

test("subtitle-clock native tracks retain their own media timestamps and are not compensated twice", () => {
  const h = primeHarness({ textTracks: [{ language: "en", mode: "showing", cues: [{ startTime: 40, endTime: 45, text: "Media-timed caption" }] }] });
  message(h, { type: "LM_PRIME_TIMELINE", breaks: [{ start: 10000, end: 40000 }] });
  at(h, 40.5); h.prime.syncTextTracks(); h.prime.renderCurrent();
  assert.equal(h.prime.state.trackClock, "media");
  assert.equal(h.prime.ui.learningLine.textContent, "Media-timed caption");
  h.prime.seekTo(41000, true); assert.equal(h.video.currentTime, 41.01);
});

test("saved vocabulary uses programme time and SPA episode changes discard the earlier ad timeline", async () => {
  const h = primeHarness(); h.cues(90);
  message(h, { type: "LM_PRIME_TIMELINE", breaks: [{ start: 10000, end: 40000 }] });
  at(h, 50); await h.prime.saveWord("sample", "context", { word: "sample", translation: "example" }, "en");
  assert.equal(h.vocab[0].time, 20);
  const oldScope = h.prime.playback.scope;
  h.prime.ui.clockVideo.ownerDocument.title = "Next episode";
  // URL is the only programme identity; title text and signed media URLs are not.
  h.prime.playback.scope = "/old-episode|gti=|titleId=|asin=";
  h.prime.checkPlaybackSession();
  assert.equal(h.prime.state.cues.length, 0);
  assert.equal(h.prime.playback.timeline.breaks().length, 0);
  message(h, { type: "LM_PRIME_TIMELINE", scope: "/old-episode|gti=|titleId=|asin=", breaks: [{ start: 0, end: 10000 }] });
  assert.equal(h.prime.playback.timeline.breaks().length, 0);
  assert.equal(h.prime.playback.scope, oldScope);
});

test("Prime's remaining-time marker freezes study features even without a legacy timer parent", async () => {
  const h = primeHarness({ settings: { autoPause: true } });
  h.cues(90); at(h, 10);
  const p = h.prime;
  const oldIndex = p.state.activeIndex;
  const oldRow = p.ui.activeRow;
  const oldScroll = p.ui.panelBody.scrollTop;
  const word = p.ui.learningLine.querySelector(".lm-word");
  const parent = h.document.createElement("div");
  parent.className = "prime-player-ad-layout-variant";
  parent.setAttribute("aria-hidden", "true");
  const marker = h.document.createElement("span");
  marker.className = "atvwebplayersdk-ad-timer-remaining-time";
  marker.textContent = "1:48";
  parent.append(marker);
  h.document.documentElement.append(parent);

  p.onTick();
  assert.equal(p.state.adActive, true, "the actual Prime timer class starts advertising state");
  assert.equal(p.ui.adStatus.hidden, false);
  assert.equal(p.ui.subs.classList.contains("lm-hidden"), true);
  assert.equal(h.document.documentElement.classList.contains("lm-prime-captions"), false);
  const lookups = h.lookupRequests().length;
  await p.showDict(word);
  assert.equal(h.lookupRequests().length, lookups, "advertising cannot open a word card");
  h.advance(108000); at(h, 118);
  assert.equal(p.state.activeIndex, oldIndex);
  assert.equal(p.ui.activeRow, oldRow);
  assert.equal(p.ui.panelBody.scrollTop, oldScroll);
  assert.equal(h.video.pauseCalls, 0, "crossing programme sentence ends cannot pause advertising");
  const key = h.key("keydown", "d");
  p.seekTo(50000, true);
  assert.equal(key.defaultPrevented, false);
  assert.equal(h.video.currentTime, 118, "transcript and keyboard seeking remain blocked during the ad");
  assert.equal(h.video.playCalls, 0);

  finish(h, marker);
  assert.equal(p.state.adActive, false);
  assert.equal(p.ui.adStatus.hidden, true);
  assert.equal(p.ui.subs.classList.contains("lm-hidden"), false);
  assert.equal(p.contentTimeMs(), 10401);
  assert.equal(p.state.activeIndex, oldIndex);
  assert.deepEqual(JSON.parse(JSON.stringify(p.playback.timeline.breaks())), [{ start: 10000, end: 118000 }]);
});

test("a cached empty programme MPD replay cannot erase an observed advertising break", () => {
  const h = primeHarness(); h.cues(90); at(h, 10);
  const programme = { type: "LM_PRIME_TIMELINE", role: "content", duration: h.video.duration * 1000, breaks: [] };
  message(h, programme);
  const marker = indicator(h); h.prime.onTick();
  h.advance(30000); at(h, 40); finish(h, marker);
  assert.equal(h.prime.contentTimeMs(), 10401);

  message(h, programme);
  assert.equal(h.prime.contentTimeMs(), 10401, "a later pull must retain the observed content offset");
  assert.deepEqual(JSON.parse(JSON.stringify(h.prime.playback.timeline.breaks())), [{ start: 10000, end: 40000 }]);
  h.prime.seekTo(12000, false);
  assert.equal(h.video.currentTime, 42.01, "subtitle seeking still includes the previously observed ad");
});

test("a later nonoverlapping manifest break preserves earlier observed advertising", () => {
  const h = primeHarness(); h.cues(90); at(h, 10);
  const marker = indicator(h); h.prime.onTick();
  h.advance(30000); at(h, 40); finish(h, marker);
  message(h, { type: "LM_PRIME_TIMELINE", role: "content", duration: h.video.duration * 1000, breaks: [{ start: 60000, end: 75000 }] });

  assert.deepEqual(JSON.parse(JSON.stringify(h.prime.playback.timeline.breaks())), [
    { start: 10000, end: 40000 },
    { start: 60000, end: 75000 }
  ]);
  assert.equal(h.prime.contentTimeMs(), 10401);
  at(h, 80);
  assert.equal(h.prime.contentTimeMs(), 35000, "both observed and manifest advertising intervals are removed");
  h.prime.seekTo(35000, false);
  assert.equal(h.video.currentTime, 80.01);
});

test("an updated manifest refines overlapping observed boundaries without double-counting", () => {
  const h = primeHarness(); h.cues(90); at(h, 10);
  const marker = indicator(h); h.prime.onTick();
  h.advance(30000); at(h, 40); finish(h, marker);
  const programme = { type: "LM_PRIME_TIMELINE", role: "content", duration: h.video.duration * 1000, breaks: [{ start: 9750, end: 40050 }] };
  for (let i = 0; i < 3; i += 1) message(h, programme);
  assert.deepEqual(JSON.parse(JSON.stringify(h.prime.playback.timeline.breaks())), [{ start: 9750, end: 40050 }]);
  assert.equal(h.prime.contentTimeMs(), 10101);
  message(h, { ...programme, breaks: [{ start: -1, end: 40050 }] });
  assert.equal(h.prime.contentTimeMs(), 10101, "a malformed replacement cannot discard the usable timeline");
});
