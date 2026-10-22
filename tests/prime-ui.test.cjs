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
  h.pendingLookups[1].callback({ ok: true, result: { word: "new-result", translation: "new" } });
  await h.flush();
  h.pendingLookups[0].callback({ ok: true, result: { word: "obsolete-result", translation: "old" } });
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
  h.pendingLookups[2].callback({ ok: true, result: { word: "current-response", translation: "new" } });
  await h.flush();
  h.pendingLookups[0].callback({ ok: true, result: { word: "stale-same-node", translation: "old" } });
  h.pendingLookups[1].callback({ ok: true, result: { word: "stale-other-node", translation: "old" } });
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

test("the Prime dictionary button adds and removes its word with confirmed feedback", async () => {
  const h = primeHarness();
  h.cues();
  const word = h.prime.ui.learningLine.querySelector(".lm-word");
  h.hover(word);
  h.advance(300);
  await h.flush();
  const button = h.prime.ui.dict.querySelector(".lm-dict-save");
  assert.equal(button.dataset.vocabState, "unsaved");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "加入生词本");

  button.click();
  assert.equal(button.disabled, true, "the operation must prevent repeated clicks while awaiting storage");
  await h.flush();
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.vocabState, "saved");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.match(button.textContent, /已加入生词本/);
  assert.equal(h.prime.ui.dict.querySelector(".lm-vocab-status").textContent, "已加入生词本");
  assert.equal(h.vocab.length, 1);
  assert.equal(h.vocab[0].word, word.dataset.word);
  assert.equal(h.vocab[0].lang, "en");
  assert.equal(h.vocab[0].context, "Sentence 0 with words");
  const savedId = h.vocab[0].id;

  button.click();
  assert.equal(button.disabled, true);
  await h.flush();
  assert.equal(button.dataset.vocabState, "unsaved");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "加入生词本");
  assert.equal(h.prime.ui.dict.querySelector(".lm-vocab-status").textContent, "已从生词本移除");
  assert.equal(h.vocab.length, 0);
  const deletion = h.requests.find((message) => message.type === "LM_VOCAB_DELETE");
  assert.equal(deletion.id, savedId);
});

test("opening an already saved Prime word shows the saved state and removes its existing id", async () => {
  const h = primeHarness({ initialVocab: [
    { id: "existing-en-word", word: "SENTENCE", lang: "en" },
    { id: "other-language-word", word: "Sentence", lang: "fr" }
  ] });
  h.cues();
  h.hover(h.prime.ui.learningLine.querySelector(".lm-word"));
  h.advance(300);
  await h.flush();
  const button = h.prime.ui.dict.querySelector(".lm-dict-save");
  assert.equal(button.dataset.vocabState, "saved");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.match(button.textContent, /已加入生词本/);
  assert.equal(h.requests.filter((message) => message.type === "LM_VOCAB_ADD").length, 0);
  button.click();
  await h.flush();
  assert.equal(button.dataset.vocabState, "unsaved");
  assert.equal(h.vocab.length, 1);
  assert.equal(h.vocab[0].id, "other-language-word");
  assert.equal(h.requests.find((message) => message.type === "LM_VOCAB_DELETE").id, "existing-en-word");
});

test("failed Prime vocabulary writes show an error without claiming success or changing the saved state", async () => {
  const h = primeHarness({ vocabErrors: { LM_VOCAB_ADD: "storage unavailable" } });
  h.cues();
  h.hover(h.prime.ui.learningLine.querySelector(".lm-word"));
  h.advance(300);
  await h.flush();
  const button = h.prime.ui.dict.querySelector(".lm-dict-save");
  button.click();
  await h.flush();
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(h.vocab.length, 0);
  assert.equal(h.prime.ui.dict.querySelector(".lm-vocab-status").textContent, "操作失败，请重试");
  assert.doesNotMatch(button.textContent, /已加入/);

  delete h.vocabErrors.LM_VOCAB_ADD;
  button.click();
  await h.flush();
  assert.equal(button.dataset.vocabState, "saved");
  assert.equal(h.vocab.length, 1);
  h.vocabErrors.LM_VOCAB_DELETE = "storage unavailable";
  button.click();
  await h.flush();
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(h.vocab.length, 1);
  assert.equal(h.prime.ui.dict.querySelector(".lm-vocab-status").textContent, "操作失败，请重试");
  assert.match(button.textContent, /已加入生词本/);
});

