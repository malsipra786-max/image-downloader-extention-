// Image Number Downloader - popup.

const $ = (id) => document.getElementById(id);
const MODE_NAMES = {
  label: 'Use label numbers',
  order: 'Page order (oldest first)',
  reverse: 'Page order (reverse)',
};

let tabId = null;
let tabUrl = '';
let connected = false;
let scan = null;      // last scan result (successful or not)
let job = null;       // download job from the background worker
let scanning = false;
let watchingScan = false; // popup opened during a scan started earlier

/* ------------------------------ helpers ------------------------------- */

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
const tabSend = (msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => null);

function showMsg(kind, text) {
  $('msg').className = `msg ${kind}`;
  $('msg').textContent = text;
}
const clearMsg = () => ($('msg').className = 'msg hidden');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Page address without query/hash: a stored scan is only reused on the same page.
const pageKey = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
};

// Make the folder name safe for Windows/macOS/Linux. "a/b" makes a subfolder.
function sanitizeFolder(raw) {
  return (raw || '')
    .split(/[\\/]+/)
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/^\.+|[. ]+$/g, ''))
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');
}

// Whole number >= 1, null for empty, NaN when invalid.
function readStart() {
  const v = $('start').value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : NaN;
}

function readMinSize() {
  const n = Number($('minSize').value);
  return Number.isInteger(n) && n > 0 ? n : 150;
}

const scanOk = () => !!(scan && scan.ok && scan.items && scan.items.length);
const scanStale = () => scanOk() && scan.minSize !== readMinSize();

/* -------------------------------- plan -------------------------------- */

// Turns the scan into the list of files. Every file gets a number or the
// plan reports an error - there is no "unnamed" file.
function buildPlan(result, mode, start) {
  const items = result.items; // page (DOM) order
  const entries = [];
  const needsRename = [];
  if (mode === 'label') {
    for (const it of items) (Number.isInteger(it.num) ? entries.push({ it, base: it.num }) : needsRename.push(it));
  } else if (mode === 'order') {
    items.forEach((it, i) => entries.push({ it, base: i + 1 }));
  } else {
    items.forEach((it, i) => entries.push({ it, base: items.length - i }));
  }

  const finalOf = (b) => (start == null ? b : start + b - 1);
  const groups = new Map(); // final number -> entries in page order
  for (const e of entries) {
    const f = finalOf(e.base);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(e);
  }
  const finals = [...groups.keys()].sort((a, b) => a - b);
  const maxFinal = finals.length ? finals[finals.length - 1] : 0;
  const width = Math.max(3, String(maxFinal).length);
  const pad = (n) => String(n).padStart(width, '0');

  const files = [];
  const dups = [];
  const errors = [];
  for (const f of finals) {
    const g = groups.get(f);
    if (!Number.isSafeInteger(f) || f < 0) {
      errors.push(`Bad number ${f} for "${g[0].it.label}"`);
      continue;
    }
    g.forEach((e, k) => {
      files.push({ filename: pad(f) + (k ? `-${k + 1}` : ''), url: e.it.url, label: e.it.label, base: e.base });
    });
    if (g.length > 1) dups.push({ f, names: g.map((_, k) => pad(f) + (k ? `-${k + 1}` : '')), labels: g.map((e) => e.it.label) });
  }
  return { mode, start, files, finals, groups, needsRename, dups, errors, pad, min: finals[0], max: maxFinal };
}

/* ------------------------------ rendering ----------------------------- */

function renderDebug() {
  const d = scan && scan.debug;
  $('debug').classList.toggle('hidden', !d);
  if (!d) return;
  const rows = [
    ['Page URL detected', d.pageUrl],
    ['Site profile', d.profile],
    ['Card detection', d.cardSource || '–'],
    ['Cards matched', d.cardsMatched],
    ['…with a readable image', d.withImage],
    ['…with a readable label ("N: …")', d.withLabel],
    ['First 3 labels (raw text)', (d.firstLabels || []).map((t) => `“${t}”`).join('\n') || '(none)'],
    ['Small images skipped', d.smallSkipped],
    ['Videos skipped', d.videosSkipped],
    ['<img> elements on page', d.pageImages],
    ['iframes on page', d.iframes],
    ['Scrolled box', `${d.scroller || '–'} (${d.steps || 0} steps)`],
  ];
  if (d.failedSelector) rows.unshift(['FAILED', d.failedSelector]);
  const t = $('debugTable');
  t.textContent = '';
  for (const [k, v] of rows) {
    const tr = el('tr', k === 'FAILED' ? 'bad' : null);
    tr.appendChild(el('td', null, k));
    const td = el('td', null, String(v == null ? '–' : v));
    td.style.whiteSpace = 'pre-wrap';
    tr.appendChild(td);
    t.appendChild(tr);
  }
  $('debug').open = !scanOk() || !!d.failedSelector || (scan.items && d.withLabel === 0);
}

