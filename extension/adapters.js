/*
 * adapters.js — per-site rules for finding article links and extracting content.
 *
 * Works in three places without changes:
 *   - the live page (injected via chrome.scripting)   -> uses window.WTW
 *   - the offscreen document (<script src>)            -> uses window.WTW
 *   - the background service worker (importScripts)     -> uses self.WTW
 *   - the Node offline test (require)                   -> uses module.exports
 *
 * Every adapter operates on a DOM `document` (real one in the browser, a jsdom
 * one in the test). Nothing here fetches — the caller supplies the HTML/DOM.
 */
(function (root) {
  "use strict";

  // Resolve a possibly-relative href against the page it came from.
  function abs(href, baseUrl) {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return null;
    }
  }

  // Trim + collapse whitespace for titles.
  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  /*
   * Some portals link internally with a private scheme instead of a URL.
   * Oracle WebCenter (novitas-solutions.com) uses `ddocname:00215106`, which
   * resolves to the same portal's pagebyid?contentId=00215106. Everything else
   * falls through to normal relative-URL resolution.
   */
  function resolveHref(href, baseUrl) {
    const raw = (href || "").trim();
    const dd = /^ddocname:\s*([A-Za-z0-9_.-]+)/i.exec(raw);
    if (dd) {
      try {
        const u = new URL(baseUrl);
        const m = /^(\/webcenter\/portal\/[^/]+)\//.exec(u.pathname);
        if (m) return `${u.origin}${m[1]}/pagebyid?contentId=${dd[1]}`;
      } catch {}
      return null;
    }
    return abs(raw, baseUrl);
  }

  /*
   * A comparison key for "is this the same page?" — ignores the fragment,
   * a trailing slash, host casing and tracking parameters, so /x, /x/ and
   * /x?utm_source=mail all collapse to one entry.
   */
  function urlKey(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      for (const k of Array.from(u.searchParams.keys())) {
        if (/^utm_/i.test(k) || /^(fbclid|gclid|mc_cid|mc_eid|_ga)$/i.test(k)) u.searchParams.delete(k);
      }
      if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
      return (u.origin + u.pathname + u.search).toLowerCase();
    } catch {
      return String(url || "").split("#")[0].toLowerCase();
    }
  }

  // Links that point at a file to download rather than a page to read.
  const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt|rtf)$/i;
  function isFileUrl(url) {
    try {
      return FILE_EXT.test(new URL(url).pathname);
    } catch {
      return FILE_EXT.test(String(url || ""));
    }
  }

  /*
   * Page furniture that is never a source worth saving. Used as a safety net
   * for the "save this page + its sources" mode: body-position filtering
   * already excludes most of it, but portal footers sometimes sit inside the
   * content wrapper, and their URLs are indistinguishable from real articles.
   */
  const FURNITURE_TEXT =
    /^(site\s*map|sitemap|disclaimer|terms(\s+(of\s+)?(use|service))?|privacy(\s+(policy|statement))?|contact(\s+us)?|help|acronyms|home|print(\s+this\s+page)?|back\s+to\s+top|top|accessibility|feedback|careers|log\s*in|sign\s*(in|up)|register|search|subscribe|skip\s+to\s+main\s+content|email\s+this)\W*$/i;
  function isFurnitureLink(url, text) {
    const raw = String(url || "").trim();
    if (!raw) return true;
    if (/^(mailto:|tel:|javascript:)/i.test(raw)) return true;
    if (raw.startsWith("#")) return true;
    return FURNITURE_TEXT.test(clean(text));
  }

  // Deepest element that contains every one of `els`. Used to find a content
  // wrapper on sites whose article container has no usable id or class.
  function commonAncestor(els) {
    if (!els || !els.length) return null;
    const chainOf = (e) => {
      const c = [];
      while (e && e.tagName) {
        c.push(e);
        e = e.parentElement;
      }
      return c.reverse();
    };
    let common = chainOf(els[0]);
    for (let i = 1; i < els.length && common.length; i++) {
      const c = chainOf(els[i]);
      let n = 0;
      while (n < common.length && n < c.length && common[n] === c[n]) n++;
      common = common.slice(0, n);
    }
    return common[common.length - 1] || null;
  }

  // De-duplicate a list of {url,title} keeping first-seen order.
  // The stored URL keeps its original form (minus the fragment); only the
  // comparison uses the normalised key.
  function dedupe(links) {
    const seen = new Set();
    const out = [];
    for (const l of links) {
      if (!l || !l.url) continue;
      const url = String(l.url).split("#")[0];
      const key = urlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Object.assign({}, l, { url, title: l.title || url }));
    }
    return out;
  }

  // ---- Generic "find the repeating article links" fallback --------------
  // Used for any site without a dedicated adapter. Groups same-origin links by
  // the shape of their path and keeps the biggest sensible group.
  function genericListLinks(doc, baseUrl) {
    const origin = (() => {
      try {
        return new URL(baseUrl).origin;
      } catch {
        return null;
      }
    })();
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    const groups = new Map();
    for (const a of anchors) {
      // Skip links inside obvious chrome (nav/header/footer/aside).
      if (a.closest("nav,header,footer,aside")) continue;
      const url = abs(a.getAttribute("href"), baseUrl);
      if (!url) continue;
      let u;
      try {
        u = new URL(url);
      } catch {
        continue;
      }
      if (origin && u.origin !== origin) continue; // same site only
      if (/\.(pdf|jpe?g|png|gif|zip|mp4|mp3|docx?|xlsx?)$/i.test(u.pathname)) continue;
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length === 0) continue; // homepage-ish
      const title = clean(a.textContent);
      if (title.length < 8) continue; // ignore icon / "more" links
      // Group key = number of path segments + first segment (the "section").
      const key = segs.length + "|" + segs[0];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ url: url, title });
    }
    // Pick the largest group (the article grid), needs at least 2 members.
    let best = [];
    for (const arr of groups.values()) {
      if (arr.length > best.length) best = arr;
    }
    return dedupe(best);
  }

  // Best-effort "next page" for unknown sites: rel=next or a link labelled next.
  function genericNextPage(doc, baseUrl) {
    let a = doc.querySelector('a[rel="next"]');
    if (!a) {
      a = Array.from(doc.querySelectorAll("a[href]")).find((x) =>
        /^\s*(next|older|more|»|›|>)\s*$/i.test(clean(x.textContent))
      );
    }
    return a ? abs(a.getAttribute("href"), baseUrl) : null;
  }

  // ---------------------------------------------------------------- ADAPTERS
  const ADAPTERS = [
    // 1) MediaWiki (churchofgod.wiki) --------------------------------------
    {
      id: "mediawiki",
      siteName: "Church of God Wiki",
      match: (url) => /(^|\.)churchofgod\.wiki$/i.test(hostOf(url)),
      isListPage: (doc) => !!doc.querySelector("#mw-pages"),
      listLinks(doc, baseUrl) {
        const root = doc.querySelector("#mw-pages") || doc;
        const links = Array.from(root.querySelectorAll("a[href]"))
          .filter((a) => {
            const href = a.getAttribute("href") || "";
            // Drop the "(previous page)/(next page)" pager links.
            if (/pagefrom=|pageuntil=/.test(href)) return false;
            if (/previous page|next page/i.test(clean(a.textContent))) return false;
            return /^\/[^:]+$/.test(href.split("#")[0]); // /en/Article style
          })
          .map((a) => ({ url: abs(a.getAttribute("href"), baseUrl), title: clean(a.textContent) }));
        return dedupe(links);
      },
      nextPage(doc, baseUrl) {
        const a = Array.from(doc.querySelectorAll("#mw-pages a[href]")).find((x) =>
          /next page/i.test(clean(x.textContent))
        );
        return a ? abs(a.getAttribute("href"), baseUrl) : null;
      },
      titleSelector: "#firstHeading, h1.firstHeading",
      contentSelector: ".mw-parser-output",
      strip: [
        ".toc",
        "#toc",
        ".navbox",
        ".infobox",
        "table.infobox",
        ".mw-editsection",
        ".reference",
        "sup.reference",
        ".noprint",
        ".mw-jump-link",
        ".hatnote",
        ".metadata",
        "style",
        "script",
      ],
    },

    // 2) WordPress (watv.org) ----------------------------------------------
    {
      id: "wordpress",
      siteName: "WATV",
      match: (url) => /^(www\.)?watv\.org$/i.test(hostOf(url)),
      isListPage: (doc, url) => /\/category\//.test(url || "") || !!doc.querySelector(".posts, .post-list, article"),
      listLinks(doc, baseUrl) {
        // Each post card carries a clean title in `.post-title` (the surrounding
        // anchor's text also includes the excerpt, so read the heading instead).
        let links = [];
        doc.querySelectorAll(".post-title, .entry-title").forEach((pt) => {
          const a = pt.querySelector("a[href]") || pt.closest("a[href]");
          const href = a && a.getAttribute("href");
          const title = clean(pt.textContent);
          if (href && title) links.push({ url: abs(href, baseUrl), title });
        });
        links = links.filter(
          (l) => l.url && !/\/category\/|\/page\//.test(l.url) && !/^\/[a-z-]+\/?$/.test(pathOf(l.url))
        );
        if (links.length < 2) {
          links = Array.from(doc.querySelectorAll('article a[href*="watv.org/"]'))
            .map((a) => ({ url: abs(a.getAttribute("href"), baseUrl), title: clean(a.textContent) }))
            .filter((l) => l.url && /\/[a-z_]+\/[^/]+\/$/.test(pathOf(l.url)) && !/\/category\//.test(l.url) && l.title);
        }
        if (links.length < 2) links = genericListLinks(doc, baseUrl);
        return dedupe(links);
      },
      // WordPress uses /page/N/ — increment until a page 404s / empties.
      nextPage(doc, baseUrl) {
        const a =
          doc.querySelector('a.next, a.next.page-numbers, a[rel="next"]') ||
          Array.from(doc.querySelectorAll("a[href]")).find((x) =>
            /^(next( page| posts)?|»|›)\s*[»›→>]*$/i.test(clean(x.textContent)) // the whole label, not "Next Generation…" titles
          );
        return a ? abs(a.getAttribute("href"), baseUrl) : null;
      },
      titleSelector: "h1.entry-title, h1.post-title, article h1, h1",
      contentSelector: ".entry-content, article .content, .post-content",
      strip: [".sharedaddy", ".jp-relatedposts", ".wp-block-buttons", "script", "style", ".ad", "iframe.ad"],
    },

    // 3) WATV CMS (happyhome / elohist .watv.org) --------------------------
    {
      id: "watvcms",
      siteName: "WATV",
      match: (url) => /(happyhome|elohist)\.watv\.org$/i.test(hostOf(url)),
      isListPage: (doc, url) =>
        /\/(list|category)\b/i.test(url || "") || doc.querySelectorAll('a[href*="/view/"], a[href*="/content/"]').length > 1,
      listLinks(doc, baseUrl) {
        const links = Array.from(doc.querySelectorAll('a[href*="/view/"], a[href*="/content/"]'))
          .filter((a) => !/\/download\//.test(a.getAttribute("href") || "")) // skip binary downloads
          .map((a) => ({
            url: abs(a.getAttribute("href"), baseUrl),
            title: clean(a.textContent) || clean(a.getAttribute("title")),
          }))
          .filter((l) => l.url && l.title && !/^(read more|more|view)$/i.test(l.title));
        return dedupe(links);
      },
      nextPage: (doc, baseUrl) => genericNextPage(doc, baseUrl),
      titleSelector: "h1, .title, .view-title, .subject",
      contentSelector: ".view-content, .content, .article, #content, .board-view",
      strip: ["script", "style", ".btn", ".buttons", "nav", ".share", ".sns", "header", "footer"],
    },

    // 4) Webflow collections (claude.com/resources/*) ----------------------
    {
      id: "webflow-claude",
      siteName: "Claude Resources",
      match: (url) => /(^|\.)claude\.com$/i.test(hostOf(url)) && /\/resources\//.test(pathOf(url)),
      isListPage: (doc, url) => /\/resources\/(tutorials|use-cases|customers)\/?$/.test(url || ""),
      listLinks(doc, baseUrl) {
        // The card's clickable link often just says "Read use case"; the real
        // title lives in a sibling heading, so climb the card and look for one.
        const titleSel =
          '[fs-list-field="heading"], [data-collection-element="title"], [class*="_title"], h1, h2, h3, h4';
        const anchors = Array.from(
          doc.querySelectorAll(
            'a[href^="/resources/tutorials/"], a[href^="/resources/use-cases/"], a[href^="/resources/customers/"]'
          )
        );
        const out = [];
        for (const a of anchors) {
          const url = abs(a.getAttribute("href"), baseUrl);
          if (!url || /\/resources\/(tutorials|use-cases|customers)\/?$/.test(pathOf(url))) continue;
          let title = clean(a.textContent);
          if (!title || /^read\b/i.test(title) || title.length < 4) {
            let node = a;
            for (let i = 0; i < 4 && node; i++) {
              const h = node.querySelector && node.querySelector(titleSel);
              if (h) {
                const t = clean(h.textContent);
                if (t && !/^read\b/i.test(t)) { title = t; break; }
              }
              node = node.parentElement;
            }
          }
          out.push({ url, title: title || url });
        }
        return dedupe(out);
      },
      // "View more" adds ?<field>_page=N — try bumping a page param.
      nextPage(doc, baseUrl) {
        try {
          const u = new URL(baseUrl);
          const key = Array.from(u.searchParams.keys()).find((k) => /_page$/.test(k)) || "";
          if (key) {
            u.searchParams.set(key, String(parseInt(u.searchParams.get(key) || "1", 10) + 1));
            return u.href;
          }
        } catch {}
        return null; // rely on live-page harvest for later pages
      },
      titleSelector: "h1",
      contentSelector: "main, article, .rich-text, .w-richtext, .post-content",
      strip: ["script", "style", "nav", "header", "footer", ".w-nav", "form", ".cta", ".newsletter"],
    },

    // 5) Oracle WebCenter portal (novitas-solutions.com) --------------------
    // Medicare guidance pages. The article is an inline "converted Word"
    // document: a nested <html><body class="convertedword"> whose tags the
    // parser flattens, leaving a wrapper <div> with no id or class. So the
    // content root is found by locating the web_* elements and taking their
    // common ancestor. Readability alone drops the link-only web_bullet_2
    // rows, which is exactly where the CFR and CMS citations live.
    {
      id: "webcenter",
      siteName: "Novitas Solutions",
      match: (url) => /(^|\.)novitas-solutions\.com$/i.test(hostOf(url)),
      isListPage: (doc) => !doc.querySelector(".web_normal, .web_bullet_1"),
      listLinks: (doc, baseUrl) => genericListLinks(doc, baseUrl),
      nextPage: () => null,
      titleSelector: "h1.web_header, h1, title",
      contentSelector: null, // resolved by contentRoot below
      contentRoot(doc) {
        const els = Array.from(
          doc.querySelectorAll(
            "h1.web_header, h2.web_header_2, h3.web_header_3, .web_normal, .web_bullet_1, .web_bullet_2, .web_bullet_3"
          )
        );
        return els.length ? commonAncestor(els) : null;
      },
      strip: ["script", "style", "nav", "header", "footer", ".skipnav"],
    },
  ];

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }
  function pathOf(url) {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  }

  // The generic adapter — used when nothing above matches.
  const GENERIC = {
    id: "generic",
    siteName: null, // derived from the page's host at run time
    match: () => true,
    isListPage: () => true,
    listLinks: genericListLinks,
    nextPage: genericNextPage,
    titleSelector: "h1, title",
    contentSelector: null, // signals "use Readability"
    strip: ["script", "style", "nav", "header", "footer", "aside", "form", ".ad", "iframe"],
  };

  function pickAdapter(url) {
    return ADAPTERS.find((a) => a.match(url)) || GENERIC;
  }

  const api = {
    ADAPTERS,
    GENERIC,
    pickAdapter,
    dedupe,
    abs,
    clean,
    genericListLinks,
    hostOf,
    resolveHref,
    urlKey,
    isFileUrl,
    isFurnitureLink,
    commonAncestor,
  };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.WTW = Object.assign(root.WTW || {}, api);
  }
})(typeof self !== "undefined" ? self : this);
