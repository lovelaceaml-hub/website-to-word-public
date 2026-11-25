/*
 * background.js — the coordinator (service worker, classic).
 *
 * Responsibilities:
 *   - "scan": harvest article links from the current tab, follow pagination,
 *             then open the selection page.
 *   - "scanSources": collect the links inside one article's body (its sources).
 *   - "create": build Word, Markdown and/or PDF files (one per item or one
 *               combined file) and save them to Downloads/Website Captures/<folder>/.
 *
 * HTML parsing and document building are delegated to the offscreen document
 * (background has no DOMParser). Adapters are shared via importScripts.
 */
importScripts("adapters.js");
const WTW = self.WTW;

const MAX_LIST_PAGES = 40; // safety cap on pagination
let currentScan = { status: "idle" };
let lastDownloadId = null;

// ---------------------------------------------------------------- offscreen
// Several items are built at once, so share one creation promise: parallel
// callers would otherwise all see "no document" and the extra creates throw.
let offscreenReady = null;
function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["DOM_PARSER"],
        justification: "Parse article HTML and build Word, Markdown and PDF files.",
      });
    })().finally(() => {
      offscreenReady = null;
    });
  }
  return offscreenReady;
}

async function callOffscreen(type, payload) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage(Object.assign({ target: "offscreen", type }, payload));
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "offscreen failed");
  return resp.result;
}

// ---------------------------------------------------------------- scanning
async function harvestLiveLinks(tabId) {
  // Inject shared adapters + the harvester, then read the result.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["adapters.js", "content.js"] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (self.WTW_harvest ? self.WTW_harvest() : null),
  });
  return result; // { adapterId, pageUrl, siteName, links } | null
}

async function runScan(tabId, pageUrl) {
  currentScan = { status: "scanning", pageUrl };
  await chrome.storage.session.set({ currentScan });

  let adapterId = WTW.pickAdapter(pageUrl).id;
  let siteName = WTW.pickAdapter(pageUrl).siteName;
  let pageTitle = "";
  let links = [];

  // 1) Whatever is already rendered in the live page (handles JS lists).
  try {
    const live = await harvestLiveLinks(tabId);
    if (live) {
      adapterId = live.adapterId || adapterId;
      siteName = live.siteName || siteName;
      pageTitle = live.pageTitle || "";
      links = live.links || [];
    }
  } catch (e) {
    /* live harvest optional */
  }

  // 2) Follow server-side pagination for the complete list.
  const visited = new Set([pageUrl]);
  let cur = pageUrl;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    let parsed;
    try {
      const html = await fetchText(cur);
      parsed = await callOffscreen("parseList", { html, url: cur, adapterId });
    } catch {
      break;
    }
    links = links.concat(parsed.links || []);
    const next = parsed.nextUrl;
    if (!next || visited.has(next)) break;
    visited.add(next);
    cur = next;
  }

  links = WTW.dedupe(links).map((l) => Object.assign({ kind: "page", depth: 0 }, l));
  currentScan = {
    status: "ready",
    mode: "list",
    pageUrl,
    pageTitle,
    adapterId,
    siteName: siteName || WTW.hostOf(pageUrl),
    items: links,
  };
  await chrome.storage.session.set({ currentScan });
  chrome.runtime.sendMessage({ type: "wtw-scan-ready" }).catch(() => {});
}

/*
 * "Save this page + its sources" — one article page, plus the pages and files
 * it cites inside its body. One level only: the sources' own links are not
 * followed.
 */
async function runSourcesScan(pageUrl) {
  currentScan = { status: "scanning", mode: "sources", pageUrl };
  await chrome.storage.session.set({ currentScan });

  const adapterId = WTW.pickAdapter(pageUrl).id;
  try {
    const parsed = await callOffscreen("parseSources", { url: pageUrl, adapterId });
    currentScan = {
      status: "ready",
      mode: "sources",
      pageUrl,
      pageTitle: parsed.pageTitle,
      adapterId,
      siteName: parsed.siteName || WTW.hostOf(pageUrl),
      items: parsed.items || [],
    };
  } catch (e) {
    currentScan = {
      status: "ready",
      mode: "sources",
      pageUrl,
      pageTitle: "",
      adapterId,
      siteName: WTW.hostOf(pageUrl),
      items: [],
      error: e.message || String(e),
    };
  }
  await chrome.storage.session.set({ currentScan });
  chrome.runtime.sendMessage({ type: "wtw-scan-ready" }).catch(() => {});
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: "include", redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ---------------------------------------------------------------- creating
function sanitize(name) {
  return (
    (name || "Untitled")
      .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // A leading dot makes a hidden file; a trailing one confuses Windows.
      .replace(/^\.+|\.+$/g, "")
      .trim()
      .slice(0, 120)
      .trim() || "Untitled"
  );
}

/*
 * Folder name for a run. The page's own title is used first: portal URLs are
 * often opaque (Novitas ends every article path in "pagebyid"), so the old
 * URL-slug fallback produced folders like "Novitas Solutions - pagebyid".
 */
function folderName(scan) {
  let label = sanitize(scan.pageTitle || "");
  if (!label || label === "Untitled") {
    label = "";
    try {
      const segs = new URL(scan.pageUrl).pathname.split("/").filter(Boolean);
      label = decodeURIComponent(segs[segs.length - 1] || "")
        .replace(/^Category:/i, "")
        .replace(/[_-]+/g, " ")
        .trim();
    } catch {}
    label = label ? sanitize(label) : "";
  }
  const site = sanitize(scan.siteName || "Website");
  return label && label !== site ? `${site} - ${label}` : site;
}

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
  pdf: "application/pdf",
};