function renderSummary() {
  renderDebug();
  if (!scanOk()) {
    $('summary').classList.add('hidden');
    updateButtons();
    return;
  }
  const mode = $('mode').value;
  const start = readStart();
  const plan = buildPlan(scan, mode, Number.isNaN(start) ? null : start);
  $('summary').classList.remove('hidden');

  $('sMode').textContent = `Mode: ${MODE_NAMES[mode]}`;
  $('sTotal').textContent = scan.items.length;
  $('sLow').textContent = plan.files.length ? plan.pad(plan.min) : '–';
  $('sHigh').textContent = plan.files.length ? plan.pad(plan.max) : '–';
  $('sFiles').textContent = plan.files.length;
  $('sRename').textContent = mode === 'label' ? plan.needsRename.length : 0;

  // Number chips from lowest to highest.
  const list = $('numList');
  list.textContent = '';
  let missing = 0;
  const MAX_CHIPS = 3000;
  if (plan.files.length) {
    for (let f = plan.min, n = 0; f <= plan.max; f++, n++) {
      const g = plan.groups.get(f);
      if (!g) missing++;
      if (n >= MAX_CHIPS) continue;
      const chip = g
        ? el('span', g.length > 1 ? 'chip dup' : 'chip', g.length > 1 ? `${plan.pad(f)} ✓ (${g.length} versions)` : `${plan.pad(f)} ✓`)
        : el('span', 'chip missing', `${plan.pad(f)} MISSING`);
      chip.title = g ? g.map((e) => e.it.label || '(no label)').join('\n') : 'No image with this number';
      list.appendChild(chip);
    }
  }
  $('sMissing').textContent = missing;

  // Preview: first 5 and last 5 files.
  const pv = $('preview');
  pv.textContent = '';
  const line = (f) => el('li', null, `${f.filename} ← ${f.label || '(no label)'}`);
  const fs = plan.files;
  if (fs.length <= 10) fs.forEach((f) => pv.appendChild(line(f)));
  else {
    fs.slice(0, 5).forEach((f) => pv.appendChild(line(f)));
    pv.appendChild(el('li', 'gap', `… ${fs.length - 10} more …`));
    fs.slice(-5).forEach((f) => pv.appendChild(line(f)));
  }

  const notes = $('sNotes');
  notes.textContent = '';
  const note = (t) => notes.appendChild(el('p', null, t));
  if (mode === 'label' && plan.files.length && plan.min > (start == null ? 1 : start)) {
    note(`Note: numbers ${plan.pad(start == null ? 1 : start)} to ${plan.pad(plan.min - 1)} were not found.`);
  }
  if (mode !== 'label') note(`Labels are ignored in this mode. ${mode === 'order' ? 'First' : 'Last'} card on the page = ${plan.pad(start == null ? 1 : start)}.`);
  if (start != null && !Number.isNaN(start)) note(`Start number ${start}: base 1 → ${plan.pad(start)}.`);
  if (scan.debug && scan.debug.videosSkipped) note(`${scan.debug.videosSkipped} video(s) ignored.`);
  if (scan.stopped) note('Scan was stopped early - the list may be incomplete.');
  if (scanStale()) note('Min image size changed since this scan - click Scan again.');

  // Duplicates (label mode only).
  $('dupBlock').classList.toggle('hidden', !plan.dups.length);
  $('dupList').textContent = '';
  for (const d of plan.dups) $('dupList').appendChild(el('li', null, `${d.names.join(', ')}  (${d.labels.join(' | ')})`));

  // Needs renaming (label mode only).
  const showRename = mode === 'label' && plan.needsRename.length > 0;
  $('renameBlock').classList.toggle('hidden', !showRename);
  $('renameList').textContent = '';
  if (showRename) {
    for (const it of plan.needsRename) {
      $('renameList').appendChild(el('li', null, it.label ? `“${it.label}”` : '(no label text found on the card)'));
    }
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
  $('barFill').style.width = `${job.total ? Math.round((job.done / job.total) * 100) : 0}%`;
  $('counter').textContent = `${job.done} / ${job.total}${job.running && job.stopRequested ? ' - stopping…' : ''}${job.running && job.round > 1 ? ' (retry)' : ''}`;

  const finished = !job.running && job.finishedAt;
  $('report').classList.toggle('hidden', !finished);
  if (finished) {
    const failed = job.failed || [];
    $('rOk').textContent = job.okAll;
    $('rSkipped').textContent = (job.skippedNames || 0) + (job.notAttempted || 0);
    $('rFailed').textContent = failed.length;

    const notes = $('rNotes');
    notes.textContent = '';
    const note = (t) => notes.appendChild(el('p', null, t));
    note(`Saved to Downloads/${job.folder}/ (${MODE_NAMES[job.mode] || ''})`);
    if (job.skippedNames) note(`${job.skippedNames} skipped: label doesn't start with "number:" (needs renaming in Flow).`);
    if (job.notAttempted) note(`${job.notAttempted} not downloaded because you pressed Stop.`);
    if (job.interrupted) note('Chrome interrupted the job. Use "Retry failed" to finish it.');
    if (failed.some((f) => /403|HTTP 4/i.test(f.error || ''))) note('If retry keeps failing, the image links may have expired: Scan again, then Download all.');

    $('rDups').textContent = '';
    if (job.duplicates && job.duplicates.length) {
      note('Duplicates saved:');
      for (const d of job.duplicates) $('rDups').appendChild(el('li', null, d));
    }
    $('failedList').textContent = '';
    for (const f of failed) {
      const li = el('li', null, `${f.filename} `);
      li.appendChild(el('span', 'err', `- ${f.error || 'failed'}`));
      li.title = f.label || '';
      $('failedList').appendChild(li);
    }
    $('retryBtn').classList.toggle('hidden', !failed.length);
  }
  updateButtons();
}

function updateButtons() {
  const running = !!(job && job.running);
  $('scanBtn').disabled = !connected || scanning || running;
  $('forceBtn').disabled = !connected || scanning || running;
  $('scanBtn').classList.toggle('hidden', scanning);
  $('stopScanBtn').classList.toggle('hidden', !scanning);
  $('stopBtn').classList.toggle('hidden', !running);
  $('retryBtn').disabled = running || scanning;

  let hint = '';
  if (!connected) hint = '';
  else if (scanning) hint = 'Scanning…';
  else if (!scan) hint = 'Run Scan first.';
  else if (!scanOk()) hint = 'Last scan found no images - nothing to download.';
  else if (scanStale()) hint = 'Settings changed - Scan again.';
  else {
    const start = readStart();
    const plan = buildPlan(scan, $('mode').value, Number.isNaN(start) ? null : start);
    if (!plan.files.length) hint = 'No image has a usable number - nothing to download.';
    else if (plan.errors.length) hint = 'Some numbers are invalid - see the summary.';
  }
  $('downloadHint').textContent = running ? '' : hint;
  $('downloadBtn').disabled = !connected || running || scanning || !!hint;
}

function setScanning(on, found) {
  scanning = on;
  $('scanStatus').textContent = on ? `Scanning… ${found || 0} images found` : '';
  updateButtons();
}

/* ------------------------------- actions ------------------------------ */

async function connect() {
  let r = await tabSend({ type: 'ping' });
  if (r) return r;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    return null;
  }
  return tabSend({ type: 'ping' });
}

