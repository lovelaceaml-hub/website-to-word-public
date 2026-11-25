/*
 * offscreen.js — the "worker" with a DOM. Runs inside offscreen.html.
 *
 * The service worker (background.js) has no DOMParser, no Image, no canvas, so
 * anything that needs to parse HTML, measure images, or build the .docx happens
 * here. Communication is via chrome.runtime messages tagged { target:"offscreen" }.
 */
(function () {
  "use strict";

  const WTW = self.WTW; // adapters + extract + docbuild attached here
  const docx = self.docx; // vendored library global

  function adapterById(id, fallbackUrl) {
    return WTW.ADAPTERS.find((a) => a.id === id) || (fallbackUrl ? WTW.pickAdapter(fallbackUrl) : WTW.GENERIC);
  }

  function makeDoc(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  async function fetchText(url) {
    const res = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }

  // Parse a category/list page -> { links:[{url,title}], nextUrl }
  function parseList({ html, url, adapterId }) {
    const doc = makeDoc(html);
    const adapter = adapterById(adapterId, url);
    const links = adapter.listLinks(doc, url) || [];
    let nextUrl = null;
    try {
      nextUrl = adapter.nextPage(doc, url) || null;
    } catch {}
    return { links, nextUrl };
  }

  /*
   * Parse ONE article page and list the sources it cites.
   *
   * The links come from the extracted blocks, so by construction they were
   * inside the article body — page furniture (site map, disclaimer, terms,
   * privacy) never gets that far. The furniture text filter is a second net
   * for portals whose footer sits inside the content wrapper.
   *
   * -> { pageTitle, siteName, items } where items[0] is the page itself.
   */
  async function parseSources({ url, adapterId }) {
    const adapter = adapterById(adapterId, url);
    const html = await fetchText(url);
    const doc = makeDoc(html);
    const article = WTW.extractContent(doc, adapter, url, { Readability: self.Readability, makeDoc });

    const parentKey = WTW.urlKey(url);
    const sources = WTW.dedupe(
      (article.links || []).filter((l) => l && l.url && !WTW.isFurnitureLink(l.url, l.title))
    )
      .filter((l) => WTW.urlKey(l.url) !== parentKey)
      .map((l) => ({ url: l.url, title: l.title, kind: WTW.isFileUrl(l.url) ? "file" : "page", depth: 1 }));

    return {
      pageTitle: article.title,
      siteName: article.siteName || WTW.hostOf(url),
      items: [{ url, title: article.title, kind: "page", depth: 0 }].concat(sources),
    };
  }

  const IMG_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/bmp": "bmp" };
  const MAX_IMG_BYTES = 8 * 1024 * 1024;

  function loadImageSize(objUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = objUrl;
    });
  }

  async function toPngBytes(blob, size) {
    // Convert unsupported formats (webp/avif/svg) to PNG via canvas.
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) return null;
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width || size.w;
    canvas.height = bmp.height || size.h;
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    const outBlob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!outBlob) return null;
    return { data: new Uint8Array(await outBlob.arrayBuffer()), width: canvas.width, height: canvas.height, type: "png" };
  }

  async function fetchImage(src) {
    try {
      const res = await fetch(src, { credentials: "include" });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size < 64 || blob.size > MAX_IMG_BYTES) return null;
      const objUrl = URL.createObjectURL(blob);
      const size = await loadImageSize(objUrl);
      URL.revokeObjectURL(objUrl);
      if (!size || size.w < 2 || size.h < 2) return null;

      const type = IMG_TYPES[blob.type];
      if (type) {
        return { data: new Uint8Array(await blob.arrayBuffer()), width: size.w, height: size.h, type };
      }
      // webp / avif / svg / unknown -> re-encode as PNG
      return await toPngBytes(blob, size);
    } catch {
      return null;
    }
  }

  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function todayLong() {
    // Avoid Intl surprises; format as "July 10, 2026".
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const d = new Date();
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function textToBase64(text) {
    // TextEncoder keeps Korean and other non-Latin text intact; btoa alone would throw.
    return bytesToBase64(new TextEncoder().encode(text));
  }

  async function packDocx(document_) {
    const blob = await docx.Packer.toBlob(document_);
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }

  /*
   * pdfmake hands back base64 directly, so no Blob round-trip is needed.
   *
   * v0.3 returns a Promise from getBase64() and ignores any callback; older
   * builds only took a callback. Both are handled, because getting this wrong
   * fails silently — the export simply never finishes.
   */
  function packPdf(def) {
    return new Promise((resolve, reject) => {
      try {
        const maybe = self.pdfMake.createPdf(def).getBase64((data) => resolve(data));
        if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  // Fetch an article, extract it, and optionally embed its images.
  async function fetchArticle(url, adapterId, includeImages, needDataUris) {
    const adapter = adapterById(adapterId, url);
    const html = await fetchText(url);
    const doc = makeDoc(html);
    const article = WTW.extractContent(doc, adapter, url, { Readability: self.Readability, makeDoc });
    article.sourceUrl = url;
    article.dateSaved = todayLong();
    if (!article.siteName) article.siteName = WTW.hostOf(url);

    article.images = {};
    if (includeImages) {
      const srcs = Array.from(new Set(article.blocks.filter((b) => b.type === "image").map((b) => b.src)));
      // Fetch images with light concurrency.
      const CONC = 4;
      for (let i = 0; i < srcs.length; i += CONC) {
        const batch = srcs.slice(i, i + CONC);
        const got = await Promise.all(batch.map((s) => fetchImage(s)));
        got.forEach((g, j) => { if (g) article.images[batch[j]] = g; });
      }
      // pdfmake places images by data URI rather than raw bytes.
      if (needDataUris) {
        for (const key of Object.keys(article.images)) {
          const im = article.images[key];
          const mime = im.type === "jpg" ? "jpeg" : im.type || "png";
          // pdfmake only draws PNG and JPEG; a GIF/BMP would make the whole item
          // fail, so the PDF just leaves that picture out (Word still has it).
          if (mime !== "png" && mime !== "jpeg") continue;
          im.dataUri = `data:image/${mime};base64,${bytesToBase64(im.data)}`;
        }
      }
    }
    return article;
  }

  function wantsPdf(formats) {
    return (formats || []).indexOf("pdf") !== -1;
  }

  // Render one article into every requested format -> [{ ext, base64 }]
  async function renderArticle(article, formats) {
    const files = [];
    for (const fmt of formats || ["docx"]) {
      if (fmt === "docx") files.push({ ext: "docx", base64: await packDocx(WTW.buildDocument(article, docx)) });
      else if (fmt === "md") files.push({ ext: "md", base64: textToBase64(WTW.buildMarkdown(article)) });
      else if (fmt === "pdf") files.push({ ext: "pdf", base64: await packPdf(WTW.buildPdfDef(article)) });
    }
    return files;
  }

  // One page -> one file per chosen format.
  async function buildDoc({ url, adapterId, includeImages, formats }) {
    const article = await fetchArticle(url, adapterId, includeImages, wantsPdf(formats));
    return {
      title: article.title,
      files: await renderArticle(article, formats),
      imageCount: Object.keys(article.images).length,
    };
  }

  /*
   * Many pages -> ONE file per chosen format.
   *
   * Everything is fetched and held here rather than shuttled through the
   * service worker, because the extracted blocks for a dozen articles are far
   * too large to pass over chrome.runtime messages. Progress is reported as it
   * goes so the results page keeps moving.
   */
  async function buildCombined({ items, adapterId, includeImages, formats, meta, progress }) {
    const sections = [];
    const failures = [];
    const needDataUris = wantsPdf(formats);
    // Files were already saved by the caller, so continue its running count
    // rather than restarting the progress bar at zero.
    const base = (progress && progress.done) || 0;
    const total = (progress && progress.total) || items.length;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const article = await fetchArticle(item.url, adapterId, includeImages, needDataUris);
        if (item.title && !article.title) article.title = item.title;
        sections.push({ article, depth: item.depth || 0 });
        chrome.runtime
          .sendMessage({ type: "wtw-progress", done: base + i + 1, total, ok: true, title: article.title })
          .catch(() => {});
      } catch (e) {
        failures.push({ url: item.url, title: item.title, detail: e.message || String(e) });
        chrome.runtime
          .sendMessage({
            type: "wtw-progress",
            done: base + i + 1,
            total,
            ok: false,
            title: item.title || item.url,
            detail: e.message || String(e),
          })
          .catch(() => {});
      }
    }
    if (!sections.length) throw new Error("none of the pages could be read");

    const bundle = {
      title: (meta && meta.title) || sections[0].article.title,
      sourceUrl: (meta && meta.sourceUrl) || sections[0].article.sourceUrl,
      siteName: (meta && meta.siteName) || sections[0].article.siteName,
      dateSaved: todayLong(),
      sections,
    };

    const files = [];
    for (const fmt of formats || ["docx"]) {
      if (fmt === "docx") files.push({ ext: "docx", base64: await packDocx(WTW.buildCombinedDocument(bundle, docx)) });
      else if (fmt === "md") files.push({ ext: "md", base64: textToBase64(WTW.buildCombinedMarkdown(bundle)) });
      else if (fmt === "pdf") files.push({ ext: "pdf", base64: await packPdf(WTW.buildCombinedPdfDef(bundle)) });
    }
    return { title: bundle.title, files, count: sections.length, failures };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return; // not for us
    (async () => {
      try {
        if (msg.type === "parseList") sendResponse({ ok: true, result: parseList(msg) });
        else if (msg.type === "parseSources") sendResponse({ ok: true, result: await parseSources(msg) });
        else if (msg.type === "buildDoc") sendResponse({ ok: true, result: await buildDoc(msg) });
        else if (msg.type === "buildCombined") sendResponse({ ok: true, result: await buildCombined(msg) });
        else sendResponse({ ok: false, error: "unknown offscreen message" });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // async response
  });
})();