test("a failed vocabulary read requires a successful retry before Prime can change storage", async () => {
  const h = primeHarness({ vocabErrors: { LM_VOCAB_LIST: "storage unavailable" } });
  h.cues();
  h.hover(h.prime.ui.learningLine.querySelector(".lm-word"));
  h.advance(300);
  await h.flush();
  const button = h.prime.ui.dict.querySelector(".lm-dict-save");
  assert.equal(button.dataset.vocabState, "error");
  assert.equal(button.textContent, "重试读取生词本");
  button.click();
  await h.flush();
  assert.equal(button.dataset.vocabState, "error");
  assert.equal(h.requests.filter((message) => ["LM_VOCAB_ADD", "LM_VOCAB_DELETE"].includes(message.type)).length, 0);
  assert.equal(h.vocab.length, 0);
  delete h.vocabErrors.LM_VOCAB_LIST;
  button.click();
  await h.flush();
  assert.equal(button.dataset.vocabState, "unsaved");
  assert.equal(h.vocab.length, 0, "retrying the read must not accidentally add a word");
});

function updateSettings(h, changes) {
  h.prime.applySettings({ ...h.prime.state.settings, ...changes });
}

test("disabling Prime hides its UI, restores platform subtitles and disables study shortcuts", async () => {
  const h = primeHarness();
  h.cues();
  h.hover(h.prime.ui.learningLine.querySelector(".lm-word"));
  h.advance(300);
  await h.flush();
  assert.equal(h.prime.ui.dict.classList.contains("lm-hidden"), false);
  assert.equal(h.document.documentElement.classList.contains("lm-prime-captions"), true);

  updateSettings(h, { enabled: false });
  for (const name of ["root", "toolbar", "panel", "dict"]) assert.equal(h.prime.ui[name].classList.contains("lm-hidden"), true, `${name} should hide`);
  assert.equal(h.document.documentElement.classList.contains("lm-prime-captions"), false, "remove the CSS selector suppressing native subtitles");
  const previousTime = h.video.currentTime;
  const previousPlayCalls = h.video.playCalls;
  const event = h.key("keydown", "d");
  h.key("keyup", "d");
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.video.currentTime, previousTime);
  assert.equal(h.video.playCalls, previousPlayCalls);

  updateSettings(h, { enabled: true });
  assert.equal(h.document.documentElement.classList.contains("lm-prime-captions"), true);
  for (const name of ["root", "toolbar", "panel"]) assert.equal(h.prime.ui[name].classList.contains("lm-hidden"), false);
});

test("caption visibility, listening mode, font size, rate and panel preference apply immediately", async () => {
  const h = primeHarness();
  h.cues(2);
  h.prime.state.native[0] = "第一句译文";
  h.prime.renderCurrent();
  updateSettings(h, { showLearning: false, showNative: false, listenMode: true, fontSize: 30, playbackRate: 0.75, panelOpen: false });
  assert.equal(h.prime.ui.learningLine.classList.contains("lm-hidden"), true);
  assert.equal(h.prime.ui.nativeLine.classList.contains("lm-hidden"), true);
  assert.equal(h.prime.ui.subs.classList.contains("lm-listen"), true);
  assert.equal(h.prime.ui.learningLine.style.fontSize, "30px");
  assert.equal(h.prime.ui.nativeLine.style.fontSize, "26px");
  assert.equal(h.video.playbackRate, 0.75);
  assert.equal(h.prime.ui.panel.classList.contains("lm-collapsed"), true);

  updateSettings(h, { showLearning: true, showNative: true, listenMode: false, panelOpen: true });
  assert.equal(h.prime.ui.learningLine.classList.contains("lm-hidden"), false);
  assert.equal(h.prime.ui.nativeLine.classList.contains("lm-hidden"), false);
  assert.equal(h.prime.ui.subs.classList.contains("lm-listen"), false);
  assert.equal(h.prime.ui.panel.classList.contains("lm-collapsed"), false);
  await h.prime.togglePanel();
  assert.equal(h.requests.at(-1).type, "LM_SET_SETTINGS");
  assert.equal(h.requests.at(-1).settings.panelOpen, false);
  assert.equal(h.prime.ui.panel.classList.contains("lm-collapsed"), true);
  assert.match(h.document.getElementById("lm-feedback-toast").textContent, /已收起/);
});

test("rare-word highlighting changes on existing word nodes and respects saved words", () => {
  const h = primeHarness();
  h.cues(2);
  const word = h.prime.ui.learningLine.querySelector(".lm-word");
  assert.equal(word.classList.contains("lm-rare"), true);
  updateSettings(h, { highlightRare: false });
  assert.equal(h.prime.ui.learningLine.querySelector(".lm-word"), word, "changing styles need not replace hover targets");
  assert.equal(word.classList.contains("lm-rare"), false);
  updateSettings(h, { highlightRare: true });
  assert.equal(word.classList.contains("lm-rare"), true);
  h.storageChange({ vocab: { newValue: [{ id: "saved", word: word.dataset.word, lang: "en" }] } });
  assert.equal(word.classList.contains("lm-saved"), true);
  assert.equal(word.classList.contains("lm-rare"), false);
});

