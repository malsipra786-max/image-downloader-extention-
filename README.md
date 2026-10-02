# Image Number Downloader

A Chrome extension that downloads **all images** from a page and names every file by a
**number**: `001.png`, `023.png`, `422.jpg` …
It is made for **Google Flow** (`flow.google.com`) but works on most image pages.

The number comes either from the image's **label** on the page (for example
`23: Staff handing dial to volunteer` → `023.png`), or from the image's **position** on the page.

**Safety rule:** if the scan finds no images, or a number can't be worked out, the extension
**refuses to download**. Files are never saved under the site's own names (like `img_8f3a.png`).
The file name is forced at the moment Chrome picks it (`onDeterminingFilename`), and after every
download the saved name is checked. If it is still wrong, the file is **kept** and reported
(orange `⚠` in the hand panel, "failed" in the scan report), with details in the debug log.

---

## 1. Install

1. Download this folder (or `git clone` it).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose this folder (the one with `manifest.json`).
5. Pin it: click the puzzle icon in Chrome's toolbar, then the pin next to **Image Number Downloader**.

### Two Chrome settings to check first

- **Turn OFF "Ask where to save each file before downloading"** at `chrome://settings/downloads`.
  Otherwise Chrome opens a "Save as" window for every image.
- **Click "Allow"** if Chrome asks: *"This site is trying to download multiple files"*.

When you update the extension: `chrome://extensions` → click the reload icon on it →
reload the Flow tab.

---

## 2. Number by hand (drag or click) — easiest

No scan and no selectors: you pick the images one at a time.

1. Open your Flow project and click the extension icon.
2. Click **✋ Number by hand (drag or click)…**. A panel opens on the page. Drag it by its
   blue title bar to move it out of the way. It stays open while you work (`–` folds it,
   `×` closes it).
3. Type a **Folder name** and a **Start number** (default 1). The big number shows the
   **next** number that will be used.
4. Save images, one at a time:
   - **Drag** an image onto the drop box, **or**
   - turn on **Click mode** and simply **click** an image.
   Each image is saved right away as `Downloads/<folder>/001.png`, `002.png`, … and the
   counter goes up by one.
5. The image flashes **green** when it is saved, **red** if it failed. The panel shows a list:
   `001 ✓ 002 ✓ 003 ✓`. Click a red number to retry it.
6. **Undo last** deletes the last saved file and moves the counter back, so you can redo it.
   **Reset list** clears the list (files are kept) and sets the counter to the start number.

Good to know:

- Flow's images have `draggable="false"`, so dragging usually doesn't work there. The panel
  checks this when it opens and **turns on Click mode by itself**; the grey line in the
  panel says which method is active. In Click mode, clicking an image saves it instead of
  opening it. The small buttons on a card (heart, ⋮) still work. Press **Esc** (or untick the
  box) to turn Click mode off and use Flow normally.
- If you number the **same image twice** (same `data-media-id`), it is still saved, but the
  panel warns you and marks it `=001`.
- **Full resolution** (on by default): Flow image addresses end with a size like `=s1600-rw`;
  this is replaced with `=s0` to get the original. If that fails, the size shown on the page
  is saved instead and marked `(small)`. Untick it to always save what is shown.
- The counter, list and folder are remembered, also after reloading the page.
- **Debug log** (at the bottom of the panel): for every image it shows the image URL, the
  file type found, the exact `filename` passed to `chrome.downloads.download`, the name Chrome
  proposed, and the name Chrome finally saved. **Copy log** copies it, for sending in a bug report.
- JPEG images are saved as `.jpg` (Windows calls the same format `.jfif`). WebP stays `.webp`,
  PNG `.png`. The type is read from the file itself, or from the server's Content-Type.
- The settings for this mode are in `HAND_CONFIG` at the top of `numberer.js`
  (`img.image`, `data-media-id`). Never use attributes like `_ngcontent-ng-c2213854978`:
  Angular changes them every time Google updates Flow.

---

## 3. Scan the whole page

1. Open your project in Google Flow and click **Images** in the left sidebar.
2. Click the extension icon.
3. Type a **Folder name**. Files go to `Downloads/<folder name>/`.
4. Pick a **Numbering mode**:
   | Mode | What it does |
   |---|---|
   | **Use label numbers** (default) | Reads the number from the label: `23: …` → `023`. Only labels that **start** with digits and a colon count. Images with other labels (like `I14: …`) are **not** downloaded; they are listed under **Needs renaming in Flow**. If two images have the same number, both are saved: `023.png`, `023-2.png`. |
   | **Page order (oldest first)** | Ignores labels. First image on the page = `001`, second = `002`, … Every image is downloaded. |
   | **Page order (reverse)** | Same, but the **last** image on the page = `001`, the one before it = `002`, … |
