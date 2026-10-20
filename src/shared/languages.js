const LM_LANGUAGES = [
  { code: "en", yt: "en", label: "English", native: "英语" },
  { code: "zh-CN", yt: "zh-Hans", label: "中文（简体）", native: "简体中文" },
  { code: "zh-TW", yt: "zh-Hant", label: "中文（繁體）", native: "繁體中文" },
  { code: "ja", yt: "ja", label: "日本語", native: "日语" },
  { code: "ko", yt: "ko", label: "한국어", native: "韩语" },
  { code: "es", yt: "es", label: "Español", native: "西班牙语" },
  { code: "fr", yt: "fr", label: "Français", native: "法语" },
  { code: "de", yt: "de", label: "Deutsch", native: "德语" },
  { code: "it", yt: "it", label: "Italiano", native: "意大利语" },
  { code: "pt", yt: "pt", label: "Português", native: "葡萄牙语" },
  { code: "ru", yt: "ru", label: "Русский", native: "俄语" },
  { code: "ar", yt: "ar", label: "العربية", native: "阿拉伯语" },
  { code: "hi", yt: "hi", label: "हिन्दी", native: "印地语" },
  { code: "th", yt: "th", label: "ไทย", native: "泰语" },
  { code: "vi", yt: "vi", label: "Tiếng Việt", native: "越南语" },
  { code: "id", yt: "id", label: "Bahasa Indonesia", native: "印尼语" },
  { code: "tr", yt: "tr", label: "Türkçe", native: "土耳其语" },
  { code: "pl", yt: "pl", label: "Polski", native: "波兰语" },
  { code: "nl", yt: "nl", label: "Nederlands", native: "荷兰语" },
  { code: "sv", yt: "sv", label: "Svenska", native: "瑞典语" },
  { code: "uk", yt: "uk", label: "Українська", native: "乌克兰语" },
  { code: "he", yt: "he", label: "עברית", native: "希伯来语" },
  { code: "el", yt: "el", label: "Ελληνικά", native: "希腊语" },
  { code: "cs", yt: "cs", label: "Čeština", native: "捷克语" },
  { code: "ro", yt: "ro", label: "Română", native: "罗马尼亚语" },
  { code: "hu", yt: "hu", label: "Magyar", native: "匈牙利语" },
  { code: "fi", yt: "fi", label: "Suomi", native: "芬兰语" },
  { code: "da", yt: "da", label: "Dansk", native: "丹麦语" },
  { code: "no", yt: "nb", label: "Norsk", native: "挪威语" },
  { code: "ms", yt: "ms", label: "Bahasa Melayu", native: "马来语" },
  { code: "fa", yt: "fa", label: "فارسی", native: "波斯语" },
  { code: "bn", yt: "bn", label: "বাংলা", native: "孟加拉语" },
  { code: "ta", yt: "ta", label: "தமிழ்", native: "泰米尔语" },
  { code: "te", yt: "te", label: "తెలుగు", native: "泰卢固语" },
  { code: "ur", yt: "ur", label: "اردو", native: "乌尔都语" },
  { code: "tl", yt: "fil", label: "Filipino", native: "菲律宾语" }
];

function lmLangByCode(code) {
  return LM_LANGUAGES.find((item) => item.code === code) || LM_LANGUAGES[0];
}

function lmYtCode(code) {
  return lmLangByCode(code).yt;
}

function lmIsCjk(code) {
  return /^(zh|ja|ko)/.test(code);
}