test("switching learning language clears old captions and requests the selected track", () => {
  const h = primeHarness();
  h.cues(2);
  h.prime.state.native[0] = "old translation";
  h.prime.state.fullTrack = true;
  const token = h.prime.state.token;
  updateSettings(h, { learningLang: "ja" });
  assert.equal(h.prime.state.cues.length, 0);
  assert.equal(h.prime.state.native.length, 0);
  assert.equal(h.prime.state.index, -1);
  assert.equal(h.prime.state.activeIndex, -1);
  assert.equal(h.prime.state.fullTrack, false);
  assert.ok(h.prime.state.token > token);
  assert.deepEqual(JSON.parse(JSON.stringify(h.postedMessages.at(-1))), { message: { source: "linguamate-content", type: "LM_PRIME_PULL", lang: "ja" }, origin: "*" });
  assert.doesNotMatch(h.prime.ui.panelBody.textContent, /Sentence/);
});

test("sync storage updates re-read merged settings and apply the newest response", async () => {
  const h = primeHarness({ deferredSettings: true });
  h.cues(2);
  const older = h.storageChange({ fontSize: { newValue: 26 } }, "sync");
  const newer = h.storageChange({ fontSize: { newValue: 32 } }, "sync");
  assert.equal(h.pendingSettings.length, 2);
  h.pendingSettings[1].callback({ ok: true, settings: { fontSize: 32, showNative: false, playbackRate: 0.5 } });
  await h.flush();
  h.pendingSettings[0].callback({ ok: true, settings: { fontSize: 26, showNative: true, playbackRate: 1 } });
  await Promise.all([older, newer]);
  assert.equal(h.prime.state.settings.fontSize, 32);
  assert.equal(h.prime.state.settings.enabled, true, "real defaults remain in force for partial saved settings");
  assert.equal(h.prime.ui.learningLine.style.fontSize, "32px");
  assert.equal(h.video.playbackRate, 0.5);
  assert.equal(h.prime.state.settings.showNative, false);
});

test("caption gaps clear text and active rows while preserving the navigation anchor", () => {
  const h = primeHarness();
  h.cues(3);
  h.prime.state.native[0] = "translated";
  h.video.currentTime = 1.7;
  h.prime.renderCurrent();
  assert.equal(h.prime.state.activeIndex, 0);
  h.video.currentTime = 1.8;
  h.prime.renderCurrent();
  assert.equal(h.prime.currentIndex(1800), -1);
  assert.equal(h.prime.state.activeIndex, -1);
  assert.equal(h.prime.state.index, 0);
  assert.equal(h.prime.navigationIndex(1800), 0);
  assert.equal(h.prime.ui.learningLine.classList.contains("lm-hidden"), true);
  assert.equal(h.prime.ui.nativeLine.classList.contains("lm-hidden"), true);
  assert.equal(h.prime.ui.cueRows[0].classList.contains("active"), false);
  h.key("keydown", "d");
  assert.equal(h.video.currentTime, 2.01, "next-cue shortcut uses the last encountered cue in a gap");
});

test("auto-pause stops natural cue endings and avoids pauses caused by seeks", () => {
  const h = primeHarness({ settings: { autoPause: true } });
  h.cues(3);
  h.video.currentTime = 1.6;
  h.prime.onTick();
  h.video.currentTime = 1.9;
  h.prime.onTick();
  assert.equal(h.video.pauseCalls, 1);
  assert.equal(h.video.paused, true);
  h.prime.seekTo(2000, true);
  h.prime.onTick();
  assert.equal(h.video.pauseCalls, 1);
  assert.equal(h.video.paused, false);
  h.video.currentTime = 5;
  h.prime.onTick();
  assert.equal(h.video.pauseCalls, 1, "large time jumps are not natural sentence endings");
});

