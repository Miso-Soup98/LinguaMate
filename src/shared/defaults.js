const LM_DEFAULTS = {
  enabled: true,
  learningLang: "en",
  nativeLang: "zh-CN",
  showLearning: true,
  showNative: true,
  listenMode: false,
  autoPause: false,
  highlightRare: true,
  fontSize: 22,
  panelOpen: true,
  playbackRate: 1,
  hideYoutubeCaptions: true
};

function lmMergeSettings(raw) {
  return Object.assign({}, LM_DEFAULTS, raw || {});
}