async function download(url, filename) {
  lastDownloadId = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  return lastDownloadId;
}

function downloadBuilt(base64, ext, filename) {
  return download(`data:${MIME[ext] || "application/octet-stream"};base64,${base64}`, filename);
}

// The extension of a file link, so a saved PDF keeps being a PDF.
function extOf(url) {
  try {
    const m = /\.([a-z0-9]{1,5})$/i.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : "pdf";
  } catch {
    return "pdf";
  }
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/*
 * Save the chosen items.
 *
 * opts = { includeImages, formats:["docx","md","pdf"], combine:bool }
 *
 * Separate mode gives one numbered file per item per format, numbered in the
 * order the page cites them. Combined mode merges the readable pages into a
 * single file per format — files (PDFs and other downloads) are always saved
 * on their own, because they cannot be merged into a Word document.
 */
async function runCreate(items, opts, scan) {
  const folder = folderName(scan);
  const formats = opts.formats && opts.formats.length ? opts.formats : ["docx"];
  const includeImages = opts.includeImages !== false;
  const base = `Website Captures/${folder}`;
  const width = Math.max(2, String(items.length).length);
  const num = (i) => String(i + 1).padStart(width, "0");
  const total = items.length;
  const results = [];
  let done = 0;

  const report = (ok, title, detail) => {
    done++;
    results.push({ ok, title, detail: detail || "" });
    chrome.runtime.sendMessage({ type: "wtw-progress", done, total, ok, title, detail }).catch(() => {});
  };

  // Downloadable files are saved as-is in both modes, keeping their position.
  const fileItems = items.filter((it) => it.kind === "file");
  const pageItems = items.filter((it) => it.kind !== "file");

  async function saveFiles() {
    for (const item of fileItems) {
      const i = items.indexOf(item);
      try {
        await download(item.url, `${base}/${num(i)} - ${sanitize(item.title)}.${extOf(item.url)}`);
        report(true, item.title);
      } catch (e) {
        report(false, item.title, e.message || String(e));
      }
    }
  }

  if (opts.combine) {
    await saveFiles();
    try {
      const built = await callOffscreen("buildCombined", {
        items: pageItems.map((it) => ({ url: it.url, title: it.title, depth: it.depth || 0 })),
        adapterId: scan.adapterId,
        includeImages,
        formats,
        meta: { title: scan.pageTitle || scan.siteName, sourceUrl: scan.pageUrl, siteName: scan.siteName },
        progress: { done, total },
      });
      const stem = `${sanitize(built.title || scan.pageTitle || "Saved pages")} - ${today()}`;
      for (const f of built.files) await downloadBuilt(f.base64, f.ext, `${base}/${stem}.${f.ext}`);
      chrome.runtime
        .sendMessage({
          type: "wtw-create-done",
          total,
          results: results.concat([{ ok: true, title: `${stem} (${built.count} documents)`, detail: "" }]),
          folder,
        })
        .catch(() => {});
    } catch (e) {
      chrome.runtime
        .sendMessage({
          type: "wtw-create-done",
          total,
          results: results.concat([{ ok: false, title: "Combined file", detail: e.message || String(e) }]),
          folder,
        })
        .catch(() => {});
    }
    return;
  }

  await saveFiles();

  const CONC = 3; // a few docs at a time — polite + memory-friendly
  for (let i = 0; i < pageItems.length; i += CONC) {
    await Promise.all(
      pageItems.slice(i, i + CONC).map(async (item) => {
        const idx = items.indexOf(item);
        try {
          const built = await callOffscreen("buildDoc", {
            url: item.url,
            adapterId: scan.adapterId,
            includeImages,
            formats,
          });
          const stem = `${base}/${num(idx)} - ${sanitize(built.title || item.title)}`;
          for (const f of built.files) await downloadBuilt(f.base64, f.ext, `${stem}.${f.ext}`);
          report(true, built.title || item.title);
        } catch (e) {
          report(false, item.title, e.message || String(e));
        }
      })
    );
  }
  chrome.runtime.sendMessage({ type: "wtw-create-done", total, results, folder }).catch(() => {});
}

// ---------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return; // offscreen handles its own

  if (msg.type === "scan") {
    (async () => {
      const tabUrl = msg.url;
      // Open the results page right away; it shows a spinner until ready.
      await chrome.tabs.create({ url: chrome.runtime.getURL("selection.html") });
      runScan(msg.tabId, tabUrl); // fire and forget
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "getScan") {
    (async () => {
      if (currentScan.status === "idle") {
        const stored = await chrome.storage.session.get("currentScan");
        if (stored.currentScan) currentScan = stored.currentScan;
      }
      sendResponse(currentScan);
    })();
    return true;
  }

  if (msg.type === "scanSources") {
    (async () => {
      await chrome.tabs.create({ url: chrome.runtime.getURL("selection.html") });
      runSourcesScan(msg.url); // fire and forget
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "create") {
    (async () => {
      const stored = (await chrome.storage.session.get("currentScan")).currentScan || currentScan;
      sendResponse({ ok: true });
      runCreate(msg.items, msg.opts || { includeImages: msg.includeImages, formats: ["docx"], combine: false }, stored);
    })();
    return true;
  }

  if (msg.type === "showLastDownload") {
    if (lastDownloadId != null) chrome.downloads.show(lastDownloadId);
    else chrome.downloads.showDefaultFolder();
    sendResponse({ ok: true });
    return true;
  }
});
