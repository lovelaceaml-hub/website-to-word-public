/*
 * extract.js — turn an article DOM into a plain list of "blocks".
 *
 * A block is one of:
 *   { type:"heading", level:1..4, runs }
 *   { type:"para",  runs }
 *   { type:"quote", runs }
 *   { type:"list",  ordered:bool, items:[runs, ...] }
 *   { type:"code",  text }
 *   { type:"image", src, alt }
 * where `runs` = [{ text, bold?, italic?, href?, break? }, ...].
 *
 * This is pure DOM -> JSON: no fetching, no docx. That makes it identical in
 * the offscreen document and in the Node offline test (jsdom), and easy to
 * eyeball. Image bytes are fetched later by whoever builds the document.
 *
 * deps: { Readability, makeDoc }  where makeDoc(htmlString) -> Document.
 */
(function (root) {
  "use strict";

  const WTW = root.WTW || (typeof require === "function" ? require("./adapters.js") : {});
  const abs = WTW.abs || ((h, b) => { try { return new URL(h, b).href; } catch { return h; } });
  const clean = WTW.clean || ((t) => (t || "").replace(/\s+/g, " ").trim());
  // Handles private link schemes (e.g. WebCenter's `ddocname:`) then falls
  // back to ordinary relative-URL resolution.
  const resolveHref = WTW.resolveHref || abs;

  const INLINE_SKIP = new Set(["script", "style"]);

  function imgSrc(img) {
    // Handle common lazy-load attributes.
    return (
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") ||
      ""
    );
  }

  // Walk inline content of `el`, producing styled runs.
  function inlineRuns(el, baseUrl) {
    const runs = [];
    function rec(node, ctx) {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const text = child.nodeValue;
          if (text && text.trim()) {
            runs.push(Object.assign({ text: text.replace(/\s+/g, " ") }, ctx));
          } else if (text && runs.length) {
            // A space between two tags ("<b>a</b> <i>b</i>") still separates words.
            const prev = runs[runs.length - 1];
            if (!prev.break && !/\s$/.test(prev.text)) runs.push({ text: " " });
          }
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toLowerCase();
        if (INLINE_SKIP.has(tag)) continue;
        if (tag === "br") {
          runs.push({ text: "", break: true });
        } else if (tag === "b" || tag === "strong") {
          rec(child, Object.assign({}, ctx, { bold: true }));
        } else if (tag === "i" || tag === "em") {
          rec(child, Object.assign({}, ctx, { italic: true }));
        } else if (tag === "a") {
          const href = child.getAttribute("href");
          const url = href ? resolveHref(href, baseUrl) : null;
          rec(child, Object.assign({}, ctx, url ? { href: url } : {}));
        } else {
          // span, sup, sub, small, u, mark, code, font, etc. — keep the text.
          rec(child, ctx);
        }
      }
    }
    rec(el, {});
    // Drop empties and the whitespace-only runs at either end; keep inner spaces.
    const kept = runs.filter((r) => r.break || r.text);
    const blank = (r) => r && !r.break && r.text.trim() === "";
    while (blank(kept[0])) kept.shift();
    while (blank(kept[kept.length - 1])) kept.pop();
    // ...and a lone space right next to a line break.
    return kept.filter((r, i) => !(blank(r) && ((kept[i - 1] || {}).break || (kept[i + 1] || {}).break)));
  }

  function collectImages(el, baseUrl) {
    return Array.from(el.querySelectorAll("img"))
      .map((img) => ({ type: "image", src: abs(imgSrc(img), baseUrl), alt: clean(img.getAttribute("alt")) }))
      .filter((b) => b.src && !/^data:/.test(b.src)); // skip inline data-URIs (usually spacers)
  }

  const BLOCK_HEADINGS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 4, h6: 4 };
  const CONTAINERS = new Set(["div", "section", "article", "main", "figure", "figcaption", "dl", "dd", "dt", "center"]);

  function walk(node, baseUrl, blocks, titleText) {
    for (const el of Array.from(node.children || [])) {
      const tag = el.tagName.toLowerCase();
      if (INLINE_SKIP.has(tag)) continue;

      if (BLOCK_HEADINGS[tag]) {
        const runs = inlineRuns(el, baseUrl);
        const text = runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim(); // runs carry their own spaces
        if (!text) continue;
        // Skip a heading that just repeats the document title.
        if (titleText && text.toLowerCase() === titleText.toLowerCase()) continue;
        blocks.push({ type: "heading", level: BLOCK_HEADINGS[tag], runs });
      } else if (tag === "p") {
        for (const img of collectImages(el, baseUrl)) blocks.push(img);
        const runs = inlineRuns(el, baseUrl);
        if (runs.length) blocks.push({ type: "para", runs });
      } else if (tag === "ul" || tag === "ol") {
        const ordered = tag === "ol";
        const items = Array.from(el.children)
          .filter((li) => li.tagName.toLowerCase() === "li")
          .map((li) => inlineRuns(li, baseUrl))
          .filter((r) => r.length);
        if (items.length) blocks.push({ type: "list", ordered, items });
      } else if (tag === "blockquote") {
        const runs = inlineRuns(el, baseUrl);
        if (runs.length) blocks.push({ type: "quote", runs });
      } else if (tag === "pre" || tag === "code") {
        const text = el.textContent.replace(/\s+$/g, "");
        if (text.trim()) blocks.push({ type: "code", text });
      } else if (tag === "img") {
        for (const img of collectImages(el.parentElement === node ? wrap(el) : el, baseUrl)) blocks.push(img);
      } else if (tag === "table") {
        // Flatten a table into simple "cell — cell" paragraphs.
        for (const tr of Array.from(el.querySelectorAll("tr"))) {
          const cells = Array.from(tr.querySelectorAll("th,td")).map((c) => clean(c.textContent)).filter(Boolean);
          if (cells.length) blocks.push({ type: "para", runs: [{ text: cells.join("  —  ") }] });
        }
      } else if (tag === "figure") {
        for (const img of collectImages(el, baseUrl)) blocks.push(img);
        const cap = el.querySelector("figcaption");
        if (cap) {
          const runs = inlineRuns(cap, baseUrl);
          if (runs.length) blocks.push({ type: "para", runs });
        }
      } else if (tag === "a" && el.getAttribute("href")) {
        // A link standing alone as a block (<div><a>…</a></div>, common in
        // citation lists). inlineRuns only reads anchors it finds among an
        // element's children, so the href of the element itself is read here.
        const href = resolveHref(el.getAttribute("href"), baseUrl);
        const text = clean(el.textContent);
        if (text) blocks.push({ type: "para", runs: [Object.assign({ text }, href ? { href } : {})] });
      } else if (CONTAINERS.has(tag)) {
        walk(el, baseUrl, blocks, titleText); // recurse into wrappers
      } else if (clean(el.textContent).length > 0 && !el.querySelector("p,div,ul,ol,table,section")) {
        // A leaf element carrying text but not a known block — treat as a paragraph.
        const runs = inlineRuns(el, baseUrl);
        if (runs.length) blocks.push({ type: "para", runs });
      }
    }
  }

  // tiny helper so a lone <img> gets processed by collectImages
  function wrap(el) {
    return { querySelectorAll: (sel) => (sel === "img" ? [el] : []) };
  }

  /*
   * collectLinks(blocks) -> [{ url, title }] in the order they are cited.
   *
   * Reads hrefs straight off the extracted runs rather than re-querying the
   * DOM. That guarantees every link came from inside the article body — page
   * furniture never reaches the blocks — and gives citation order for free.
   * Consecutive runs sharing an href are one link (bold or italic inside an
   * anchor splits the text into several runs).
   */
  function collectLinks(blocks) {
    const out = [];
    let cur = null;
    function flush() {
      if (cur) {
        // Trailing sentence punctuation is part of the prose, not the title.
        const title = clean(cur.text).replace(/[\s,;:.]+$/, "");
        out.push({ url: cur.url, title: title || cur.url });
      }
      cur = null;
    }
    function scan(runs) {
      for (const r of runs || []) {
        if (r.href) {
          // Runs are joined with no separator: a run boundary comes from a tag
          // (<span>c</span>ritical), not from a word gap, and any real spacing
          // is already carried inside the run text.
          if (cur && cur.url === r.href) cur.text += r.text || "";
          else {
            flush();
            cur = { url: r.href, text: r.text || "" };
          }
        } else {
          flush();
        }
      }
      flush();
    }
    for (const b of blocks || []) {
      if (b.runs) scan(b.runs);
      if (b.items) for (const item of b.items) scan(item);
    }
    return out;
  }

  /*
   * extractContent(doc, adapter, baseUrl, deps)
   * -> { title, siteName, blocks, links }  (or throws if nothing usable found)
   */
  function extractContent(doc, adapter, baseUrl, deps) {
    deps = deps || {};
    let title =
      clean((doc.querySelector(adapter.titleSelector || "h1") || {}).textContent) ||
      clean((doc.querySelector("title") || {}).textContent);

    // An adapter may compute its root when no selector can name it.
    let root = null;
    if (typeof adapter.contentRoot === "function") {
      try {
        root = adapter.contentRoot(doc, baseUrl) || null;
      } catch {
        root = null;
      }
    }
    if (!root && adapter.contentSelector) root = doc.querySelector(adapter.contentSelector);

    // Generic path (or the site's selector missed): fall back to Readability.
    if (!root && deps.Readability && deps.makeDoc) {
      try {
        const article = new deps.Readability(doc.cloneNode(true)).parse();
        if (article && article.content) {
          if (article.title) title = clean(article.title) || title;
          const frag = deps.makeDoc(article.content);
          root = frag.body || frag.documentElement || frag;
        }
      } catch {
        /* fall through */
      }
    }
    if (!root) root = doc.body || doc.documentElement;

    // Remove noise per the adapter's strip list.
    if (adapter.strip && adapter.strip.length) {
      root.querySelectorAll(adapter.strip.join(",")).forEach((n) => n.remove());
    }

    const blocks = [];
    walk(root, baseUrl, blocks, title);

    // If walking a wrapper produced nothing (unusual markup), grab paragraphs directly.
    if (blocks.length === 0) {
      root.querySelectorAll("p").forEach((p) => {
        const runs = inlineRuns(p, baseUrl);
        if (runs.length) blocks.push({ type: "para", runs });
      });
    }

    return { title: title || "Untitled", siteName: adapter.siteName, blocks, links: collectLinks(blocks) };
  }

  const api = { extractContent, inlineRuns, collectLinks };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.WTW = Object.assign(root.WTW || {}, api);
  }
})(typeof self !== "undefined" ? self : this);
