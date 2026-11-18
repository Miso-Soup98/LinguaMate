import { pipeline, env } from "../vendor/audio-asr/transformers.mjs";
import * as ort from "../vendor/audio-asr/ort.wasm.min.mjs";

const runtime = new URL("../vendor/audio-asr/", import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: runtime + "ort-wasm-simd-threaded.mjs", wasm: runtime + "ort-wasm-simd-threaded.wasm" };
env.allowLocalModels = false;
env.useBrowserCache = true;
const kanaRoot = "https://huggingface.co/shrippen/kaiwa-kana-ctc/resolve/99dd836ea672ee18abc88c7d6bb54fbbd187835b/";
let whisper, kanaSession, symbols;
const modelBytes = 356148324;
const status = message => self.postMessage({ status: message });

async function asset(file, expectedSize) {
  const url = kanaRoot + file;
  const cache = await caches.open("lm-kana-ctc-v2");
  const cached = await cache.match(url);
  if (cached) {
    const data = await cached.arrayBuffer();
    if (!expectedSize || data.byteLength === expectedSize) return data;
    await cache.delete(url);
  }
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error("模型下载失败：" + response.status);
  if (!expectedSize) {
    const data = await response.arrayBuffer();
    JSON.parse(new TextDecoder().decode(data));
    await cache.put(url, new Response(data)).catch(() => {});
    return data;
  }
  const data = new Uint8Array(expectedSize);
  const reader = response.body.getReader();
  let offset = 0, lastPercent = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > expectedSize) {
      await reader.cancel();
      throw new Error("假名模型大小异常");
    }
    data.set(value, offset);
    offset += value.length;
    const percent = Math.floor(100 * offset / expectedSize);
    if (percent !== lastPercent) status("正在下载假名模型 " + percent + "%");
    lastPercent = percent;
  }
  if (offset !== expectedSize) throw new Error("假名模型下载不完整，请重试");
  await cache.put(url, new Response(data)).catch(() => {});
  return data.buffer;
}

async function recognizeKana(samples) {
  if (!kanaSession) {
    const vocab = JSON.parse(new TextDecoder().decode(await asset("vocab.json")));
    symbols = Object.fromEntries(Object.entries(vocab).map(([key, id]) => [id, key]));
    const model = await asset("model.int8.onnx", modelBytes);
    status("正在启动假名模型…");
    kanaSession = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  }
  status("正在识别本句实际读音…");
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length + 1e-7);
  const tensor = new ort.Tensor("float32", samples.map(v => (v - mean) / sd), [1, samples.length]);
  const outputs = await kanaSession.run({ [kanaSession.inputNames[0]]: tensor });
  const logits = outputs[kanaSession.outputNames[0]];
  const [, frames, size] = logits.dims;
  let previous = -1, kana = "", peak = 0, minimum = 1;
  for (let f = 0; f < frames; f++) {
    const offset = f * size;
    let best = 0;
    for (let k = 1; k < size; k++) {
      if (logits.data[offset+k] > logits.data[offset+best]) best = k;
    }
    if (best !== previous) {
      if (previous > 2) minimum = Math.min(minimum, peak);
      peak = 0;
      if (best > 2) kana += symbols[best] || "";
    }
    if (best > 2) {
      const maximum = logits.data[offset+best];
      let total = 0;
      for (let k = 0; k < size; k++) total += Math.exp(logits.data[offset+k] - maximum);
      peak = Math.max(peak, 1 / total);
    }
    previous = best;
  }
  if (previous > 2) minimum = Math.min(minimum, peak);
  tensor.dispose();
  for (const output of Object.values(outputs)) output.dispose();
  return { kana, confidentKana: kana.length >= 3 && minimum >= .90 };
}
self.onmessage = async ({ data: { samples } }) => {
  try {
    if (!(samples instanceof Float32Array) || samples.length < 3200 || samples.length > 304000) throw new Error("本句音频长度不受支持");
    self.postMessage({ status: "正在准备本地听写模型…" });
    const reported = new Map();
    whisper ||= await pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
      progress_callback: event => {
        if (event.status === "progress" && Number.isFinite(event.progress)) {
          const percent = Math.floor(event.progress / 5) * 5;
          if (reported.get(event.file) !== percent) status("正在下载听写模型 " + event.file + " " + percent + "%");
          reported.set(event.file, percent);
        }
      },
      revision: "64da57285918e20ea79ea5c88eed7197933abaa8", device: "wasm", dtype: "q8"
    });
    self.postMessage({ status: "正在听写日语原文…" });
    const { text } = await whisper(samples, { language: "japanese", task: "transcribe", max_new_tokens: 112, do_sample: false });
    self.postMessage({ status: "正在读取原声假名（首次需下载模型）…" });
    try {
      const reading = await recognizeKana(samples);
      self.postMessage({ text: text.trim(), ...reading });
    } catch (error) {
      if (!text.trim()) throw error;
      self.postMessage({ text: text.trim(), kana: "", kanaError: "假名识别失败，可重试：" + error.message });
    }
  } catch (error) { self.postMessage({ error: "本地识别失败（可重试）：" + error.message }); }
};
