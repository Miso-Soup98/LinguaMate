if (typeof importScripts === "function") {
  importScripts("../vendor/kuromoji/kuromoji.js", "../shared/japanese.js", "japanese-service.js");
}

const DEFAULTS = {
  enabled: true,
  learningLang: "en",
  nativeLang: "zh-CN",
  showLearning: true,
  showNative: true,
  nativeInteractive: false,
  listenMode: false,
  autoPause: false,
  highlightRare: true,
  fontSize: 22,
  panelOpen: true,
  playbackRate: 1,
  hideYoutubeCaptions: true,
  japaneseFurigana: "unknown",
  accent: "us"
};

const cache = new Map();
const CACHE_LIMIT = 4000;
let googleRetryAfter = 0;
const BACKUP_FORMAT = "linguamate-backup";
const BACKUP_VERSION = 1;
let storageTail = Promise.resolve();

// All storage operations share one queue, including reads. Two tabs can never
// read the same snapshot and then overwrite each other's completed changes.
function withStorage(operation) {
  const result = storageTail.then(operation);
  storageTail = result.catch(() => {});
  return result;
}

chrome.runtime.onInstalled.addListener(async () => {
  await withStorage(async () => {
    const stored = await getSettings();
    await chrome.storage.sync.set(stored);
    const local = await chrome.storage.local.get({ vocab: [], known: {} });
    const repair = {};
    if (!Array.isArray(local.vocab)) repair.vocab = [];
    if (!isRecord(local.known)) repair.known = {};
    if (Object.keys(repair).length) await chrome.storage.local.set(repair);
  });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "lm-lookup",
      title: "用语伴查阅选中词",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "lm-reader",
      title: "用语伴阅读选中文本",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "lm-reader-page",
      title: "用语伴阅读本页",
      contexts: ["page"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["src/content/reader.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/shared/languages.js", "src/shared/defaults.js", "src/shared/feedback.js", "src/shared/japanese.js", "src/shared/japanese-ui.js", "src/shared/japanese-client.js", "src/content/reader.js"]
    });
    await chrome.tabs.sendMessage(tab.id, {
      type: "LM_READER",
      mode: info.menuItemId,
      text: info.selectionText || ""
    });
  } catch (err) {
    console.warn("LinguaMate reader inject failed", err);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true;
});

async function handleMessage(message) {
  if (!isRecord(message)) throw new Error("invalid_message");
  switch (message.type) {
    case "LM_GET_SETTINGS":
      return withStorage(async () => ({ ok: true, settings: await getSettings() }));
    case "LM_SET_SETTINGS":
      return withStorage(async () => {
        const settings = validateSettings(message.settings);
        const previous = await getSettings();
        await chrome.storage.sync.set(settings);
        return { ok: true, settings: { ...previous, ...settings } };
      });
    case "LM_TRANSLATE":
      return {
        ok: true,
        result: await translateText(message.text, message.from, message.to, message.refresh === true)
      };
    case "LM_LOOKUP":
      return {
        ok: true,
        result: await lookupWord(message.word, message.from, message.to, message.context,
          message.isPhrase === true ? { ...(isRecord(message.japanese) ? message.japanese : {}), isPhrase: true } : message.japanese)
      };
    case "LM_JA_ANALYZE":
      return { ok: true, tokens: await lmJapaneseService.analyze(message.text) };
    case "LM_PRONOUNCE": {
      const clip = await pronounceClip(message.text, message.tl, message.audioUrl);
      return { ok: true, audio: clip.audio || "", mime: clip.mime || "audio/mpeg" };
    }
    case "LM_VOCAB_LIST":
      return withStorage(async () => ({ ok: true, ...await getLearningData() }));
    case "LM_VOCAB_ADD":
      return withStorage(async () => ({ ok: true, item: await addVocab(message.item) }));
    case "LM_VOCAB_UPDATE":
      return withStorage(async () => ({ ok: true, item: await updateVocab(message.id, message.patch) }));
    case "LM_VOCAB_DELETE":
      return withStorage(async () => {
        await deleteVocab(message.id);
        return { ok: true };
      });
    case "LM_MARK_KNOWN":
      return withStorage(async () => {
        if (message.known !== undefined && typeof message.known !== "boolean") throw new Error("invalid_known");
        return { ok: true, known: await markKnown(message.word, message.lang, message.known !== false, message.japanese) };
      });
    case "LM_DATA_EXPORT":
      return withStorage(async () => ({ ok: true, data: await exportLearningData() }));
    case "LM_DATA_IMPORT":
      return withStorage(async () => ({ ok: true, stats: await importLearningData(message.backup, message.mode) }));
    default:
      return { ok: false, error: "unknown_message" };
  }
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    try {
      Object.assign(settings, validateSettings({ [key]: stored[key] }));
    } catch (_) {
      // Old or externally written invalid values use the documented default.
    }
  }
  return settings;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value, field, maxLength, allowEmpty = true) {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

function cleanLang(value, fallback) {
  if (value === undefined && fallback) value = fallback;
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) throw new Error("invalid_language");
  try {
    const canonical = Intl.getCanonicalLocales(value)[0];
    return /^ja(?:-|$)/i.test(canonical) ? "ja" : canonical;
  } catch (_) {
    throw new Error("invalid_language");
  }
}

