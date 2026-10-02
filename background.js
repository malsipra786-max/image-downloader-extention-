// Image Number Downloader - background service worker.
// Runs the download job so it keeps going when the popup is closed.
//
// FILE NAMES: every file is saved under a name WE choose (001.png, 023-2.jpg, ...).
// The image is fetched first, its type is read from its bytes (or Content-Type),
// and it is saved from a blob: URL. The name is set twice:
//   1) the `filename` option of chrome.downloads.download, and
//   2) chrome.downloads.onDeterminingFilename + suggest(), which is the step
//      where Chrome really decides the name (without it, Chrome can fall back
//      to "<uuid>.jfif" for blob: URLs).
// Afterwards the saved name is checked. A wrong name is REPORTED, and the file
// is kept. Every step is logged and sent back to the caller.

const BATCH_SIZE = 3;              // files downloaded at the same time
const BATCH_DELAY_MS = 500;        // pause between batches so Chrome doesn't skip files
const DOWNLOAD_TIMEOUT_MS = 180000;
const FILENAME_RE = /^\d{3,}(-\d+)?$/;

let job = null;
let jobLoaded = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e && e.message ? e.message : String(e));

/* ------------------------------ helpers ------------------------------- */

const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };

// Content-Type -> file extension. JPEG has several names (Windows calls it
// ".jfif"); all of them are saved as .jpg.
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/jfif': 'jpg', 'image/pjp': 'jpg',
  'image/png': 'png', 'image/apng': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp',
};

// The file extension: from the file's first bytes, else from the Content-Type.
function pickExt(base64, mime) {
  const sniffed = sniffExt(base64);
  if (sniffed) return { ext: sniffed, how: 'from the file bytes' };
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXT[m]) return { ext: MIME_EXT[m], how: `from Content-Type ${m}` };
  const sub = /^image\/([a-z0-9]+)/.exec(m);
  if (sub) return { ext: sub[1], how: `from Content-Type ${m}` };
  return null;
}

// The real image type, read from the file's first bytes.
function sniffExt(base64) {
  let b;
  try {
    b = atob(base64.slice(0, 24));
  } catch {
    return null;
  }
  const c = (i) => b.charCodeAt(i);
  if (c(0) === 0x89 && b.slice(1, 4) === 'PNG') return 'png';
  if (c(0) === 0xff && c(1) === 0xd8 && c(2) === 0xff) return 'jpg';
  if (b.slice(0, 4) === 'RIFF' && b.slice(8, 12) === 'WEBP') return 'webp';
  if (b.slice(0, 4) === 'GIF8') return 'gif';
  if (b.slice(4, 12) === 'ftypavif' || b.slice(4, 12) === 'ftypavis') return 'avif';
  if (b.slice(0, 2) === 'BM') return 'bmp';
  return null;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Refuses the whole job if anything about the file list is unsafe.
function validateJob(folder, files) {
  if (!folder || /(^|\/)\.\.?(\/|$)/.test(folder) || /[<>:"\\|?*]/.test(folder)) return 'Invalid folder name.';
  if (!Array.isArray(files) || !files.length) return 'Nothing to download. Run a successful scan first.';
  const names = new Set();
  for (const f of files) {
    if (!f || typeof f.url !== 'string' || !f.url) return 'An image has no URL. Scan again.';
    if (typeof f.filename !== 'string' || !FILENAME_RE.test(f.filename)) {
      return `Refused: an image has no valid number (${JSON.stringify(f && f.filename)}). Nothing was downloaded.`;
    }
    if (names.has(f.filename)) return `Refused: two images would get the same name (${f.filename}).`;
    names.add(f.filename);
  }
  return null;
}

/* --------------------------- chrome.downloads -------------------------- */

// Our downloads in progress: blob URL -> { wanted, log, id, suggested }.
const pendingNames = new Map();

// Forces the exact file name. Chrome calls this for every download right when
// it picks the name; suggest() overrides whatever Chrome came up with.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let p = pendingNames.get(item.url) || pendingNames.get(item.finalUrl);
  if (!p) for (const x of pendingNames.values()) if (x.id === item.id) p = x;
  if (!p) return; // not ours: Chrome keeps its normal name
  p.suggested = true;
  p.log.push(`onDeterminingFilename: Chrome proposed "${item.filename}" (mime "${item.mime || '?'}") -> suggest("${p.wanted}")`);
  suggest({ filename: p.wanted, conflictAction: 'overwrite' });
});

function waitForDownload(id) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve({ id, ...r });
    };
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') finish({ ok: true });
      else if (d.state.current === 'interrupted') finish({ ok: false, error: (d.error && d.error.current) || 'INTERRUPTED' });
    };
    chrome.downloads.onChanged.addListener(onChanged);
    const timer = setTimeout(() => {
      chrome.downloads.cancel(id).catch(() => {});
      finish({ ok: false, error: 'TIMEOUT' });
    }, DOWNLOAD_TIMEOUT_MS);
    chrome.downloads.search({ id }).then(([it]) => {
      if (!it) return;
      if (it.state === 'complete') finish({ ok: true });
      else if (it.state === 'interrupted') finish({ ok: false, error: it.error || 'INTERRUPTED' });
    });
  });
}

