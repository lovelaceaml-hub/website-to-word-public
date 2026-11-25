/*
 * mdbuild.js — turn extracted blocks into Markdown text.
 *
 * Mirrors docbuild.js but produces a plain string, so it has no dependencies
 * at all and runs identically in the offscreen document and the Node test.
 *
 *   buildMarkdown(article)          -> string   (one article)
 *   buildCombinedMarkdown(bundle)   -> string   (cover + contents + sections)
 *
 * Images are referenced by their original URL rather than embedded — Markdown
 * has no container for bytes. The Word and PDF exports carry embedded copies.
 */
(function (root) {
  "use strict";

  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();

  // Escape only the characters that would change Markdown's meaning. Being
  // conservative keeps ordinary prose (underscores in ids, dots in "Pub. 100-02")
  // readable instead of littered with backslashes.
  function esc(text) {
    return String(text || "").replace(/([\\`*\[\]])/g, "\\$1");
  }

  function runsToMd(runs) {
    let out = "";
    for (const r of runs || []) {
      if (r.break) {
        out += "  \n";
        continue;
      }
      const text = r.text || "";
      if (!text) continue;
      let piece = esc(text);
      if (r.bold) piece = `**${piece}**`;
      if (r.italic) piece = `*${piece}*`;
      if (r.href) piece = `[${piece}](${r.href})`;
      out += piece;
    }
    return out.trim();
  }

  // GitHub-style anchor for the contents list in combined mode.
  function slug(text) {
    return clean(text)
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80);
  }

  /*
   * Render the body blocks. `offset` shifts every heading down a level so a
   * combined document keeps one heading hierarchy (article titles sit above
   * the headings that came from inside each article).
   */
  function blocksToMd(blocks, offset) {
    const lines = [];
    for (const b of blocks || []) {
      if (b.type === "heading") {
        const level = Math.min(Math.max((b.level || 1) + (offset || 0), 1), 6);
        const text = runsToMd(b.runs);
        if (text) lines.push("#".repeat(level) + " " + text, "");
      } else if (b.type === "para") {
        const text = runsToMd(b.runs);
        if (text) lines.push(text, "");
      } else if (b.type === "quote") {
        const text = runsToMd(b.runs);
        if (text) lines.push("> " + text.replace(/\n/g, "\n> "), "");
      } else if (b.type === "code") {
        lines.push("```", String(b.text || "").replace(/`{3,}/g, "``"), "```", "");
      } else if (b.type === "list") {
        (b.items || []).forEach((item, i) => {
          const text = runsToMd(item);
          if (text) lines.push((b.ordered ? `${i + 1}. ` : "- ") + text);
        });
        lines.push("");
      } else if (b.type === "image") {
        if (b.src) lines.push(`![${esc(b.alt || "")}](${b.src})`, "");
      }
    }
    return lines;
  }

  function metaLines(article) {
    const out = [];
    if (article.sourceUrl) out.push(`Source: <${article.sourceUrl}>`);
    if (article.dateSaved) out.push(`Date saved: ${article.dateSaved}`);
    if (article.siteName) out.push(`Site: ${article.siteName}`);
    return out.length ? [out.map((l) => `*${l}*`).join("  \n"), ""] : [];
  }

  function buildMarkdown(article) {
    const lines = [`# ${clean(article.title) || "Untitled"}`, ""];
    lines.push(...metaLines(article));
    lines.push("---", "");
    lines.push(...blocksToMd(article.blocks, 0));
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  /*
   * bundle = { title, sourceUrl, dateSaved, siteName, sections: [{ article, depth }] }
   * depth 0 = a page you picked, depth 1 = a source cited by it.
   */
  function buildCombinedMarkdown(bundle) {
    const sections = bundle.sections || [];
    const lines = [`# ${clean(bundle.title) || "Untitled"}`, ""];
    lines.push(...metaLines(bundle));
    lines.push("", "## Contents", "");
    sections.forEach((s, i) => {
      const t = clean(s.article.title) || `Document ${i + 1}`;
      const n = sections.slice(0, i + 1).filter((x) => !x.depth).length; // 1, 2, 3 — sources don't count
      lines.push(`${s.depth ? "    " : ""}${s.depth ? "-" : `${n}.`} [${esc(t)}](#${slug(t)})`);
    });
    lines.push("");

    for (const s of sections) {
      const t = clean(s.article.title) || "Untitled";
      lines.push("---", "", `## ${esc(t)}`, "");
      if (s.article.sourceUrl) lines.push(`*Source: <${s.article.sourceUrl}>*`, "");
      lines.push(...blocksToMd(s.article.blocks, 1));
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  const api = { buildMarkdown, buildCombinedMarkdown, runsToMd, slug };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.WTW = Object.assign(root.WTW || {}, api);
  }
})(typeof self !== "undefined" ? self : this);
