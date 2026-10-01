// Flow Image Downloader - popup.

const $ = (id) => document.getElementById(id);

let tabId = null;
let scan = null;      // last scan result from the page
let job = null;       // download job state from the background worker
let scanning = false;
let viewOk = false;
let onFlow = false;

/* ------------------------------ helpers ------------------------------- */

function isFlowUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'labs.google' && /flow/i.test(u.pathname);
  } catch {
    return false;
  }
}

// Identifies the Flow project in a URL, so an old scan of another project isn't shown.
function projectKey(url) {
  try {
    const u = new URL(url);
    const m = /\/project\/[^/]+/.exec(u.pathname);
    return m ? m[0] : u.pathname;
  } catch {
    return url;
  }
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

function tabSend(msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => null);
}

function showMsg(kind, text) {
  const el = $('msg');
  el.className = `msg ${kind}`;
  el.textContent = text;
}

function clearMsg() {
  $('msg').className = 'msg hidden';
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Make the folder name safe for Windows/macOS/Linux. "a/b" makes a subfolder.
function sanitizeFolder(raw) {
  return (raw || '')
    .split(/[\\/]+/)
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/^\.+|[. ]+$/g, ''))
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

// Returns a whole number >= 1, null for empty, or NaN when invalid.
function readStart() {
  const v = $('start').value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : NaN;
}

/* -------------------------------- plan -------------------------------- */

function buildPlan(result, start) {
  const valid = [];
  const invalid = [];
  for (const it of result.items) (it.num != null ? valid : invalid).push(it);
  valid.sort((a, b) => a.order - b.order); // page (DOM) order decides duplicate order

  const finalOf = (n) => (start == null ? n : start + n - 1);
  const byNum = new Map();
  for (const it of valid) {
    if (!byNum.has(it.num)) byNum.set(it.num, []);
    byNum.get(it.num).push(it);
  }
  const nums = [...byNum.keys()].sort((a, b) => a - b);
  const minNum = nums.length ? nums[0] : null;
  const maxNum = nums.length ? nums[nums.length - 1] : null;
  const width = Math.max(3, String(maxNum == null ? 0 : finalOf(maxNum)).length);
  const pad = (n) => String(n).padStart(width, '0');

  const files = [];
  const dups = [];
  for (const n of nums) {
    const group = byNum.get(n);
    group.forEach((it, k) => {
      files.push({ filename: pad(finalOf(n)) + (k ? `-${k + 1}` : ''), url: it.url, name: it.name, num: n });
    });
    if (group.length > 1) dups.push({ n, group });
  }
  return { valid, invalid, byNum, minNum, maxNum, files, dups, pad, finalOf };
}

/* ------------------------------ rendering ----------------------------- */

function renderSummary() {
  if (!scan || !scan.ok) {
    $('summary').classList.add('hidden');
    updateButtons();
    return;
  }
  const start = readStart();
  const plan = buildPlan(scan, Number.isNaN(start) ? null : start);
  $('summary').classList.remove('hidden');

  $('sTotal').textContent = scan.items.length;
  $('sLow').textContent = plan.minNum == null ? '–' : plan.pad(plan.finalOf(plan.minNum));
  $('sHigh').textContent = plan.maxNum == null ? '–' : plan.pad(plan.finalOf(plan.maxNum));
  $('sFiles').textContent = plan.files.length;
  $('sRename').textContent = plan.invalid.length;

  // Number list from lowest to highest.
  const list = $('numList');
  list.textContent = '';
  let missing = 0;
  const MAX_CHIPS = 3000;
  if (plan.minNum != null) {
    for (let n = plan.minNum; n <= plan.maxNum; n++) {
      const g = plan.byNum.get(n);
      if (!g) missing++;
      if (n - plan.minNum >= MAX_CHIPS) continue;
      const label = plan.pad(plan.finalOf(n));
      const chip = g
        ? el('span', g.length > 1 ? 'chip dup' : 'chip', g.length > 1 ? `${label} ✓ (${g.length} versions)` : `${label} ✓`)
        : el('span', 'chip missing', `${label} MISSING`);
      chip.title = g ? g.map((i) => i.name).join('\n') : `No image named "${n}: …"`;
      list.appendChild(chip);
    }
  }
  $('sMissing').textContent = missing;

  const notes = $('sNotes');
  notes.textContent = '';
  if (plan.minNum != null && plan.minNum > 1) {
    notes.appendChild(el('p', null, `Note: no images named 1 to ${plan.minNum - 1} were found.`));
  }
  if (plan.maxNum != null && plan.maxNum - plan.minNum >= MAX_CHIPS) {
    notes.appendChild(el('p', null, `Showing the first ${MAX_CHIPS} numbers only.`));
  }
  if (scan.videosSkipped) notes.appendChild(el('p', null, `${scan.videosSkipped} video(s) ignored.`));
  if (scan.stopped) notes.appendChild(el('p', null, 'Scan was stopped early — the list may be incomplete.'));
  if (start != null && !Number.isNaN(start)) {
    notes.appendChild(el('p', null, `Start number ${start}: name 1 → ${plan.pad(start)}.`));
  }

  // Duplicates.
  const dupList = $('dupList');
  dupList.textContent = '';
  $('dupBlock').classList.toggle('hidden', !plan.dups.length);
  for (const d of plan.dups) {
    const base = plan.pad(plan.finalOf(d.n));
    const names = d.group.map((_, k) => (k ? `${base}-${k + 1}` : base)).join(', ');
    dupList.appendChild(el('li', null, `${base}: ${d.group.length} versions → ${names}`));
  }

  // Needs renaming.
  const renameList = $('renameList');
  renameList.textContent = '';
  $('renameBlock').classList.toggle('hidden', !plan.invalid.length);
  for (const it of plan.invalid) {
    renameList.appendChild(el('li', null, it.name ? `"${it.name}"` : '(no name found on the card)'));
  }

  updateButtons();
}

