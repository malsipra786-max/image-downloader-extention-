// Image Number Downloader - content script.
// Injected into the current tab by the popup. It scrolls the page, finds the
// images, reads each image's label, and fetches image bytes for the background
// worker. It never downloads anything itself.

(() => {
  // Skip if a live copy is already running in this tab. (A copy left over from
  // an older version of the extension is dead and gets replaced.)
  const prev = window.__imageNumberDownloader;
  if (prev && prev.alive()) return;

  /* =========================================================================
   * CONFIG - every selector, URL pattern and setting lives here.
   * ======================================================================= */
  const CONFIG = {
    // A label must START with digits and a colon: "23: Staff handing dial".
    // "(?!\d)" stops things like "16:9 wide shot" or "10:30" from counting.
    labelRegex: /^\s*(\d+)\s*:(?!\d)/,

    // Images smaller than this (width or height, in pixels) are ignored:
    // icons, avatars, logos. The popup can change it.
    defaultMinImageSize: 150,

    /* --------------------------- SITE PROFILES ---------------------------
     * The first profile whose urlPattern matches the page address is used.
     * Any selector left as '' falls back to generic detection, which works
     * on most sites without changes.
     *
     * To add your own site, copy the example at the bottom of the list and
     * fill in what you need:
     *   name          - shown in the popup
     *   urlPattern    - a regular expression tested against the full page URL,
     *                   or a list of them (the profile is used if ANY matches)
     *   card          - CSS selector for ONE image card (box that holds the image and its label)
     *   label         - CSS selector, inside a card, for the element with the "23: ..." text
     *   fullImage     - CSS selector, inside a card, for the full-size <img> or an <a href> to it
     *   gridContainer - CSS selector for the scrollable box around the images
     *   view          - (optional) sidebar check, see the Flow profile
     * After editing: chrome://extensions -> reload the extension -> reload the page.
     * ------------------------------------------------------------------- */
    profiles: [
      {
        name: 'Google Flow',
        // Flow lives at https://flow.google.com/project/<project-id>/collection/<collection-id>.
        // The IDs change for every project, so the patterns never contain an ID.
        // The second pattern (labs.google with "flow" in the path) is a backup
        // in case Google moves Flow back there.
        urlPattern: [
          /^https:\/\/flow\.google\.com(\/|$)/i,
          /^https:\/\/labs\.google\/[^?#]*flow/i,
        ],
        card: '',
        label: '',
        fullImage: '',
        gridContainer: '',
        // The extension warns (and asks for "Force scan anyway") when another
        // sidebar item than "Images" is selected.
        view: {
          sidebarLabels: ['All media', 'Images', 'Characters', 'Scenes', 'Tools', 'Bin'],
          required: 'Images',
        },
      },
      // Example - remove the // to use it:
      // {
      //   name: 'My gallery site',
      //   urlPattern: /^https:\/\/www\.example\.com\/gallery/i,
      //   card: '.gallery-item',
      //   label: '.caption',
      //   fullImage: 'a.full-size',
      //   gridContainer: '',
      // },
    ],

    /* ------------------------- GENERIC DETECTION ------------------------ */
    generic: {
      // Attributes on/near an image that may hold the full-size image URL.
      fullResAttributes: ['data-full-src', 'data-fullsrc', 'data-original', 'data-large', 'data-hires', 'data-zoom-src', 'data-src', 'data-lazy-src'],
      // Attributes on the image itself checked for a label (in this order).
      imageLabelAttributes: ['alt', 'title', 'aria-label'],
      // Attributes on the elements around the image checked for a label.
      containerLabelAttributes: ['aria-label', 'title', 'data-name', 'data-title'],
      // Things that are never the label (hover buttons, icons, menus).
      ignoreInCard: [
        'button button', '[role="button"] [role="button"]', 'button', '[role="button"]',
        '[role="menu"]', '[role="menuitem"]', '[role="tooltip"]', 'svg', 'i',
        '.material-icons', '[class*="material-symbols"]', '[class*="google-symbols"]',
        'script', 'style', 'template',
      ].join(', '),
      // How far up from the image to look for its label.
      maxLabelLevels: 8,

      // Turns a thumbnail URL into the full-size URL. Applies on every site.
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
    },

    // Auto-scrolling (images load lazily while scrolling).
    scroll: {
      stepFraction: 0.8,   // scroll this part of the visible height per step
      delayMs: 700,        // wait after each step for images to load
      bottomWaitMs: 1500,  // at the bottom, wait this long for more images
      bottomRetries: 3,    // give up after this many waits with nothing new
      maxSteps: 5000,      // safety limit
    },
  };
  /* ========================== end of CONFIG ============================= */

  const RE = CONFIG.labelRegex;
  const G = CONFIG.generic;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const alive = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };
  window.__imageNumberDownloader = { alive };

  let scanning = false;
  let stopFlag = false;
  let found = 0;

  const matchesUrl = (p, url) => [].concat(p.urlPattern || []).some((re) => re.test(url));
  const matchProfile = (url) => CONFIG.profiles.find((p) => matchesUrl(p, url)) || null;

  /* --------------------------- DOM helpers ------------------------------ */

  // All elements, including ones inside open shadow roots, in page order.
  function deepAll(root) {
    const out = [];
    const visit = (r) => {
      for (const el of r.querySelectorAll('*')) {
        out.push(el);
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    if (root.nodeType === 1) out.push(root);
    if (root.shadowRoot) visit(root.shadowRoot);
    visit(root);
    return out;
  }

  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (r) => {
      out.push(...r.querySelectorAll(selector));
      for (const el of r.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  }

  // Parent element, crossing shadow-root boundaries.
  const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  function isInside(node, ancestor) {
    for (let e = node; e; e = up(e)) if (e === ancestor) return true;
    return false;
  }

  function isIgnored(el, root) {
    for (let e = el; e && e !== root; e = up(e)) {
      if (e.matches && e.matches(G.ignoreInCard)) return true;
    }
    return false;
  }

  // Text of an element without hover buttons/icons. Uses textContent, so
  // CSS "..." truncation does not cut the label.
  function textOf(el) {
    let out = '';
    const visit = (n, isRoot) => {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType === 1 && !isRoot && n.matches(G.ignoreInCard)) return;
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.shadowRoot) visit(n.shadowRoot, false);
      for (const c of n.childNodes) visit(c, false);
    };
    visit(el, true);
    return norm(out);
  }

  const absolute = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  };

  const isPlaceholder = (url) =>
    !url || url === 'about:blank' || (url.startsWith('data:') && url.length < 300) || /^data:image\/svg/i.test(url);

  const IMAGE_LINK = /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i;

  function bgUrl(el) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') return null;
    const m = /url\(\s*["']?(.*?)["']?\s*\)/.exec(bg);
    return m ? m[1] : null;
  }

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

  /* --------------------------- view check ------------------------------- */

  function detectView(profile) {
    const v = profile && profile.view;
    if (!v) return { view: null, labels: [] };
    const byLabel = new Map();
    for (const el of deepQueryAll('a, button, li, [role="tab"], [role="button"], [role="option"], [role="menuitem"], [role="link"], [role="treeitem"]')) {
      const t = norm(el.textContent);
      const label = v.sidebarLabels.find((l) => t === l || (t.endsWith(l) && t.length <= l.length + 25));
      if (!label) continue;
      const p = byLabel.get(label);
      if (!p || isInside(el, p)) byLabel.set(label, el);
    }
    const labels = [...byLabel.keys()];
    if (labels.length < 2) return { view: null, labels };

    const activeSel = '[aria-selected="true"], [aria-current]:not([aria-current="false"]), [data-state="active"], [data-state="on"], [data-state="checked"], [aria-pressed="true"], [aria-checked="true"], [data-selected="true"], [data-active="true"]';
    const isActive = (el) => {
      for (let e = el, i = 0; e && i < 3; e = up(e), i++) if (e.matches(activeSel)) return true;
      return !!el.querySelector(activeSel);
    };
    const active = labels.filter((l) => isActive(byLabel.get(l)));
    if (active.length === 1) return { view: active[0], labels };

    // Fallback: the selected item usually looks different from the others.
    if (labels.length >= 3) {
      const sig = (el) => {
        const cs = getComputedStyle(el);
        return [cs.backgroundColor, cs.color, cs.fontWeight].join('|');
      };
      const sigs = labels.map((l) => sig(byLabel.get(l)));
      const unique = labels.filter((l, i) => sigs.filter((s) => s === sigs[i]).length === 1);
      if (unique.length === 1) return { view: unique[0], labels };
    }
    return { view: null, labels };
  }

  function checkPage() {
    const profile = matchProfile(location.href);
    const view = detectView(profile);
    let viewWarning = null;
    if (profile && profile.view && view.view && view.view !== profile.view.required) {
      viewWarning = `Open the ${profile.view.required} view first ("${view.view}" is selected now).`;
    }
    return { url: location.href, profile: profile ? profile.name : null, view: view.view, viewWarning };
  }

  /* --------------------------- finding images --------------------------- */

  // A media candidate: an <img> or an element with a CSS background image,
  // big enough, with a real (non-placeholder) URL.
  function mediaUrl(el) {
    if (el.tagName === 'IMG') {
      let u = el.currentSrc || el.getAttribute('src');
      if (isPlaceholder(u)) u = G.fullResAttributes.map((a) => el.getAttribute(a)).find((x) => x && !isPlaceholder(x));
      return u || null;
    }
    return bgUrl(el);
  }

  function findMedia(root, minSize, stats) {
    const out = [];
    for (const el of deepAll(root)) {
      const tag = el.tagName;
      if (tag === 'VIDEO' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SOURCE' || tag === 'svg') continue;
      const isImg = tag === 'IMG';
      if (!isImg) {
        // Background images: check size first (cheap), then the style.
        const r = el.getBoundingClientRect();
        if (r.width < minSize || r.height < minSize) continue;
      }
      const url = mediaUrl(el);
      if (!url || isPlaceholder(url)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < minSize || r.height < minSize) {
        if (isImg && stats && r.width > 0) stats.small.add(absolute(url));
        continue;
      }
      out.push({ el, thumb: absolute(url) });
    }
    return out;
  }

  // The card of an image: its biggest parent that holds no other image.
  function climbToCard(media, all) {
    const others = all.filter((m) => m !== media && m.thumb !== media.thumb).map((m) => m.el);
    let el = media.el;
    for (let p = up(el); p && p !== document.body && p !== document.documentElement; p = up(p)) {
      if (others.some((o) => isInside(o, p))) break;
      el = p;
    }
    return el;
  }

  const containsVideo = (card) => card.tagName === 'VIDEO' || deepAll(card).some((e) => e.tagName === 'VIDEO');

  // Returns [{ card, media }] in page order.
  function findCards(profile, minSize, dbg) {
    if (profile && profile.card) {
      const cards = deepQueryAll(profile.card);
      if (cards.length) {
        dbg.cardSource = `profile "${profile.name}" card selector: ${profile.card}`;
        return cards.map((card) => {
          let media = null;
          if (profile.fullImage) {
            const el = card.querySelector(profile.fullImage);
            if (el && el.tagName === 'IMG') media = { el, thumb: absolute(mediaUrl(el) || '') };
          }
          if (!media) {
            const inside = findMedia(card, 0, null).sort((a, b) => area(b.el) - area(a.el));
            media = inside[0] || null;
          }
          return { card, media };
        });
      }
      dbg.failedSelector = `card selector "${profile.card}" (profile "${profile.name}") matched 0 elements - used generic detection instead`;
    }
    dbg.cardSource = `generic: <img>, <picture> and background images at least ${minSize}px`;
    const media = findMedia(document, minSize, dbg.statsSets);
    return media.map((m) => ({ card: climbToCard(m, media), media: m }));
  }

  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };

  /* ---------------------------- full-size URL --------------------------- */

  function fullResUrl(media, card, profile) {
    const el = media.el;
    let url = null;

    // 1) profile selector for the full-size image or link
    if (profile && profile.fullImage) {
      const f = card.querySelector(profile.fullImage);
      if (f) url = f.tagName === 'A' ? f.getAttribute('href') : largestFromSrcset(f.getAttribute('srcset')) || f.currentSrc || f.getAttribute('src') || bgUrl(f);
    }
    // 2) a parent link pointing at an image
    if (!url) {
      for (let e = el, i = 0; e && i < 6; e = up(e), i++) {
        if (e.tagName === 'A') {
          const h = e.getAttribute('href') || '';
          if (IMAGE_LINK.test(h) || /^data:image\//i.test(h)) url = h;
          break;
        }
      }
    }
    // 3) data attributes
    if (!url) {
      for (const a of G.fullResAttributes) {
        const v = el.getAttribute(a);
        if (v && !isPlaceholder(v)) {
          url = v;
          break;
        }
      }
    }
    // 4) the largest srcset entry (including <picture><source>)
    if (!url && el.tagName === 'IMG') {
      const sets = [el.getAttribute('srcset')];
      if (el.parentElement && el.parentElement.tagName === 'PICTURE') {
        for (const s of el.parentElement.querySelectorAll('source')) sets.push(s.getAttribute('srcset'));
      }
      url = largestFromSrcset(sets.filter(Boolean).join(', '));
    }
    // 5) what is shown
    if (!url) url = media.thumb;
    return absolute(G.upgradeUrl(absolute(url)));
  }

  /* ------------------------------- labels ------------------------------- */

  // The innermost element inside root whose text starts with "number:".
  function findLabelIn(root) {
    let best = null;
    let bestText = '';
    for (const el of deepAll(root)) {
      if (el.tagName === 'IMG' || isIgnored(el, root)) continue;
      const t = textOf(el);
      if (t && RE.test(t) && (!best || isInside(el, best))) {
        best = el;
        bestText = t;
      }
    }
    return best ? bestText : null;
  }

  function attrLabel(el, attrs) {
    for (const a of attrs) {
      const v = norm(el.getAttribute && el.getAttribute(a));
      if (v && RE.test(v)) return v;
    }
    return null;
  }

  // Text to show for a card without a valid label (for "Needs renaming").
  function displayText(media, card) {
    let best = '';
    for (const el of deepAll(card)) {
      if (isIgnored(el, card)) continue;
      const own = norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(''));
      if (!own) continue;
      const t = textOf(el);
      if (t.length > best.length) best = t;
    }
    if (best) return best;
    for (const a of [...G.imageLabelAttributes, ...G.containerLabelAttributes]) {
      const v = norm(media.el.getAttribute(a) || card.getAttribute(a));
      if (v) return v;
    }
    return '';
  }

  // Finds the label: FIRST match of "digits:" in this order:
  //   the image's alt/title/aria-label -> each containing element up to the
  //   card (attributes, then text) -> text-only siblings of the card.
  function readLabel(media, card, profile) {
    const el = media.el;

    if (profile && profile.label) {
      const l = card.querySelector(profile.label);
      if (l) {
        const t = attrLabel(l, ['title', 'aria-label']) || textOf(l);
        return { text: t, num: RE.test(t) ? parseInt(RE.exec(t)[1], 10) : null };
      }
    }

    const hit = (t) => ({ text: t, num: parseInt(RE.exec(t)[1], 10) });

    let t = attrLabel(el, G.imageLabelAttributes);
    if (t) return hit(t);

    let level = 0;
    for (let e = up(el); e && level < G.maxLabelLevels; e = up(e), level++) {
      t = attrLabel(e, G.containerLabelAttributes) || findLabelIn(e);
      if (t) return hit(t);
      if (e === card) break;
    }

    // Siblings of the card, only if they hold no image (then they belong to this card).
    for (const sib of [card.previousElementSibling, card.nextElementSibling]) {
      if (!sib || deepAll(sib).some((x) => x.tagName === 'IMG')) continue;
      t = findLabelIn(sib);
      if (t) return hit(t);
    }

    return { text: displayText(media, card), num: null };
  }

  /* ------------------------------- scroll ------------------------------- */

  function isScrollable(el) {
    const oy = getComputedStyle(el).overflowY;
    return /(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 5;
  }

  function findScroller(profile, firstEl) {
    if (profile && profile.gridContainer) {
      const el = deepQueryAll(profile.gridContainer)[0];
      if (el) return el;
    }
    for (let e = firstEl && up(firstEl); e && e !== document.body; e = up(e)) {
      if (e.nodeType === 1 && isScrollable(e)) return e;
    }
    // No image yet: take the biggest scrollable box on the page.
    let best = null;
    for (const el of deepAll(document.body)) {
      if (el.clientHeight > 200 && isScrollable(el) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
    }
    const doc = document.scrollingElement || document.documentElement;
    if (best && best.scrollHeight - best.clientHeight > doc.scrollHeight - doc.clientHeight) return best;
    return doc;
  }

  const describe = (el) => {
    if (!el) return 'none';
    if (el === document.scrollingElement || el === document.documentElement) return 'the whole page';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}>`;
  };

  /* -------------------------------- scan -------------------------------- */

  async function scan({ minSize, force }) {
    minSize = Number(minSize) > 0 ? Number(minSize) : CONFIG.defaultMinImageSize;
    const profile = matchProfile(location.href);
    const dbg = {
      pageUrl: location.href,
      profile: profile ? profile.name : 'none (generic detection)',
      cardSource: '',
      failedSelector: null,
      cardsMatched: 0,
      withImage: 0,
      withLabel: 0,
      firstLabels: [],
      smallSkipped: 0,
      videosSkipped: 0,
      scroller: '',
      steps: 0,
      statsSets: { small: new Set() },
    };
    const finish = (r) => {
      dbg.smallSkipped = dbg.statsSets.small.size;
      delete dbg.statsSets;
      dbg.pageImages = deepQueryAll('img').length;
      dbg.iframes = document.querySelectorAll('iframe').length;
      return { ...r, debug: dbg, minSize, pageUrl: location.href, at: Date.now() };
    };

    if (!force) {
      const page = checkPage();
      if (page.viewWarning) return finish({ ok: false, code: 'wrong-view', error: page.viewWarning, items: [] });
    }

    const items = new Map();   // key (image URL) -> item
    const order = [];          // keys in page (DOM) order
    const seenCards = new WeakSet();
    const seenKeys = new Set();
    const videoKeys = new Set();

    const collect = () => {
      const cards = findCards(profile, minSize, dbg);
      let anchor = -1;         // index in `order` of the last known card in this pass
      let pendingNew = [];     // new keys seen before any known card in this pass
      for (const { card, media } of cards) {
        // Count each card once: by image URL, or by element when it has no image.
        // (Lazy grids re-create card elements while scrolling.)
        if (media && media.thumb && !isPlaceholder(media.thumb)) {
          if (!seenKeys.has(media.thumb)) {
            seenKeys.add(media.thumb);
            dbg.cardsMatched++;
          }
        } else {
          if (!seenCards.has(card)) {
            seenCards.add(card);
            dbg.cardsMatched++;
          }
          continue;
        }
        if (containsVideo(card)) {
          videoKeys.add(media.thumb);
          continue;
        }
        const key = media.thumb;
        if (items.has(key)) {
          const idx = order.indexOf(key);
          if (pendingNew.length) {
            order.splice(idx, 0, ...pendingNew);
            pendingNew = [];
          }
          anchor = order.indexOf(key);
          continue;
        }
        const label = readLabel(media, card, profile);
        items.set(key, { key, url: fullResUrl(media, card, profile), label: label.text, num: label.num });
        if (anchor >= 0) order.splice(++anchor, 0, key);
        else pendingNew.push(key);
      }
      // New cards with no known card in this pass go at the end.
      order.push(...pendingNew);
      found = items.size;
      chrome.runtime.sendMessage({ type: 'scanProgress', found }).catch(() => {});
    };

    collect();
    if (!items.size) {
      await sleep(1500);
      collect();
    }

    const firstEl = (() => {
      const m = findMedia(document, minSize, null)[0];
      return m ? m.el : null;
    })();
    const sc = findScroller(profile, firstEl);
    dbg.scroller = describe(sc);

    sc.scrollTop = 0;
    await sleep(CONFIG.scroll.delayMs);
    collect();

    const cs = CONFIG.scroll;
    let bottomTries = 0;
    for (let step = 0; step < cs.maxSteps && !stopFlag; step++) {
      dbg.steps = step + 1;
      const before = items.size;
      sc.scrollTop += Math.max(200, sc.clientHeight * cs.stepFraction);
      // Also fire the event ourselves: some lazy-loading grids only react to it.
      (sc === document.scrollingElement ? window : sc).dispatchEvent(new Event('scroll'));
      await sleep(cs.delayMs);
      collect();
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (!atBottom) {
        bottomTries = 0;
        continue;
      }
      const height = sc.scrollHeight;
      await sleep(cs.bottomWaitMs);
      collect();
      if (items.size === before && sc.scrollHeight === height) {
        if (++bottomTries >= cs.bottomRetries) break;
      } else {
        bottomTries = 0;
      }
    }
    sc.scrollTop = 0;

    const list = order.map((k) => items.get(k));
    dbg.videosSkipped = videoKeys.size;
    dbg.withImage = list.length;
    dbg.withLabel = list.filter((i) => i.num != null).length;
    dbg.firstLabels = list.filter((i) => i.label).slice(0, 3).map((i) => i.label);

    if (!list.length) {
      if (!dbg.failedSelector) {
        dbg.failedSelector = dbg.cardsMatched
          ? 'cards were found, but none had a readable image URL'
          : `no image at least ${minSize}px was found (generic detection)`;
      }
      return finish({ ok: false, code: 'no-images', error: 'No images found on this page.', items: [] });
    }
    return finish({ ok: true, stopped: stopFlag, profile: profile ? profile.name : null, items: list });
  }

  async function runScan(opts) {
    if (scanning) return { ok: false, error: 'A scan is already running.' };
    scanning = true;
    stopFlag = false;
    found = 0;
    let result;
    try {
      result = await scan(opts || {});
    } catch (e) {
      result = { ok: false, error: `Scan failed: ${e && e.message ? e.message : e}`, items: [], debug: { pageUrl: location.href } };
    } finally {
      scanning = false;
    }
    chrome.runtime.sendMessage({ type: 'scanDone', result }).catch(() => {});
    return result;
  }

  /* --------------------------- fetch bytes ------------------------------ */

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
      return { ok: true, base64: toBase64(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' };
    } catch (e) {
      return { ok: false, error: `page fetch failed: ${e && e.message ? e.message : e}` };
    }
  }

  /* ------------------------------ page info ----------------------------- */

  function shortHtml(el, max) {
    const clone = el.cloneNode(true);
    for (const e of [clone, ...clone.querySelectorAll('*')]) {
      for (const a of [...e.attributes]) {
        if (a.value.length > 160) e.setAttribute(a.name, `${a.value.slice(0, 120)}…[${a.value.length} chars]`);
      }
    }
    let html = clone.outerHTML;
    if (el.shadowRoot) html += `\n<!-- shadow root -->\n${el.shadowRoot.innerHTML.slice(0, 2000)}`;
    return html.length > max ? `${html.slice(0, max)}…[cut]` : html;
  }

  function pageInfo(minSize) {
    minSize = Number(minSize) > 0 ? Number(minSize) : CONFIG.defaultMinImageSize;
    const profile = matchProfile(location.href);
    const dbg = { statsSets: { small: new Set() } };
    const cards = findCards(profile, minSize, dbg);
    const page = checkPage();
    const out = [
      `URL: ${location.href}`,
      `Profile: ${profile ? profile.name : 'none (generic)'}; detected view: ${page.view || 'unknown'}`,
      `Card detection: ${dbg.cardSource}${dbg.failedSelector ? ` (${dbg.failedSelector})` : ''}`,
      `Cards now on screen: ${cards.length}; <img> on page: ${deepQueryAll('img').length}; small images skipped: ${dbg.statsSets.small.size}; iframes: ${document.querySelectorAll('iframe').length}`,
    ];
    cards.slice(0, 2).forEach(({ card, media }, i) => {
      const label = media ? readLabel(media, card, profile) : null;
      out.push('', `--- Sample card ${i + 1} ---`);
      out.push(`Label read: ${label ? JSON.stringify(label.text) : 'none'} -> number ${label && label.num != null ? label.num : 'NONE'}`);
      if (media) out.push(`Image URL: ${fullResUrl(media, card, profile).slice(0, 200)}`);
      out.push(shortHtml(card, 6000));
    });
    if (!cards.length) {
      // Nothing matched: show the biggest images and their surroundings.
      const imgs = deepQueryAll('img').sort((a, b) => area(b) - area(a)).slice(0, 2);
      imgs.forEach((img, i) => {
        let e = img;
        for (let k = 0; k < 4 && up(e) && up(e) !== document.body; k++) e = up(e);
        const r = img.getBoundingClientRect();
        out.push('', `--- Biggest <img> ${i + 1} (${Math.round(r.width)}x${Math.round(r.height)}px) with 4 parent levels ---`, shortHtml(e, 6000));
      });
      if (!imgs.length) out.push('', 'No <img> elements found on this page.');
    }
    if (profile && profile.view) {
      const item = deepQueryAll('a, button, li, [role="tab"]').find((el) => /Images$/.test(norm(el.textContent)) && norm(el.textContent).length < 40);
      if (item) out.push('', '--- Sidebar "Images" item (with parent) ---', shortHtml(up(item) || item, 3000));
    }
    return out.join('\n');
  }

  /* ------------------------------ messages ------------------------------ */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'ping':
        sendResponse({ ok: true, scanning, found });
        return;
      case 'checkPage':
        sendResponse(checkPage());
        return;
      case 'scan':
        runScan(msg).then(sendResponse);
        return true;
      case 'stopScan':
        stopFlag = true;
        sendResponse({ ok: true });
        return;
      case 'fetchImage':
        if (msg.via === 'numberer') return; // answered by the hand-numbering panel
        fetchImage(msg.url).then(sendResponse);
        return true;
      case 'pageInfo':
        sendResponse({ text: pageInfo(msg.minSize) });
        return;
    }
  });
})();
