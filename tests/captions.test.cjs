const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const source = fs.readFileSync(path.resolve(__dirname, "../src/shared/captions.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const parse = (input) => JSON.parse(JSON.stringify(context.lmParseCaptionTrack(input)));

test("JSON numeric strings use milliseconds and zero starts retain their identity", () => {
  assert.deepEqual(parse(JSON.stringify({ lang: "ja", cues: [
    { start: "12000", text: " later " },
    { start: 0, begin: 9000, end: "800", text: "first" },
    { start: "1500", end: "2000", content: " next\nline " },
    { begin: "3000", dur: "2000", text: "duration" }
  ] })), { lang: "ja", cues: [
    { start: 0, end: 800, text: "first" },
    { start: 1500, end: 2000, text: "next line" },
    { start: 3000, end: 5000, text: "duration" },
    { start: 12000, end: 13500, text: "later" }
  ] });
});

test("JSON rejects invalid, negative, empty or reversed cue times", () => {
  const cues = [
    { start: 0, end: 0, text: "zero duration" },
    { start: 5, end: 4, text: "reversed" },
    { start: -1, text: "negative" },
    { start: "", text: "empty" },
    { start: "NaN", text: "bad" },
    { text: "missing" },
    { start: false, text: "boolean" },
    { start: "1s", text: "wrong unit" },
    { start: 10, end: "bad", text: "bad end" },
    { start: 10, dur: -4, text: "bad duration" },
    { start: 10, text: " " }, null
  ];
  assert.deepEqual(parse(JSON.stringify({ cues })), { lang: "", cues: [] });
});

test("JSON accepts timedtext, subtitles and array forms without throwing on bad input", () => {
  const cue = { start: 500, end: 700, text: "hello" };
  for (const input of [{ timedtext: { text: [cue] } }, { subtitles: [cue] }, [cue]]) {
    assert.deepEqual(parse(JSON.stringify(input)).cues, [cue]);
  }
  for (const input of ["{bad json", "{\"cues\":{}}", "", null, "unrecognized response"]) {
    assert.deepEqual(parse(input), { lang: "", cues: [] });
  }
});

test("WebVTT supports two or three part times, identifiers, settings and language headers", () => {
  assert.deepEqual(parse("\uFEFFWEBVTT\r\nLanguage: de\r\n\r\nsecond\r\n00:01:02.000 --> 00:01:03.250 align:start position:20%\r\nHallo\r\n\r\n00:02.000 --> 00:04.500\r\nfirst line\r\nsecond line\r\n"), { lang: "de", cues: [
    { start: 2000, end: 4500, text: "first line second line" },
    { start: 62000, end: 63250, text: "Hallo" }
  ] });
});

test("WebVTT skips metadata blocks and decodes entities after stripping cue markup", () => {
  const input = `WEBVTT

NOTE examples may contain arrows
00:00.000 --> 00:03.000
not a cue

STYLE
::cue { color: lime; }

REGION
id:bottom

00:00.000 --> 00:03.000
<v Speaker><b>A &amp; B</b><br> &#x65E5;&#26412; &lt;literal&gt; &quot;yes&quot;</v>
`;
  assert.deepEqual(parse(input), { lang: "", cues: [{ start: 0, end: 3000, text: 'A & B 日本 <literal> "yes"' }] });
});

test("WebVTT filters malformed minutes, seconds, duration and partial timestamps", () => {
  const input = `WEBVTT

00:60.000 --> 01:02.000
bad seconds

00:99:00.000 --> 01:00:00.000
bad minutes

00:03.000 --> 00:02.000
reversed

00:02.000 --> 00:02.000
empty duration

00:01.000 --> 00:02.000garbage
partial end

01.000 --> 02.000
not VTT timestamps

00:00.000 --> 00:01.000
valid
`;
  assert.deepEqual(parse(input).cues, [{ start: 0, end: 1000, text: "valid" }]);
});

const xmlCases = [
  {
    name: "TTML Document roots, namespaces, br and inline spans",
    input: '<?xml version="1.0"?><tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xml:lang="ja"><tt:body><tt:div><tt:p begin="00:00:03.000" end="00:00:04.000">最後</tt:p><tt:p begin="00:00:00.000" dur="2s"><tt:span>こんにちは</tt:span><tt:br/><tt:span>世界 &amp; friends</tt:span></tt:p></tt:div></tt:body></tt:tt>',
    expected: { lang: "ja", cues: [
      { start: 0, end: 2000, text: "こんにちは 世界 & friends" },
      { start: 3000, end: 4000, text: "最後" }
    ] }
  },
  {
    name: "DFXP default namespaces and nested container timing",
    input: '<tt xmlns="http://www.w3.org/2006/10/ttaf1"><body begin="10s" dur="20s" xml:lang="en"><div begin="2s" end="8s"><p begin="500ms" dur="1.5s"><span>Hel</span><span>lo</span><![CDATA[ & goodbye]]></p><p begin="5s" dur="10s">clipped</p></div></body></tt>',
    expected: { lang: "en", cues: [
      { start: 12500, end: 14000, text: "Hello & goodbye" },
      { start: 17000, end: 18000, text: "clipped" }
    ] }
  },
  {
    name: "TTML filters invalid and unbounded timing without inventing cue duration",
    input: '<tt><body><div><p begin="bad" end="2s">bad begin</p><p begin="-1s" end="2s">negative</p><p begin="2s" end="1s">backward</p><p begin="2s" dur="0s">zero</p><p begin="00:60:00" end="01:01:00">invalid minute</p><p begin="2s">unbounded</p><p begin="3s" dur="bad">bad duration</p><p begin="1s" end="2s">valid</p></div></body></tt>',
    expected: { lang: "", cues: [{ start: 1000, end: 2000, text: "valid" }] }
  },
  {
    name: "TTML timed container can supply cue bounds",
    input: '<tt xml:lang="zh"><body><div begin="4s" dur="2s"><p>bounded by container</p></div></body></tt>',
    expected: { lang: "zh", cues: [{ start: 4000, end: 6000, text: "bounded by container" }] }
  },
  {
    name: "TTML parameter namespaces supply frame and tick rates",
    input: '<tt xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25" ttp:tickRate="100"><body><div><p begin="00:00:01:05" dur="25f">frames</p><p begin="300t" end="400t">ticks</p></div></body></tt>',
    expected: { lang: "", cues: [{ start: 1200, end: 2200, text: "frames" }, { start: 3000, end: 4000, text: "ticks" }] }
  },
  {
    name: "Malformed XML is rejected",
    input: '<tt><body><p begin="0s" end="1s">invalid</body></tt>',
    expected: { lang: "", cues: [] }
  },
  {
    name: "TTML fractional clock timestamps retain precise millisecond boundaries",
    input: '<tt><body><p begin="00:00:01.001" end="00:00:02.001">milliseconds</p></body></tt>',
    expected: { lang: "", cues: [{ start: 1001, end: 2001, text: "milliseconds" }] }
  }
];

function chromeExecutable() {
  return [process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
  ].find((candidate) => candidate && fs.existsSync(candidate));
}

test("XML fixtures run through the real Chrome DOMParser", { timeout: 45000 }, (t) => {
  const chrome = chromeExecutable();
  if (!chrome) return t.skip("Set CHROME_PATH to run real browser XML parsing coverage");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "linguamate-captions-"));
  try {
    const fixture = path.join(directory, "captions.html");
    const browserCheck = function (cases) {
      const failures = cases.map(({ name, input, expected }) => {
        const actual = lmParseCaptionTrack(input);
        return JSON.stringify(actual) === JSON.stringify(expected) ? null : { name, expected, actual };
      }).filter(Boolean);
      document.title = "LM_CAPTIONS_RESULT:" + btoa(unescape(encodeURIComponent(JSON.stringify({ count: cases.length, failures }))));
    };
    const script = `${source}\n(${browserCheck})(${JSON.stringify(xmlCases).replace(/</g, "\\u003c")});`;
    fs.writeFileSync(fixture, `<!doctype html><title>pending</title><script>${script}</script>`, "utf8");
    const output = execFileSync(chrome, ["--headless", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${path.join(directory, "profile")}`, "--dump-dom", pathToFileURL(fixture).href], { encoding: "utf8", timeout: 35000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const encoded = output.match(/<title>LM_CAPTIONS_RESULT:([^<]+)<\/title>/)?.[1];
    assert.ok(encoded, `Chrome did not finish caption fixtures: ${output.slice(0, 500)}`);
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.count, xmlCases.length);
    assert.deepEqual(result.failures, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
