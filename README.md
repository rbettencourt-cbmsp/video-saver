# Video Saver

A small Manifest V3 browser extension that finds videos on the current page and saves them as a single `.mp4` for offline viewing. It has no accounts, no trial and no paywall.

## What it does

- **Finds videos** two ways:
  - watches the tab's network traffic, including embedded player iframes, for HLS (`.m3u8`), DASH (`.mpd`) and direct video files. It also recognises manifests by their `Content-Type` when the URL has no extension
  - scans the page and every frame for `<video>` elements with plain http(s) sources
- **Shows a count** on the toolbar icon and lists what it found, best first: full streams, then files, then single-track streams. Thumbnail preview clips are dimmed, and DRM-protected streams are greyed out
- **Saves** in a helper tab with a progress bar:
  - **HLS**: master playlists (the best quality is picked), separate audio tracks, fMP4 and MPEG-TS, and byte-range playlists
  - **DASH**: `SegmentTemplate` (with or without a timeline), `SegmentList` with byte ranges, and one-file-per-track manifests (Facebook/Reddit style)
  - **Direct files**: Facebook/Instagram-style `bytestart`/`byteend` slices are widened to the whole file
- **Merges** the video and any separate audio into one `.mp4` with a bundled copy of ffmpeg (WebAssembly). It uses stream copy, so there's no re-encoding and no quality loss. If merging fails, the raw tracks are saved instead, along with the ffmpeg command to merge them yourself
- **Sends the page as Referer** for CDNs that refuse requests without it (TikTok and others). It does this with a temporary per-tab `declarativeNetRequest` rule
- **Reuses signed URLs**: segments listed without a query string inherit the manifest's signature (CloudFront-style `Policy`/`Signature`)

It does **not** save encrypted or DRM-protected streams (Netflix, Disney+, Prime Video and similar), and that is on purpose. It also doesn't do live streams or YouTube.

## Install (developer mode)

1. In this folder, run `npm install` (this also copies ffmpeg into `vendor/`)
2. Open `chrome://extensions` (or `edge://extensions`)
3. Turn on **Developer mode**
4. Click **Load unpacked** and pick this folder

## Use

1. Open the page and start playing the video
2. Click the extension icon. Pick the item marked **Full stream (recommended)** if there is one
3. Click **Save**, then choose where to save the `.mp4`

## Known limitations

- The whole video is held in memory (more than once while merging), so very long videos use a lot of RAM. Browser WebAssembly can't go past about 2 GB
- For DASH, only the first period is saved (multi-period streams show a warning)
- On Facebook and Instagram, the separate video and audio files show up as two plain MP4 items rather than one stream, so each saves on its own

## Tests

```powershell
npm test
```

Browser tests: run `python -m http.server 8765` in this folder and open `http://127.0.0.1:8765/test/run.html`. It runs the real `saver.js` against generated streams on a fake signed CDN in 8 scenarios: HLS master with separate audio, byte-range HLS, DASH timeline, DASH `$Number$`, DASH segment list, DASH one-file-per-track, a direct file that needs a Referer, and a DRM manifest that must be refused. It should end with `DONE PASS: 8`.

## Licenses

The extension's own code is MIT (see `LICENSE`). The bundled `@ffmpeg/core` is **GPL-2.0-or-later**. That's fine for personal use, but if you publish the extension with ffmpeg included, the package as a whole has to follow the GPL (for example, by sharing the source).

## Responsible use

Only save content you have the right to keep. Check the terms of the site and of the content's creator.
