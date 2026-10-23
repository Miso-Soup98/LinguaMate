const ui = {
  search: document.getElementById("search"),
  statusFilter: document.getElementById("statusFilter"),
  vocabList: document.getElementById("vocabList"),
  cardBox: document.getElementById("cardBox"),
  form: document.getElementById("settingsForm"),
  status: document.getElementById("operationStatus"),
  settingsStatus: document.getElementById("settingsStatus"),
  backupStatus: document.getElementById("backupStatus")
};
let vocab = [];
let currentCard = null;
let vocabLoaded = false;
let vocabVersion = 0;
let settingsLoaded = false;
let settingsLoadVersion = 0;
let settingsSaving = false;
let settingsRevision = 0;
let pendingSettings = null;
let dataBusy = false;
let importedBackup = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function download(name, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvEscape(value) { return `"${String(value || "").replace(/"/g, '""')}"`; }

function review(item, grade) {
  let ease = item.ease || 2.5;
  let interval = item.interval || 0;
  if (grade === "again") { ease = Math.max(1.3, ease - 0.2); interval = 0.25; }
  else if (grade === "good") { ease += 0.05; interval = interval ? interval * ease : 1; }
  else { ease += 0.15; interval = interval ? interval * (ease + 0.15) : 3; }
  return { ease, interval, reps: (item.reps || 0) + 1, due: Date.now() + interval * 86400000, status: grade === "easy" && interval > 21 ? "known" : "learning" };
}

function langLabel(code) { return LM_LANGUAGES.find((item) => item.code === code)?.native || code || "其他"; }
function isJapanese(item) { return /^ja(?:-|$)/i.test(item.lang || ""); }
function searchKey(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60)); }
function japaneseReading(item) { return item.japanese?.baseReading || item.japanese?.reading || ""; }
function japaneseMeta(item) {
  if (!isJapanese(item) || !item.japanese) return "";
  return `<div class="jp-reading">${escapeHtml(japaneseReading(item))}</div><small>辞书形${item.japanese.pos ? ` · ${escapeHtml(item.japanese.pos)}` : ""}</small>`;
}
function japaneseSources(item) {
  if (!isJapanese(item) || !Array.isArray(item.sourceForms) || !item.sourceForms.length) return "";
  return `<details class="source-forms"><summary>遇到的词形与例句（${item.sourceForms.length}）</summary>${item.sourceForms.map((form) => `<div class="source-form"><strong>${escapeHtml(form.surface)}</strong>${form.reading ? ` <span>${escapeHtml(form.reading)}</span>` : ""}${form.conjugation ? ` · ${escapeHtml(form.conjugation)}` : ""}<p>${escapeHtml(form.context)}</p><small>${escapeHtml(form.videoTitle)}${Number.isFinite(form.time) ? ` · ${Math.floor(form.time / 60)}:${String(Math.floor(form.time % 60)).padStart(2, "0")}` : ""}</small></div>`).join("")}</details>`;
}
function fillLangSelect(select) {
  const langs = Array.from(new Set(vocab.map((item) => item.lang || "und")));
  const current = select.value || "all";
  select.innerHTML = `<option value="all">全部语言</option>${langs.map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(langLabel(code))}</option>`).join("")}`;
  select.value = langs.includes(current) || current === "all" ? current : "all";
}

function renderVocab() {
  const langSelect = document.getElementById("langFilter");
  fillLangSelect(langSelect);
  const q = searchKey(ui.search.value.trim());
  const rows = vocab.filter((item) => (ui.statusFilter.value === "all" || item.status === ui.statusFilter.value)
    && (langSelect.value === "all" || (item.lang || "und") === langSelect.value)
    && (!q || searchKey([item.word, item.translation, item.context, item.videoTitle, item.japanese?.lemma, item.japanese?.reading, item.japanese?.baseReading, ...(item.sourceForms || []).flatMap((form) => [form.surface, form.reading, form.context])].join(" ")).includes(q)));
  if (!rows.length) {
    ui.vocabList.innerHTML = `<p class="muted">${vocabLoaded ? "还没有匹配的生词。去视频里点词收藏即可。" : "尚未读取生词本，请重试。"}</p>`;
    return;
  }
  const groups = new Map();
  rows.forEach((item) => { const key = item.lang || "und"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); });
  ui.vocabList.innerHTML = Array.from(groups.entries()).map(([code, items]) => `<h2>${escapeHtml(langLabel(code))}</h2>${items.map((item) => `
    <article class="item" data-id="${escapeHtml(item.id)}">
      <div><strong>${escapeHtml(item.word)}</strong>${japaneseMeta(item)}<div>${escapeHtml(item.translation)}</div><small>${item.status === "known" ? "已掌握" : "学习中"}</small></div>
      <div class="ctx">${escapeHtml(item.context)}<br>${escapeHtml(item.videoTitle)}${japaneseSources(item)}</div>
      <menu><button data-act="known" ${dataBusy || item.status === "known" ? "disabled" : ""}>${item.status === "known" ? "已掌握" : "掌握"}</button><button data-act="speak">朗读</button><button data-act="delete" ${dataBusy ? "disabled" : ""}>删除</button></menu>
    </article>`).join("")}`).join("");
}

function renderCard() {
  const lang = document.getElementById("cardLang").value || "all";
  currentCard = vocab.find((item) => (lang === "all" || (item.lang || "und") === lang) && item.status !== "known" && (item.due || 0) <= Date.now()) || null;
  if (!currentCard) {
    ui.cardBox.innerHTML = `<p class="muted">${vocabLoaded ? `今天没有到期卡片。当前生词 ${vocab.length} 个。` : "尚未读取复习记录，请重试。"}</p>`;
    return;
  }
  const selectedType = document.getElementById("japaneseCardType")?.value || "meaning";
  const reading = japaneseReading(currentCard);
  const source = (currentCard.sourceForms || []).find((form) => form.surface && form.surface !== currentCard.word);
  const surface = source?.surface || currentCard.japanese?.surface || "";
  const canReading = isJapanese(currentCard) && !!reading;
  const canLemma = isJapanese(currentCard) && !!surface && surface !== currentCard.word;
  const type = selectedType === "reading" && canReading ? "reading" : selectedType === "lemma" && canLemma ? "lemma" : "meaning";
  const prompt = type === "reading" ? "请回忆这个词的假名读音" : type === "lemma" ? "这个字幕词形的辞书形是什么？" : "请回忆词义";
  const note = isJapanese(currentCard) && selectedType !== "meaning" && type === "meaning" ? `<p class="muted">${selectedType === "reading" ? "这个词尚无假名信息" : "这个词尚无活用例句"}，先按词义复习。</p>` : "";
  const frontDetail = type === "meaning" ? (isJapanese(currentCard) ? reading : currentCard.phonetic) : type === "lemma" ? (source?.context || currentCard.context) : "";
  const answer = type === "reading" ? reading : type === "lemma" ? `${currentCard.word}${reading ? `（${reading}）` : ""}` : currentCard.translation || "暂无释义";
  const extraAnswer = type === "meaning" ? "" : currentCard.translation || "暂无释义";
  const answerForm = type === "lemma" ? source?.conjugation || currentCard.japanese?.conjugation || "" : "";
  ui.cardBox.innerHTML = `<div class="card"><p class="card-question">${prompt}</p><h2>${escapeHtml(type === "lemma" ? surface : currentCard.word)}</h2><p>${escapeHtml(frontDetail)}</p>${note}<div data-reveal hidden><p class="card-answer">${escapeHtml(answer)}</p>${extraAnswer ? `<p>${escapeHtml(extraAnswer)}</p>` : ""}${answerForm ? `<p>${escapeHtml(answerForm)}</p>` : ""}<p>${escapeHtml(currentCard.context)}</p></div>
    <div class="card-actions"><button data-act="reveal">${type === "meaning" ? "显示释义" : "显示答案"}</button><button class="again" data-grade="again" ${dataBusy ? "disabled" : ""}>再来</button><button class="good" data-grade="good" ${dataBusy ? "disabled" : ""}>记得</button><button class="easy" data-grade="easy" ${dataBusy ? "disabled" : ""}>简单</button></div></div>`;
}

function renderData() { fillLangSelect(document.getElementById("cardLang")); renderVocab(); renderCard(); }

async function loadVocab(showStatus = true) {
  const version = ++vocabVersion;
  if (showStatus) lmReportStatus(ui.status, "正在读取生词本…", "pending");
  const response = await lmSendMessage("LM_VOCAB_LIST");
  if (version !== vocabVersion) return false;
  if (response.ok !== true || !Array.isArray(response.vocab)) {
    lmReportStatus(ui.status, response.error || "读取生词本失败，现有列表已保留，请重试", "error");
    document.getElementById("retryVocab").hidden = false;
    return false;
  }
  vocab = response.vocab;
  vocabLoaded = true;
  document.getElementById("retryVocab").hidden = true;
  renderData();
  if (showStatus) lmReportStatus(ui.status, `已读取 ${vocab.length} 个生词`, "success");
  return true;
}

function setSettingsEnabled(enabled) { Array.from(ui.form.elements).forEach((el) => { el.disabled = !enabled; }); }
async function loadSettings() {
  const version = ++settingsLoadVersion;
  const revision = settingsRevision;
  lmReportStatus(ui.settingsStatus, "正在读取设置…", "pending");
  const response = await lmSendMessage("LM_GET_SETTINGS");
  if (version !== settingsLoadVersion || revision !== settingsRevision) return;
  if (response.ok !== true || !response.settings) {
    lmReportStatus(ui.settingsStatus, response.error || "读取设置失败，请重试", "error");
    document.getElementById("retryLoadSettings").hidden = false;
    return;
  }
  for (const name of ["learningLang", "nativeLang", "fontSize", "playbackRate"]) ui.form.elements[name].value = response.settings[name];
  if (ui.form.elements.japaneseFurigana) ui.form.elements.japaneseFurigana.value = response.settings.japaneseFurigana || "unknown";
  for (const name of ["autoPause", "listenMode", "highlightRare", "hideYoutubeCaptions"]) ui.form.elements[name].checked = !!response.settings[name];
  settingsLoaded = true;
  setSettingsEnabled(true);
  document.getElementById("retryLoadSettings").hidden = true;
  lmReportStatus(ui.settingsStatus, "设置已读取", "success");
}

async function saveSettings() {
  if (settingsSaving || !pendingSettings) return;
  settingsSaving = true;
  while (pendingSettings) {
    const snapshot = pendingSettings;
    pendingSettings = null;
    lmReportStatus(ui.settingsStatus, "正在保存…", "pending");
    const response = await lmSendMessage("LM_SET_SETTINGS", { settings: snapshot.settings });
    if (response.ok !== true) {
      pendingSettings ||= snapshot;
      lmReportStatus(ui.settingsStatus, response.error || "设置保存失败，请重试", "error");
      document.getElementById("retrySaveSettings").hidden = false;
      break;
    }
    if (snapshot.revision === settingsRevision) lmReportStatus(ui.settingsStatus, "设置已保存", "success");
    else if (!pendingSettings) lmReportStatus(ui.settingsStatus, "上次设置已保存，当前修改请点击保存设置", "success");
    document.getElementById("retrySaveSettings").hidden = true;
  }
  settingsSaving = false;
}

async function changeVocab(type, payload, success) {
  if (dataBusy) return false;
  dataBusy = true;
  vocabVersion += 1;
  ui.vocabList.querySelectorAll("button[data-act='known'], button[data-act='delete']").forEach((button) => { button.disabled = true; });
  ui.cardBox.querySelectorAll("button[data-grade]").forEach((button) => { button.disabled = true; });
  lmReportStatus(ui.status, "正在保存…", "pending");
  const response = await lmSendMessage(type, payload);
  dataBusy = false;
  if (response.ok !== true || (type === "LM_VOCAB_UPDATE" && !response.item)) {
    lmReportStatus(ui.status, response.error || "操作失败，现有记录已保留，请重试", "error");
    // Keep the current card and its revealed answer on a failed write.
    ui.vocabList.querySelectorAll("button[data-act='known'], button[data-act='delete']").forEach((button) => { button.disabled = false; });
    ui.cardBox.querySelectorAll("button[data-grade]").forEach((button) => { button.disabled = false; });
    return false;
  }
  if (type === "LM_VOCAB_DELETE") vocab = vocab.filter((item) => item.id !== payload.id);
  else vocab = vocab.map((item) => item.id === payload.id ? response.item : item);
  renderData();
  lmReportStatus(ui.status, success, "success");
  return true;
}

document.querySelector("nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  document.querySelectorAll("nav button").forEach((el) => el.classList.toggle("active", el === button));
  document.querySelectorAll("main > section").forEach((section) => { section.hidden = section.id !== `view-${button.dataset.view}`; });
});
ui.search.addEventListener("input", renderVocab);
ui.statusFilter.addEventListener("change", renderVocab);
document.getElementById("langFilter").addEventListener("change", renderVocab);
document.getElementById("cardLang").addEventListener("change", renderCard);
document.getElementById("japaneseCardType")?.addEventListener("change", renderCard);
document.getElementById("retryVocab").addEventListener("click", () => { if (!dataBusy) loadVocab(); });
document.getElementById("retryLoadSettings").addEventListener("click", loadSettings);
document.getElementById("retrySaveSettings").addEventListener("click", saveSettings);

document.getElementById("exportCsv").addEventListener("click", () => {
  if (!vocabLoaded) return lmReportStatus(ui.status, "请先读取生词本再导出", "error");
  download("linguamate-vocab.csv", ["word,translation,context,video,status,reading,sourceForms", ...vocab.map((item) => [item.word, item.translation, item.context, item.videoTitle, item.status, japaneseReading(item), (item.sourceForms || []).map((form) => form.surface).join(" / ")].map(csvEscape).join(","))].join("\n"));
  lmReportStatus(ui.status, "CSV 已生成，请在浏览器下载中查看", "success");
});
document.getElementById("exportAnki").addEventListener("click", () => {
  if (!vocabLoaded) return lmReportStatus(ui.status, "请先读取生词本再导出", "error");
  const clean = (value) => escapeHtml(value).replace(/[\t\r\n]+/g, " ");
  download("linguamate-anki.txt", vocab.map((item) => `${clean(item.word)}\t${japaneseReading(item) ? `${clean(japaneseReading(item))}<br>` : ""}${clean(item.translation)}<br>${clean(item.context)}`).join("\n"));
  lmReportStatus(ui.status, "Anki 文件已生成，请在浏览器下载中查看", "success");
});

ui.vocabList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  const row = button?.closest(".item");
  const item = vocab.find((entry) => entry.id === row?.dataset.id);
  if (!item || button.disabled) return;
  if (button.dataset.act === "speak") {
    try { const utter = new SpeechSynthesisUtterance(isJapanese(item) ? japaneseReading(item) || item.word : item.word); utter.lang = item.lang || "en"; speechSynthesis.speak(utter); }
    catch (_) { lmReportStatus(ui.status, "朗读不可用，请检查浏览器语音设置", "error"); }
  } else if (button.dataset.act === "delete") await changeVocab("LM_VOCAB_DELETE", { id: item.id }, `已删除「${item.word}」`);
  else if (button.dataset.act === "known") await changeVocab("LM_VOCAB_UPDATE", { id: item.id, patch: { status: "known", due: Date.now() + 30 * 86400000 } }, `已将「${item.word}」标为掌握`);
});
ui.cardBox.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.act === "reveal") return ui.cardBox.querySelector("[data-reveal]")?.removeAttribute("hidden");
  if (button.dataset.grade && currentCard) await changeVocab("LM_VOCAB_UPDATE", { id: currentCard.id, patch: review(currentCard, button.dataset.grade) }, "复习记录已保存");
});
ui.form.addEventListener("input", () => { settingsRevision += 1; });
ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!settingsLoaded || !ui.form.reportValidity()) return;
  const settings = {};
  for (const name of ["learningLang", "nativeLang"]) settings[name] = ui.form.elements[name].value;
  if (ui.form.elements.japaneseFurigana) settings.japaneseFurigana = ui.form.elements.japaneseFurigana.value;
  for (const name of ["fontSize", "playbackRate"]) settings[name] = Number(ui.form.elements[name].value);
  for (const name of ["autoPause", "listenMode", "highlightRare", "hideYoutubeCaptions"]) settings[name] = ui.form.elements[name].checked;
  pendingSettings = { settings, revision: ++settingsRevision };
  saveSettings();
});

function validateBackup(value) {
  if (!value || value.format !== "linguamate-backup" || value.version !== 1 || typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt)) || !Array.isArray(value.vocab) || !value.known || typeof value.known !== "object" || Array.isArray(value.known)) throw new Error("不是有效的语伴 JSON 备份（版本 1）");
  if (value.vocab.length > 100000 || Object.keys(value.known).length > 100000 || Object.keys(value).some((key) => !["format", "version", "exportedAt", "vocab", "known"].includes(key))) throw new Error("备份格式或记录数量不受支持");
  const ids = new Set();
  const words = new Set();
  for (const item of value.vocab) {
    if (!item || typeof item !== "object" || ["id", "word", "lang", "nativeLang"].some((key) => typeof item[key] !== "string" || !item[key].trim()) || !["learning", "known"].includes(item.status)) throw new Error("备份中存在无效生词，请重新选择完整备份");
    if (["time", "reps", "interval", "ease", "due", "createdAt", "updatedAt"].some((key) => !Number.isFinite(item[key]) || item[key] < 0) || !Number.isInteger(item.reps) || item.ease < 1) throw new Error("备份中的复习进度无效");
    let key = `${item.lang.trim().toLowerCase()}:${item.word.normalize("NFC").trim().toLowerCase()}`;
    if (item.japanese !== undefined) {
      if (!isJapanese(item) || !item.japanese || typeof item.japanese !== "object" || Array.isArray(item.japanese) || typeof item.japanese.lemma !== "string" || item.word !== item.japanese.lemma || !item.japanese.lemma.trim()) throw new Error("备份中的日语词条无效");
      const limits = { lemma: 500, reading: 500, baseReading: 500, pos: 500, conjugation: 1000, surface: 500, entryId: 200 };
      if (Object.entries(limits).some(([field, max]) => item.japanese[field] !== undefined && (typeof item.japanese[field] !== "string" || item.japanese[field].length > max))) throw new Error("备份中的日语读音或词形无效");
      const reading = searchKey(japaneseReading(item)).trim();
      const entryId = item.japanese.entryId || "";
      if (reading || entryId) key += `|reading=${encodeURIComponent(reading)}|entry=${encodeURIComponent(entryId)}`;
    }
    if (item.sourceForms !== undefined) {
      if (!Array.isArray(item.sourceForms) || item.sourceForms.length > 20) throw new Error("备份中的词形例句无效");
      const limits = { surface: 500, reading: 500, conjugation: 1000, context: 100000, videoTitle: 5000, videoUrl: 10000 };
      for (const form of item.sourceForms) {
        if (!form || typeof form !== "object" || typeof form.surface !== "string" || !form.surface.trim() || Object.entries(limits).some(([field, max]) => form[field] !== undefined && (typeof form[field] !== "string" || form[field].length > max)) || (form.time !== undefined && (!Number.isFinite(form.time) || form.time < 0))) throw new Error("备份中的词形例句无效");
      }
    }
    if (ids.has(item.id) || words.has(key)) throw new Error("备份中有重复记录，请选择语伴导出的完整备份");
    ids.add(item.id);
    words.add(key);
  }
  if (Object.entries(value.known).some(([key, entry]) => entry !== true || key.indexOf(":") < 1)) throw new Error("备份中的掌握记录无效");
  return value;
}

document.getElementById("exportBackup").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  lmReportStatus(ui.backupStatus, "正在生成完整备份…", "pending");
  const response = await lmSendMessage("LM_DATA_EXPORT");
  button.disabled = false;
  if (response.ok !== true || !response.data) return lmReportStatus(ui.backupStatus, response.error || "备份失败，请重试", "error");
  download(`linguamate-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(response.data, null, 2), "application/json;charset=utf-8");
  lmReportStatus(ui.backupStatus, `已生成 ${response.data.vocab.length} 个生词的完整备份，包含复习进度和掌握记录`, "success");
});
let importFileVersion = 0;
document.getElementById("importFile").addEventListener("change", async (event) => {
  const version = ++importFileVersion;
  importedBackup = null;
  document.getElementById("importBackup").disabled = true;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("备份文件超过 20 MB，请检查所选文件");
    const parsed = validateBackup(JSON.parse(await file.text()));
    if (version !== importFileVersion) return;
    importedBackup = parsed;
    document.getElementById("importBackup").disabled = false;
    lmReportStatus(ui.backupStatus, `预览：${parsed.vocab.length} 个生词，${Object.keys(parsed.known).length} 条掌握记录。请选择恢复方式，再点击恢复。`, "success");
  } catch (error) {
    if (version !== importFileVersion) return;
    lmReportStatus(ui.backupStatus, error instanceof SyntaxError ? "JSON 格式错误，请选择语伴导出的完整备份" : error.message, "error");
  }
});
document.getElementById("importBackup").addEventListener("click", async () => {
  if (!importedBackup || dataBusy) return;
  const mode = document.getElementById("importMode").value;
  if (mode === "replace" && !confirm("替换会清除当前生词与复习进度，并使用备份中的记录。建议先导出当前完整备份。确定替换吗？")) return;
  dataBusy = true;
  vocabVersion += 1;
  const file = document.getElementById("importFile");
  const modeSelect = document.getElementById("importMode");
  const button = document.getElementById("importBackup");
  file.disabled = modeSelect.disabled = button.disabled = true;
  renderData();
  lmReportStatus(ui.backupStatus, "正在恢复，请稍候…", "pending");
  const response = await lmSendMessage("LM_DATA_IMPORT", { backup: importedBackup, mode }, 30000);
  dataBusy = false;
  file.disabled = modeSelect.disabled = button.disabled = false;
  if (response.ok !== true) {
    renderData();
    return lmReportStatus(ui.backupStatus, response.error || "恢复失败，现有记录已保留，请重试", "error");
  }
  renderData();
  await loadVocab(false);
  lmReportStatus(ui.backupStatus, `恢复完成：现有 ${response.stats?.vocabCount ?? ""} 个生词，复习进度已保留`, "success");
});

for (const name of ["learningLang", "nativeLang"]) LM_LANGUAGES.forEach((lang) => ui.form.elements[name].add(new Option(lang.native, lang.code)));
setSettingsEnabled(false);
loadVocab();
loadSettings();
