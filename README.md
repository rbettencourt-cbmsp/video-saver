# Video Saver

A small Manifest V3 browser extension that finds videos on the current page and saves them for offline viewing. It has no accounts, no trial and no paywall.

## What it does

- Watches the tab's network traffic for `.m3u8`, `.mp4`, `.webm` and `.mov` requests
- Scans the page (including iframes) for `<video>` elements with plain http(s) sources
- **Direct files** are saved with the browser's own downloader
- **HLS streams** are fetched segment by segment in a helper tab and joined into one file:
  - plain MPEG-TS streams → `.ts` (plays in VLC; see conversion below)
  - fMP4 streams → `.mp4`

It does **not** handle encrypted or DRM-protected streams, and that is on purpose.

## Install (developer mode)

1. In this folder, run `npm install` (this also copies ffmpeg into `vendor/`)
1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## Use

1. Open the page and start playing the video
2. Click the extension icon. Pick the item marked **Full stream (recommended)**. Items marked *Preview clip* are short thumbnail animations, not the video
3. Click **Save**

## Known limitations

- Byte-range HLS isn't supported yet
- The whole video is held in memory (more than once while merging), so very long videos use a lot of RAM. Browser WebAssembly can't go past about 2 GB

## Tests

```powershell
npm test
```

To check the MP4 merge in a real browser, run `python -m http.server 8765` in this folder and open `http://127.0.0.1:8765/test/mux.html`. It should end with `RESULT: PASS`.

## Licenses

The extension's own code is MIT (see `LICENSE`). The bundled `@ffmpeg/core` is **GPL-2.0-or-later**. That's fine for personal use, but if you publish the extension with ffmpeg included, the package as a whole has to follow the GPL (for example, by sharing the source).

## Responsible use

Only save content you have the right to keep. Check the terms of the site and of the content's creator.