/* ------------------------- blob URLs (offscreen) ----------------------- */

let offscreenReady = null;

// Creates the offscreen page once and waits until it answers.
function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const ctx = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) : [];
      if (!ctx.length) {
        await chrome.offscreen
          .createDocument({
            url: 'offscreen.html',
            reasons: ['BLOBS'],
            justification: 'Turn fetched image bytes into a file Chrome can download.',
          })
          .catch((e) => {
            if (!/single offscreen/i.test(errText(e))) throw e;
          });
      }
      for (let i = 0; i < 50; i++) {
        const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'ping' }).catch(() => null);
        if (r && r.ok) return;
        await sleep(100);
      }
      throw new Error('offscreen page did not start');
    })().catch((e) => {
      offscreenReady = null;
      throw e;
    });
  }
  return offscreenReady;
}

async function makeBlobUrl(base64, mime) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'makeBlobUrl', base64, mime }).catch(() => null);
  if (!r || !r.url) {
    offscreenReady = null; // it may have been closed; recreate next time
    throw new Error('could not prepare the file');
  }
  return r.url;
}

function revokeBlobUrl(url) {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => {});
}

/* ------------------------------ fetching ------------------------------ */

// `via` picks which script in the tab answers ('numberer' = hand-numbering panel).
async function getBytes(url, tabId, via) {
  const errors = [];
  // 1) Inside the page: works for blob:, data: and the page's own URLs.
  if (tabId != null) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'fetchImage', url, via });
      if (r && r.ok) return { ...r, source: 'the page' };
      errors.push(r ? r.error : 'no answer from the page (was it reloaded?)');
    } catch (e) {
      errors.push(`page: ${errText(e)}`);
    }
  }
  // 2) From the extension (no CORS limits).
  if (/^https?:/i.test(url)) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, base64: toBase64(await res.arrayBuffer()), mime: res.headers.get('content-type') || '', source: 'the extension' };
    } catch (e) {
      errors.push(`extension: ${errText(e)}`);
    }
  }
  return { ok: false, error: errors.join('; ') };
}

/* ---------------------------- one download ---------------------------- */

