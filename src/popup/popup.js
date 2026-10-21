const fields = ["enabled", "learningLang", "nativeLang", "autoPause", "listenMode", "showNative", "nativeInteractive", "highlightRare", "fontSize", "playbackRate", "accent"];

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload), resolve);
  });
}

function fillSelect(id) {
  const el = document.getElementById(id);
  LM_LANGUAGES.forEach((lang) => el.add(new Option(lang.native, lang.code)));
}

async function load() {
  fillSelect("learningLang");
  fillSelect("nativeLang");
  const [settingsRes, vocabRes] = await Promise.all([send("LM_GET_SETTINGS"), send("LM_VOCAB_LIST")]);
  const settings = settingsRes.settings || {};
  fields.forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!settings[key];
    else el.value = settings[key];
  });
  document.getElementById("stats").textContent = `生词本 ${((vocabRes.vocab || []).length)}`;
}

async function save() {
  const settings = {};
  fields.forEach((key) => {
    const el = document.getElementById(key);
    settings[key] = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
  });
  settings.playbackRate = Number(settings.playbackRate);
  await send("LM_SET_SETTINGS", { settings });
}

document.addEventListener("change", save);
document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
load();
