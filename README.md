# Image Number Downloader

A Chrome extension that downloads **all images** from a page and names every file by a
**number**: `001.png`, `023.png`, `422.jpg` …
It is made for **Google Flow** (`flow.google.com`) but works on most image pages.

The number comes either from the image's **label** on the page (for example
`23: Staff handing dial to volunteer` → `023.png`), or from the image's **position** on the page.

**Safety rule:** if the scan finds no images, or a number can't be worked out, the extension
**refuses to download**. Files are never saved under the site's own names (like `img_8f3a.png`).
After every download it checks the saved file name; if it is wrong, the file is deleted and
counted as failed.

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

## 2. How to use it

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

## 3. Messages

| Message | What to do |
|---|---|
| *Run Scan first.* | Download only works after a successful scan. |
| *No images found* | Wait for the page to load and scan again. If it still fails, see section 4. |
| *Open the Images view first* | Click **Images** in Flow's sidebar, or click **Force scan anyway**. |
| *No site profile for this address* | Only information: generic detection is used. |
| *Chrome doesn't let extensions read this page* | Chrome blocks extensions on `chrome://` pages and the Web Store. |

---

## 4. Fixing detection with the debug panel

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
| `content.js` | runs in the page: `CONFIG`, finds images and labels, scrolls |
| `background.js` | downloads in small batches, checks every saved file name |
| `offscreen.html` / `offscreen.js` | turns image bytes into files Chrome can save |
| `popup.html` / `popup.css` / `popup.js` | the window you click on |
