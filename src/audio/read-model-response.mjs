// Fetch exposes decoded bytes. A compressed response's length describes
// the wire representation, so it cannot be used for percentage progress.
export async function readModelResponse(response, report) {
  const length = Number(response.headers.get("Content-Length"));
  const encoding = response.headers.get("Content-Encoding");
  let total = Number.isSafeInteger(length) && length > 0 && (!encoding || encoding === "identity") ? length : null;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total && loaded > total) total = null;
      report({ loaded, total, progress: total ? Math.min(99, 100 * loaded / total) : null });
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  report({ loaded, total: loaded, progress: 100 });
  return data;
}