test("one-cue text tracks work and never fall back to a different learning language", async () => {
  const english = { language: "en", mode: "showing", cues: [{ startTime: 0, endTime: 2, text: "English" }, { startTime: 2, endTime: 3, text: "More English" }] };
  const japanese = { language: "ja-JP", mode: "hidden", cues: [{ startTime: 0, endTime: 2, text: "日本語" }] };
  const h = primeHarness({ settings: { learningLang: "ja" }, textTracks: [english, japanese] });
  h.prime.syncTextTracks();
  await h.flush();
  assert.equal(h.prime.state.cues.length, 1);
  assert.equal(h.prime.state.cues[0].text, "日本語");
  assert.equal(h.prime.state.trackLang, "ja-JP");
  assert.equal(h.prime.state.fullTrack, true);
  assert.equal(english.mode, "showing", "do not change the platform's track selection");

  const onlyWrongLanguage = primeHarness({ settings: { learningLang: "ja" }, textTracks: [english] });
  onlyWrongLanguage.prime.syncTextTracks();
  assert.equal(onlyWrongLanguage.prime.state.cues.length, 0);
  assert.equal(onlyWrongLanguage.prime.state.fullTrack, false);
});

test("a stale translation cannot overwrite subtitles after the native language changes", async () => {
  const h = primeHarness({ deferredTranslation: true });
  h.cues(2);
  const oldTask = h.prime.translateCues(h.prime.state.cues, h.prime.state.token);
  assert.equal(h.pendingTranslations.length, 1);
  updateSettings(h, { nativeLang: "de" });
  assert.equal(h.pendingTranslations.length, 2);
  assert.equal(h.pendingTranslations[1].message.to, "de");
  h.pendingTranslations[1].callback({ ok: true, result: { text: "[0] Neue Übersetzung\n[1] Neuer Satz" } });
  await h.flush();
  h.pendingTranslations[0].callback({ ok: true, result: { text: "[0] obsolete translation" } });
  await oldTask;
  assert.equal(h.prime.state.native[0], "Neue Übersetzung");
  assert.equal(h.prime.ui.nativeLine.textContent, "Neue Übersetzung");
});

test("study shortcuts preserve Ctrl, Alt, Meta and editable controls", () => {
  const h = primeHarness();
  h.cues(3);
  const input = h.document.createElement("input");
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { target: input }, { target: { tagName: "DIV", isContentEditable: true } }]) {
    const before = h.video.currentTime;
    const event = h.key("keydown", "d", options);
    h.key("keyup", "d", options);
    assert.equal(event.defaultPrevented, false);
    assert.equal(h.video.currentTime, before);
  }
  const ordinary = h.key("keydown", "d");
  assert.equal(ordinary.defaultPrevented, true);
  assert.equal(h.video.currentTime, 2.01);
});

test("native subtitle interactivity changes on both the overlay and transcript", () => {
  const h = primeHarness();
  h.cues(2);
  h.prime.state.native[0] = "日本語の字幕";
  h.prime.renderPanel();
  h.prime.renderCurrent();
  assert.equal(h.prime.ui.nativeLine.querySelectorAll(".lm-word").length, 0);
  assert.equal(h.prime.ui.cueRows[0].querySelector(".lm-cue-native").querySelectorAll(".lm-word").length, 0);
  updateSettings(h, { nativeInteractive: true });
  assert.ok(h.prime.ui.nativeLine.querySelectorAll(".lm-word").length > 0);
  assert.ok(h.prime.ui.cueRows[0].querySelector(".lm-cue-native").querySelectorAll(".lm-word").length > 0);
  updateSettings(h, { nativeInteractive: false });
  assert.equal(h.prime.ui.nativeLine.querySelectorAll(".lm-word").length, 0);
  assert.equal(h.prime.ui.nativeLine.textContent, "日本語の字幕");
});

test("failed panel preference writes preserve its state and display explicit error feedback", async () => {
  const h = primeHarness({ vocabErrors: { LM_SET_SETTINGS: "storage unavailable" } });
  h.cues(2);
  await h.prime.togglePanel();
  assert.equal(h.prime.state.settings.panelOpen, true);
  assert.equal(h.prime.ui.panel.classList.contains("lm-collapsed"), false);
  const toast = h.document.getElementById("lm-feedback-toast");
  assert.equal(toast.getAttribute("role"), "alert");
  assert.equal(toast.dataset.tone, "error");
  assert.match(toast.textContent, /保存失败/);
});

test("auto-pause ignores short native-player seeks across a cue boundary", () => {
  const h = primeHarness({ settings: { autoPause: true } });
  h.cues(3);
  h.video.currentTime = 1.6;
  h.prime.onTick();
  h.video.seeking = true;
  h.video.emit("seeking");
  h.video.currentTime = 2.1;
  h.prime.onTick();
  assert.equal(h.video.pauseCalls, 0, "native seeking is not natural playback even if the time jump is small");
  h.video.seeking = false;
  h.video.emit("seeked");
  h.prime.onTick();
  assert.equal(h.video.pauseCalls, 0);
});
