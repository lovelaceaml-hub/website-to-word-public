// popup.js — the toolbar button. Kicks off a scan and opens the results tab.
async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

(async function init() {
  const tab = await currentTab();
  const siteBox = document.getElementById("site");
  const scanBtn = document.getElementById("scan");
  const sourcesBtn = document.getElementById("sources");

  try {
    const host = new URL(tab.url).host;
    siteBox.textContent = "Current page: " + host;
  } catch {
    siteBox.textContent = "";
  }

  // Don't try to scan Chrome's own pages.
  if (!/^https?:/i.test(tab.url || "")) {
    scanBtn.disabled = true;
    sourcesBtn.disabled = true;
    scanBtn.textContent = "Open a website first";
    return;
  }

  function start(btn, message) {
    btn.onclick = async () => {
      scanBtn.disabled = true;
      sourcesBtn.disabled = true;
      btn.textContent = "Opening results…";
      await chrome.runtime.sendMessage(Object.assign({ tabId: tab.id, url: tab.url }, message));
      setTimeout(() => window.close(), 500);
    };
  }

  start(scanBtn, { type: "scan" });
  start(sourcesBtn, { type: "scanSources" });
})();
