/*
 * docbuild.js — turn extracted blocks (+ fetched images) into a docx Document.
 *
 * The `docx` library and the image bytes are injected, so this file has no
 * environment assumptions and runs the same in the offscreen document and in
 * the Node test.
 *
 * buildDocument({ title, siteName, sourceUrl, blocks, images }, docx) -> Document
 *   images: { [src]: { data:Uint8Array, width, height, type:"png"|"jpg"|"gif"|"bmp" } }
 *
 * Packing to bytes/base64 is left to the caller (Packer.toBuffer in Node,
 * Packer.toBlob in the browser) because those differ per environment.
 */
(function (root) {
  "use strict";

  const MAX_IMG_WIDTH = 480; // px, keeps images inside the page margins

  function runsToChildren(runs, docx) {
    const { TextRun, ExternalHyperlink } = docx;
    const out = [];
    for (const r of runs || []) {
      if (r.break) {
        out.push(new TextRun({ break: 1 }));
        continue;
      }
      const text = r.text || "";
      if (!text) continue;
      if (r.href) {
        out.push(
          new ExternalHyperlink({
            link: r.href,
            children: [new TextRun({ text, style: "Hyperlink" })],
          })
        );
      } else {
        out.push(new TextRun({ text, bold: !!r.bold, italics: !!r.italic }));
      }
    }
    if (out.length === 0) out.push(new TextRun({ text: "" }));
    return out;
  }

  function scaled(w, h) {
    if (!w || !h) return { width: MAX_IMG_WIDTH, height: Math.round(MAX_IMG_WIDTH * 0.66) };
    if (w <= MAX_IMG_WIDTH) return { width: w, height: h };
    const ratio = MAX_IMG_WIDTH / w;
    return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
  }

  /*
   * Render body blocks into docx paragraphs.
   * `offset` shifts every heading down a level so a combined document keeps a
   * single hierarchy (article titles sit above the headings found inside them).
   */
  function blocksToChildren(blocks, images, docx, offset) {
    const { Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType, BorderStyle } = docx;
    const children = [];
    for (const b of blocks || []) {
      if (b.type === "heading") {
        const lvl =
          [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][
            Math.min(Math.max((b.level || 1) + (offset || 0), 1), 4) - 1
          ];
        children.push(new Paragraph({ heading: lvl, children: runsToChildren(b.runs, docx) }));
      } else if (b.type === "para") {
        children.push(new Paragraph({ children: runsToChildren(b.runs, docx), spacing: { after: 120 } }));
      } else if (b.type === "quote") {
        children.push(
          new Paragraph({
            children: runsToChildren(b.runs, docx),
            indent: { left: 480 },
            border: { left: { color: "AAAAAA", space: 12, style: BorderStyle.SINGLE, size: 12 } },
            spacing: { after: 120 },
          })
        );
      } else if (b.type === "code") {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: b.text, font: "Consolas", size: 18 })],
            shading: { fill: "F2F2F2" },
            spacing: { after: 120 },
          })
        );
      } else if (b.type === "list") {
        b.items.forEach((item, idx) => {
          if (b.ordered) {
            const kids = runsToChildren(item, docx);
            kids.unshift(new TextRun({ text: `${idx + 1}. `, bold: true }));
            children.push(new Paragraph({ children: kids, indent: { left: 360 }, spacing: { after: 40 } }));
          } else {
            children.push(
              new Paragraph({ children: runsToChildren(item, docx), bullet: { level: 0 }, spacing: { after: 40 } })
            );
          }
        });
      } else if (b.type === "image") {
        const img = (images || {})[b.src];
        if (img && img.data) {
          const dim = scaled(img.width, img.height);
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 120 },
              children: [new ImageRun({ data: img.data, type: img.type || "png", transformation: dim })],
            })
          );
          if (b.alt) {
            children.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 160 },
                children: [new TextRun({ text: b.alt, italics: true, size: 18, color: "888888" })],
              })
            );
          }
        }
      }
    }
    return children;
  }

  // The gray "Source / Date saved / Site" strip under a title.
  function metaParagraph(article, docx) {
    const { Paragraph, TextRun, BorderStyle } = docx;
    const metaLines = [`Source: ${article.sourceUrl || ""}`, `Date saved: ${article.dateSaved || ""}`];
    if (article.siteName) metaLines.push(`Site: ${article.siteName}`);
    const metaRuns = [];
    metaLines.forEach((line, i) => {
      if (i > 0) metaRuns.push(new TextRun({ break: 1, text: "", size: 18, color: "888888" }));
      metaRuns.push(new TextRun({ text: line, size: 18, color: "888888" }));
    });
    return new Paragraph({
      children: metaRuns,
      spacing: { after: 200 },
      border: { bottom: { color: "CCCCCC", space: 6, style: BorderStyle.SINGLE, size: 6 } },
    });
  }

  // Shared document options — East-Asian font fallback so Korean renders
  // (mirrors the video-transcriber docgen).
  function documentOptions(title, children) {
    return {
      creator: "Website to Word",
      title: title || "Untitled",
      description: "Saved from the web by Website to Word",
      styles: {
        default: {
          document: { run: { font: { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Malgun Gothic" }, size: 22 } },
        },
      },
      sections: [{ properties: {}, children }],
    };
  }

  function buildDocument(article, docx) {
    const {
      Document,
      Paragraph,
      TextRun,
      HeadingLevel,
    } = docx;

    const images = article.images || {};
    const children = [];

    // --- Title ---------------------------------------------------------
    children.push(
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: article.title || "Untitled" })] })
    );

    // --- Gray metadata line --------------------------------------------
    children.push(metaParagraph(article, docx));

    // --- Body ----------------------------------------------------------
    children.push.apply(children, blocksToChildren(article.blocks, images, docx, 0));

    return new Document(documentOptions(article.title, children));
  }

  /*
   * buildCombinedDocument(bundle, docx) -> Document
   *
   * bundle = { title, sourceUrl, dateSaved, siteName, sections: [{ article, depth }] }
   * depth 0 = a page you picked, depth 1 = a source it cites.
   *
   * Cover page, then a clickable contents list, then each article on a fresh
   * page with its sources following it. The contents uses real bookmarks and
   * internal hyperlinks rather than a TOC field: a TOC field makes Word prompt
   * "update fields?" every time the document is opened.
   */
  function buildCombinedDocument(bundle, docx) {
    const { Document, Paragraph, TextRun, HeadingLevel, Bookmark, InternalHyperlink, PageBreak } = docx;
    const sections = bundle.sections || [];
    const children = [];

    // --- Cover ---------------------------------------------------------
    children.push(
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: bundle.title || "Untitled" })] })
    );
    children.push(metaParagraph(bundle, docx));
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: `${sections.length} document${sections.length === 1 ? "" : "s"}`,
            size: 18,
            color: "888888",
          }),
        ],
      })
    );

    // --- Contents ------------------------------------------------------
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Contents" })] }));
    sections.forEach((s, i) => {
      const title = (s.article && s.article.title) || `Document ${i + 1}`;
      children.push(
        new Paragraph({
          spacing: { after: 40 },
          indent: s.depth ? { left: 360 } : undefined,
          children: [
            new InternalHyperlink({
              anchor: `wtw_sec_${i}`,
              children: [new TextRun({ text: `${s.depth ? "" : `${sections.slice(0, i + 1).filter((x) => !x.depth).length}. `}${title}`, style: "Hyperlink" })],
            }),
          ],
        })
      );
    });

    // --- Sections ------------------------------------------------------
    sections.forEach((s, i) => {
      const article = s.article || {};
      const title = article.title || `Document ${i + 1}`;
      children.push(
        new Paragraph({
          heading: s.depth ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
          pageBreakBefore: true,
          children: [new Bookmark({ id: `wtw_sec_${i}`, children: [new TextRun({ text: title })] })],
        })
      );
      if (article.sourceUrl) {
        children.push(
          new Paragraph({
            spacing: { after: 160 },
            children: [new TextRun({ text: `Source: ${article.sourceUrl}`, size: 18, color: "888888" })],
          })
        );
      }
      children.push.apply(children, blocksToChildren(article.blocks, article.images || {}, docx, 1));
    });

    return new Document(documentOptions(bundle.title, children));
  }

  const api = { buildDocument, buildCombinedDocument, blocksToChildren };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.WTW = Object.assign(root.WTW || {}, api);
  }
})(typeof self !== "undefined" ? self : this);