5. *(Optional)* **Start number**: with `400`, number 1 → `400`, 2 → `401`, 23 → `422`. Works in every mode.
6. *(Optional)* **Min image size**: images smaller than this (in pixels) are ignored, so icons,
   avatars and logos are skipped. Default `150`.
7. Click **Scan**. The extension scrolls through the whole page by itself (so all lazy-loaded
   images appear), then scrolls back to the top. Don't scroll while it scans.
8. Check the summary:
   - images found, lowest and highest number
   - the number list: `✓`, **MISSING**, or `✓ (2 versions)`
   - the **Preview**: first 5 and last 5 files, like `001 ← 23: Staff handing dial…`.
     **Check the order here before downloading.**
   - **Needs renaming in Flow** (label mode only)
9. Click **Download all**. A progress bar and a counter (e.g. `37 / 600`) show progress.
   You can close the popup; the download keeps running. **Stop** stops it.
10. The **report** shows downloaded / skipped / failed. **Retry failed** tries the failed
    ones again and replaces the old files (you never get `023 (1).png`).

You can switch mode or start number after a scan without scanning again. If you change the
min image size, scan again.

---

## 4. Messages

| Message | What to do |
|---|---|
| *Run Scan first.* | Download only works after a successful scan. |
| *No images found* | Wait for the page to load and scan again. If it still fails, see section 5, or use "Number by hand" (section 2). |
| *Open the Images view first* | Click **Images** in Flow's sidebar, or click **Force scan anyway**. |
| *No site profile for this address* | Only information: generic detection is used. |
| *Chrome doesn't let extensions read this page* | Chrome blocks extensions on `chrome://` pages and the Web Store. |

---

## 5. Fixing detection with the debug panel

After every scan, open **Debug panel** in the popup:

| Line | Meaning |
|---|---|
| Page URL detected | the address the extension saw |
| Site profile | which profile matched (or generic) |
| Card detection | which selector / method was used |
| **FAILED** | which selector found nothing (only shown when something failed) |
| Cards matched | how many image cards were found |
| …with a readable image | how many of them had an image URL |
| …with a readable label | how many had a label starting with `number:` |
| First 3 labels (raw text) | the exact text read, so you can see what went wrong |
| Small images skipped | images below the min size (lower the setting if real images are skipped) |

**Typical fixes**

- *Cards matched = 0*: the images may be smaller than the min size; lower it and scan again.
- *Readable image = 0*: the page shows images in a way the generic code can't read. Set
  `fullImage` / `card` in the site profile (below).
- *Readable label = 0* but the labels look right on screen: set `label` in the site profile.

**Copy page info** (bottom of the popup) copies what the extension sees, including the HTML of
sample cards, to your clipboard. Paste it into a message to get the selectors fixed.

### Site profiles

All URL patterns and selectors are in the `CONFIG` object at the top of `content.js`.
`CONFIG.profiles` is a list; the first profile whose `urlPattern` matches the page is used.
The Google Flow profile matches `flow.google.com` (any path, e.g.
`/project/<id>/collection/<id>`) and, as a backup, `labs.google` addresses containing "flow".

```js
{
  name: 'My gallery site',
  urlPattern: /^https:\/\/www\.example\.com\/gallery/i,   // or a list of patterns
  card: '.gallery-item',      // one image card
  label: '.caption',          // the "23: ..." text inside a card
  fullImage: 'a.full-size',   // full-size <img> or link inside a card
  gridContainer: '',          // the scrolling box ('' = auto)
},
```

Empty selectors (`''`) use generic detection. To find a selector: right-click the thing on the
page → **Inspect**, and look for an attribute that is the same on every card (such as
`data-testid="..."` or `role="..."`). Avoid random class names like `sc-a1b2c3`; they change.
After editing, reload the extension at `chrome://extensions` and reload the page.

---

## Files

| File | Job |
|---|---|
| `manifest.json` | extension settings (Manifest V3) |
| `content.js` | runs in the page for Scan: `CONFIG`, finds images and labels, scrolls |
| `numberer.js` | the "Number by hand" panel (drag / click), `HAND_CONFIG` |
| `background.js` | downloads in small batches, checks every saved file name |
| `offscreen.html` / `offscreen.js` | turns image bytes into files Chrome can save |
| `popup.html` / `popup.css` / `popup.js` | the window you click on |
