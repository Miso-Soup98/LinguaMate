// Small, page-local lookup cache. Context and morphology are part of identity;
// a different sentence must never inherit the previous sentence's analysis.
function lmCreateDictSession(send) {
  const values = new Map(), pending = new Map();
  const keyOf = (query) => JSON.stringify([query.word, query.from, query.to, query.context || "", query.isPhrase === true, query.japanese || null]);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function peek(query) {
    const key = keyOf(query), item = values.get(key);
    if (!item) return null;
    if (Date.now() - item.at > 300000) { values.delete(key); return null; }
    values.delete(key); values.set(key, item);
    return clone(item.response);
  }
  async function lookup(query) {
    const cached = peek(query);
    if (cached) return cached;
    const key = keyOf(query);
    if (!pending.has(key)) {
      const work = Promise.resolve(send("LM_LOOKUP", query)).then((response) => {
        if (response?.ok && response.result && (response.result.entries?.length || response.result.translation)) {
          values.set(key, { response: clone(response), at: Date.now() });
          if (values.size > 80) values.delete(values.keys().next().value);
        }
        return response;
      }).finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return clone(await pending.get(key));
  }
  return { peek, lookup };
}

// Choose a side before the loading placeholder is painted. Keep the edge next
// to the word fixed as definitions grow, so the card never flips across a line.
function lmPlaceDictionary(card, anchor, viewport, reset = false) {
  if (!card || !anchor) return;
  const word = anchor.getBoundingClientRect();
  const gap = 6, margin = 8;
  const below = Math.max(0, viewport.height - word.bottom - gap - margin);
  const above = Math.max(0, word.top - gap - margin);
  const preferred = Math.min(560, viewport.height * .72);
  if (reset || card.dataset.anchorSide === undefined) card.dataset.anchorSide = below >= preferred || below >= above ? "below" : "above";
  let side = card.dataset.anchorSide;
  // If the page layout moved the anchor to an edge, recover usable space.
  if ((side === "below" ? below : above) < 100 && (side === "below" ? above : below) > 160) side = card.dataset.anchorSide = side === "below" ? "above" : "below";
  const available = side === "below" ? below : above;
  card.style.maxHeight = `${Math.max(0, Math.min(preferred, available))}px`;
  const width = card.getBoundingClientRect().width || Math.min(420, viewport.width - 16);
  card.style.left = `${Math.round(Math.max(margin, Math.min(word.left, viewport.width - width - margin)))}px`;
  card.style.top = side === "below" ? `${Math.round(word.bottom + gap)}px` : "auto";
  card.style.bottom = side === "above" ? `${Math.round(viewport.height - word.top + gap)}px` : "auto";
}
