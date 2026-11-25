/*
 * selection.js — the results page.
 *
 * 1) Poll the background for scan results (it may still be paginating).
 * 2) Show a checklist: a flat list of articles in "scan" mode, or the page you
 *    were on with its cited sources indented beneath it in "sources" mode.
 * 3) On "Create", hand the chosen items plus the format options back, then
 *    show live progress.
 */
let scan = null;

const $ = (id) => document.getElementById(id);

// Format + combine + pictures are remembered between runs.
const PREFS_KEY = "wtwPrefs";
const DEFAULT_PREFS = { formats: ["docx"], combine: false, images: true };

async function loadPrefs() {
  try {
    const stored = await chrome.storage.local.get(PREFS_KEY);
    return Object.assign({}, DEFAULT_PREFS, stored[PREFS_KEY] || {});
  } catch {
    return Object.assign({}, DEFAULT_PREFS);
  }
}

function currentPrefs() {
  const formats = [];
  if ($("fmt-docx").checked) formats.push("docx");
  if ($("fmt-md").checked) formats.push("md");
  if ($("fmt-pdf").checked) formats.push("pdf");
  return { formats, combine: $("combine").checked, images: $("images").checked };
}

function savePrefs() {
  try {
    chrome.storage.local.set({ [PREFS_KEY]: currentPrefs() });
  } catch {}
}

function applyPrefs(p) {
  $("fmt-docx").checked = p.formats.includes("docx");
  $("fmt-md").checked = p.formats.includes("md");
  $("fmt-pdf").checked = p.formats.includes("pdf");
  $("combine").checked = !!p.combine;
  $("images").checked = p.images !== false;
}

function onOptionsChanged() {
  const p = currentPrefs();
  // At least one format must stay ticked, or "Create" would produce nothing.
  if (!p.formats.length) {
    $("fmt-docx").checked = true;
    p.formats.push("docx");
  }
  $("pdfNote").style.display = p.formats.includes("pdf") ? "block" : "none";
  $("create").textContent = p.combine ? "Create one combined file" : "Create documents";
  savePrefs();
  updateCount();
}

function isSources() {
  return scan && scan.mode === "sources";
}

function renderSource() {
  const host = (() => {
    try {
      return new URL(scan.pageUrl).host;
    } catch {
      return "";
    }
  })();
  if (isSources()) {
    const sources = scan.items.length - 1;
    $("source").textContent =
      `${scan.pageTitle || host} — this page plus ${sources} source${sources === 1 ? "" : "s"} it links to.`;
  } else {
    $("source").textContent =
      `From ${host} — found ${scan.items.length} article${scan.items.length === 1 ? "" : "s"}.`;
  }
}

function renderList(filter) {
  const ul = $("list");
  ul.innerHTML = "";
  const q = (filter || "").toLowerCase();
  scan.items.forEach((item, idx) => {
    if (q && !(item.title || "").toLowerCase().includes(q)) return;
    const li = document.createElement("li");
    if (isSources()) li.className = item.depth ? "child" : "parent";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item._checked !== false;
    cb.dataset.idx = idx;
    cb.addEventListener("change", () => {
      scan.items[idx]._checked = cb.checked;
      updateCount();
    });

    const wrap = document.createElement("div");
    wrap.style.flex = "1";
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = item.title || item.url;
    if (item.kind === "file") {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "FILE";
      b.title = "Saved exactly as it is, not converted";
      t.appendChild(b);
    }
    const u = document.createElement("div");
    u.className = "row-url";
    u.textContent = item.url;
    wrap.appendChild(t);
    wrap.appendChild(u);
    li.appendChild(cb);
    li.appendChild(wrap);
    ul.appendChild(li);
  });
  updateCount();
}

function updateCount() {
  const chosen = scan.items.filter((i) => i._checked !== false);
  $("selcount").textContent = chosen.length;
  $("create").disabled = chosen.length === 0;
}

let pickerShown = false;
async function showPicker() {
  // pollScan can be reached twice (its own timer and "wtw-scan-ready"); build once.
  if (pickerShown) return;
  pickerShown = true;
  $("status").style.display = "none";
  $("picker").style.display = "block";
  renderSource();
  scan.items.forEach((i) => (i._checked = true));

  applyPrefs(await loadPrefs());
  ["fmt-docx", "fmt-md", "fmt-pdf", "combine", "images"].forEach((id) =>
    $(id).addEventListener("change", onOptionsChanged)
  );
  onOptionsChanged();
  renderList("");

  $("filter").addEventListener("input", (e) => renderList(e.target.value));
  $("all").onclick = () => { scan.items.forEach((i) => (i._checked = true)); renderList($("filter").value); };
  $("none").onclick = () => { scan.items.forEach((i) => (i._checked = false)); renderList($("filter").value); };
  $("create").onclick = startCreate;
}

async function startCreate() {
  const items = scan.items
    .filter((i) => i._checked !== false)
    .map((i) => ({ url: i.url, title: i.title, kind: i.kind || "page", depth: i.depth || 0 }));
  if (!items.length) return;

  const p = currentPrefs();
  $("picker").style.display = "none";
  $("progressWrap").style.display = "block";
  $("pcount").textContent = `0 / ${items.length}`;

  await chrome.runtime.sendMessage({
    type: "create",
    items,
    opts: { includeImages: p.images, formats: p.formats, combine: p.combine },
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "wtw-scan-ready") pollScan();
  else if (msg.type === "wtw-progress") {
    $("pcount").textContent = `${msg.done} / ${msg.total}`;
    $("bar").firstElementChild.style.width = `${(msg.done / msg.total) * 100}%`;
    const line = document.createElement("div");
    line.className = msg.ok ? "ok" : "fail";
    line.textContent = (msg.ok ? "✓ " : "✕ ") + (msg.title || msg.url) + (msg.ok ? "" : ` — ${msg.detail || "failed"}`);
    $("log").prepend(line);
  } else if (msg.type === "wtw-create-done") {
    const okCount = msg.results.filter((r) => r.ok).length;
    const head = document.querySelector("#progressWrap h1");
    head.textContent = `Done — ${okCount} of ${msg.results.length} saved`;
    $("bar").firstElementChild.style.width = "100%";
    msg.results
      .filter((r) => !r.ok)
      .forEach((r) => {
        const line = document.createElement("div");
        line.className = "fail";
        line.textContent = `✕ ${r.title} — ${r.detail || "failed"}`;
        $("log").prepend(line);
      });
    $("openFolder").style.display = "inline-block";
    $("openFolder").onclick = () => chrome.runtime.sendMessage({ type: "showLastDownload" });
  }
});

async function pollScan() {
  const resp = await chrome.runtime.sendMessage({ type: "getScan" });
  if (resp && resp.status === "ready") {
    scan = resp;
    if (!scan.items || scan.items.length === 0) {
      $("status").textContent =
        scan.mode === "sources"
          ? `This page could not be read${scan.error ? ` (${scan.error})` : ""}. Try "Scan this page for articles" instead.`
          : "No articles found on this page. Try opening a category or list page, then scan again.";
      return;
    }
    showPicker();
  } else {
    if (resp && resp.mode === "sources") {
      $("status").innerHTML = '<span class="spinner"></span>Reading the page and its links…';
    }
    setTimeout(pollScan, 700); // still scanning
  }
}

pollScan();