function validateSettings(input) {
  if (!isRecord(input)) throw new Error("invalid_settings");
  const validated = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`unknown_setting:${key}`);
    if (typeof DEFAULTS[key] === "boolean") {
      if (typeof value !== "boolean") throw new Error(`invalid_setting:${key}`);
      validated[key] = value;
    } else if (key === "fontSize") {
      if (!Number.isInteger(value) || value < 16 || value > 40) throw new Error(`invalid_setting:${key}`);
      validated[key] = value;
    } else if (key === "playbackRate") {
      if (!Number.isFinite(value) || value < 0.5 || value > 2) throw new Error(`invalid_setting:${key}`);
      validated[key] = value;
    } else if (key === "accent") {
      if (value !== "us" && value !== "uk") throw new Error(`invalid_setting:${key}`);
      validated[key] = value;
    } else if (key === "japaneseFurigana") {
      if (!["all", "unknown", "hover", "off"].includes(value)) throw new Error(`invalid_setting:${key}`);
      validated[key] = value;
    } else {
      validated[key] = cleanLang(value);
    }
  }
  return validated;
}

async function getLearningData() {
  const { vocab, known } = await chrome.storage.local.get({ vocab: [], known: {} });
  if (!Array.isArray(vocab) || !isRecord(known)) throw new Error("invalid_stored_data");
  // Prime tracks may label the same language ja or ja-JP. Normalize their
  // learning identity while preserving IDs, examples and review schedules.
  const normalizedVocab = vocab.map((row) => isRecord(row) && /^ja(?:-|$)/i.test(row.lang || "") ? { ...row, lang: cleanLang(row.lang) } : row);
  const normalizedKnown = {};
  for (const [key, value] of Object.entries(known)) {
    const canonical = key.replace(/^ja(?:-[a-z0-9]{2,8})*:/i, "ja:");
    if (value === true || !Object.hasOwn(normalizedKnown, canonical)) normalizedKnown[canonical] = value;
  }
  return { vocab: normalizedVocab, known: normalizedKnown };
}

function vocabKey(word, lang) {
  return `${cleanLang(lang, "en")}:${cleanText(word, "word", 500, false).normalize("NFC").trim().toLowerCase()}`;
}

// The spelling stays in the identity: 橋 and 箸 must never merge merely because
// they share a reading. A reading also separates homographs such as 生.
function vocabIdentity(row) {
  const key = vocabKey(row.word, row.lang);
  if (!row.lang.toLowerCase().startsWith("ja") || !row.japanese) return key;
  const reading = japaneseReadingKey(row.japanese.baseReading || row.japanese.reading || "");
  const entryId = row.japanese.entryId || "";
  return reading || entryId ? `${key}|reading=${encodeURIComponent(reading)}|entry=${encodeURIComponent(entryId)}` : key;
}