async function refreshPage() {
  const p = await tabSend({ type: 'checkPage' });
  const note = $('pageNote');
  if (!p) return;
  if (p.profile) {
    note.className = 'note';
    note.textContent = `Site profile: ${p.profile}`;
  } else {
    note.className = 'note warn';
    note.textContent = 'No site profile for this address - generic detection will be used.';
  }
  if (p.viewWarning) {
    note.className = 'note warn';
    note.textContent = p.viewWarning;
    $('forceBtn').classList.remove('hidden');
  }
}

async function doScan(force) {
  clearMsg();
  scan = null;
  renderSummary();
  setScanning(true, 0);
  const res = await tabSend({ type: 'scan', minSize: readMinSize(), force: !!force });
  setScanning(false);
  if (!res) {
    showMsg('error', 'The scan stopped unexpectedly. Reload the page and try again.');
    return;
  }
  scan = res;
  if (!res.ok) {
    if (res.code === 'wrong-view') {
      showMsg('error', `${res.error} Or click "Force scan anyway".`);
      $('forceBtn').classList.remove('hidden');
    } else if (res.code === 'no-images') {
      showMsg('error', 'No images found. Check the debug panel below, then use "Copy page info" and send it for a selector fix.');
    } else {
      showMsg('error', res.error || 'Scan failed.');
    }
  } else if ($('mode').value === 'label' && !res.items.some((i) => Number.isInteger(i.num))) {
    showMsg('warn', 'Images were found, but no label starts with "number:". Rename them in Flow, or pick a page-order mode.');
  }
  renderSummary();
}