function renderJob() {
  if (!job) {
    $('progress').classList.add('hidden');
    $('report').classList.add('hidden');
    updateButtons();
    return;
  }
  $('progress').classList.remove('hidden');
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  $('barFill').style.width = `${pct}%`;
  $('counter').textContent = job.running
    ? `${job.done} / ${job.total}${job.stopRequested ? ' — stopping…' : ''}${job.round > 1 ? ' (retry)' : ''}`
    : `${job.done} / ${job.total}`;

  const finished = !job.running && job.finishedAt;
  $('report').classList.toggle('hidden', !finished);
  if (finished) {
    const failed = job.failed || [];
    $('rOk').textContent = job.okAll;
    $('rSkipped').textContent = (job.skippedNames || 0) + (job.notAttempted || 0);
    $('rFailed').textContent = failed.length;

    const notes = $('rNotes');
    notes.textContent = '';
    notes.appendChild(el('p', null, `Saved to Downloads/${job.folder}/`));
    if (job.skippedNames) notes.appendChild(el('p', null, `${job.skippedNames} skipped because the name needs renaming in Flow.`));
    if (job.notAttempted) notes.appendChild(el('p', null, `${job.notAttempted} not downloaded because you pressed Stop.`));
    if (job.duplicates) notes.appendChild(el('p', null, `${job.duplicates} extra duplicate version(s) saved as -2, -3, ….`));
    if (job.interrupted) notes.appendChild(el('p', null, 'Chrome interrupted the job. Use "Retry failed" to finish it.'));
    if (failed.some((f) => /403|FORBIDDEN|HTTP 4/i.test(f.error || ''))) {
      notes.appendChild(el('p', null, 'If retry keeps failing, the image links may have expired: click Scan again, then Download all.'));
    }

    const fl = $('failedList');
    fl.textContent = '';
    for (const f of failed) {
      const li = el('li', null, `${f.filename} `);
      li.appendChild(el('span', 'err', `— ${f.error || 'failed'}`));
      li.title = f.name || '';
      fl.appendChild(li);
    }
    $('retryBtn').classList.toggle('hidden', !failed.length);
  }
  updateButtons();
}

function updateButtons() {
  const running = !!(job && job.running);
  $('scanBtn').disabled = !onFlow || !viewOk || scanning || running;
  $('scanBtn').classList.toggle('hidden', scanning);
  $('stopScanBtn').classList.toggle('hidden', !scanning);
  const hasFiles = !!(scan && scan.ok && scan.items.some((i) => i.num != null));
  $('downloadBtn').disabled = !onFlow || !hasFiles || running || scanning;
  $('stopBtn').classList.toggle('hidden', !running);
  $('retryBtn').disabled = running || scanning;
}

function setScanning(on, found) {
  scanning = on;
  $('scanStatus').textContent = on ? `Scanning… ${found || 0} images found` : '';
  updateButtons();
}

function updateFolderPreview() {
  $('folderPreview').textContent = sanitizeFolder($('folder').value) || '…';
}

/* ------------------------------- actions ------------------------------ */

async function ensureContent() {
  let r = await tabSend({ type: 'ping' });
  if (r) return r;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    return null;
  }
  return tabSend({ type: 'ping' });
}

async function refreshView() {
  const v = await tabSend({ type: 'checkView' });
  if (!v) {
    viewOk = false;
    showMsg('error', 'Could not read the Flow page. Reload the page and try again.');
  } else if (v.view === 'Images') {
    viewOk = true;
    clearMsg();
  } else if (v.view) {
    viewOk = false;
    showMsg('error', `Open the Images view in Flow first. ("${v.view}" is selected in the left sidebar.)`);
  } else {
    viewOk = true;
    showMsg('warn', 'Could not confirm which view is open. Make sure "Images" is selected in Flow\'s left sidebar.');
  }
  updateButtons();
}