function japaneseReadingKey(value) {
  return value.normalize("NFKC").trim().replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

function knownEntryMatches(key, row) {
  const base = vocabKey(row.word, row.lang);
  if (key === base) return true;
  if (!row.japanese || !key.startsWith(`${base}|reading=`)) return false;
  const separator = key.lastIndexOf("|entry=");
  if (separator < base.length + 9) return false;
  try {
    const reading = decodeURIComponent(key.slice(base.length + 9, separator));
    const entry = decodeURIComponent(key.slice(separator + 7));
    const targetReading = japaneseReadingKey(row.japanese.baseReading || row.japanese.reading || "");
    return japaneseReadingKey(reading) === targetReading && (!entry || !row.japanese.entryId || entry === row.japanese.entryId);
  } catch (_) { return false; }
}

function indexKnownKeys(known) {
  const index = new Map();
  for (const [key, value] of Object.entries(known)) {
    if (value !== true) continue;
    const reading = key.lastIndexOf("|reading=");
    const base = reading >= 0 && key.lastIndexOf("|entry=") > reading ? key.slice(0, reading) : key;
    if (!index.has(base)) index.set(base, []);
    index.get(base).push(key);
  }
  return index;
}

function matchingKnownKeys(known, row, index) {
  const candidates = index ? index.get(vocabKey(row.word, row.lang)) || [] : Object.keys(known);
  return candidates.filter((key) => known[key] === true && knownEntryMatches(key, row));
}

function clearKnownEntry(known, row, index) {
  for (const key of matchingKnownKeys(known, row, index)) delete known[key];
}

const JAPANESE_TEXT_FIELDS = { lemma: 500, reading: 500, baseReading: 500, pos: 500, conjugation: 1000, surface: 500, entryId: 200 };
const SOURCE_FORM_TEXT_FIELDS = { surface: 500, reading: 500, conjugation: 1000, context: 100000, videoTitle: 5000, videoUrl: 10000 };

function validateJapanese(value) {
  if (!isRecord(value)) throw new Error("invalid_japanese");
  const clean = {};
  for (const [key, max] of Object.entries(JAPANESE_TEXT_FIELDS)) {
    if (value[key] !== undefined) clean[key] = cleanText(value[key], `japanese_${key}`, max).normalize("NFC").trim();
  }
  if (!clean.lemma) throw new Error("invalid_japanese_lemma");
  return clean;
}

function validateSourceForms(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error("invalid_source_forms");
  return value.map((form) => {
    if (!isRecord(form) || Object.keys(form).some((key) => !Object.hasOwn(SOURCE_FORM_TEXT_FIELDS, key) && key !== "time")) throw new Error("invalid_source_form");
    const clean = {};
    for (const [key, max] of Object.entries(SOURCE_FORM_TEXT_FIELDS)) clean[key] = cleanText(form[key] === undefined ? "" : form[key], `source_${key}`, max);
    if (!clean.surface.trim()) throw new Error("invalid_source_surface");
    clean.time = form.time === undefined ? 0 : form.time;
    if (!Number.isFinite(clean.time) || clean.time < 0) throw new Error("invalid_source_time");
    return clean;
  });
}

function sourceFormOf(row) {
  return {
    surface: row.japanese?.surface || row.word,
    reading: row.japanese?.reading || "", conjugation: row.japanese?.conjugation || "",
    context: row.context || "", videoTitle: row.videoTitle || "", videoUrl: row.videoUrl || "", time: row.time || 0
  };
}

function mergeSourceForms(...groups) {
  const forms = [];
  const seen = new Set();
  for (const form of groups.flat()) {
    const key = JSON.stringify([form.surface, form.context, form.videoUrl, form.time]);
    if (!seen.has(key)) { seen.add(key); forms.push(form); }
  }
  return forms.slice(0, 20);
}

function sameVocabEntry(left, right) {
  if (vocabIdentity(left) === vocabIdentity(right)) return true;
  if (!left.lang.toLowerCase().startsWith("ja") || cleanLang(left.lang) !== cleanLang(right.lang)) return false;
  if (!left.japanese || !right.japanese) {
    const legacy = left.japanese ? right : left;
    const enriched = left.japanese ? left : right;
    return vocabKey(legacy.word, legacy.lang) === vocabKey(enriched.word, enriched.lang) ||
      (enriched.japanese?.surface && vocabKey(legacy.word, legacy.lang) === vocabKey(enriched.japanese.surface, enriched.lang));
  }
  return vocabKey(left.word, left.lang) === vocabKey(right.word, right.lang) &&
    japaneseReadingKey(left.japanese.baseReading || left.japanese.reading || "") === japaneseReadingKey(right.japanese.baseReading || right.japanese.reading || "") &&
    (!left.japanese.entryId || !right.japanese.entryId || left.japanese.entryId === right.japanese.entryId);
}

function indexVocabRow(index, row) {
  const keys = [vocabKey(row.word, row.lang)];
  if (row.japanese?.surface) keys.push(vocabKey(row.japanese.surface, row.lang));
  for (const key of new Set(keys)) {
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(row);
  }
}

function findIndexedVocab(index, row) {
  const keys = [vocabKey(row.word, row.lang)];
  if (row.japanese?.surface) keys.push(vocabKey(row.japanese.surface, row.lang));
  for (const key of new Set(keys)) {
    for (const candidate of index.get(key) || []) if (sameVocabEntry(candidate, row)) return candidate;
  }
  return null;
}

function migrateLegacyKnown(known, vocab, target, vocabIndex) {
  const baseKey = vocabKey(target.word, target.lang);
  if (!target.japanese || vocabIdentity(target) === baseKey) return;
  const broadKeys = [baseKey];
  if (target.japanese.entryId) broadKeys.push(vocabIdentity({ ...target, japanese: { ...target.japanese, entryId: "" } }));
  for (const key of broadKeys) {
    if (!known[key]) continue;
    delete known[key];
    // Retain mastery of explicitly different saved entries before narrowing a
    // formerly unspecific legacy flag to the entry the user is changing.
    for (const row of vocabIndex ? vocabIndex.get(baseKey) || [] : vocab) if (row.status === "known" && knownEntryMatches(key, row)) known[vocabIdentity(row)] = true;
  }
}

const VOCAB_TEXT_FIELDS = { translation: 50000, phonetic: 5000, context: 100000, videoTitle: 5000, videoUrl: 10000 };
const VOCAB_NUMBER_FIELDS = ["time", "reps", "interval", "ease", "due", "createdAt", "updatedAt"];

function validateVocab(row) {
  if (!isRecord(row)) throw new Error("invalid_vocab_item");
  const allowed = new Set(["id", "word", "lang", "nativeLang", "status", "japanese", "sourceForms", ...Object.keys(VOCAB_TEXT_FIELDS), ...VOCAB_NUMBER_FIELDS]);
  if (Object.keys(row).some((key) => !allowed.has(key))) throw new Error("unknown_vocab_field");
  const clean = {
    id: cleanText(row.id, "id", 200, false),
    word: cleanText(row.word, "word", 500, false).normalize("NFC").trim(),
    lang: cleanLang(row.lang),
    nativeLang: cleanLang(row.nativeLang),
    status: row.status
  };
  if (!["learning", "known"].includes(clean.status)) throw new Error("invalid_status");
  for (const [key, max] of Object.entries(VOCAB_TEXT_FIELDS)) clean[key] = cleanText(row[key], key, max);
  for (const key of VOCAB_NUMBER_FIELDS) {
    if (!Number.isFinite(row[key]) || row[key] < 0) throw new Error(`invalid_${key}`);
    clean[key] = row[key];
  }
  if (!Number.isInteger(clean.reps)) throw new Error("invalid_reps");
  if (clean.ease < 1) throw new Error("invalid_ease");
  if (row.japanese !== undefined) {
    if (!clean.lang.toLowerCase().startsWith("ja")) throw new Error("invalid_japanese_language");
    clean.japanese = validateJapanese(row.japanese);
    if (clean.word !== clean.japanese.lemma) throw new Error("invalid_japanese_word");
  }
  if (row.sourceForms !== undefined) clean.sourceForms = validateSourceForms(row.sourceForms);
  return clean;
}

function newVocab(item) {
  if (!isRecord(item)) throw new Error("invalid_vocab_item");
  const now = Date.now();
  const created = {
    id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    word: item.word,
    lang: cleanLang(item.lang, "en"),
    nativeLang: cleanLang(item.nativeLang, "zh-CN"),
    status: "learning",
    time: item.time === undefined ? 0 : item.time,
    reps: 0,
    interval: 0,
    ease: 2.5,
    due: now,
    createdAt: now,
    updatedAt: now
  };
  for (const key of Object.keys(VOCAB_TEXT_FIELDS)) created[key] = item[key] === undefined ? "" : item[key];
  if (item.japanese !== undefined) {
    created.japanese = validateJapanese(item.japanese);
    created.word = created.japanese.lemma;
    created.sourceForms = item.sourceForms === undefined ? [sourceFormOf(created)] : mergeSourceForms([sourceFormOf(created)], validateSourceForms(item.sourceForms));
  } else if (item.sourceForms !== undefined) created.sourceForms = item.sourceForms;
  return validateVocab(created);
}

async function addVocab(item) {
  const created = newVocab(item);
  const { vocab, known } = await getLearningData();
  const existing = vocab.find((row) => sameVocabEntry(row, created));
  if (existing) {
    const wasKnown = existing.status === "known" || matchingKnownKeys(known, existing).length > 0 || matchingKnownKeys(known, created).length > 0;
    migrateLegacyKnown(known, vocab, created);
    if (created.japanese) {
      const oldKey = vocabIdentity(existing);
      const oldForm = sourceFormOf(existing);
      existing.japanese = { ...existing.japanese, ...created.japanese };
      existing.word = created.word;
      existing.sourceForms = mergeSourceForms(created.sourceForms || [], existing.sourceForms || [oldForm]);
      // Migrating a legacy surface card keeps its ID, mastery and review dates.
      if (wasKnown) { delete known[oldKey]; clearKnownEntry(known, existing); known[vocabIdentity(existing)] = true; existing.status = "known"; }
    }
    for (const field of ["translation", "phonetic", "context", "videoTitle", "videoUrl"]) {
      if (created[field]) existing[field] = created[field];
    }
    if (created.context || created.videoUrl) existing.time = created.time;
    existing.updatedAt = Date.now();
    await chrome.storage.local.set({ vocab, known });
    return existing;
  }
  if (matchingKnownKeys(known, created).length) { created.status = "known"; known[vocabIdentity(created)] = true; }
  vocab.unshift(created);
  await chrome.storage.local.set({ vocab, known });
  return created;
}

async function updateVocab(id, patch) {
  cleanText(id, "id", 200, false);
  if (!isRecord(patch) || ["id", "createdAt", "updatedAt"].some((key) => Object.hasOwn(patch, key))) throw new Error("invalid_patch");
  const { vocab, known } = await getLearningData();
  const index = vocab.findIndex((item) => item.id === id);
  const row = vocab[index];
  if (!row) throw new Error("missing_item");
  const updated = validateVocab({ ...row, ...patch, updatedAt: Date.now() });
  const key = vocabIdentity(updated);
  if (vocab.some((item, itemIndex) => itemIndex !== index && sameVocabEntry(item, updated))) throw new Error("duplicate_word");
  const oldKey = vocabIdentity(row);
  migrateLegacyKnown(known, vocab, updated);
  if (oldKey !== key && row.status === "known") delete known[oldKey];
  clearKnownEntry(known, updated);
  if (updated.status === "known") known[key] = true;
  vocab[index] = updated;
  await chrome.storage.local.set({ vocab, known });
  return updated;
}

async function deleteVocab(id) {
  cleanText(id, "id", 200, false);
  const { vocab } = await getLearningData();
  await chrome.storage.local.set({ vocab: vocab.filter((item) => item.id !== id) });
}

async function markKnown(word, lang, isKnown, japanese) {
  let target = { word, lang: cleanLang(lang, "en") };
  if (japanese !== undefined) {
    if (!isRecord(japanese) || !/^ja(?:-|$)/i.test(target.lang)) throw new Error("invalid_japanese");
    const analysis = {};
    for (const field of ["lemma", "reading", "baseReading", "entryId", "surface"]) {
      if (japanese[field] !== undefined) analysis[field] = cleanText(japanese[field], `japanese_${field}`, field === "entryId" ? 200 : 500).normalize("NFC").trim();
    }
    if (!analysis.lemma) throw new Error("invalid_japanese_lemma");
    target = { ...target, word: analysis.lemma, japanese: analysis };
  }
  const key = vocabIdentity(target);
  const { vocab, known } = await getLearningData();
  // Upgrade a broad legacy mastery flag before changing one lexical reading.
  migrateLegacyKnown(known, vocab, target);
  clearKnownEntry(known, target);
  if (isKnown) known[key] = true;
  for (const row of vocab) {
    if (target.japanese ? sameVocabEntry(row, target) : vocabKey(row.word, row.lang) === key) {
      row.status = isKnown ? "known" : "learning";
      row.updatedAt = Date.now();
      if (isKnown) known[vocabIdentity(row)] = true;
      else delete known[vocabIdentity(row)];
    }
  }
  await chrome.storage.local.set({ vocab, known });
  return known;
}

function validateBackup(data) {
  if (!isRecord(data) || data.format !== BACKUP_FORMAT || data.version !== BACKUP_VERSION ||
      typeof data.exportedAt !== "string" || !Number.isFinite(Date.parse(data.exportedAt)) ||
      !Array.isArray(data.vocab) || !isRecord(data.known) || data.vocab.length > 100000 ||
      Object.keys(data.known).length > 100000 || Object.keys(data).some((key) => !["format", "version", "exportedAt", "vocab", "known"].includes(key))) {
    throw new Error("invalid_backup");
  }
  const vocab = data.vocab.map(validateVocab);
  const ids = new Set();
  const entries = new Map();
  for (const row of vocab) {
    if (ids.has(row.id) || findIndexedVocab(entries, row)) throw new Error("duplicate_backup_item");
    ids.add(row.id);
    indexVocabRow(entries, row);
  }
  const known = {};
  for (const [key, value] of Object.entries(data.known)) {
    const colon = key.indexOf(":");
    if (value !== true || colon < 1) throw new Error("invalid_backup_known");
    const parts = key.slice(colon + 1).split("|reading=");
    const base = vocabKey(parts[0], key.slice(0, colon));
    if (parts.length === 1) known[base] = true;
    else {
      if (!/^ja(?:-[a-z0-9]{2,8})*:/i.test(key) || parts.length !== 2) throw new Error("invalid_backup_known");
      const readingParts = parts[1].split("|entry=");
      if (readingParts.length !== 2) throw new Error("invalid_backup_known");
      let reading, entryId;
      try { reading = decodeURIComponent(readingParts[0]); entryId = decodeURIComponent(readingParts[1]); }
      catch (_) { throw new Error("invalid_backup_known"); }
      cleanText(reading, "known_reading", 500);
      cleanText(entryId, "known_entry", 200);
      known[`${base}|reading=${encodeURIComponent(japaneseReadingKey(reading))}|entry=${encodeURIComponent(entryId)}`] = true;
    }
  }
  const knownIndex = indexKnownKeys(known);
  for (const row of vocab) {
    const key = vocabIdentity(row);
    if (row.status === "known") known[key] = true;
    else if (matchingKnownKeys(known, row, knownIndex).length) row.status = "known";
  }
  return { vocab, known };
}

async function exportLearningData() {
  const { vocab, known } = await getLearningData();
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), vocab, known };
}

