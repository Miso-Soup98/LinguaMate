function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload), resolve);
  });
}

const ui = {
  search: document.getElementById("search"),
  statusFilter: document.getElementById("statusFilter"),
  vocabList: document.getElementById("vocabList"),
  cardBox: document.getElementById("cardBox"),
  form: document.getElementById("settingsForm")
};

let vocab = [];
let currentCard = null;

function download(name, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

function review(item, grade) {
  const now = Date.now();
  let ease = item.ease || 2.5;
  let interval = item.interval || 0;
  if (grade === "again") {
    ease = Math.max(1.3, ease - 0.2);
    interval = 0.25;
  } else if (grade === "good") {
    ease += 0.05;
    interval = interval ? interval * ease : 1;
  } else {
    ease += 0.15;
    interval = interval ? interval * (ease + 0.15) : 3;
  }
  return {
    ease,
    interval,
    reps: (item.reps || 0) + 1,
    due: now + interval * 24 * 60 * 60 * 1000,
    status: grade === "easy" && interval > 21 ? "known" : "learning"
  };
}

function langLabel(code) {
  const found = LM_LANGUAGES.find((item) => item.code === code);
  return found ? found.native : code || "其他";
}

function fillLangSelect(select, selected) {
  const langs = Array.from(new Set(vocab.map((item) => item.lang || "und")));
  const current = selected || select.value || "all";
  select.innerHTML = `<option value="all">全部语言</option>${langs
    .map((code) => `<option value="${code}">${langLabel(code)}</option>`)
    .join("")}`;
  select.value = langs.includes(current) || current === "all" ? current : "all";
}

function renderVocab() {
  const langSelect = document.getElementById("langFilter");
  fillLangSelect(langSelect);
  const q = ui.search.value.trim().toLowerCase();
  const status = ui.statusFilter.value;
  const lang = langSelect.value;
  const rows = vocab.filter((item) => {
    const hit = [item.word, item.translation, item.context, item.videoTitle].join(" ").toLowerCase();
    const statusOk = status === "all" || item.status === status;
    const langOk = lang === "all" || (item.lang || "und") === lang;
    return statusOk && langOk && (!q || hit.includes(q));
  });
  if (!rows.length) {
    ui.vocabList.innerHTML = `<p class="muted">还没有匹配的生词。去视频里点词收藏即可。</p>`;
    return;
  }
  const groups = new Map();
  rows.forEach((item) => {
    const key = item.lang || "und";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  ui.vocabList.innerHTML = Array.from(groups.entries())
    .map(([code, items]) => {
      const cards = items
        .map(
          (item) => `<article class="item" data-id="${item.id}">
        <div>
          <strong>${item.word}</strong>
          <div>${item.translation || ""}</div>
        </div>
        <div class="ctx">${item.context || ""}<br>${item.videoTitle || ""}</div>
        <menu>
          <button data-act="known">掌握</button>
          <button data-act="speak">朗读</button>
          <button data-act="delete">删除</button>
        </menu>
      </article>`
        )
        .join("");
      return `<h2>${langLabel(code)}</h2>${cards}`;
    })
    .join("");
}

function dueCards() {
  const now = Date.now();
  const lang = document.getElementById("cardLang")?.value || "all";
  return vocab.filter((item) => {
    const langOk = lang === "all" || (item.lang || "und") === lang;
    return langOk && item.status !== "known" && (item.due || 0) <= now;
  });
}

function renderCard() {
  const queue = dueCards();
  currentCard = queue[0] || null;
  if (!currentCard) {
    ui.cardBox.innerHTML = `<p class="muted">今天没有到期卡片。当前生词 ${vocab.length} 个。</p>`;
    return;
  }
  ui.cardBox.innerHTML = `
    <div class="card">
      <h2>${currentCard.word}</h2>
      <p>${currentCard.phonetic || ""}</p>
      <p data-reveal hidden>${currentCard.translation || "暂无释义"}<br>${currentCard.context || ""}</p>
      <div class="card-actions">
        <button data-act="reveal">显示释义</button>
        <button class="again" data-grade="again">再来</button>
        <button class="good" data-grade="good">记得</button>
        <button class="easy" data-grade="easy">简单</button>
      </div>
    </div>
  `;
}

async function load() {
  let vocabRes = {};
  let settingsRes = {};
  try {
    [vocabRes, settingsRes] = await Promise.all([send("LM_VOCAB_LIST"), send("LM_GET_SETTINGS")]);
  } catch (err) {
    renderVocab();
    renderCard();
    return;
  }
  vocab = vocabRes.vocab || [];
  fillLangSelect(document.getElementById("cardLang"));
  renderVocab();
  renderCard();
  const settings = settingsRes.settings || {};
  ["learningLang", "nativeLang"].forEach((name) => {
    const select = ui.form.elements[name];
    if (!select.options.length) {
      LM_LANGUAGES.forEach((lang) => select.add(new Option(lang.native, lang.code)));
    }
    select.value = settings[name];
  });
  ui.form.elements.fontSize.value = settings.fontSize;
  ui.form.elements.playbackRate.value = settings.playbackRate;
  ui.form.elements.autoPause.checked = !!settings.autoPause;
  ui.form.elements.listenMode.checked = !!settings.listenMode;
  ui.form.elements.highlightRare.checked = !!settings.highlightRare;
  ui.form.elements.hideYoutubeCaptions.checked = !!settings.hideYoutubeCaptions;
}

document.querySelector("nav").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-view]");
  if (!btn) return;
  document.querySelectorAll("nav button").forEach((el) => el.classList.toggle("active", el === btn));
  document.querySelectorAll("main > section").forEach((section) => {
    section.hidden = section.id !== `view-${btn.dataset.view}`;
  });
});

