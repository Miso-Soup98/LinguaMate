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
  accent: "us"
};

const cache = new Map();
const CACHE_LIMIT = 4000;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set(Object.assign({}, DEFAULTS, stored));
  const local = await chrome.storage.local.get({ vocab: [], known: {} });
  if (!Array.isArray(local.vocab)) await chrome.storage.local.set({ vocab: [] });
  if (!local.known || typeof local.known !== "object") {
    await chrome.storage.local.set({ known: {} });
  }

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
      files: ["src/shared/languages.js", "src/shared/defaults.js", "src/content/reader.js"]
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
  switch (message.type) {
    case "LM_GET_SETTINGS":
      return { ok: true, settings: await getSettings() };
    case "LM_SET_SETTINGS":
      await chrome.storage.sync.set(message.settings || {});
      return { ok: true, settings: await getSettings() };
    case "LM_TRANSLATE":
      return {
        ok: true,
        result: await translateText(message.text, message.from, message.to)
      };
    case "LM_LOOKUP":
      return {
        ok: true,
        result: await lookupWord(message.word, message.from, message.to, message.context)
      };
    case "LM_PRONOUNCE": {
      const clip = await pronounceClip(message.text, message.tl, message.audioUrl);
      return { ok: true, audio: clip.audio || "", mime: clip.mime || "audio/mpeg" };
    }
    case "LM_VOCAB_LIST":
      return { ok: true, vocab: await getVocab(), known: await getKnown() };
    case "LM_VOCAB_ADD":
      return { ok: true, item: await addVocab(message.item) };
    case "LM_VOCAB_UPDATE":
      return { ok: true, item: await updateVocab(message.id, message.patch) };
    case "LM_VOCAB_DELETE":
      await deleteVocab(message.id);
      return { ok: true };
    case "LM_MARK_KNOWN":
      await markKnown(message.word, message.lang, message.known !== false);
      return { ok: true, known: await getKnown() };
    default:
      return { ok: false, error: "unknown_message" };
  }
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return Object.assign({}, DEFAULTS, stored);
}

async function getVocab() {
  const { vocab } = await chrome.storage.local.get({ vocab: [] });
  return Array.isArray(vocab) ? vocab : [];
}

async function getKnown() {
  const { known } = await chrome.storage.local.get({ known: {} });
  return known && typeof known === "object" ? known : {};
}

function vocabKey(word, lang) {
  return `${lang || "und"}:${String(word || "").toLowerCase()}`;
}

async function addVocab(item) {
  const vocab = await getVocab();
  const word = String(item.word || "").trim();
  if (!word) throw new Error("empty_word");
  const existing = vocab.find(
    (row) => row.word.toLowerCase() === word.toLowerCase() && row.lang === item.lang
  );
  if (existing) {
    existing.translation = item.translation || existing.translation;
    existing.context = item.context || existing.context;
    existing.videoTitle = item.videoTitle || existing.videoTitle;
    existing.videoUrl = item.videoUrl || existing.videoUrl;
    existing.updatedAt = Date.now();
    await chrome.storage.local.set({ vocab });
    return existing;
  }
  const created = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    word,
    translation: item.translation || "",
    phonetic: item.phonetic || "",
    lang: item.lang || "en",
    nativeLang: item.nativeLang || "zh-CN",
    context: item.context || "",
    videoTitle: item.videoTitle || "",
    videoUrl: item.videoUrl || "",
    time: item.time || 0,
    status: "learning",
    reps: 0,
    interval: 0,
    ease: 2.5,
    due: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  vocab.unshift(created);
  await chrome.storage.local.set({ vocab });
  return created;
}

async function updateVocab(id, patch) {
  const vocab = await getVocab();
  const row = vocab.find((item) => item.id === id);
  if (!row) throw new Error("missing_item");
  Object.assign(row, patch, { updatedAt: Date.now() });
  await chrome.storage.local.set({ vocab });
  return row;
}

async function deleteVocab(id) {
  const vocab = await getVocab();
  await chrome.storage.local.set({ vocab: vocab.filter((item) => item.id !== id) });
}

async function markKnown(word, lang, isKnown) {
  const known = await getKnown();
  const key = vocabKey(word, lang);
  if (isKnown) known[key] = true;
  else delete known[key];
  await chrome.storage.local.set({ known });
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

async function translateText(text, from, to) {
  const clean = String(text || "").trim();
  if (!clean) return { text: "", phonetic: "" };
  if (from === to) return { text: clean, phonetic: "" };
  const key = `t:${from}:${to}:${clean}`;
  const cached = cacheGet(key);
  if (cached) return cached;

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

async function lookupWord(word, from, to, context) {
  const clean = String(word || "").trim();
  if (!clean) return { word: "", translation: "", phonetic: "", senses: [], entries: [] };
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
  const packed = clean
    .map((line, index) => (line ? `[${index}] ${line}` : ""))
    .filter(Boolean)
    .join("\n");
  try {
    const translated = await translateGoogle(packed, from, to, false);
    const found = {};
    const pattern = /\[(\d+)\]\s*([\s\S]*?)(?=\s*\[\d+\]|$)/g;
    String(translated.text || "").replace(pattern, (_, index, gloss) => {
      found[index] = gloss.replace(/\s+/g, " ").trim();
      return "";
    });
    return clean.map((line, index) => found[String(index)] || "");
  } catch (err) {
    return clean.map(() => "");
  }
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
  const res = await fetch(url);
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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mymemory_${res.status}`);
  const data = await res.json();
  return {
    text: (data.responseData && data.responseData.translatedText) || "",
    phonetic: "",
    senses: []
  };
}
