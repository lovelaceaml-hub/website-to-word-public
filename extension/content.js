/*
 * content.js — injected into the current tab alongside adapters.js.
 *
 * Reads the ALREADY-RENDERED page (so anything the user expanded via
 * "View more" or infinite scroll is included) and returns the article links
 * it can see. Runs in the extension's isolated world; adapters.js has attached
 * WTW to that world's global just before this file runs.
 */
(function () {
  "use strict";
  const WTW = self.WTW;
  self.WTW_harvest = function () {
    const url = location.href;
    const adapter = WTW.pickAdapter(url);
    let links = [];
    try {
      links = adapter.listLinks(document, url) || [];
    } catch {}
    if (!links.length) {
      try {
        links = WTW.genericListLinks(document, url) || [];
      } catch {}
    }
    // The page's own title names the download folder — far more useful than
    // the last URL segment on portals with opaque paths.
    const h1 = document.querySelector("h1");
    const pageTitle = WTW.clean((h1 && h1.textContent) || document.title || "");
    return {
      adapterId: adapter.id,
      pageUrl: url,
      pageTitle,
      siteName: adapter.siteName || WTW.hostOf(url),
      links: WTW.dedupe(links),
    };
  };
})();