ui.search.addEventListener("input", renderVocab);
ui.statusFilter.addEventListener("change", renderVocab);
document.getElementById("langFilter").addEventListener("change", renderVocab);
document.getElementById("cardLang").addEventListener("change", renderCard);

document.getElementById("exportCsv").addEventListener("click", () => {
  const header = "word,translation,context,video,status";
  const lines = vocab.map((item) =>
    [item.word, item.translation, item.context, item.videoTitle, item.status].map(csvEscape).join(",")
  );
  download("linguamate-vocab.csv", [header, ...lines].join("\n"));
});

document.getElementById("exportAnki").addEventListener("click", () => {
  const lines = vocab.map((item) => `${item.word}\t${item.translation || ""}<br>${item.context || ""}`);
  download("linguamate-anki.txt", lines.join("\n"));
});

ui.vocabList.addEventListener("click", async (ev) => {
  const itemEl = ev.target.closest(".item");
  const act = ev.target.dataset.act;
  if (!itemEl || !act) return;
  const id = itemEl.dataset.id;
  const item = vocab.find((row) => row.id === id);
  if (act === "delete") await send("LM_VOCAB_DELETE", { id });
  if (act === "known") {
    await send("LM_VOCAB_UPDATE", { id, patch: { status: "known", due: Date.now() + 30 * 86400000 } });
    await send("LM_MARK_KNOWN", { word: item.word, lang: item.lang, known: true });
  }
  if (act === "speak" && item) {
    const utter = new SpeechSynthesisUtterance(item.word);
    utter.lang = item.lang || "en";
    speechSynthesis.speak(utter);
  }
  await load();
});

ui.cardBox.addEventListener("click", async (ev) => {
  if (ev.target.dataset.act === "reveal") {
    ui.cardBox.querySelector("[data-reveal]")?.removeAttribute("hidden");
    return;
  }
  const grade = ev.target.dataset.grade;
  if (!grade || !currentCard) return;
  await send("LM_VOCAB_UPDATE", { id: currentCard.id, patch: review(currentCard, grade) });
  await load();
});

ui.form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const settings = {
    learningLang: ui.form.elements.learningLang.value,
    nativeLang: ui.form.elements.nativeLang.value,
    fontSize: Number(ui.form.elements.fontSize.value),
    playbackRate: Number(ui.form.elements.playbackRate.value),
    autoPause: ui.form.elements.autoPause.checked,
    listenMode: ui.form.elements.listenMode.checked,
    highlightRare: ui.form.elements.highlightRare.checked,
    hideYoutubeCaptions: ui.form.elements.hideYoutubeCaptions.checked
  };
  await send("LM_SET_SETTINGS", { settings });
});

load();
