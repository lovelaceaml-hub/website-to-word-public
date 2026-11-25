/*
 * pdfbuild.js — turn extracted blocks into a pdfmake document definition.
 *
 * Only the definition is built here; packing it into bytes needs the pdfmake
 * library and a browser, so the caller does that (offscreen.js). Keeping this
 * file pure means the Node test can assert the document's structure without
 * rendering a PDF.
 *
 *   buildPdfDef(article)         -> docDefinition   (one article)
 *   buildCombinedPdfDef(bundle)  -> docDefinition   (cover + contents + sections)
 *
 * KNOWN LIMIT: pdfmake ships Roboto only, which has no Korean/Chinese/Japanese
 * glyphs. CJK text renders blank in PDF — use the Word export for those pages.
 * docbuild.js sets an East-Asian font, so Word is unaffected.
 */
(function (root) {
  "use strict";

  const MAX_IMG_WIDTH = 460; // points, keeps images inside A4 margins
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  const STYLES = {
    title: { fontSize: 22, bold: true, margin: [0, 0, 0, 8] },
    h1: { fontSize: 16, bold: true, margin: [0, 12, 0, 5] },
    h2: { fontSize: 14, bold: true, margin: [0, 10, 0, 4] },
    h3: { fontSize: 12, bold: true, margin: [0, 8, 0, 3] },
    h4: { fontSize: 11, bold: true, margin: [0, 6, 0, 3] },
    meta: { fontSize: 8, color: "#888888", margin: [0, 0, 0, 10] },
    quote: { italics: true, color: "#444444", margin: [20, 0, 0, 6] },
    code: { fontSize: 8, color: "#333333", margin: [0, 0, 0, 6], preserveLeadingSpaces: true },
    caption: { fontSize: 8, italics: true, color: "#888888", alignment: "center", margin: [0, 2, 0, 8] },
    link: { color: "#1155cc", decoration: "underline" },
  };

  function runsToText(runs) {
    const out = [];
    for (const r of runs || []) {
      if (r.break) {
        out.push({ text: "\n" });
        continue;
      }
      const text = r.text || "";
      if (!text) continue;
      const piece = { text };
      if (r.bold) piece.bold = true;
      if (r.italic) piece.italics = true;
      if (r.href) {
        piece.link = r.href;
        piece.color = "#1155cc";
        piece.decoration = "underline";
      }
      out.push(piece);
    }
    return out.length ? out : [{ text: "" }];
  }

  const HEADING_STYLE = ["h1", "h2", "h3", "h4"];

  function blocksToContent(blocks, images, offset) {
    const content = [];
    for (const b of blocks || []) {
      if (b.type === "heading") {
        const lvl = Math.min(Math.max((b.level || 1) + (offset || 0), 1), 4);
        content.push({ text: runsToText(b.runs), style: HEADING_STYLE[lvl - 1] });
      } else if (b.type === "para") {
        content.push({ text: runsToText(b.runs), margin: [0, 0, 0, 6] });
      } else if (b.type === "quote") {
        content.push({ text: runsToText(b.runs), style: "quote" });
      } else if (b.type === "code") {
        content.push({ text: String(b.text || ""), style: "code" });
      } else if (b.type === "list") {
        const items = (b.items || []).map((item) => ({ text: runsToText(item) }));
        if (items.length) content.push(Object.assign({ margin: [0, 0, 0, 6] }, b.ordered ? { ol: items } : { ul: items }));
      } else if (b.type === "image") {
        const img = images && images[b.src];
        // pdfmake needs the bytes as a data URI; the caller attaches it.
        if (img && img.dataUri) {
          const width = img.width && img.width < MAX_IMG_WIDTH ? img.width : MAX_IMG_WIDTH;
          content.push({ image: img.dataUri, width, alignment: "center", margin: [0, 4, 0, 2] });
          if (b.alt) content.push({ text: b.alt, style: "caption" });
        }
      }
    }
    return content;
  }

  function metaBlock(article) {
    const lines = [];
    if (article.sourceUrl) lines.push(`Source: ${article.sourceUrl}`);
    if (article.dateSaved) lines.push(`Date saved: ${article.dateSaved}`);
    if (article.siteName) lines.push(`Site: ${article.siteName}`);
    return lines.length ? [{ text: lines.join("\n"), style: "meta" }] : [];
  }

  function baseDef(title) {
    return {
      info: { title: clean(title) || "Untitled", creator: "Website to Word", producer: "Website to Word" },
      pageSize: "LETTER",
      pageMargins: [56, 56, 56, 56],
      styles: STYLES,
      defaultStyle: { fontSize: 10, lineHeight: 1.25 },
    };
  }

  function buildPdfDef(article) {
    const def = baseDef(article.title);
    def.content = [{ text: clean(article.title) || "Untitled", style: "title" }]
      .concat(metaBlock(article))
      .concat(blocksToContent(article.blocks, article.images || {}, 0));
    return def;
  }

  /*
   * bundle = { title, sourceUrl, dateSaved, siteName, sections: [{ article, depth }] }
   * Cover page, then pdfmake's own table of contents (real page numbers), then
   * each article starting on a fresh page with its sources following it.
   */
  function buildCombinedPdfDef(bundle) {
    const def = baseDef(bundle.title);
    const sections = bundle.sections || [];

    const content = [{ text: clean(bundle.title) || "Untitled", style: "title", margin: [0, 160, 0, 8] }];
    content.push.apply(content, metaBlock(bundle));
    content.push({
      text: `${sections.length} document${sections.length === 1 ? "" : "s"}`,
      style: "meta",
      pageBreak: "after",
    });
    content.push({ toc: { title: { text: "Contents", style: "h1" } }, pageBreak: "after" });

    sections.forEach((s, i) => {
      const title = clean(s.article.title) || `Document ${i + 1}`;
      content.push({
        text: title,
        style: s.depth ? "h2" : "h1",
        tocItem: true,
        tocMargin: [s.depth ? 16 : 0, 0, 0, 0],
        pageBreak: i === 0 ? undefined : "before",
      });
      if (s.article.sourceUrl) content.push({ text: s.article.sourceUrl, style: "meta" });
      content.push.apply(content, blocksToContent(s.article.blocks, s.article.images || {}, 1));
    });

    def.content = content;
    return def;
  }

  const api = { buildPdfDef, buildCombinedPdfDef, runsToText, STYLES };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.WTW = Object.assign(root.WTW || {}, api);
  }
})(typeof self !== "undefined" ? self : this);