async function downloadOne(file, folder, tabId, via) {
  const log = [];
  const fail = (error, extra) => ({ ok: false, error, log, ...extra });
  log.push(`image URL: ${file.url.slice(0, 160)}`);

  const data = await getBytes(file.url, tabId, via);
  if (!data.ok) return fail(data.error);
  const kind = pickExt(data.base64, data.mime);
  log.push(`fetched ${Math.round((data.base64.length * 3) / 4)} bytes via ${data.source}, Content-Type "${data.mime || 'none'}"` +
    (kind ? `, type ${kind.ext} (${kind.how})` : ''));
  if (!kind) return fail(`not an image (Content-Type "${data.mime || 'unknown'}")`);

  const wanted = `${folder}/${file.filename}.${kind.ext}`;
  let blobUrl;
  try {
    blobUrl = await makeBlobUrl(data.base64, EXT_MIME[kind.ext] || (data.mime || '').split(';')[0] || 'application/octet-stream');
  } catch (e) {
    return fail(errText(e));
  }

  // Registered BEFORE the download starts: onDeterminingFilename can fire
  // before chrome.downloads.download() returns the id.
  const pending = { wanted, log, id: null, suggested: false };
  pendingNames.set(blobUrl, pending);
  let id;
  try {
    log.push(`chrome.downloads.download({ url: "${blobUrl}", filename: "${wanted}", saveAs: false, conflictAction: "overwrite" })`);
    id = await chrome.downloads.download({ url: blobUrl, filename: wanted, saveAs: false, conflictAction: 'overwrite' });
    pending.id = id;
    log.push(`-> download id ${id}`);
  } catch (e) {
    pendingNames.delete(blobUrl);
    revokeBlobUrl(blobUrl);
    log.push(`-> error: ${errText(e)}`);
    return fail(errText(e));
  }
  const r = await waitForDownload(id);
  pendingNames.delete(blobUrl);
  revokeBlobUrl(blobUrl);
  if (!pending.suggested) log.push('onDeterminingFilename did not fire for this download');
  if (!r.ok) {
    log.push(`-> download failed: ${r.error}`);
    return fail(r.error, { id });
  }

  // Check the name Chrome actually used. A wrong name is reported, the file is KEPT.
  const [item] = await chrome.downloads.search({ id });
  const full = (item && item.filename) || '';
  const saved = full.replace(/\\/g, '/');
  log.push(`Chrome saved the file as: "${full}"`);
  if (!saved.endsWith(`/${wanted}`)) {
    const got = saved.split('/').pop() || 'unknown';
    log.push(`NAME MISMATCH: wanted "${wanted}", got "${got}" (file kept)`);
    return fail(`saved as "${got}" instead of "${file.filename}.${kind.ext}" - file kept, see the debug log`, { id, mismatch: true, savedAs: got });
  }
  return { ok: true, id, saved: `${file.filename}.${kind.ext}`, log };
}

/* -------------------------------- job --------------------------------- */

async function saveJob() {
  await chrome.storage.session.set({ job }).catch(() => {});
}

function broadcast() {
  saveJob();
  chrome.runtime.sendMessage({ type: 'jobProgress', job }).catch(() => {});
}

async function loadJob() {
  if (jobLoaded) return;
  jobLoaded = true;
  const { job: saved } = await chrome.storage.session.get('job');
  if (saved && !job) {
    job = saved;
    if (job.running) {
      // Chrome stopped the worker mid-job: offer the rest through "Retry failed".
      job.running = false;
      job.stopRequested = false;
      job.interrupted = true;
      const rest = (job.pendingFiles || []).slice(job.done);
      job.failed = (job.failed || []).concat(rest.map((f) => ({ ...f, error: 'not downloaded (interrupted)' })));
      job.pendingFiles = null;
      job.notAttempted = 0;
      job.finishedAt = Date.now();
    }
  }
}

async function runJob(files) {
  Object.assign(job, {
    running: true,
    stopRequested: false,
    total: files.length,
    done: 0,
    ok: 0,
    failed: [],
    notAttempted: 0,
    finishedAt: null,
    pendingFiles: files,
  });
  broadcast();

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    if (job.stopRequested) break;
    const batch = files.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((f) => downloadOne(f, job.folder, job.tabId).catch((e) => ({ ok: false, error: errText(e) })))
    );
    results.forEach((r, k) => {
      job.done++;
      if (r.ok) {
        job.ok++;
        job.okAll++;
      } else {
        job.failed.push({ ...batch[k], error: r.error });
      }
    });
    broadcast();
    if (i + BATCH_SIZE < files.length) await sleep(BATCH_DELAY_MS);
  }

  job.notAttempted = job.total - job.done;
  job.running = false;
  job.stopRequested = false;
  job.pendingFiles = null;
  job.finishedAt = Date.now();
  broadcast();
}

