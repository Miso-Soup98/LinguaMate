const fields = ["enabled", "learningLang", "nativeLang", "autoPause", "listenMode", "showNative", "nativeInteractive", "highlightRare", "fontSize", "playbackRate", "accent"];
const statusBox = document.getElementById("operationStatus");
const retryButton = document.getElementById("retrySettings");
let loaded = false;
let saving = false;
let pendingSettings = {};
let changeVersion = 0;
let loadVersion = 0;

function setEnabled(enabled) {
  fields.forEach((key) => { document.getElementById(key).disabled = !enabled; });
}

function fillSelect(id) {
  const el = document.getElementById(id);
  LM_LANGUAGES.forEach((lang) => el.add(new Option(lang.native, lang.code)));
}

async function load() {
  const version = ++loadVersion;
  lmReportStatus(statusBox, "正在读取设置…", "pending");
  retryButton.hidden = true;
  const [settingsRes, vocabRes] = await Promise.all([lmSendMessage("LM_GET_SETTINGS"), lmSendMessage("LM_VOCAB_LIST")]);
  if (version !== loadVersion) return;
  if (settingsRes.ok === true && settingsRes.settings && typeof settingsRes.settings === "object") {
    fields.forEach((key) => {
      const el = document.getElementById(key);
      if (key === "playbackRate" && settingsRes.settings[key] != null && !Array.from(el.options).some((option) => option.value === String(settingsRes.settings[key]))) {
        el.add(new Option(`${settingsRes.settings[key]}x`, String(settingsRes.settings[key])));
      }
      if (el.type === "checkbox") el.checked = !!settingsRes.settings[key];
      else if (settingsRes.settings[key] != null) el.value = settingsRes.settings[key];
    });
    loaded = true;
    setEnabled(true);
    lmReportStatus(statusBox, "设置已读取", "success");
  } else {
    loaded = false;
    setEnabled(false);
    lmReportStatus(statusBox, settingsRes.error || "读取设置失败，请重试", "error");
    retryButton.hidden = false;
  }
  document.getElementById("stats").textContent = vocabRes.ok === true && Array.isArray(vocabRes.vocab)
    ? `生词本 ${vocabRes.vocab.length}` : "生词本读取失败";
}

async function save() {
  if (!loaded || saving || !Object.keys(pendingSettings).length) return;
  saving = true;
  retryButton.hidden = true;
  while (Object.keys(pendingSettings).length) {
    const settings = pendingSettings;
    pendingSettings = {};
    const version = changeVersion;
    lmReportStatus(statusBox, "正在保存…", "pending");
    const response = await lmSendMessage("LM_SET_SETTINGS", { settings });
    if (response.ok !== true) {
      // Keep newer choices when retrying an earlier failed request.
      pendingSettings = Object.assign({}, settings, pendingSettings);
      lmReportStatus(statusBox, response.error || "设置保存失败，请重试", "error");
      retryButton.hidden = false;
      break;
    }
    if (version === changeVersion) lmReportStatus(statusBox, "设置已保存", "success");
  }
  saving = false;
}

document.addEventListener("change", (event) => {
  const el = event.target;
  if (!loaded || !fields.includes(el.id)) return;
  pendingSettings[el.id] = el.type === "checkbox" ? el.checked : ["fontSize", "playbackRate"].includes(el.id) ? Number(el.value) : el.value;
  changeVersion += 1;
  save();
});
retryButton.addEventListener("click", () => loaded ? save() : load());
document.getElementById("openOptions").addEventListener("click", () => {
  try {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) lmReportStatus(statusBox, "打开生词本失败，请刷新扩展后重试", "error");
    });
  } catch (_) {
    lmReportStatus(statusBox, "语伴连接已中断，请刷新扩展后重试", "error");
  }
});
fillSelect("learningLang");
fillSelect("nativeLang");
setEnabled(false);
load();