async function importLearningData(backup, mode) {
  if (mode !== "merge" && mode !== "replace") throw new Error("invalid_import_mode");
  const imported = validateBackup(backup);
  let { vocab, known } = imported;
  if (mode === "merge") {
    const current = await getLearningData();
    const ids = new Set(current.vocab.map((row) => row.id));
    const entries = new Map();
    current.vocab.forEach((row) => indexVocabRow(entries, row));
    const added = [];
    for (const row of imported.vocab) {
      const existing = findIndexedVocab(entries, row);
      if (!existing) { added.push(row); indexVocabRow(entries, row); continue; }
      // Merge examples without replacing a user's current review schedule.
      if (row.japanese) {
        const oldForm = sourceFormOf(existing);
        existing.japanese = { ...row.japanese, ...existing.japanese };
        existing.word = existing.japanese.lemma;
        existing.sourceForms = mergeSourceForms(existing.sourceForms || [oldForm], row.sourceForms || [sourceFormOf(row)]);
        indexVocabRow(entries, existing);
      }
    }
    for (const row of added) {
      if (ids.has(row.id)) row.id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      ids.add(row.id);
    }
    vocab = [...current.vocab, ...added];
    known = { ...imported.known, ...current.known };
    // Existing cards retain their current status and review schedule on merge.
    const currentKnownIndex = indexKnownKeys(known);
    for (const row of current.vocab) {
      const key = vocabIdentity(row);
      migrateLegacyKnown(known, current.vocab, row, entries);
      clearKnownEntry(known, row, currentKnownIndex);
      if (row.status === "known") known[key] = true;
    }
    const knownIndex = indexKnownKeys(known);
    for (const row of added) {
      if (row.status === "known" || matchingKnownKeys(known, row, knownIndex).length) {
        row.status = "known";
        known[vocabIdentity(row)] = true;
      }
    }
  }
  await chrome.storage.local.set({ vocab, known });
  return { vocabCount: vocab.length, knownCount: Object.keys(known).length, mode };
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > 1000 * 60 * 60 * 12) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
  if (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

async function translateText(text, from, to, refresh = false) {
  const clean = String(text || "").trim();
  if (!clean) return { text: "", phonetic: "" };
  if (from === to) return { text: clean, phonetic: "" };
  const key = `t:${from}:${to}:${clean}`;
  const cached = cacheGet(key);
  if (cached && !refresh) return cached;

  try {
    const google = await translateGoogle(clean, from, to);
    if (google.text) {
      cacheSet(key, google);
      return google;
    }
  } catch (err) {
    console.warn("google translate failed", err);
  }

  const fallback = await translateMyMemory(clean, from, to);
  cacheSet(key, fallback);
  return fallback;
}

async function lookupWord(word, from, to, context, japanese) {
  const clean = String(word || "").trim();
  if (!clean) return { word: "", translation: "", phonetic: "", senses: [], entries: [] };
  if (/^ja(?:-|$)/i.test(from || "")) return lmJapaneseService.lookup(clean, to || "zh-CN", context, japanese);
  const key = `w:${from}:${to}:${clean.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const result = {
    word: clean,
    translation: "",
    phonetic: "",
    phoneticUs: "",
    phoneticUk: "",
    audioUs: "",
    audioUk: "",
    senses: [],
    entries: [],
    context: context || ""
  };

  const english = String(from || "").toLowerCase().startsWith("en");
  const [googleResult, dictionary] = await Promise.all([
    translateGoogle(clean, from, to, true).catch(() => null),
    english ? fetchEnglishEntry(clean) : Promise.resolve(null)
  ]);

  if (googleResult) {
    result.translation = googleResult.text;
    result.phonetic = googleResult.phonetic;
    result.senses = googleResult.senses || [];
  } else {
    const fallback = await translateMyMemory(clean, from, to).catch(() => ({ text: "" }));
    result.translation = fallback.text;
  }

  if (dictionary) {
    result.phoneticUs = dictionary.phoneticUs;
    result.phoneticUk = dictionary.phoneticUk;
    result.audioUs = dictionary.audioUs;
    result.audioUk = dictionary.audioUk;
    result.phonetic = dictionary.phoneticUs || dictionary.phoneticUk || result.phonetic;
    result.entries = await translateEntries(dictionary.entries, to);
    if (!result.translation && result.entries[0] && result.entries[0].items[0]) {
      result.translation = result.entries[0].items[0].gloss || result.entries[0].items[0].definition;
    }
  }

  cacheSet(key, result);
  return result;
}

async function fetchEnglishEntry(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry) return null;
  const sounds = classifyPhonetics(entry.phonetics || []);
  const entries = (entry.meanings || []).slice(0, 3).map((meaning) => ({
    pos: meaning.partOfSpeech || "",
    items: (meaning.definitions || []).slice(0, 2).map((item) => ({
      definition: item.definition || "",
      example: item.example || "",
      synonyms: (item.synonyms || meaning.synonyms || []).slice(0, 4)
    }))
  }));
  return Object.assign(sounds, { entries });
}

function classifyPhonetics(phonetics) {
  const sounds = { phoneticUs: "", phoneticUk: "", audioUs: "", audioUk: "" };
  phonetics.forEach((item) => {
    const audio = item.audio || "";
    const text = item.text || "";
    const uk = /[-_/]uk\b|british|gb\b/i.test(audio);
    const us = /[-_/]us\b|american/i.test(audio);
    if (uk) {
      if (text && !sounds.phoneticUk) sounds.phoneticUk = text;
      if (audio && !sounds.audioUk) sounds.audioUk = audio;
    } else if (us) {
      if (text && !sounds.phoneticUs) sounds.phoneticUs = text;
      if (audio && !sounds.audioUs) sounds.audioUs = audio;
    } else if (text) {
      if (!sounds.phoneticUs) sounds.phoneticUs = text;
      if (!sounds.phoneticUk) sounds.phoneticUk = text;
    }
  });
  if (!sounds.phoneticUk) sounds.phoneticUk = sounds.phoneticUs;
  if (!sounds.phoneticUs) sounds.phoneticUs = sounds.phoneticUk;
  return sounds;
}

async function translateEntries(entries, to) {
  const definitions = [];
  entries.forEach((entry) => {
    entry.items.forEach((item) => definitions.push(item.definition));
  });
  const glosses = await translateLines(definitions, "en", to);
  let index = 0;
  return entries.map((entry) => ({
    pos: entry.pos,
    items: entry.items.map((item) => {
      const gloss = glosses[index] || "";
      index += 1;
      return {
        gloss,
        definition: item.definition,
        example: item.example,
        synonyms: item.synonyms
      };
    })
  }));
}

async function translateLines(lines, from, to) {
  const clean = lines.map((line) => String(line || "").replace(/\s+/g, " ").trim());
  if (!clean.some(Boolean) || from === to) return clean;
  const found = {};
  clean.forEach((line, index) => {
    const cached = cacheGet(`t:${from}:${to}:${line}`);
    if (cached?.text) found[index] = cached.text;
  });
  const packed = clean
    .map((line, index) => (line && !found[index] ? `[${index}] ${line}` : ""))
    .filter(Boolean)
    .join("\n");
  try {
    const translated = packed ? await translateGoogle(packed, from, to, false) : { text: "" };
    const pattern = /[\[［](\d+)[\]］]\s*([\s\S]*?)(?=\s*[\[［]\d+[\]］]|$)/g;
    String(translated.text || "").replace(pattern, (_, index, gloss) => {
      found[index] = gloss.replace(/\s+/g, " ").trim();
      if (found[index] && clean[Number(index)]) cacheSet(`t:${from}:${to}:${clean[Number(index)]}`, { text: found[index], phonetic: "" });
      return "";
    });
  } catch (err) {
    // Individual entries below can still succeed if batch markers were lost.
  }
  return Promise.all(clean.map(async (line, index) => {
    if (!line) return "";
    if (found[String(index)]) return found[String(index)];
    try { return (await translateText(line, from, to)).text || ""; } catch (_) { return ""; }
  }));
}

async function pronounceClip(text, tl, audioUrl) {
  const spoken = String(text || "").trim().slice(0, 160);
  if (!spoken && !audioUrl) return { audio: "", mime: "audio/mpeg" };
  try {
    if (audioUrl) {
      const clip = await audioToBase64(audioUrl);
      if (clip.audio) return clip;
    }
  } catch (err) {
    /* use synthesized speech below */
  }
  const lang = tl || "en-US";
  const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(
    lang
  )}&q=${encodeURIComponent(spoken)}`;
  return audioToBase64(url);
}

async function audioToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) return { audio: "", mime: "audio/mpeg" };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || bytes.length > 250000) return { audio: "", mime: "audio/mpeg" };
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const mime = String(res.headers.get("content-type") || "audio/mpeg").split(";")[0];
  return { audio: btoa(binary), mime: mime || "audio/mpeg" };
}

