// One dictionary body for YouTube and Prime. All asynchronous work belongs to
// the rendered body, never to a global "current word".
var lmWordCard = (() => {
  const escape = (value) => String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const posNames = { noun: "名词", verb: "动词", adjective: "形容词", adverb: "副词", pronoun: "代词", preposition: "介词", conjunction: "连词", interjection: "感叹词", determiner: "限定词", "phrasal verb": "短语动词", idiom: "习语" };
  const flatten = (data) => (data.entries || []).flatMap((entry) => (entry.items || []).map((item) => ({ ...item, pos: entry.pos, posLabel: entry.posLabel, headword: entry.headword, reading: entry.reading, contextEligible: entry.contextEligible })));
  const stop = new Set("a an the of to in on at for with from as by and or but if it its this that these those i you he she we they me him her us them my your his our their be am is are was were been being do does did have has had can could will would shall should may might must not so very also into out up down over under one some any something someone person thing make get take use go come give put say tell used using usually especially such often".split(" "));
  function words(value) {
    const tokens = (String(value || "").toLowerCase().match(/[a-z]{3,}/g) || []).map((word) => word.length > 4 ? word.replace(/s$/, "") : word);
    if (/\b(?:hours?|minutes?|seconds?|days?|weeks?|months?|years?)\b/i.test(value)) tokens.push("time");
    return new Set(tokens.filter((word) => !stop.has(word) && !/^(?:two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)$/.test(word)));
  }
  // This is evidence-based lexical matching, not an AI claim about meaning.
  // Show candidates only when the sentence actually shares content words with
  // a definition/example. Keep all dictionary alternatives in source order.
  function contextMatches(items, context, excluded = "") {
    const keys = words(context), ignore = words(excluded);
    ignore.forEach((word) => keys.delete(word));
    const scored = items.map((item, index) => {
      const definition = words(`${item.definition} ${item.usage || ""}`), example = words(item.example);
      const hits = item.contextEligible === false ? [] : [...keys].filter((word) => definition.has(word) || example.has(word));
      const score = hits.reduce((sum, word) => sum + (definition.has(word) ? 2 : 1), 0);
      const clauses = String(item.definition || "").split(/;\s*/);
      const matchedClauses = clauses.filter((clause) => hits.some((hit) => words(clause).has(hit)));
      return { index, score, hits, excerpt: matchedClauses.length ? matchedClauses.join("; ") : item.definition };
    }).filter((item) => item.score >= 2 && item.hits.length > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    // A single ubiquitous word matching many unrelated senses is not useful.
    if (scored.length > 3 && scored[0].score === scored[3].score) return [];
    return scored.slice(0, 2);
  }
  function highlight(context, word) {
    const index = context.toLocaleLowerCase().indexOf(String(word || "").toLocaleLowerCase());
    if (index < 0 || !word) return escape(context);
    return escape(context.slice(0, index)) + "<mark>" + escape(context.slice(index, index + word.length)) + "</mark>" + escape(context.slice(index + word.length));
  }
  function html(data, context, from) {
    const japanese = /^ja(?:-|$)/i.test(from);
    const headword = data.dictionaryHeadword || data.word;
    const query = encodeURIComponent(headword || "");
    const links = japanese
      ? [["Jisho", `https://jisho.org/search/${query}`], ["Weblio 日语辞典", `https://www.weblio.jp/content/${query}`]]
      : [["Cambridge", `https://dictionary.cambridge.org/dictionary/english/${query}`], ["Wiktionary", `https://en.wiktionary.org/wiki/${query}`]];
    return `<section class="lm-word-card">
      <section class="lm-card-context"><div class="lm-card-label">本句参考</div>
        <div class="lm-dict-context">${context ? highlight(context, data.word) : "没有原句。划选字幕中的完整词组，可以查询搭配和习语。"}</div>
        ${context ? '<div class="lm-context-translation" aria-live="polite">正在翻译原句…</div><button type="button" class="lm-card-retry" hidden>重试原句翻译</button><div class="lm-card-muted">整句机器翻译，供判断语境；不等于已确定这个词的含义。</div>' : ""}
      </section>
      <section class="lm-card-context-senses" hidden></section>
      ${(data.englishForms || []).length ? `<div class="lm-card-forms">词典原形参考：${data.englishForms.map((form) => `${escape(form.surface)} → ${escape(form.lemma)}`).join("；")}</div>` : ""}
      <div class="lm-card-label lm-senses-title"></div><div class="lm-card-senses"></div>
      <button type="button" class="lm-card-more" hidden></button>
      <div class="lm-card-gloss-status" role="status"></div><button type="button" class="lm-card-gloss-retry" hidden>重试释义翻译</button>
      <div class="lm-card-choice-status" role="status"></div>
      ${data.dictionarySource ? `<div class="lm-def">词典：${escape(data.dictionarySource)}${data.dictionaryDate ? ` · ${escape(data.dictionaryDate)}` : ""}</div>` : ""}
      ${data.translationSource ? `<div class="lm-def">译文来源：${escape(data.translationSource)}</div>` : ""}
      ${data.lookupNotice ? `<p class="lm-ja-note">${escape(data.lookupNotice)}</p>` : ""}
      <div class="lm-card-links">核对词典：${links.map(([label, url]) => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`).join(" · ")}</div>
      <form class="lm-card-query"><label>查完整词组／校正查询<input aria-label="查完整词组或校正查询" maxlength="200" value="${escape(data.word)}"></label><button type="submit">查询</button></form>
    </section>`;
  }
  function bind(container, { data, context = "", from, to, send, isCurrent = () => true, onSaveMeaning, onQuery, onResize = () => {} }) {
    const root = container.querySelector(".lm-word-card");
    if (!root) return;
    const alive = () => root.isConnected && container.contains(root) && isCurrent();
    const items = flatten(data);
    let visible = 6, glossBusy = false, contextBusy = false, choiceBusy = false;
    const attempted = new Set();
    const sameLanguage = /^en(?:-|$)/i.test(to);
    const meanings = root.querySelector(".lm-card-senses");
    const more = root.querySelector(".lm-card-more");
    const glossStatus = root.querySelector(".lm-card-gloss-status");
    const glossRetry = root.querySelector(".lm-card-gloss-retry");
    const choiceStatus = root.querySelector(".lm-card-choice-status");
    const contextOutput = root.querySelector(".lm-context-translation");
    const contextRetry = root.querySelector(".lm-card-retry");
    const contextual = root.querySelector(".lm-card-context-senses");
    const contextChoices = new Map();
    async function showContextMatches(english) {
      const matches = contextMatches(items, english, `${data.word} ${data.dictionaryHeadword || ""} ${(data.englishForms || []).map((form) => form.lemma).join(" ")}`);
      if (!matches.length || !alive()) return;
      const choices = matches.map((match) => ({ ...match, definition: match.excerpt,
        gloss: match.excerpt === items[match.index].definition ? items[match.index].gloss : "" }));
      const pending = choices.filter((item) => !item.gloss && !sameLanguage);
      if (pending.length) {
        let response;
        try { response = await send("LM_GLOSS_TRANSLATE", { lines: pending.map((item) => item.definition), to }); } catch (_) {}
        if (!alive()) return;
        pending.forEach((item, i) => { if (response?.ok && response.glosses?.[i]) item.gloss = response.glosses[i]; });
      }
      contextual.hidden = false;
      choices.forEach((item) => contextChoices.set(item.index, item.gloss || item.definition));
      contextual.innerHTML = `<div class="lm-card-label">语境相关义项 · 待确认</div><div class="lm-card-muted">根据原句与词典中的词语匹配，供参考。</div>${choices.map(({ index, hits, gloss, definition }) => `<div class="lm-entry"><div class="lm-gloss">${escape(gloss || definition)}</div><div class="lm-def">原文释义片段：${escape(definition)}</div><div class="lm-card-muted">义项 ${index + 1} · 匹配线索：${escape(hits.join("、"))}</div><button type="button" data-save-sense="${index}" data-context-sense="true">收藏此义项</button></div>`).join("")}`;
      onResize();
    }
    function render() {
      root.querySelector(".lm-senses-title").textContent = items.length ? `词典义项 · ${items.length} 项` : "词语译文（未匹配到词典）";
      meanings.innerHTML = items.length ? items.slice(0, visible).map((item, index) => `<article class="lm-entry" data-sense="${index}">
        <div class="lm-pos" title="${escape(item.pos)}">${escape(item.posLabel || posNames[item.pos] || item.pos || "释义")}${item.headword && item.headword !== data.word ? ` · ${escape(item.headword)}` : ""}${item.reading ? ` · ${escape(item.reading)}` : ""}</div>
        <div class="lm-gloss">${index + 1}. ${escape(item.gloss || item.definition)}</div>
        ${item.gloss && item.gloss !== item.definition ? `<div class="lm-def">原文释义：${escape(item.definition)}</div>` : ""}
        ${item.usage ? `<div class="lm-def">用法：${escape(item.usage)}</div>` : ""}
        ${item.example ? `<div class="lm-ex">例：${escape(item.example)}</div><div class="lm-example-translation" aria-live="polite">${escape(item.exampleTranslation)}</div>${sameLanguage ? "" : `<button type="button" data-example="${index}">翻译例句</button>`}` : ""}
        ${(item.synonyms || []).length ? `<div class="lm-syn">近义：${escape(item.synonyms.join("、"))}</div>` : ""}
        <button type="button" class="lm-sense-save" data-save-sense="${index}" ${choiceBusy ? "disabled" : ""}>收藏此义项</button>
      </article>`).join("") : `<div class="lm-gloss">${escape(data.translation || "暂无译文。可核对原文或查询完整词组。")}</div>`;
      more.hidden = visible >= items.length;
      more.textContent = `更多义项（还有 ${Math.max(0, items.length - visible)} 项）`;
      onResize();
    }
    async function translateVisible() {
      if (glossBusy || sameLanguage || !alive()) return;
      const pending = items.slice(0, visible).filter((item) => !item.gloss && !attempted.has(item));
      if (!pending.length) return;
      glossBusy = true;
      glossRetry.hidden = true;
      glossStatus.textContent = "正在翻译释义，原文已可阅读…";
      // Keep batches small and sequential even when many sections are opened.
      for (let offset = 0; offset < pending.length && alive(); offset += 6) {
        const batch = pending.slice(offset, offset + 6);
        batch.forEach((item) => attempted.add(item));
        let response;
        try { response = await send("LM_GLOSS_TRANSLATE", { lines: batch.map((item) => item.definition), to }); } catch (_) {}
        if (!alive()) { glossBusy = false; return; }
        batch.forEach((item, index) => { if (response?.ok && response.glosses?.[index]) item.gloss = response.glosses[index]; });
        if (items[0]?.gloss) {
          data.translation = items[0].gloss;
          const summary = container.querySelector(".lm-dict-trans");
          if (summary) summary.textContent = data.translation;
        }
        // Patch only translated fields. Replacing the list while the user is
        // clicking a sense/example would move controls under their pointer.
        batch.forEach((item) => {
          const index = items.indexOf(item), article = meanings.querySelector(`[data-sense="${index}"]`);
          if (!article || !item.gloss) return;
          article.querySelector(".lm-gloss").textContent = `${index + 1}. ${item.gloss}`;
          if (item.gloss !== item.definition) {
            const original = document.createElement("div"); original.className = "lm-def";
            original.textContent = `原文释义：${item.definition}`;
            article.querySelector(".lm-gloss").after(original);
          }
        });
      }
      glossBusy = false;
      const missing = items.slice(0, visible).some((item) => !item.gloss);
      glossStatus.textContent = missing ? "部分释义翻译暂不可用，已保留词典原文。" : "";
      glossRetry.hidden = !missing;
      onResize();
      if (items.slice(0, visible).some((item) => !item.gloss && !attempted.has(item))) translateVisible();
    }
    async function translateContext() {
      if (!contextOutput || contextBusy || !alive()) return;
      contextBusy = true; contextRetry.hidden = true;
      contextOutput.textContent = "正在翻译原句…";
      const englishContext = /^en(?:-|$)/i.test(from) ? Promise.resolve(context)
        : /^en(?:-|$)/i.test(to) ? null
        : send("LM_TRANSLATE", { text: context, from, to: "en" }).then((response) => response?.ok ? response.result?.text || "" : "").catch(() => "");
      let response;
      try { response = await send("LM_TRANSLATE", { text: context, from, to }); } catch (_) {}
      if (!alive()) return;
      contextBusy = false;
      const translated = response?.ok && response.result?.text;
      contextOutput.textContent = translated || "原句翻译暂不可用，仍可阅读和收藏词典义项。";
      contextRetry.hidden = Boolean(translated);
      onResize();
      showContextMatches(englishContext ? await englishContext : translated || "");
    }
    more.addEventListener("click", () => { visible += 6; render(); translateVisible(); });
    glossRetry.addEventListener("click", () => { attempted.clear(); translateVisible(); });
    contextRetry?.addEventListener("click", translateContext);
    root.addEventListener("click", async (event) => {
      const save = event.target.closest("[data-save-sense]");
      if (save && !choiceBusy && alive()) {
        choiceBusy = true;
        const item = items[Number(save.dataset.saveSense)];
        root.querySelectorAll("[data-save-sense]").forEach((button) => { button.disabled = true; });
        choiceStatus.textContent = "正在保存所选义项…";
        let success = false;
        const meaning = save.dataset.contextSense ? contextChoices.get(Number(save.dataset.saveSense)) : item.gloss || item.definition;
        try { success = await onSaveMeaning?.(meaning); } catch (_) {}
        if (!alive()) return;
        choiceBusy = false;
        root.querySelectorAll("[data-save-sense]").forEach((button) => { button.disabled = false; });
        choiceStatus.textContent = success ? "已将此义项保存到生词本" : "保存失败，请重试";
        return;
      }
      const button = event.target.closest("[data-example]");
      if (!button || button.disabled || !alive()) return;
      const exampleIndex = Number(button.dataset.example);
      const item = items[exampleIndex];
      const output = button.parentElement.querySelector(".lm-example-translation");
      button.disabled = true; output.textContent = "正在翻译例句…";
      let response;
      try { response = await send("LM_TRANSLATE", { text: item.example, from: "en", to }); } catch (_) {}
      if (!alive()) return;
      item.exampleTranslation = response?.ok ? response.result?.text || "" : "";
      // Expanding more meanings can recreate this article while its example
      // request is in flight. Update the current article, not a detached node.
      const currentButton = meanings.querySelector(`[data-example="${exampleIndex}"]`);
      if (currentButton) {
        currentButton.parentElement.querySelector(".lm-example-translation").textContent = item.exampleTranslation || "例句翻译失败，请重试";
        currentButton.disabled = false;
        currentButton.textContent = item.exampleTranslation ? "重新翻译例句" : "重试例句翻译";
      }
      onResize();
    });
    root.querySelector(".lm-card-query").addEventListener("submit", (event) => {
      event.preventDefault();
      const query = event.currentTarget.querySelector("input").value.trim();
      if (query && query.length <= 200 && alive()) onQuery?.(query);
    });
    render(); translateVisible(); translateContext();
    return { get items() { return items; } };
  }
  return { html, bind, flatten, highlight, contextMatches };
})();
