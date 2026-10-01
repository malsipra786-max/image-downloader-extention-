// Flow Image Downloader - content script.
// Runs inside the Google Flow page. It scans the image grid, reads each card's
// name and image URL, and fetches blob:/data: images for the background script.

(() => {
  if (window.__flowImageDownloaderLoaded) return;
  window.__flowImageDownloaderLoaded = true;

  /* =========================================================================
   * PAGE CONFIG - every page-specific selector lives here.
   * If Google changes the Flow page and the extension stops finding images,
   * this is the only place you should need to edit. An empty string ('')
   * means "auto-detect".
   * ======================================================================= */
  const CONFIG = {
    // The page counts as Google Flow when its address matches this.
    flowUrl: /^https:\/\/labs\.google\/.*flow/i,

    selectors: {
      // The scrollable element that holds the image grid.
      // '' = auto-detect (the nearest scrollable parent of the first card).
      gridContainer: '',

      // One image card in the grid.
      // '' = auto-detect: for every grid <img>, take its biggest parent
      // element that still contains only that one image.
      card: '',

      // The element inside a card that shows the name, e.g. "23: Staff handing dial".
      // '' = auto-detect (the smallest element whose text starts with "number:").
      nameLabel: '',

      // The image inside a card.
      image: 'img',

      // A card that contains this is a video and is always ignored.
      video: 'video',

      // Things inside a card that are NOT the name (hover buttons, icons, menus).
      ignoreInCard: [
        'button', '[role="button"]', '[role="menu"]', '[role="menuitem"]',
        '[role="tooltip"]', 'svg', 'i', '.material-icons',
        '[class*="material-symbols"]', '[class*="google-symbols"]'
      ].join(', '),

      // Page areas that are never part of the image grid.
      notGrid: 'nav, header, aside, [role="navigation"], [role="dialog"], [role="menu"], [role="banner"]',
    },

    // Attributes that may hold the FULL name (visible text can be cut off with "...").
    // Checked on the card, the name label and everything inside the card.
    nameAttributes: ['data-name', 'data-title', 'data-media-name', 'title', 'aria-label'],

    // How to tell that the "Images" view is open in the left sidebar.
    imagesView: {
      sidebarLabels: ['All media', 'Images', 'Characters', 'Scenes', 'Tools', 'Bin'],
      imagesLabel: 'Images',
      // Elements that can be sidebar items.
      itemSelector: 'a, button, li, [role="tab"], [role="button"], [role="option"], [role="menuitem"], [role="link"], [role="treeitem"]',
      // How the selected sidebar item is marked.
      activeSelector: '[aria-selected="true"], [aria-current]:not([aria-current="false"]), [data-state="active"], [data-state="on"], [data-state="checked"], [aria-pressed="true"], [aria-checked="true"], [data-selected="true"], [data-active="true"]',
      activeClass: /(^|[-_\s])(active|selected|current|checked)([-_\s]|$)/i,
    },

    // Auto-scrolling (images load lazily while scrolling).
    scroll: {
      stepFraction: 0.8,   // scroll this part of the visible height per step
      delayMs: 700,        // wait after each step for images to load
      bottomWaitMs: 1500,  // at the bottom, wait this long for more images
      bottomRetries: 3,    // give up after this many waits with nothing new
      maxSteps: 5000,      // safety limit
    },

    fullRes: {
      // Extra attributes that may hold the full-size image URL.
      urlAttributes: ['data-full-src', 'data-original', 'data-src', 'data-url'],

      // Turns a grid (thumbnail) URL into the full-resolution URL.
      upgradeUrl(url) {
        try {
          const u = new URL(url, location.href);
          // Next.js image optimizer: /_next/image?url=<original>&w=640&q=75
          if (u.pathname.endsWith('/_next/image') && u.searchParams.get('url')) {
            return new URL(u.searchParams.get('url'), location.href).href;
          }
          // Google image server: ...=w400-h300-c or ...=s512  ->  =s0 (original size)
          if (/(^|\.)googleusercontent\.com$/.test(u.hostname)) {
            return u.href.replace(/=[swh]\d+[-\w]*$/, '=s0');
          }
          return u.href;
        } catch {
          return url;
        }
      },

      // Optional and slow: click each card, read the big image from the viewer
      // that opens, then press Escape. Turn on only if the grid URL is a small thumbnail
      // that upgradeUrl() can't fix.
      openCard: {
        enabled: false,
        viewerImage: '[role="dialog"] img',  // the big image in the opened viewer
        closeButton: '',                     // optional close button selector
        waitMs: 5000,
      },
    },
  };
  /* ======================= end of PAGE CONFIG ============================ */

  const NAME_RE = /^\s*(\d+)\s*:/;
  const S = CONFIG.selectors;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  let scanning = false;
  let stopScanFlag = false;
  let scanFound = 0;

  /* ---------------------------- view check ------------------------------ */

  function isActive(el) {
    const iv = CONFIG.imagesView;
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
      if (e.matches(iv.activeSelector)) return true;
      if (typeof e.className === 'string' && iv.activeClass.test(e.className)) return true;
    }
    return !!el.querySelector(iv.activeSelector);
  }

  function detectView() {
    const iv = CONFIG.imagesView;
    const byLabel = new Map();
    for (const el of document.querySelectorAll(iv.itemSelector)) {
      const t = norm(el.textContent);
      const label = iv.sidebarLabels.find(
        (l) => t === l || (t.endsWith(l) && t.length <= l.length + 25)
      );
      if (!label) continue;
      // Keep the innermost element for each label.
      const prev = byLabel.get(label);
      if (!prev || prev.contains(el)) byLabel.set(label, el);
    }
    const labels = [...byLabel.keys()];
    if (labels.length < 2) return { view: null, labels, how: 'sidebar not found' };

    const active = labels.filter((l) => isActive(byLabel.get(l)));
    if (active.length === 1) return { view: active[0], labels, how: 'attribute' };

    // Fallback: the selected item usually looks different (background/colour/weight).
    const sig = (el) => {
      const cs = getComputedStyle(el);
      return [cs.backgroundColor, cs.color, cs.fontWeight].join('|');
    };
    if (labels.length >= 3) {
      const sigs = labels.map((l) => sig(byLabel.get(l)));
      const unique = labels.filter((l, i) => sigs.filter((s) => s === sigs[i]).length === 1);
      if (unique.length === 1) return { view: unique[0], labels, how: 'style' };
    }
    return { view: null, labels, how: 'could not tell which item is selected' };
  }

  /* --------------------------- card finding ----------------------------- */

  function isGridImage(img) {
    if (img.closest(S.notGrid)) return false;
    const r = img.getBoundingClientRect();
    // Skip tiny icons/avatars, but keep images that aren't laid out yet.
    if (r.width > 0 && (r.width < 48 || r.height < 48)) return false;
    return true;
  }

  // Counts grid images (not videos, so a video card with a poster image stays one card).
  function countImages(root, imageSet) {
    let n = 0;
    for (const m of root.querySelectorAll(S.image)) {
      if (imageSet.has(m) && ++n > 1) break;
    }
    return n;
  }

  function findCards() {
    if (S.card) {
      return [...document.querySelectorAll(S.card)].filter((c) => !c.closest(S.notGrid));
    }
    const imgs = [...document.querySelectorAll(S.image)].filter(isGridImage);
    const imageSet = new Set(imgs);
    const cards = [];
    const seen = new Set();
    for (const img of imgs) {
      let el = img;
      while (el.parentElement && el.parentElement !== document.body) {
        const p = el.parentElement;
        if (p.matches(S.notGrid)) break;
        if (countImages(p, imageSet) > 1) break;
        el = p;
      }
      if (!seen.has(el)) {
        seen.add(el);
        cards.push(el);
      }
    }
    return cards;
  }

  function isScrollable(el) {
    const oy = getComputedStyle(el).overflowY;
    return /(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 5;
  }

  function findScroller(cards) {
    if (S.gridContainer) {
      const el = document.querySelector(S.gridContainer);
      if (el) return el;
    }
    const first = cards[0];
    for (let e = first && first.parentElement; e && e !== document.body; e = e.parentElement) {
      if (isScrollable(e)) return e;
    }
    return document.scrollingElement || document.documentElement;
  }

  /* ---------------------------- name reading ---------------------------- */

  function isIgnored(el, card) {
    for (let e = el; e && e !== card; e = e.parentElement) {
      if (e.matches && e.matches(S.ignoreInCard)) return true;
    }
    return false;
  }

  // textContent (not innerText) so CSS "..." truncation doesn't cut the name.
  function textOf(el, card) {
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!isIgnored(n.parentElement, card)) out += n.nodeValue;
    }
    return norm(out);
  }

  function autoLabel(card) {
    const els = [card, ...card.querySelectorAll('*')].filter(
      (el) => !isIgnored(el, card) && !el.matches(`${S.image}, ${S.video}`)
    );
    // 1) the innermost element whose text starts with "number:"
    let best = null;
    for (const el of els) {
      const t = textOf(el, card);
      if (t && NAME_RE.test(t) && (!best || best.contains(el))) best = el;
    }
    if (best) return best;
    // 2) otherwise the element with the longest text of its own
    let bestLen = 0;
    for (const el of els) {
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.nodeValue)
        .join('');
      if (!norm(own)) continue;
      const len = textOf(el, card).length;
      if (len > bestLen) {
        bestLen = len;
        best = el;
      }
    }
    return best;
  }

  function readName(card) {
    const label = S.nameLabel ? card.querySelector(S.nameLabel) : autoLabel(card);
    const visible = label ? textOf(label, card) : '';

    const attrs = [];
    const add = (el) => {
      if (!el || !el.getAttribute) return;
      for (const a of CONFIG.nameAttributes) {
        const v = norm(el.getAttribute(a));
        if (v && !attrs.includes(v)) attrs.push(v);
      }
    };
    add(card);
    add(label);
    if (label) for (let e = label.parentElement; e && card.contains(e); e = e.parentElement) add(e);
    card.querySelectorAll('*').forEach((el) => {
      if (!isIgnored(el, card)) add(el);
    });

    // Prefer an attribute that is the full version of the visible text.
    const base = visible.replace(/(\.\.\.|…)\s*$/, '').trim();
    if (base) {
      const full = attrs
        .filter((a) => a.startsWith(base))
        .sort((a, b) => b.length - a.length)[0];
      return full || visible;
    }
    return attrs.find((a) => NAME_RE.test(a)) || '';
  }

  /* ------------------------------ image URL ----------------------------- */

  function largestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestW = -1;
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [u, d] = part.trim().split(/\s+/);
      const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 0;
      if (u && w > bestW) {
        bestW = w;
        best = u;
      }
    }
    return best;
  }

  function isPlaceholder(url) {
    return !url || (url.startsWith('data:') && url.length < 300) || url === 'about:blank';
  }

  function bestUrlFromImg(img, card) {
    for (const el of [img, card]) {
      if (!el) continue;
      for (const a of CONFIG.fullRes.urlAttributes) {
        const v = el.getAttribute(a);
        if (v && !isPlaceholder(v)) return v;
      }
    }
    return largestFromSrcset(img.getAttribute('srcset')) || img.currentSrc || img.getAttribute('src');
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  function readImage(card) {
    const img = card.matches(S.image) ? card : card.querySelector(S.image);
    if (!img) return null;
    const thumb = img.getAttribute('src') || img.currentSrc;
    if (isPlaceholder(thumb)) return null;
    const best = bestUrlFromImg(img, card);
    return { thumb: absolute(thumb), url: absolute(CONFIG.fullRes.upgradeUrl(absolute(best))) };
  }

  async function urlByOpeningCard(card) {
    const oc = CONFIG.fullRes.openCard;
    (card.querySelector(S.image) || card).click();
    const t0 = Date.now();
    let found = null;
    while (Date.now() - t0 < oc.waitMs) {
      const imgs = [...document.querySelectorAll(oc.viewerImage)].filter(
        (i) => i.complete && i.naturalWidth > 0
      );
      imgs.sort((a, b) => b.naturalWidth - a.naturalWidth);
      if (imgs[0]) {
        found = bestUrlFromImg(imgs[0], null);
        break;
      }
      await sleep(150);
    }
    const closeBtn = oc.closeButton && document.querySelector(oc.closeButton);
    if (closeBtn) closeBtn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(400);
    return found ? absolute(CONFIG.fullRes.upgradeUrl(absolute(found))) : null;
  }

  /* -------------------------------- scan -------------------------------- */

  async function scan() {
    const view = detectView();
    if (view.view && view.view !== CONFIG.imagesView.imagesLabel) {
      return { ok: false, error: `Open the Images view in Flow first. ("${view.view}" is selected now.)` };
    }

    const items = new Map(); // thumb URL -> item (removes repeat detections)
    let videosSkipped = 0;
    const videoCards = new WeakSet();

    const collect = async () => {
      for (const card of findCards()) {
        if (card.querySelector(S.video) || card.matches(S.video)) {
          if (!videoCards.has(card)) {
            videoCards.add(card);
            videosSkipped++;
          }
          continue;
        }
        const img = readImage(card);
        if (!img || items.has(img.thumb)) continue;
        const name = readName(card);
        const m = NAME_RE.exec(name);
        let url = img.url;
        if (CONFIG.fullRes.openCard.enabled && m) {
          url = (await urlByOpeningCard(card)) || url;
        }
        items.set(img.thumb, {
          order: items.size,
          name,
          num: m ? parseInt(m[1], 10) : null,
          url,
          thumb: img.thumb,
        });
      }
      scanFound = items.size;
      chrome.runtime.sendMessage({ type: 'scanProgress', found: items.size }).catch(() => {});
    };

    let cards = findCards();
    if (!cards.length) {
      await sleep(1500);
      cards = findCards();
    }
    if (!cards.length) {
      return { ok: false, error: 'No images found on this page. Open the Images view of your project and wait until the grid has loaded.' };
    }

    const sc = findScroller(cards);
    sc.scrollTop = 0;
    await sleep(CONFIG.scroll.delayMs);
    await collect();

    const cs = CONFIG.scroll;
    let bottomTries = 0;
    for (let step = 0; step < cs.maxSteps && !stopScanFlag; step++) {
      const before = items.size;
      const prevTop = sc.scrollTop;
      sc.scrollTop = prevTop + Math.max(200, sc.clientHeight * cs.stepFraction);
      await sleep(cs.delayMs);
      await collect();

      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (!atBottom) {
        bottomTries = 0;
        continue;
      }
      // At the bottom: wait for more images to load before giving up.
      const height = sc.scrollHeight;
      await sleep(cs.bottomWaitMs);
      await collect();
      if (items.size === before && sc.scrollHeight === height) {
        if (++bottomTries >= cs.bottomRetries) break;
      } else {
        bottomTries = 0;
      }
    }

    sc.scrollTop = 0;

    const list = [...items.values()];
    if (!list.length) {
      return { ok: false, error: 'No images found. Make sure the Images view is open and images have loaded.' };
    }
    return {
      ok: true,
      stopped: stopScanFlag,
      pageUrl: location.href,
      at: Date.now(),
      videosSkipped,
      items: list,
    };
  }

  async function runScan() {
    if (scanning) return { ok: false, error: 'A scan is already running.' };
    scanning = true;
    stopScanFlag = false;
    scanFound = 0;
    let result;
    try {
      result = await scan();
    } catch (e) {
      result = { ok: false, error: `Scan failed: ${e && e.message ? e.message : e}` };
    } finally {
      scanning = false;
    }
    chrome.runtime.sendMessage({ type: 'scanDone', result }).catch(() => {});
    return result;
  }

  /* ------------------------- fetch blob:/data: -------------------------- */

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  async function fetchImage(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const buf = await res.arrayBuffer();
      return { ok: true, base64: toBase64(buf), mime: res.headers.get('content-type') || '' };
    } catch (e) {
      return { ok: false, error: `Page fetch failed: ${e && e.message ? e.message : e}` };
    }
  }

  /* ------------------------------ debug info ---------------------------- */

  function shortHtml(el, max) {
    const clone = el.cloneNode(true);
    for (const e of [clone, ...clone.querySelectorAll('*')]) {
      for (const a of [...e.attributes]) {
        if (a.value.length > 160) e.setAttribute(a.name, `${a.value.slice(0, 120)}…[${a.value.length} chars]`);
      }
    }
    const html = clone.outerHTML;
    return html.length > max ? `${html.slice(0, max)}…[cut]` : html;
  }

  function debugInfo() {
    const out = [];
    const view = detectView();
    const cards = findCards();
    out.push(`URL: ${location.href}`);
    out.push(`Detected view: ${view.view || 'unknown'} (${view.how}); sidebar labels found: ${view.labels.join(', ') || 'none'}`);
    out.push(`Cards found: ${cards.length} (card selector: ${S.card || 'auto'})`);
    const sc = findScroller(cards);
    out.push(`Scroll container: <${sc.tagName.toLowerCase()} class="${sc.className}"> scrollHeight=${sc.scrollHeight} clientHeight=${sc.clientHeight}`);
    cards.slice(0, 2).forEach((c, i) => {
      const img = readImage(c);
      out.push('');
      out.push(`--- Card ${i + 1} ---`);
      out.push(`Name read: ${JSON.stringify(readName(c))}`);
      out.push(`Grid URL: ${img ? img.thumb.slice(0, 200) : 'none'}`);
      out.push(`Download URL: ${img ? img.url.slice(0, 200) : 'none'}`);
      out.push(shortHtml(c, 6000));
    });
    const imagesItem = [...document.querySelectorAll(CONFIG.imagesView.itemSelector)].find(
      (el) => norm(el.textContent).endsWith('Images') && norm(el.textContent).length < 40
    );
    if (imagesItem) {
      out.push('');
      out.push('--- Sidebar "Images" item (with parent) ---');
      out.push(shortHtml(imagesItem.parentElement || imagesItem, 3000));
    }
    return out.join('\n');
  }

  /* ------------------------------ messages ------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'ping':
        sendResponse({ ok: true, isFlow: CONFIG.flowUrl.test(location.href), scanning, found: scanFound });
        return;
      case 'checkView':
        sendResponse(detectView());
        return;
      case 'scan':
        runScan().then(sendResponse);
        return true;
      case 'stopScan':
        stopScanFlag = true;
        sendResponse({ ok: true });
        return;
      case 'fetchImage':
        fetchImage(msg.url).then(sendResponse);
        return true;
      case 'debugInfo':
        sendResponse({ text: debugInfo() });
        return;
    }
  });
})();