async function onDownload() {
  // Safety: only after a successful, current scan, with a number for every file.
  if (!scanOk()) {
    showMsg('error', scan ? 'The last scan found no images. Nothing was downloaded.' : 'Run Scan first.');
    return;
  }
  if (scanStale()) {
    showMsg('error', 'Settings changed since the scan. Click Scan again.');
    return;
  }
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
  const mode = $('mode').value;
  const plan = buildPlan(scan, mode, start);
  if (!plan.files.length) {
    showMsg('error', 'Nothing to download: no image has a usable number. Nothing was downloaded.');
    return;
  }
  if (plan.errors.length || plan.files.some((f) => !/^\d{3,}(-\d+)?$/.test(f.filename))) {
    showMsg('error', `Refused: some numbers could not be determined (${plan.errors[0] || 'invalid file name'}). Nothing was downloaded.`);
    return;
  }
  saveSettings();
  clearMsg();
  const r = await send({
    type: 'startDownload',
    tabId,
    folder,
    mode,
    files: plan.files.map(({ filename, url, label }) => ({ filename, url, label })),
    skippedNames: mode === 'label' ? plan.needsRename.length : 0,
    duplicates: plan.dups.map((d) => d.names.join(', ')),
  });
  if (!r || !r.ok) showMsg('error', (r && r.error) || 'Could not start the download.');
}

async function onRetry() {
  const r = await send({ type: 'retryFailed', tabId });
  if (!r || !r.ok) showMsg('error', (r && r.error) || 'Could not retry.');
}

async function onPageInfo() {
  const r = connected ? await tabSend({ type: 'pageInfo', minSize: readMinSize() }) : null;
  if (!r) {
    showMsg('error', 'Could not read this page.');
    return;
  }
  try {
    await navigator.clipboard.writeText(r.text);
    showMsg('info', 'Page info copied. Paste it into your message so the selectors can be fixed.');
  } catch {
    showMsg('error', 'Could not copy to the clipboard.');
  }
}

function saveSettings() {
  chrome.storage.local.set({
    folder: $('folder').value.trim(),
    mode: $('mode').value,
    minSize: $('minSize').value.trim(),
  });
}

function updateFolderPreview() {
  $('folderPreview').textContent = sanitizeFolder($('folder').value) || '…';
}

/* -------------------------------- init -------------------------------- */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === 'scanProgress' && sender.tab && sender.tab.id === tabId) {
    // Only while a scan is known to run (late messages must not restart "Scanning…").
    if (scanning) $('scanStatus').textContent = `Scanning… ${msg.found} images found`;
  } else if (msg.type === 'scanDone' && sender.tab && sender.tab.id === tabId && scanning && watchingScan) {
    // The popup was opened while a scan was already running.
    watchingScan = false;
    setScanning(false);
    scan = msg.result;
    renderSummary();
  } else if (msg.type === 'jobProgress') {
    job = msg.job;
    renderJob();
  }
});

async function init() {
  $('scanBtn').addEventListener('click', () => doScan(false));
  $('forceBtn').addEventListener('click', () => doScan(true));
  $('stopScanBtn').addEventListener('click', () => tabSend({ type: 'stopScan' }));
  $('downloadBtn').addEventListener('click', onDownload);
  $('stopBtn').addEventListener('click', () => send({ type: 'stopDownload' }));
  $('retryBtn').addEventListener('click', onRetry);
  $('infoBtn').addEventListener('click', onPageInfo);
  $('start').addEventListener('input', renderSummary);
  $('minSize').addEventListener('input', renderSummary);
  $('mode').addEventListener('change', () => {
    saveSettings();
    renderSummary();
  });
  $('folder').addEventListener('input', updateFolderPreview);
  $('folder').addEventListener('change', saveSettings);
  $('minSize').addEventListener('change', saveSettings);

  const s = await chrome.storage.local.get(['folder', 'mode', 'minSize']);
  $('folder').value = s.folder || '';
  if (s.mode && MODE_NAMES[s.mode]) $('mode').value = s.mode;
  $('minSize').value = s.minSize || '150';
  updateFolderPreview();

  job = await send({ type: 'getJob' });
  renderJob();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  tabUrl = (tab && tab.url) || '';

  const ping = tabId != null ? await connect() : null;
  if (!ping) {
    showMsg('error', "Chrome doesn't let extensions read this page (for example chrome:// pages or the Web Store). Open your Flow project and try again. If it is a normal page, reload it.");
    updateButtons();
    return;
  }
  connected = true;
  await refreshPage();

  const stored = await send({ type: 'getScan', tabId });
  if (stored && pageKey(stored.pageUrl) === pageKey(tabUrl)) scan = stored;
  if (ping.scanning) {
    watchingScan = true;
    setScanning(true, ping.found);
  }
  renderSummary();
  renderJob();
}

document.addEventListener('DOMContentLoaded', init);