async function onScan() {
  await refreshView();
  if (!viewOk) return;
  scan = null;
  renderSummary();
  setScanning(true, 0);
  const res = await tabSend({ type: 'scan' });
  setScanning(false);
  if (!res) {
    showMsg('error', 'The scan stopped unexpectedly. Reload the Flow page and try again.');
    return;
  }
  if (!res.ok) {
    showMsg('error', res.error);
    return;
  }
  scan = res;
  if (!res.items.some((i) => i.num != null)) {
    showMsg('warn', 'Images were found, but none of the names start with "number:". See "Needs renaming in Flow".');
  }
  renderSummary();
}

async function onDownload() {
  const folder = sanitizeFolder($('folder').value);
  if (!folder) {
    showMsg('error', 'Enter a folder name first.');
    $('folder').focus();
    return;
  }
  const start = readStart();
  if (Number.isNaN(start)) {
    showMsg('error', 'Start number must be a whole number of 1 or more (or leave it empty).');
    $('start').focus();
    return;
  }
  if (!scan || !scan.ok) return;
  const plan = buildPlan(scan, start);
  if (!plan.files.length) {
    showMsg('error', 'Nothing to download: no image name starts with "number:".');
    return;
  }
  await chrome.storage.local.set({ folder: $('folder').value.trim() });
  clearMsg();
  const r = await send({
    type: 'startDownload',
    tabId,
    folder,
    files: plan.files,
    skippedNames: plan.invalid.length,
    duplicates: plan.files.length - plan.byNum.size,
  });
  if (!r || !r.ok) showMsg('error', (r && r.error) || 'Could not start the download.');
}

async function onRetry() {
  const r = await send({ type: 'retryFailed', tabId });
  if (!r || !r.ok) showMsg('error', (r && r.error) || 'Could not retry.');
}

async function onDebug() {
  const r = await tabSend({ type: 'debugInfo' });
  if (!r) {
    showMsg('error', 'Open your Flow project first.');
    return;
  }
  try {
    await navigator.clipboard.writeText(r.text);
    showMsg('info', 'Page info copied. Paste it into your message so the selectors can be fixed.');
  } catch {
    showMsg('error', 'Could not copy to the clipboard.');
  }
}

/* -------------------------------- init -------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'scanProgress' && sender.tab && sender.tab.id === tabId) {
    if (!scanning) setScanning(true, msg.found);
    else $('scanStatus').textContent = `Scanning… ${msg.found} images found`;
  } else if (msg.type === 'scanDone' && sender.tab && sender.tab.id === tabId && scanning) {
    // Popup was reopened during the scan: show the result when it arrives.
    setScanning(false);
    if (msg.result && msg.result.ok) {
      scan = msg.result;
      renderSummary();
    } else if (msg.result) {
      showMsg('error', msg.result.error);
    }
  } else if (msg.type === 'jobProgress') {
    job = msg.job;
    renderJob();
  }
});

async function init() {
  $('scanBtn').addEventListener('click', onScan);
  $('stopScanBtn').addEventListener('click', () => tabSend({ type: 'stopScan' }));
  $('downloadBtn').addEventListener('click', onDownload);
  $('stopBtn').addEventListener('click', () => send({ type: 'stopDownload' }));
  $('retryBtn').addEventListener('click', onRetry);
  $('debugBtn').addEventListener('click', onDebug);
  $('start').addEventListener('input', renderSummary);
  $('folder').addEventListener('input', updateFolderPreview);
  $('folder').addEventListener('change', () => chrome.storage.local.set({ folder: $('folder').value.trim() }));

  const { folder = '' } = await chrome.storage.local.get('folder');
  $('folder').value = folder;
  updateFolderPreview();

  job = await send({ type: 'getJob' });
  renderJob();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  if (!tab || !isFlowUrl(tab.url || '')) {
    showMsg('error', 'This is not a Google Flow page. Open your project at labs.google/flow, then click the extension again.');
    updateButtons();
    return;
  }

  const ping = await ensureContent();
  if (!ping) {
    showMsg('error', 'Could not connect to the Flow page. Reload the page and try again.');
    updateButtons();
    return;
  }
  onFlow = true;
  await refreshView();

  const stored = await send({ type: 'getScan', tabId });
  if (stored && stored.ok && projectKey(stored.pageUrl) === projectKey(tab.url)) {
    scan = stored;
    renderSummary();
  }
  if (ping.scanning) setScanning(true, ping.found);
  updateButtons();
}

document.addEventListener('DOMContentLoaded', init);
