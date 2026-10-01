// Flow Image Downloader - background service worker.
// Runs the download job so it keeps going when the popup is closed.

const BATCH_SIZE = 3;              // files downloaded at the same time
const BATCH_DELAY_MS = 500;        // pause between batches so Chrome doesn't skip files
const DOWNLOAD_TIMEOUT_MS = 180000;

let job = null;
let jobLoaded = false;

// Direct downloads waiting for Chrome to pick a file name: url -> [pending]
const pendingByUrl = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ helpers ------------------------------- */

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };

function extFromMime(mime) {
  return MIME_EXT[(mime || '').split(';')[0].trim().toLowerCase()] || null;
}

function extFromName(name) {
  const m = /\.(png|jpe?g|webp|gif|avif)$/i.exec(name || '');
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null;
}

function guessExtFromUrl(url) {
  try {
    if (url.startsWith('data:')) return extFromMime(url.slice(5).split(/[;,]/)[0]) || 'png';
    return extFromName(new URL(url).pathname) || 'png';
  } catch {
    return 'png';
  }
}

// Detect the real image type from the file's first bytes.
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
  if (b.slice(4, 12) === 'ftypavif') return 'avif';
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

const errText = (e) => (e && e.message ? e.message : String(e));

/* ---------------------------- file naming ----------------------------- */

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const list = pendingByUrl.get(item.url);
  if (!list) return; // not ours: Chrome keeps its normal name
  const p = list.find((x) => x.id === item.id) || list.find((x) => !x.claimed);
  if (!p) return;
  p.claimed = true;
  p.mime = item.mime || '';
  const ext = p.fixedExt || extFromMime(item.mime) || extFromName(item.filename) || p.fallbackExt;
  suggest({ filename: `${p.base}.${ext}`, conflictAction: 'overwrite' });
});

function addPending(url, p) {
  if (!pendingByUrl.has(url)) pendingByUrl.set(url, []);
  pendingByUrl.get(url).push(p);
}

function removePending(url, p) {
  const list = pendingByUrl.get(url);
  if (!list) return;
  const i = list.indexOf(p);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) pendingByUrl.delete(url);
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

async function startAndWait(url, filename, pending) {
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'overwrite' });
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  if (id === undefined) return { ok: false, error: 'Download did not start' };
  if (pending) pending.id = id;
  return waitForDownload(id);
}

/* ------------------------- blob URLs (offscreen) ----------------------- */

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length) return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Turn fetched image bytes into a file Chrome can download.',
      })
      .catch((e) => {
        if (!/single offscreen/i.test(errText(e))) throw e;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function makeBlobUrl(base64, mime) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'makeBlobUrl', base64, mime });
  if (!r || !r.url) throw new Error('Could not prepare the file');
  return r.url;
}

function revokeBlobUrl(url) {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url }).catch(() => {});
}

/* ------------------------------ fetching ------------------------------ */

async function getBytes(url, tabId) {
  const errors = [];
  // 1) Inside the Flow page: works for blob:, data: and the page's own URLs.
  if (tabId != null) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'fetchImage', url });
      if (r && r.ok) return r;
      errors.push(r ? r.error : 'no answer from page');
    } catch (e) {
      errors.push(`page: ${errText(e)}`);
    }
  }
  // 2) From the extension (no CORS limits for allowed hosts).
  if (/^https?:/i.test(url)) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return { ok: true, base64: toBase64(buf), mime: res.headers.get('content-type') || '' };
    } catch (e) {
      errors.push(`extension: ${errText(e)}`);
    }
  }
  return { ok: false, error: errors.join('; ') };
}

/* ---------------------------- one download ---------------------------- */

async function downloadOne(file, folder, tabId) {
  const base = `${folder}/${file.filename}`;
  const url = file.url;
  let firstError = '';

  // https: let Chrome download the URL directly (keeps the original file).
  if (/^https?:/i.test(url)) {
    const pending = { base, fallbackExt: guessExtFromUrl(url) };
    addPending(url, pending);
    const r = await startAndWait(url, `${base}.${pending.fallbackExt}`, pending);
    removePending(url, pending);
    if (r.ok) {
      if (!pending.mime || /^image\//i.test(pending.mime)) return { ok: true };
      // The server sent something that isn't an image (e.g. a sign-in page).
      await chrome.downloads.removeFile(r.id).catch(() => {});
      firstError = `not an image (${pending.mime})`;
    } else {
      firstError = r.error;
    }
    if (r.id !== undefined) chrome.downloads.erase({ id: r.id }).catch(() => {});
  }

  // blob:, data:, or a failed direct download: fetch the bytes, then save them.
  const data = await getBytes(url, tabId);
  if (!data.ok) return { ok: false, error: [firstError, data.error].filter(Boolean).join('; ') };
  const ext = sniffExt(data.base64) || extFromMime(data.mime);
  if (!ext) return { ok: false, error: `not an image (${data.mime || 'unknown type'})` };

  let blobUrl;
  try {
    blobUrl = await makeBlobUrl(data.base64, EXT_MIME[ext]);
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
  // Registered too: once onDeterminingFilename has a listener, Chrome only keeps
  // the name we suggest there.
  const pending = { base, fixedExt: ext };
  addPending(blobUrl, pending);
  const r = await startAndWait(blobUrl, `${base}.${ext}`, pending);
  removePending(blobUrl, pending);
  revokeBlobUrl(blobUrl);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/* -------------------------------- job --------------------------------- */

function publicJob() {
  return job;
}

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
      // The browser stopped the worker mid-job; whatever wasn't done counts as not downloaded.
      job.running = false;
      job.stopRequested = false;
      job.interrupted = true;
      // Offer the files that weren't reached through "Retry failed".
      const rest = (job.pendingFiles || []).slice(job.done);
      job.failed = (job.failed || []).concat(rest.map((f) => ({ ...f, error: 'not downloaded (interrupted)' })));
      job.pendingFiles = null;
      job.notAttempted = 0;
      job.finishedAt = Date.now();
    }
  }
}

async function runJob(files) {
  job.running = true;
  job.stopRequested = false;
  job.total = files.length;
  job.done = 0;
  job.ok = 0;
  job.failed = [];
  job.notAttempted = 0;
  job.finishedAt = null;
  job.pendingFiles = files;
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
      if (sender.tab && msg.result && msg.result.ok) {
        chrome.storage.session.set({ [`scan_${sender.tab.id}`]: msg.result }).catch(() => {});
      }
      return;

    case 'getScan': {
      const key = `scan_${msg.tabId}`;
      chrome.storage.session.get(key).then((o) => sendResponse(o[key] || null));
      return true;
    }

    case 'getJob':
      loadJob().then(() => sendResponse(publicJob()));
      return true;

    case 'startDownload':
      loadJob().then(() => {
        if (job && job.running) {
          sendResponse({ ok: false, error: 'A download is already running.' });
          return;
        }
        job = {
          tabId: msg.tabId,
          folder: msg.folder,
          skippedNames: msg.skippedNames || 0,
          duplicates: msg.duplicates || 0,
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
        job.round++;
        job.interrupted = false;
        if (msg.tabId != null) job.tabId = msg.tabId;
        runJob(files);
        sendResponse({ ok: true });
      });
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
