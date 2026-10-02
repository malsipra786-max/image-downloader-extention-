// Image Number Downloader - hand-numbering panel.
// Injected into the page by the popup ("Number by hand"). A floating panel:
// drag an image onto it, or turn on Click mode and click images, and each one
// is saved right away as the next number (001.png, 002.png, ...).

(() => {
  // Already open in this tab: just show it.
  const prev = window.__handNumberer;
  if (prev && prev.alive()) {
    prev.show();
    return;
  }

  /* =========================================================================
   * HAND-NUMBERING CONFIG
   * Flow is an Angular app: attributes like _ngcontent-ng-c2213854978 change
   * every time Google rebuilds the site, so they are NEVER used here.
   * ======================================================================= */
  const HAND_CONFIG = {
    // Images that can be numbered. Flow: <img class="image" data-media-id="...">.
    imageSelector: 'img.image, img[data-media-id]',
    // Attribute with a unique id per image (on the image or one of its parents).
    // Used to warn when the same image is numbered twice.
    mediaIdAttribute: 'data-media-id',
    // On other sites, any image at least this big (px) can be numbered.
    genericMinSize: 100,
    // Full resolution: Flow image URLs (flow.google.com/asb/...) end with a size
    // parameter like "=s1600-rw" or "=w400-h300-c". It is replaced by this.
    fullResParam: '=s0',
    sizeParamRegex: /=[a-z]\d+(?:-[a-z0-9]+)*$/i,
    // How long the green / red highlight stays on the image (ms).
    flashMs: { ok: 1200, fail: 3500 },
  };
  /* ======================================================================= */

  const STORE_KEY = 'handNumbering';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const alive = () => {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  };

  let host = null;     // panel host element (shadow DOM inside)
  let root = null;     // shadow root
  let hoverBox = null;
  let saveTimer = null;
  let lastDrag = null; // { img, at } - image the user started dragging on this page
  let dragStatus = { state: 'unknown', reason: '' };

  const state = {
    folder: '',
    start: 1,
    next: 1,
    clickMode: false,
    clickModeTouched: false, // user switched it by hand: don't auto-change it
    fullRes: true,
    pos: null,
    history: [],             // { n, filename, mediaId, url, displayUrl, status, saved, id, error, dupOf, usedFallback }
  };

  /* ------------------------------ helpers ------------------------------- */

  const pad = (n) => String(n).padStart(Math.max(3, String(n).length), '0');
  const $ = (sel) => root.querySelector(sel);

  function sanitizeFolder(raw) {
    return (raw || '')
      .split(/[\\/]+/)
      .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/^\.+|[. ]+$/g, ''))
      .filter((s) => s && s !== '.' && s !== '..')
      .join('/');
  }

  // "...=s1600-rw" -> "...=s0" (only when the URL ends with such a parameter).
  function fullResUrl(url) {
    const m = /^([^?#]*)(.*)$/.exec(url);
    if (!HAND_CONFIG.sizeParamRegex.test(m[1])) return url;
    return m[1].replace(HAND_CONFIG.sizeParamRegex, HAND_CONFIG.fullResParam) + m[2];
  }

  const srcOf = (img) => {
    try {
      return new URL(img.currentSrc || img.getAttribute('src') || '', location.href).href;
    } catch {
      return '';
    }
  };

  const isOurs = (el) => !!host && (el === host || host.contains(el));

  function isCandidate(img) {
    if (!img || img.tagName !== 'IMG' || isOurs(img)) return false;
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src || (src.startsWith('data:') && src.length < 300)) return false;
    if (img.matches(HAND_CONFIG.imageSelector)) return true;
    const r = img.getBoundingClientRect();
    return r.width >= HAND_CONFIG.genericMinSize && r.height >= HAND_CONFIG.genericMinSize;
  }

  function mediaIdOf(img) {
    const el = img.closest(`[${HAND_CONFIG.mediaIdAttribute}]`);
    return el ? el.getAttribute(HAND_CONFIG.mediaIdAttribute) : null;
  }

  const inRect = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  // The image under a point. Works even when a hover overlay covers the image
  // or the image has pointer-events: none.
  function imageAt(x, y) {
    const els = document.elementsFromPoint(x, y).filter((el) => !isOurs(el));
    for (const el of els) if (isCandidate(el)) return el;
    for (const el of els.slice(0, 8)) {
      const img = [...el.querySelectorAll('img')].find((i) => isCandidate(i) && inRect(i.getBoundingClientRect(), x, y));
      if (img) return img;
    }
    return null;
  }

  function pageImages() {
    const set = new Set(document.querySelectorAll(HAND_CONFIG.imageSelector));
    for (const img of document.querySelectorAll('img')) if (isCandidate(img)) set.add(img);
    return [...set].filter((i) => !isOurs(i));
  }

  /* ---------------------------- persistence ----------------------------- */

  async function load() {
    try {
      const o = await chrome.storage.local.get([STORE_KEY, 'folder']);
      Object.assign(state, o[STORE_KEY] || {});
      if (!state.folder && o.folder) state.folder = o.folder;
    } catch {}
    // Anything still "saving" from last time is unknown now.
    for (const h of state.history) if (h.status === 'pending') h.status = 'failed';
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const copy = { ...state, history: state.history.slice(-500) };
      chrome.storage.local.set({ [STORE_KEY]: copy }).catch(() => {});
    }, 200);
  }

  /* ------------------------------ feedback ------------------------------ */

  // Coloured box over the image: blue = saving, green = saved, red = failed.
  function flash(img, kind, text) {
    if (!img || !root || !img.isConnected) return;
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    let box = img.__hnBox;
    if (!box || !box.isConnected) {
      box = document.createElement('div');
      box.className = 'flash';
      box.appendChild(document.createElement('span'));
      root.appendChild(box);
      img.__hnBox = box;
    }
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.className = `flash ${kind}`;
    box.firstChild.textContent = text;
    clearTimeout(box.__t);
    if (kind !== 'pending') {
      box.__t = setTimeout(() => {
        box.remove();
        img.__hnBox = null;
      }, kind === 'ok' ? HAND_CONFIG.flashMs.ok : HAND_CONFIG.flashMs.fail);
    }
  }

  function setStatus(kind, text) {
    const el = $('.status');
    el.className = `status ${kind}`;
    el.textContent = text;
  }

  /* ------------------------------- saving ------------------------------- */

  async function saveImage(img, url) {
    const folder = sanitizeFolder(state.folder);
    if (!folder) {
      setStatus('error', 'Enter a folder name first.');
      $('.folder').focus();
      flash(img, 'fail', 'No folder name');
      return;
    }
    if (!url) {
      setStatus('error', 'Could not read the image address.');
      flash(img, 'fail', 'No image URL');
      return;
    }
    const n = state.next;
    state.next = n + 1;
    const mediaId = img ? mediaIdOf(img) : null;
    const earlier = mediaId ? state.history.find((h) => h.mediaId === mediaId && h.status !== 'failed') : null;
    const entry = {
      n,
      filename: pad(n),
      mediaId,
      displayUrl: url,
      url: state.fullRes ? fullResUrl(url) : url,
      status: 'pending',
      dupOf: earlier ? earlier.filename : null,
    };
    state.history.push(entry);
    render();
    save();
    if (earlier) setStatus('warn', `Warning: this image was already saved as ${earlier.filename}. Saving it again as ${entry.filename}.`);
    else setStatus('info', `Saving ${entry.filename}…`);
    flash(img, 'pending', `${entry.filename} …`);
    await send(entry, img, folder);
  }

  async function send(entry, img, folder) {
    entry.status = 'pending';
    render();
    let r;
    try {
      r = await chrome.runtime.sendMessage({
        type: 'saveImage',
        folder,
        filename: entry.filename,
        url: entry.url,
        fallbackUrl: entry.url !== entry.displayUrl ? entry.displayUrl : null,
      });
    } catch (e) {
      r = { ok: false, error: alive() ? String(e && e.message ? e.message : e) : 'The extension was reloaded - reload this page.' };
    }
    r = r || { ok: false, error: 'no answer from the extension' };
    entry.status = r.ok ? 'ok' : 'failed';
    entry.saved = r.saved || null;
    entry.id = r.id;
    entry.error = r.ok ? null : r.error;
    entry.usedFallback = !!r.usedFallback;
    entry.folder = folder;
    render();
    save();
    if (r.ok) {
      flash(img, 'ok', `${entry.filename} ✓`);
      let msg = `Saved ${folder}/${r.saved}`;
      if (entry.dupOf) msg += ` (same image as ${entry.dupOf})`;
      if (r.usedFallback) msg += ' - full size failed, saved the size shown on the page';
      setStatus(entry.dupOf || r.usedFallback ? 'warn' : 'ok', msg);
    } else {
      flash(img, 'fail', `${entry.filename} ✗`);
      setStatus('error', `${entry.filename} failed: ${r.error}. Click the red number to retry.`);
    }
  }

  async function undoLast() {
    const last = state.history[state.history.length - 1];
    if (!last) return;
    if (last.status === 'pending') {
      setStatus('warn', 'Wait until the last image has finished saving.');
      return;
    }
    state.history.pop();
    state.next = last.n;
    if (last.status === 'ok' && last.id != null) {
      await chrome.runtime.sendMessage({ type: 'removeDownload', id: last.id }).catch(() => {});
      setStatus('info', `Undid ${last.filename} (file deleted). Next number is ${pad(state.next)}.`);
    } else {
      setStatus('info', `Undid ${last.filename}. Next number is ${pad(state.next)}.`);
    }
    render();
    save();
  }

  /* ---------------------------- drag & drop ----------------------------- */

  // Works out whether dragging page images can work here.
  function detectDrag() {
    const imgs = pageImages().filter((i) => {
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    }).slice(0, 12);
    if (!imgs.length) return { state: 'unknown', reason: 'no images visible yet' };
    const noDrag = imgs.filter((i) => i.draggable === false || i.getAttribute('draggable') === 'false').length;
    if (noDrag > imgs.length / 2) return { state: 'blocked', reason: 'the images have draggable="false"' };
    const covered = imgs.filter((i) => {
      const r = i.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top && top !== i && !isOurs(top);
    }).length;
    if (covered > imgs.length / 2) return { state: 'blocked', reason: 'the images are covered by other elements' };
    return { state: 'ready', reason: '' };
  }

  function applyDetection(force) {
    const d = detectDrag();
    if (dragStatus.state === 'works') return;
    dragStatus = d;
    if (!state.clickModeTouched || force) {
      if (d.state === 'blocked') state.clickMode = true;
      else if (d.state === 'ready') state.clickMode = false;
    }
    render();
  }

  function onDragStart(e) {
    const t = e.composedPath()[0];
    if (!t || isOurs(t)) return;
    let img = t.tagName === 'IMG' ? t : null;
    if (!img && t.querySelector) img = [...t.querySelectorAll('img')].find(isCandidate) || null;
    if (img && isCandidate(img)) {
      lastDrag = { img, at: Date.now() };
      if (dragStatus.state !== 'works') {
        dragStatus = { state: 'works', reason: '' };
        render();
      }
    }
  }

  function urlFromDrop(dt) {
    const list = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
    if (list) return list.trim();
    const html = dt.getData('text/html');
    if (html) {
      const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
      if (m) return m[1].replace(/&amp;/g, '&');
    }
    const text = (dt.getData('text/plain') || '').trim();
    if (/^(https?:|data:image\/)/i.test(text)) return text;
    return null;
  }

  function onDrop(e) {
    e.preventDefault();
    $('.zone').classList.remove('over');
    let img = lastDrag && Date.now() - lastDrag.at < 60000 ? lastDrag.img : null;
    lastDrag = null;
    let url = img ? srcOf(img) : null;
    if (!url) {
      url = urlFromDrop(e.dataTransfer);
      if (url) {
        // Find the same image on the page, for the highlight and the duplicate check.
        img = pageImages().find((i) => srcOf(i) === url) || null;
      }
    }
    if (!url) {
      setStatus('error', 'That drop had no image in it. Use Click mode instead.');
      state.clickMode = true;
      state.clickModeTouched = true;
      render();
      save();
      return;
    }
    saveImage(img, url);
  }

  /* ------------------------------ click mode ---------------------------- */

  // A small button over the image (heart, reuse, menu) is left to Flow.
  function isSmallControl(target, img) {
    const ctl = target && target.closest && target.closest('button, [role="button"], a[href], [role="menuitem"]');
    if (!ctl || ctl.contains(img)) return false;
    const a = ctl.getBoundingClientRect();
    const b = img.getBoundingClientRect();
    return a.width * a.height < 0.25 * b.width * b.height;
  }

  function onPointer(e) {
    if (!state.clickMode || !host || e.button !== 0) return;
    if (e.composedPath().includes(host)) return;
    const img = imageAt(e.clientX, e.clientY);
    if (!img || isSmallControl(e.target, img)) return;
    // Stop Flow from opening the image: this click is ours.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type === 'click') saveImage(img, srcOf(img));
  }

  let hoverRaf = 0;
  function onMove(e) {
    if (!state.clickMode || !hoverBox) return;
    cancelAnimationFrame(hoverRaf);
    hoverRaf = requestAnimationFrame(() => {
      const img = e.composedPath().includes(host) ? null : imageAt(e.clientX, e.clientY);
      if (!img || isSmallControl(e.target, img)) {
        hoverBox.style.display = 'none';
        return;
      }
      const r = img.getBoundingClientRect();
      Object.assign(hoverBox.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      hoverBox.firstChild.textContent = `Click = save as ${pad(state.next)}`;
    });
  }

  function onKey(e) {
    if (e.key === 'Escape' && state.clickMode && !e.composedPath().includes(host)) {
      state.clickMode = false;
      state.clickModeTouched = true;
      render();
      save();
    }
  }

  /* ------------------------------- the panel ---------------------------- */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; z-index: 2147483647; width: 300px;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #1f1f1f; background: #fff; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.28); overflow: hidden;
    }
    .head {
      display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      background: #1a73e8; color: #fff; cursor: move; user-select: none; font-weight: 600;
    }
    .head .title { flex: 1; }
    .head button { all: unset; cursor: pointer; width: 22px; text-align: center; font-size: 16px; line-height: 22px; border-radius: 4px; }
    .head button:hover { background: rgba(255,255,255,.2); }
    .body { padding: 10px; }
    .panel.min .body { display: none; }
    label { display: block; font-weight: 600; font-size: 12px; margin-bottom: 6px; }
    input[type=text], input[type=number] {
      display: block; width: 100%; margin-top: 3px; padding: 5px 7px;
      border: 1px solid #c4c7c5; border-radius: 6px; font: inherit; color: inherit; background: #fff;
    }
    .row { display: flex; gap: 8px; align-items: flex-end; }
    .row > label { flex: 1; }
    .next { text-align: center; min-width: 96px; margin-bottom: 6px; }
    .next span { display: block; font-size: 11px; color: #5f6368; }
    .next b { display: block; font: 700 28px/1.1 ui-monospace, Menlo, Consolas, monospace; color: #1a73e8; }
    .zone {
      border: 2px dashed #8ab4f8; border-radius: 10px; padding: 18px 8px; margin: 4px 0 8px;
      text-align: center; color: #1a73e8; background: #f4f8fe; font-weight: 600;
    }
    .zone.over { background: #d2e3fc; border-color: #1a73e8; }
    .method { font-size: 12px; background: #f1f3f4; border-radius: 6px; padding: 5px 7px; margin-bottom: 6px; }
    .method.on { background: #e6f4ea; color: #137333; }
    .chk { display: flex; gap: 6px; align-items: center; font-weight: 400; }
    .status { font-size: 12px; min-height: 18px; padding: 4px 6px; border-radius: 6px; margin: 6px 0; word-break: break-word; }
    .status.ok { background: #e6f4ea; color: #137333; }
    .status.warn { background: #fef7e0; color: #7a4f01; }
    .status.error { background: #fce8e6; color: #a50e0e; }
    .status.info { background: #e8f0fe; color: #174ea6; }
    .list { display: flex; flex-wrap: wrap; gap: 4px; max-height: 110px; overflow-y: auto; margin-bottom: 8px; }
    .list:empty::before { content: "Nothing saved yet."; color: #888; font-size: 12px; }
    .chip { font: 11px/1 ui-monospace, Menlo, Consolas, monospace; padding: 4px 6px; border-radius: 4px; white-space: nowrap; }
    .chip.ok { background: #e6f4ea; color: #137333; }
    .chip.pending { background: #e8f0fe; color: #174ea6; }
    .chip.failed { background: #fce8e6; color: #a50e0e; cursor: pointer; font-weight: 700; }
    .chip.dup { outline: 1px solid #f9ab00; }
    .buttons { display: flex; gap: 6px; }
    .buttons button {
      flex: 1; padding: 6px 8px; border: 1px solid #c4c7c5; border-radius: 16px; background: #fff;
      font: 600 12px/1.2 system-ui, sans-serif; color: #1f1f1f; cursor: pointer;
    }
    .buttons button:hover { background: #f1f3f4; }
    .flash, .hover {
      position: fixed; z-index: 2147483646; pointer-events: none; border-radius: 6px;
      display: flex; align-items: flex-start; justify-content: flex-start;
    }
    .flash span, .hover span {
      font: 700 13px/1 system-ui, sans-serif; color: #fff; padding: 5px 7px; border-radius: 4px; margin: 6px;
    }
    .flash.pending { border: 4px solid #1a73e8; background: rgba(26,115,232,.15); }
    .flash.pending span { background: #1a73e8; }
    .flash.ok { border: 4px solid #1e8e3e; background: rgba(30,142,62,.25); }
    .flash.ok span { background: #1e8e3e; }
    .flash.fail { border: 4px solid #d93025; background: rgba(217,48,37,.25); }
    .flash.fail span { background: #d93025; }
    .hover { display: none; border: 3px dashed #1a73e8; }
    .hover span { background: #1a73e8; }
  `;

  const HTML = `
    <div class="panel">
      <div class="head"><span class="title">⠿ Number images by hand</span>
        <button class="min" title="Minimise">–</button><button class="close" title="Close">×</button></div>
      <div class="body">
        <label>Folder name <input class="folder" type="text" placeholder="e.g. My Flow project"></label>
        <div class="row">
          <label>Start number <input class="start" type="number" min="1" step="1"></label>
          <div class="next"><span>Next number</span><b class="nextNum">001</b></div>
        </div>
        <div class="zone">Drop an image here</div>
        <div class="method"></div>
        <label class="chk"><input class="clickMode" type="checkbox"> Click mode (click an image to save it)</label>
        <label class="chk"><input class="fullRes" type="checkbox"> Full resolution (replace "=s1600…" with "=s0")</label>
        <div class="status info">Saved to Downloads/&lt;folder&gt;/ as 001, 002, …</div>
        <div class="list"></div>
        <div class="buttons"><button class="undo">Undo last</button><button class="reset">Reset list</button></div>
      </div>
    </div>`;

  function render() {
    if (!root) return;
    $('.nextNum').textContent = pad(state.next);
    if (root.activeElement !== $('.folder')) $('.folder').value = state.folder;
    if (root.activeElement !== $('.start')) $('.start').value = state.start;
    $('.clickMode').checked = state.clickMode;
    $('.fullRes').checked = state.fullRes;

    const m = $('.method');
    let drag;
    if (dragStatus.state === 'works') drag = 'Drag & drop: works ✓';
    else if (dragStatus.state === 'blocked') drag = `Drag & drop: blocked here (${dragStatus.reason})`;
    else if (dragStatus.state === 'ready') drag = 'Drag & drop: ready - drag an image onto the box';
    else drag = `Drag & drop: not tested yet (${dragStatus.reason || 'try it'})`;
    m.textContent = state.clickMode
      ? `Active: CLICK MODE - click any image to save it as ${pad(state.next)}. Esc turns it off. (${drag})`
      : `Active: ${drag}`;
    m.className = `method${state.clickMode ? ' on' : ''}`;
    $('.zone').textContent = state.clickMode ? `Click an image (or drop one here) → ${pad(state.next)}` : `Drop an image here → ${pad(state.next)}`;

    const list = $('.list');
    list.textContent = '';
    for (const h of state.history.slice(-200)) {
      const chip = document.createElement('span');
      const mark = h.status === 'ok' ? '✓' : h.status === 'pending' ? '…' : '✗';
      chip.className = `chip ${h.status}${h.dupOf ? ' dup' : ''}`;
      chip.textContent = `${h.filename} ${mark}${h.dupOf ? ` =${h.dupOf}` : ''}${h.usedFallback ? ' (small)' : ''}`;
      chip.title = h.status === 'failed' ? `${h.error || 'failed'} - click to retry` : h.saved || h.url;
      if (h.status === 'failed') chip.addEventListener('click', () => retry(h));
      list.appendChild(chip);
    }
    list.scrollTop = list.scrollHeight;
    if (hoverBox && !state.clickMode) hoverBox.style.display = 'none';
  }

  function retry(entry) {
    const folder = sanitizeFolder(entry.folder || state.folder);
    if (!folder) return setStatus('error', 'Enter a folder name first.');
    const img = pageImages().find((i) => srcOf(i) === entry.displayUrl) || null;
    setStatus('info', `Retrying ${entry.filename}…`);
    flash(img, 'pending', `${entry.filename} …`);
    send(entry, img, folder);
  }

  function placePanel(panel) {
    const w = 300;
    const p = state.pos || { x: innerWidth - w - 20, y: 80 };
    const x = Math.min(Math.max(0, p.x), Math.max(0, innerWidth - w));
    const y = Math.min(Math.max(0, p.y), Math.max(0, innerHeight - 60));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  }

  function makeDraggable(panel) {
    const head = panel.querySelector('.head');
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      const move = (ev) => {
        state.pos = { x: ev.clientX - dx, y: ev.clientY - dy };
        placePanel(panel);
      };
      const upFn = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', upFn, true);
        save();
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', upFn, true);
    });
  }

  const POINTER_EVENTS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'];

  function attachListeners() {
    for (const t of POINTER_EVENTS) window.addEventListener(t, onPointer, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('dragstart', onDragStart, true);
  }

  function detachListeners() {
    for (const t of POINTER_EVENTS) window.removeEventListener(t, onPointer, true);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('dragstart', onDragStart, true);
  }

  async function open() {
    if (host && host.isConnected) return;
    await load();
    host = document.createElement('div');
    host.setAttribute('data-image-number-panel', '');
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    hoverBox = document.createElement('div');
    hoverBox.className = 'hover';
    hoverBox.appendChild(document.createElement('span'));
    root.appendChild(hoverBox);
    document.documentElement.appendChild(host);

    const panel = $('.panel');
    placePanel(panel);
    makeDraggable(panel);

    $('.folder').addEventListener('input', (e) => {
      state.folder = e.target.value;
      save();
    });
    $('.start').addEventListener('change', (e) => {
      const n = Number(e.target.value);
      if (!Number.isInteger(n) || n < 1) {
        setStatus('error', 'Start number must be a whole number of 1 or more.');
        e.target.value = state.start;
        return;
      }
      state.start = n;
      state.next = n;
      setStatus('info', `Next number set to ${pad(n)}.`);
      render();
      save();
    });
    $('.clickMode').addEventListener('change', (e) => {
      state.clickMode = e.target.checked;
      state.clickModeTouched = true;
      render();
      save();
    });
    $('.fullRes').addEventListener('change', (e) => {
      state.fullRes = e.target.checked;
      save();
    });
    $('.undo').addEventListener('click', undoLast);
    $('.reset').addEventListener('click', () => {
      if (state.history.some((h) => h.status === 'pending')) return setStatus('warn', 'Wait until saving has finished.');
      state.history = [];
      state.next = state.start;
      setStatus('info', `List cleared (files are kept). Next number is ${pad(state.next)}.`);
      render();
      save();
    });
    $('.min').addEventListener('click', () => panel.classList.toggle('min'));
    $('.close').addEventListener('click', close);

    const zone = $('.zone');
    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', onDrop);

    attachListeners();
    state.clickModeTouched = false; // re-detect each time the panel opens
    applyDetection(false);
    if (dragStatus.state === 'unknown') {
      // Images may still be loading.
      await sleep(1500);
      if (host) applyDetection(false);
    }
    render();
  }

  function close() {
    detachListeners();
    if (host) host.remove();
    host = null;
    root = null;
    hoverBox = null;
    save();
  }

  /* ------------------------------ messages ------------------------------ */

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'fetchImage' && msg.via === 'numberer') {
      (async () => {
        try {
          const res = await fetch(msg.url);
          if (!res.ok) return sendResponse({ ok: false, error: `HTTP ${res.status}` });
          sendResponse({ ok: true, base64: toBase64(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' });
        } catch (e) {
          sendResponse({ ok: false, error: `page fetch failed: ${e && e.message ? e.message : e}` });
        }
      })();
      return true;
    }
    if (msg.type === 'openHandPanel') {
      open().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  window.__handNumberer = { alive, show: () => open() };
  open();
})();