/* ------------------------------ messages ------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;

  switch (msg.type) {
    case 'scanDone':
      if (sender.tab && msg.result) {
        chrome.storage.session.set({ [`scan_${sender.tab.id}`]: msg.result }).catch(() => {});
      }
      return;

    case 'getScan': {
      const key = `scan_${msg.tabId}`;
      chrome.storage.session.get(key).then((o) => sendResponse(o[key] || null));
      return true;
    }

    case 'getJob':
      loadJob().then(() => sendResponse(job));
      return true;

    case 'startDownload':
      loadJob().then(() => {
        if (job && job.running) {
          sendResponse({ ok: false, error: 'A download is already running.' });
          return;
        }
        const problem = validateJob(msg.folder, msg.files);
        if (problem) {
          sendResponse({ ok: false, error: problem });
          return;
        }
        job = {
          tabId: msg.tabId,
          folder: msg.folder,
          mode: msg.mode,
          skippedNames: msg.skippedNames || 0,
          duplicates: msg.duplicates || [],
          okAll: 0,
          round: 1,
        };
        runJob(msg.files);
        sendResponse({ ok: true });
      });
      return true;

    case 'retryFailed':
      loadJob().then(() => {
        if (!job || job.running || !job.failed || !job.failed.length) {
          sendResponse({ ok: false, error: 'Nothing to retry.' });
          return;
        }
        const files = job.failed.map(({ error, ...f }) => f);
        const problem = validateJob(job.folder, files);
        if (problem) {
          sendResponse({ ok: false, error: problem });
          return;
        }
        job.round++;
        job.interrupted = false;
        if (msg.tabId != null) job.tabId = msg.tabId;
        runJob(files);
        sendResponse({ ok: true });
      });
      return true;

    // One image from the hand-numbering panel (drag/drop or click mode).
    case 'saveImage': {
      const tabId = sender.tab ? sender.tab.id : null;
      const files = [{ filename: msg.filename, url: msg.url }];
      const problem = validateJob(msg.folder, files);
      if (problem) {
        sendResponse({ ok: false, error: problem });
        return;
      }
      (async () => {
        let r = await downloadOne(files[0], msg.folder, tabId, 'numberer').catch((e) => ({ ok: false, error: errText(e) }));
        // Full-size URL failed: try the URL shown on the page, and say so.
        // (Not when the file was saved under a wrong name: that file exists.)
        if (!r.ok && !r.mismatch && msg.fallbackUrl && msg.fallbackUrl !== msg.url) {
          const r2 = await downloadOne({ filename: msg.filename, url: msg.fallbackUrl }, msg.folder, tabId, 'numberer').catch((e) => ({ ok: false, error: errText(e) }));
          const log = [...(r.log || []), `full-size failed (${r.error}) - trying the display-size URL`, ...(r2.log || [])];
          r = r2.ok || r2.mismatch ? { ...r2, log, usedFallback: true, fullResError: r.error } : { ok: false, error: `${r.error}; display-size URL: ${r2.error}`, log };
        }
        sendResponse(r);
      })();
      return true;
    }

    // "Undo last" in the hand-numbering panel: delete the file it saved.
    case 'removeDownload':
      (async () => {
        try {
          await chrome.downloads.removeFile(msg.id);
        } catch {}
        await chrome.downloads.erase({ id: msg.id }).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;

    case 'stopDownload':
      if (job && job.running) {
        job.stopRequested = true;
        broadcast();
      }
      sendResponse({ ok: true });
      return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`scan_${tabId}`).catch(() => {});
});
