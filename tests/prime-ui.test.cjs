const assert = require("node:assert/strict");
const test = require("node:test");
const { primeHarness } = require("./prime-harness.cjs");

test("playback follows the current cue without scrolling on unchanged 250ms ticks", () => {
  const h = primeHarness();
  h.cues();
  h.video.currentTime = 16.5;
  h.prime.renderCurrent();
  const { panelBody, learningLine } = h.prime.ui;
  assert.ok(panelBody.scrollTop > 0, "later playback cues must move the transcript viewport");
  assert.ok(panelBody.querySelectorAll(".lm-cue")[8].classList.contains("active"));
  const word = learningLine.querySelector(".lm-word");
  const writes = panelBody.scrollWrites;
  h.prime.renderCurrent();
  h.prime.renderCurrent();
  assert.equal(learningLine.querySelector(".lm-word"), word, "unchanged captions must preserve hovered DOM words");
  assert.equal(panelBody.scrollWrites, writes, "polling an unchanged cue must not repeatedly move the viewport");
});

test("manual upward scrolling suspends follow until the resume button is clicked", () => {
  const h = primeHarness();
  h.cues();
  h.video.currentTime = 16.5;
  h.prime.renderCurrent();
  const { panelBody, panel, followButton } = h.prime.ui;
  assert.ok(followButton, "the transcript needs a visible resume control");
  panelBody.scrollTop = 20;
  panelBody.emit("scroll");
  assert.equal(h.prime.state.followTranscript, false);
  h.video.currentTime = 20.5;
  h.prime.renderCurrent();
  assert.equal(panelBody.scrollTop, 20, "new cues must preserve the user's history-reading position");
  panel.emit("click", { target: followButton });
  assert.equal(h.prime.state.followTranscript, true);
  assert.ok(panelBody.scrollTop > 20, "resuming follows the current playback cue immediately");
});

test("scrolling back to the transcript bottom resumes automatic follow", () => {
  const h = primeHarness();
  h.cues();
  h.video.currentTime = 20.5;
  h.prime.renderCurrent();
  const { panelBody } = h.prime.ui;
  panelBody.scrollTop = 0;
  panelBody.emit("scroll");
  assert.equal(h.prime.state.followTranscript, false);
  panelBody.scrollTop = panelBody.scrollHeight - panelBody.clientHeight;
  panelBody.emit("scroll");
  assert.equal(h.prime.state.followTranscript, true);
});

test("appending live transcript cues and translations preserves existing word nodes", () => {
  const h = primeHarness();
  const rows = h.cues(8);
  const word = rows[0].querySelector(".lm-word");
  h.prime.state.cues.push({ start: 16000, end: 18000, text: "The newest live caption" });
  h.prime.renderPanel();
  assert.equal(h.prime.ui.panelBody.querySelectorAll(".lm-cue").length, 9);
  assert.equal(h.prime.ui.panelBody.querySelectorAll(".lm-cue")[0], rows[0]);
  assert.equal(rows[0].querySelector(".lm-word"), word);
  h.prime.state.native[0] = "第一句翻译";
  h.prime.renderPanel();
  assert.equal(rows[0].querySelector(".lm-cue-native").textContent, "第一句翻译");
  assert.equal(rows[0].querySelector(".lm-word"), word, "translation completion must preserve hover targets");
});

test("a fresh track replaces obsolete content and seeking follows earlier active cues", () => {
  const h = primeHarness();
  const rows = h.cues();
  const obsoleteWord = rows[0].querySelector(".lm-word");
  h.video.currentTime = 20.5;
  h.prime.renderCurrent();
  h.prime.ui.panelBody.scrollTop = 20;
  h.prime.ui.panelBody.emit("scroll");
  assert.equal(h.prime.state.followTranscript, false);
  h.prime.seekTo(2000, true);
  assert.equal(h.prime.state.followTranscript, true, "deliberate seeks must resume following playback");
  assert.ok(h.prime.ui.panelBody.scrollTop < 200, "backward seeks must reveal the earlier active cue");
  h.prime.state.cues = [{ start: 0, end: 5000, text: "A replacement track" }];
  h.prime.state.native = [];
  h.prime.renderPanel();
  h.prime.renderCurrent();
  assert.equal(h.prime.ui.panelBody.querySelectorAll(".lm-cue").length, 1);
  assert.equal(obsoleteWord.isConnected, false, "old track words must be removed even if their row container is reused");
  assert.match(h.prime.ui.panelBody.textContent, /replacement track/);
});

test("quick mouse passes cancel lookup; a deliberate hover performs one lookup", async () => {
  const h = primeHarness();
  h.cues();
  const words = h.prime.ui.learningLine.querySelectorAll(".lm-word");
  h.hover(words[0]);
  h.advance(100);
  h.leave(words[0], words[1]);
  h.hover(words[1], words[0]);
  h.advance(100);
  h.leave(words[1]);
  h.advance(1000);
  assert.equal(h.lookupRequests().length, 0, "sweeping past words must not query or flash cards");
  h.hover(words[2]);
  h.advance(299);
  assert.equal(h.lookupRequests().length, 0);
  h.advance(1);
  await h.flush();
  assert.equal(h.lookupRequests().length, 1);
  assert.equal(h.lookupRequests()[0].word, words[2].dataset.word);
  h.hover(words[2]);
  h.advance(1000);
  assert.equal(h.lookupRequests().length, 1, "remaining over one word must not refetch it");
});

