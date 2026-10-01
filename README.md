# Flow Image Downloader

A Chrome extension that downloads **all images** from an open Google Flow project
(labs.google/flow). Each file is named by the **number at the start of the image's name**
in Flow, for example:

| Name in Flow                              | File        |
|-------------------------------------------|-------------|
| `23: Staff handing dial to volunteer`     | `023.png`   |
| `17: Large clay dial filling frame`       | `017.png`   |
| `23: (a regenerated version)`             | `023-2.png` |

The order of the cards on screen is never used. Only the number in the name counts.

---

## 1. Install

1. Download this folder to your computer (or `git clone` it).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose this folder (the one with `manifest.json`).
5. Pin the extension: click the puzzle icon in Chrome's toolbar, then the pin next to
   **Flow Image Downloader**.

### Two Chrome settings to check first

- **Turn OFF "Ask where to save each file before downloading".**
  Go to `chrome://settings/downloads` and switch it off. If it is on, Chrome opens a
  "Save as" window for every single image.
- **Click "Allow"** if Chrome asks: *"This site is trying to download multiple files"*.

---

## 2. How to use it

1. Open your project in Google Flow.
2. In Flow's left sidebar, click **Images**. (The extension only works on the Images view.
   It never downloads videos, characters, or anything from the Bin.)
3. Click the extension icon.
4. Type a **Folder name**. Files are saved to `Downloads/<folder name>/`.
   The extension remembers the last folder name.
5. *(Optional)* Type a **Start number**. Leave it empty to use the numbers as they are.
   If you type `400`, then name 1 → `400`, name 2 → `401`, name 23 → `422`.
6. Click **Scan**. The extension scrolls through the whole grid by itself (so lazy-loaded
   images appear), then scrolls back to the top. Don't scroll the page while it scans.
7. Check the summary:
   - how many images were found, the lowest and highest number
   - a list of every number: `✓`, **MISSING**, or `✓ (2 versions)`
   - **Duplicates**: every version is downloaded as `023`, `023-2`, `023-3` … in page order
   - **Needs renaming in Flow**: images whose name does not start with `number:`
     (for example `I14: …` or a name with no number). These are **not** downloaded.
     Rename them in Flow and scan again.
8. Click **Download all**. You will see a progress bar and a counter (e.g. `37 / 600`).
   You can close the popup — the download keeps running. Click **Stop** to stop.
9. At the end you get a report: **downloaded**, **skipped**, **failed**.
   Click **Retry failed** to try the failed ones again. Retrying replaces the old file
   (you will not get `023 (1).png`).

**Tips**

- File names use at least 3 digits, and more if needed: up to 999 → `007.png`;
  over 999 → `0007.png`.
- The real file type is kept (`.png`, `.jpg` or `.webp`).
- If **Retry failed** keeps failing, Flow's image links may have expired.
  Click **Scan** again, then **Download all** (existing files are overwritten).

---

## 3. Messages you may see

| Message | What to do |
|---|---|
| *This is not a Google Flow page* | Open your project at labs.google/flow first. |
| *Open the Images view in Flow first* | Click **Images** in Flow's left sidebar. |
| *Could not confirm which view is open* | The extension couldn't detect the sidebar. Make sure **Images** is selected, then scan. |
| *No images found* | Wait for the grid to load, then scan again. If it still fails, see "Fixing selectors". |
| *Could not connect to the Flow page* | Reload the Flow tab and try again. |

---

## 4. Fixing selectors (if Google changes the Flow page)

All page-specific settings are in **one place**: the `CONFIG` object at the top of
`content.js`. Each line has a comment.

| Setting | What it is | Default |
|---|---|---|
| `selectors.gridContainer` | the scrollable box that holds the grid | auto-detect |
| `selectors.card` | one image card | auto-detect |
| `selectors.nameLabel` | the element with the text `23: …` inside a card | auto-detect |
| `selectors.image` | the image inside a card | `img` |
| `selectors.ignoreInCard` | hover buttons / icons to ignore when reading the name | buttons, icons |
| `nameAttributes` | attributes that may hold the full name (checked before visible text) | `title`, `aria-label`, … |
| `imagesView` | how the selected "Images" sidebar item is recognised | aria attributes |
| `fullRes.upgradeUrl` | turns a grid thumbnail URL into the full-size URL | handles Next.js and Google image URLs |
| `fullRes.openCard` | (slow, off by default) open each card and read the big image | `enabled: false` |
| `scroll` | scroll speed and waiting times | — |

**How to find a selector**

1. Open your Flow project in the Images view.
2. Right-click an image card's name (e.g. `23: Staff handing…`) → **Inspect**.
3. In the Elements panel, look for an attribute that is the same on every card
   (for example `data-testid="media-card"`, or a `role`). Avoid random class names
   like `sc-a1b2c3` — they change often.
4. Put it in `CONFIG`, e.g. `card: '[data-testid="media-card"]'`.
5. Go to `chrome://extensions` and click the **reload** icon on the extension,
   then reload the Flow tab.

**Quick help:** click **Copy page info (for fixing selectors)** at the bottom of the popup.
It copies what the extension sees (detected view, number of cards, the HTML of the first two
cards, the "Images" sidebar item). Paste that into a message to whoever is fixing the selectors.

---

## Files

| File | Job |
|---|---|
| `manifest.json` | extension settings (Manifest V3) |
| `content.js` | runs in the Flow page: finds cards, reads names, scrolls, `CONFIG` |
| `background.js` | runs the downloads in small batches; keeps going when the popup closes |
| `offscreen.html` / `offscreen.js` | turns `blob:`/`data:` images into files Chrome can save |
| `popup.html` / `popup.css` / `popup.js` | the window you click on |