async function translateGoogle(text, from, to, detailed) {
  if (Date.now() < googleRetryAfter) throw new Error("google_rate_limited");
  const params = new URLSearchParams({
    client: "gtx",
    sl: from === "auto" ? "auto" : from,
    tl: to,
    dt: "t",
    ie: "UTF-8",
    oe: "UTF-8",
    q: text
  });
  if (detailed) {
    params.append("dt", "bd");
    params.append("dt", "rm");
    params.append("dt", "ex");
  } else {
    params.append("dt", "rm");
  }
  const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const res = await fetch(url, typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(6000) } : undefined);
  if (res.status === 429) googleRetryAfter = Date.now() + 60000;
  if (!res.ok) throw new Error(`google_${res.status}`);
  const data = await res.json();
  const translated = Array.isArray(data[0])
    ? data[0].map((part) => (part && part[0] ? part[0] : "")).join("")
    : "";
  let phonetic = "";
  if (Array.isArray(data[0])) {
    for (const part of data[0]) {
      if (part && part[3]) phonetic += part[3];
    }
  }
  if (!phonetic && Array.isArray(data[8]) && data[8][0] && data[8][0][2]) {
    phonetic = String(data[8][0][2]);
  }
  const senses = [];
  if (Array.isArray(data[1])) {
    for (const group of data[1]) {
      const pos = group[0] || "";
      const words = Array.isArray(group[1]) ? group[1].slice(0, 6) : [];
      if (words.length) senses.push({ pos, words });
    }
  }
  return { text: translated, phonetic, senses };
}

async function translateMyMemory(text, from, to) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(
    `${from}|${to}`
  )}`;
  const res = await fetch(url, typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(6000) } : undefined);
  if (!res.ok) throw new Error(`mymemory_${res.status}`);
  const data = await res.json();
  if (data.responseStatus && Number(data.responseStatus) !== 200) throw new Error("translation_unavailable");
  const translated = String(data.responseData?.translatedText || "");
  if (/QUERY LENGTH LIMIT|MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE/i.test(translated)) throw new Error("translation_unavailable");
  return {
    text: translated,
    phonetic: "",
    senses: []
  };
}
