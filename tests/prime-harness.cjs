const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// A deliberately small browser fixture: real Prime content-script functions run
// unchanged, with deterministic geometry and timers instead of a network player.
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const entries = this.listeners.get(type) || [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== listener));
  }
  emit(type, fields = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...fields };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}

function decode(value) {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

class Element extends Events {
  constructor(tag, ownerDocument, nodeType = 1) {
    super();
    this.tagName = tag.toUpperCase();
    this.localName = tag;
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this._className = "";
    this._text = "";
    this._scrollTop = 0;
    this.scrollWrites = 0;
    this.replaceCount = 0;
    this.hovered = false;
    this.classList = {
      contains: (name) => this._className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this._className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this._className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.contains(name) : force;
        this.classList[enabled ? "add" : "remove"](name);
        return enabled;
      }
    };
  }
  get className() { return this._className; }
  set className(value) { this._className = String(value); }
  get parentNode() { return this.parentElement; }
  get childElementCount() { return this.children.filter((node) => node.nodeType === 1).length; }
  get firstElementChild() { return this.children.find((node) => node.nodeType === 1) || null; }
  get firstChild() { return this.children[0] || null; }
  get lastElementChild() { return [...this.children].reverse().find((node) => node.nodeType === 1) || null; }
  get isConnected() { return this === this.ownerDocument.documentElement || !!this.parentElement?.isConnected; }
  set textContent(value) { this.replaceChildren(); this._text = String(value ?? ""); }
  get textContent() { return this._text + this.children.map((node) => node.textContent).join(""); }
  set innerText(value) { this.textContent = value; }
  get innerText() { return this.textContent; }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    for (const match of String(html).matchAll(/<\/(\w+)[^>]*>|<(\w+)([^>]*)>|([^<]+)/g)) {
      if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
      if (match[4]) { stack.at(-1).appendChild(this.ownerDocument.createTextNode(decode(match[4]))); continue; }
      const node = this.ownerDocument.createElement(match[2]);
      for (const attr of match[3].matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)')?/g)) {
        node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? ""));
      }
      stack.at(-1).appendChild(node);
      if (!["br", "img", "input", "hr"].includes(match[2]) && !match[3].trimEnd().endsWith("/")) stack.push(node);
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = value;
    if (name === "id") this.id = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name.startsWith("data-")) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())];
  }
  appendChild(node) {
    if (node.nodeType === 11) { for (const child of [...node.children]) this.appendChild(child); return node; }
    node.parentElement?.removeChild(node);
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  after(node) {
    if (!this.parentElement) return;
    node.parentElement?.removeChild(node);
    const parent = this.parentElement;
    node.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  click() { if (!this.disabled) this.emit("click"); }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentElement = null; return node; }
  remove() { this.parentElement?.removeChild(this); }
  replaceChildren(...nodes) {
    this.replaceCount += 1;
    this.children.forEach((node) => { node.parentElement = null; });
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
    if (selector === ":hover") return this.hovered;
    if (selector.endsWith(":hover")) return this.hovered && this.matches(selector.slice(0, -6));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return selector.slice(1).split(".").every((name) => this.classList.contains(name));
    const attr = selector.match(/^\[([\w-]+)(?:(\*?=)['"]?([^'"\]]+)['"]?)?\]$/);
    if (attr) {
      const value = attr[1] === "class" ? this.className : attr[1].startsWith("data-") ? this.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : this.getAttribute(attr[1]);
      return value != null && (attr[2] === undefined || (attr[2] === "*=" ? value.includes(attr[3]) : value === attr[3]));
    }
    return this.localName === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get clientWidth() { return this._clientWidth ?? 340; }
  set clientWidth(value) { this._clientWidth = value; }
  get clientHeight() { return this._clientHeight ?? (this.classList.contains("lm-panel-body") ? 180 : 32); }
  set clientHeight(value) { this._clientHeight = value; }
  get offsetHeight() { return this.classList.contains("lm-cue") ? 72 : this.clientHeight; }
  get offsetTop() {
    return this.classList.contains("lm-cue") ? this.parentElement.children.indexOf(this) * 72 : 0;
  }
  get scrollHeight() { return Math.max(this.clientHeight, this.children.filter((node) => node.classList?.contains("lm-cue")).length * 72); }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) { this.scrollWrites += 1; this._scrollTop = Math.max(0, Math.min(Number(value), this.scrollHeight - this.clientHeight)); }
  scrollTo(options, top) { this.scrollTop = typeof options === "object" ? options.top : top; }
  scrollIntoView() {
    const body = this.closest(".lm-panel-body");
    if (body) body.scrollTop = this.offsetTop - body.clientHeight / 2 + this.offsetHeight / 2;
  }
  getBoundingClientRect() {
    const body = this.closest(".lm-panel-body");
    const row = this.closest(".lm-cue");
    const top = 100 + (row ? row.offsetTop - body.scrollTop : 0);
    return { top, bottom: top + this.offsetHeight, left: 400, right: 400 + this.clientWidth, width: this.clientWidth, height: this.offsetHeight };
  }
  setPointerCapture() {}
  hasPointerCapture() { return false; }
  releasePointerCapture() {}
}

