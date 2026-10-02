// Image Number Downloader - background service worker.
// Runs the download job so it keeps going when the popup is closed.
//
// SAFETY: every file is saved under a name WE choose (001.png, 023-2.jpg, ...).
// The image is fetched first, its type is read from its bytes, and it is saved
// from a blob: URL with an explicit file name. After saving, the real file name
// is checked; if Chrome saved it under any other name, the file is deleted and
// counted as failed. The site's own file names are never used.

const BATCH_SIZE = 3;              // files downloaded at the same time
const BATCH_DELAY_MS = 500;        // pause between batches so Chrome doesn't skip files
const DOWNLOAD_TIMEOUT_MS = 180000;
const FILENAME_RE = /^\d{3,}(-\d+)?$/;

let job = null;
let jobLoaded = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e && e.message ? e.message : String(e));

/* ------------------------------ helpers ------------------------------- */

const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

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
      if (r && r.ok) return r;
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
      return { ok: true, base64: toBase64(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' };
    } catch (e) {
      errors.push(`extension: ${errText(e)}`);
    }
  }
  return { ok: false, error: errors.join('; ') };
}

/* ---------------------------- one download ---------------------------- */

async function downloadOne(file, folder, tabId, via) {
  const data = await getBytes(file.url, tabId, via);
  if (!data.ok) return { ok: false, error: data.error };

  const ext = sniffExt(data.base64);
  if (!ext) return { ok: false, error: `not a PNG/JPG/WEBP/GIF/AVIF image (${data.mime || 'unknown type'})` };

  const wanted = `${folder}/${file.filename}.${ext}`;
  let blobUrl;
  try {
    blobUrl = await makeBlobUrl(data.base64, EXT_MIME[ext]);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }

  let id;
  try {
    id = await chrome.downloads.download({ url: blobUrl, filename: wanted, saveAs: false, conflictAction: 'overwrite' });
  } catch (e) {
    revokeBlobUrl(blobUrl);
    return { ok: false, error: errText(e) };
  }
  const r = await waitForDownload(id);
  revokeBlobUrl(blobUrl);
  if (!r.ok) return { ok: false, error: r.error };

  // Check the name Chrome actually used. Wrong name -> delete the file.
  const [item] = await chrome.downloads.search({ id });
  const saved = ((item && item.filename) || '').replace(/\\/g, '/');
  if (!saved.endsWith(`/${wanted}`)) {
    await chrome.downloads.removeFile(id).catch(() => {});
    chrome.downloads.erase({ id }).catch(() => {});
    const got = saved.split('/').pop() || 'unknown';
    return { ok: false, error: `Chrome saved it as "${got}" instead of "${file.filename}.${ext}" (another extension may be renaming downloads) - file deleted` };
  }
  return { ok: true, id, saved: `${file.filename}.${ext}` };
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
        if (!r.ok && msg.fallbackUrl && msg.fallbackUrl !== msg.url) {
          const r2 = await downloadOne({ filename: msg.filename, url: msg.fallbackUrl }, msg.folder, tabId, 'numberer').catch((e) => ({ ok: false, error: errText(e) }));
          r = r2.ok ? { ...r2, usedFallback: true, fullResError: r.error } : { ok: false, error: `${r.error}; display-size URL: ${r2.error}` };
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