test("an open dictionary remains stable while crossing another word briefly", async () => {
  const h = primeHarness();
  h.cues();
  const words = h.prime.ui.learningLine.querySelectorAll(".lm-word");
  h.hover(words[0]);
  h.advance(300);
  await h.flush();
  const firstCard = h.prime.ui.dict.textContent;
  h.leave(words[0], words[1]);
  h.hover(words[1], words[0]);
  h.advance(479);
  assert.equal(h.lookupRequests().length, 1);
  assert.equal(h.prime.ui.dict.textContent, firstCard);
  h.leave(words[1], h.prime.ui.dict);
  h.prime.onHover({ target: h.prime.ui.dict });
  h.advance(1000);
  assert.equal(h.lookupRequests().length, 1, "entering the card must cancel a pending word switch");
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), false);
});

test("late dictionary responses cannot replace a newer hovered word", async () => {
  const h = primeHarness({ deferredLookup: true });
  h.cues();
  const words = h.prime.ui.learningLine.querySelectorAll(".lm-word");
  h.hover(words[0]);
  h.advance(300);
  h.leave(words[0], words[1]);
  h.hover(words[1], words[0]);
  h.advance(480);
  assert.equal(h.pendingLookups.length, 2);
  h.pendingLookups[1].callback({ result: { word: "new-result", translation: "new" } });
  await h.flush();
  h.pendingLookups[0].callback({ result: { word: "obsolete-result", translation: "old" } });
  await h.flush();
  assert.match(h.prime.ui.dict.textContent, /new-result/);
  assert.doesNotMatch(h.prime.ui.dict.textContent, /obsolete-result/);
});

test("returning to the same word still rejects an earlier request for that node", async () => {
  const h = primeHarness({ deferredLookup: true });
  h.cues();
  const words = h.prime.ui.learningLine.querySelectorAll(".lm-word");
  h.hover(words[0]);
  h.advance(300);
  h.leave(words[0], words[1]);
  h.hover(words[1], words[0]);
  h.advance(480);
  h.leave(words[1], words[0]);
  h.hover(words[0], words[1]);
  h.advance(480);
  assert.equal(h.pendingLookups.length, 3);
  assert.equal(h.pendingLookups[0].message.word, h.pendingLookups[2].message.word);
  h.pendingLookups[2].callback({ result: { word: "current-response", translation: "new" } });
  await h.flush();
  h.pendingLookups[0].callback({ result: { word: "stale-same-node", translation: "old" } });
  h.pendingLookups[1].callback({ result: { word: "stale-other-node", translation: "old" } });
  await h.flush();
  assert.match(h.prime.ui.dict.textContent, /current-response/);
  assert.doesNotMatch(h.prime.ui.dict.textContent, /stale-/);
});

test("a pending hover is cancelled when its caption word disappears", () => {
  const h = primeHarness();
  h.cues();
  const word = h.prime.ui.learningLine.querySelector(".lm-word");
  h.hover(word);
  h.advance(200);
  h.video.currentTime = 2.5;
  h.prime.renderCurrent();
  assert.equal(word.isConnected, false);
  h.advance(1000);
  assert.equal(h.lookupRequests().length, 0, "a detached caption must not open a delayed dictionary");
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), true);
});

test("open cards follow their anchor after rendering and close if it is hidden or removed", async () => {
  const h = primeHarness();
  const rows = h.cues();
  const word = rows[0].querySelector(".lm-word");
  let position = { left: 480, top: 220, bottom: 240, right: 520, width: 40, height: 20 };
  word.getBoundingClientRect = () => position;
  h.hover(word);
  h.advance(300);
  await h.flush();
  assert.equal(h.prime.ui.dict.style.left, "480px");
  assert.equal(h.prime.ui.dict.style.top, "246px");

  position = { ...position, left: 520, top: 260, bottom: 280, right: 560 };
  h.prime.renderCurrent();
  assert.equal(h.prime.ui.dict.style.left, "520px");
  assert.equal(h.prime.ui.dict.style.top, "286px");

  h.prime.state.native[0] = "Translation changes the transcript's layout";
  position = { ...position, left: 560, top: 300, bottom: 320, right: 600 };
  h.prime.renderPanel();
  assert.equal(rows[0].querySelector(".lm-word"), word);
  assert.equal(h.prime.ui.dict.style.left, "560px");
  assert.equal(h.prime.ui.dict.style.top, "326px");

  word.classList.add("lm-hidden");
  h.prime.renderCurrent();
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), true);
  word.classList.remove("lm-hidden");
  h.hover(word);
  h.advance(300);
  await h.flush();
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), false);
  h.prime.state.cues[0].text = "Replacement caption removes the original anchor";
  h.prime.renderPanel();
  assert.equal(word.isConnected, false);
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), true);
});

test("scroll and resize close cards anchored to moving content", async () => {
  const h = primeHarness();
  h.cues();
  const word = h.prime.ui.learningLine.querySelector(".lm-word");
  h.hover(word);
  h.advance(300);
  await h.flush();
  h.window.emit("scroll", { target: h.prime.ui.dict });
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), false, "scrolling a dictionary's own content must keep it open");
  h.window.emit("scroll", { target: h.prime.ui.panelBody });
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), true);
  h.hover(word);
  h.advance(300);
  await h.flush();
  h.window.emit("resize");
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), true);
});