function primeHarness({ deferredLookup = false, deferredTranslation = false, deferredSettings = false, initialVocab = [], vocabErrors = {}, settings = {}, textTracks = [] } = {}) {
  const document = new Events();
  document.createElement = (tag) => new Element(tag, document);
  document.createTextNode = (text) => { const node = new Element("#text", document, 3); node._text = text; return node; };
  document.createDocumentFragment = () => new Element("#fragment", document, 11);
  document.documentElement = document.createElement("html");
  document.querySelectorAll = (selector) => document.documentElement.querySelectorAll(selector);
  document.querySelector = (selector) => document.documentElement.querySelector(selector);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.title = "Prime regression fixture";
  const video = document.createElement("video");
  video.clientWidth = 1000;
  video.clientHeight = 600;
  video.currentTime = 0;
  video.textTracks = textTracks;
  video.paused = false;
  video.seeking = false;
  video.playbackRate = 1;
  video.playCalls = 0;
  video.pauseCalls = 0;
  video.play = () => { video.paused = false; video.playCalls += 1; return Promise.resolve(); };
  video.pause = () => { video.paused = true; video.pauseCalls += 1; };
  document.documentElement.append(video);
  const window = new Events();
  window.innerWidth = 1440;
  window.innerHeight = 900;
  const postedMessages = [];
  window.postMessage = (message, origin) => postedMessages.push({ message, origin });
  const timers = new Map();
  let now = 0;
  let timerId = 0;
  const setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const requests = [];
  const pendingLookups = [];
  const pendingTranslations = [];
  const pendingSettings = [];
  let backendSettings = { ...settings };
  const vocab = initialVocab.map((item) => ({ ...item }));
  const storageListeners = [];
  let vocabId = 0;
  const chrome = {
    runtime: {
      id: "prime-test",
      sendMessage(message, callback) {
        requests.push(message);
        if (message.type === "LM_LOOKUP") {
          if (deferredLookup) pendingLookups.push({ message, callback });
          else callback({ ok: true, result: { word: message.word, translation: `translation:${message.word}` } });
        } else if (vocabErrors[message.type]) {
          callback({ ok: false, error: vocabErrors[message.type] });
        } else if (message.type === "LM_GET_SETTINGS") {
          if (deferredSettings) pendingSettings.push({ message, callback });
          else callback({ ok: true, settings: { ...backendSettings } });
        } else if (message.type === "LM_SET_SETTINGS") {
          backendSettings = { ...backendSettings, ...message.settings };
          callback({ ok: true, settings: { ...backendSettings } });
        } else if (message.type === "LM_TRANSLATE") {
          if (deferredTranslation) pendingTranslations.push({ message, callback });
          else callback({ ok: true, result: { text: message.text.split("\n").map((line) => line.replace(/^(\[\d+\])\s*/, "$1 translated:")).join("\n") } });
        } else if (message.type === "LM_VOCAB_LIST") {
          callback({ ok: true, vocab: vocab.map((item) => ({ ...item })), known: {} });
        } else if (message.type === "LM_VOCAB_ADD") {
          const item = message.item;
          const existing = vocab.find((entry) => entry.lang === item.lang && entry.word.toLowerCase() === item.word.trim().toLowerCase());
          const saved = existing || { ...item, id: `fixture-vocab-${++vocabId}`, word: item.word.trim(), status: "learning" };
          if (existing) Object.assign(existing, item);
          else vocab.unshift(saved);
          callback({ ok: true, item: { ...saved } });
        } else if (message.type === "LM_VOCAB_DELETE") {
          const index = vocab.findIndex((item) => item.id === message.id);
          if (index !== -1) vocab.splice(index, 1);
          callback({ ok: true });
        } else callback({ ok: true });
      }
    },
    storage: {
      local: { get(_key, callback) { callback({}); }, set() {} },
      onChanged: {
        addListener(listener) { storageListeners.push(listener); },
        removeListener(listener) { const index = storageListeners.indexOf(listener); if (index !== -1) storageListeners.splice(index, 1); }
      }
    }
  };
  const context = vm.createContext({
    document, window, chrome, Intl, URL, Blob, console,
    location: { href: "https://www.primevideo.com/detail/fixture" },
    setTimeout, clearTimeout, setInterval: () => 0,
    requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout
  });
  const file = path.resolve(__dirname, "../src/content/prime.js");
  for (const name of ["defaults.js", "frequency.js", "captions.js", "feedback.js", "vocab-button.js"]) {
    const helper = path.resolve(__dirname, "../src/shared", name);
    vm.runInContext(fs.readFileSync(helper, "utf8"), context, { filename: helper });
  }
  const exports = ["state", "ui", "ensureUi", "mount", "renderCurrent", "renderPanel", "renderWords", "scrapeLiveCaption", "seekTo", "applyTrack", "onHover", "onLeave", "hideDict", "togglePanel", "setTranscriptFollow", "followCurrentCue", "onTranscriptScroll", "onDictViewportChange", "applySettings", "syncSettings", "currentIndex", "navigationIndex", "onTick", "onKeyDown", "onKeyUp", "translateCues", "syncTextTracks"];
  const source = fs.readFileSync(file, "utf8").replace(/\s+boot\(\);\s*\}\)\(\);\s*$/, `\n globalThis.prime = { ${exports.map((name) => `${name}: typeof ${name} === 'undefined' ? undefined : ${name}`).join(",")} };\n})();`);
  vm.runInContext(source, context, { filename: file });
  if (!context.prime) throw new Error("Prime test harness could not export content-script functions");
  const prime = context.prime;
  prime.state.settings = context.lmMergeSettings(settings);
  prime.state.vocab = vocab.map((item) => ({ ...item }));
  prime.mount();
  return {
    prime, video, document, window, requests, pendingLookups, pendingTranslations, pendingSettings, postedMessages, vocab, vocabErrors,
    setBackendSettings(value) { backendSettings = { ...backendSettings, ...value }; },
    storageChange(changes, area = "local") { return Promise.all(storageListeners.map((listener) => listener(changes, area))); },
    key(type, key, options = {}) { return document.emit(type, { key, target: document.documentElement, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options }); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = until;
    },
    hover(word, from = null) { if (from) from.hovered = false; word.hovered = true; prime.onHover({ target: word, relatedTarget: from }); },
    leave(word, to = null) { word.hovered = false; if (to) to.hovered = true; prime.onLeave({ target: word, relatedTarget: to }); },
    lookupRequests() { return requests.filter((message) => message.type === "LM_LOOKUP"); },
    cues(count = 12) {
      prime.state.cues = Array.from({ length: count }, (_, index) => ({ start: index * 2000, end: index * 2000 + 1800, text: `Sentence ${index} with words` }));
      prime.state.native = [];
      prime.renderPanel();
      prime.renderCurrent();
      return prime.ui.panelBody.querySelectorAll(".lm-cue");
    },
    async flush() { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); }
  };
}

module.exports = { primeHarness };
