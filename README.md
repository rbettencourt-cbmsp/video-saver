# Video Saver

A Manifest V3 browser extension that finds videos on any page and saves them as a single `.mp4` for offline viewing. It has no accounts, no trial and no paywall.

## Features

- **Finds videos before you press play.** It reads the page for Wistia, Vimeo and Loom players, including links in Next.js page data such as Skool lessons, and for `<video>` elements. It also watches network traffic, including inside player iframes, for HLS (`.m3u8`), DASH (`.mpd`) and direct video files
- **Floating button** on pages with videos. It opens the Video Saver panel right on the page. Hover it and click × to hide it on that page
- **Quality picker.** Every resolution the stream offers is listed; the best is selected by default
- **Download queue.** Up to 3 downloads run at once, with progress, speed, cancel, retry and "Show in folder" in the Downloads tab. The popup shows the latest ones
- **Long videos.** Downloads stream to disk, not memory, and are merged into one MP4 in parts, so multi-hour videos work
- **One MP4 out.** Separate video and audio tracks are merged with a bundled copy of ffmpeg (WebAssembly) using stream copy, so there's no re-encoding and no quality loss
- **Formats:**
  - HLS: master playlists, separate audio, fMP4 and MPEG-TS, and byte ranges
  - DASH: `SegmentTemplate` (with or without a timeline), `SegmentList`, and one-file-per-track
  - Direct files: Facebook/Instagram-style partial links are widened to the whole file
- **Picky CDNs.** It sends the page or player URL as Referer (TikTok and others) and reuses signed URLs (CloudFront `Policy`/`Signature`) for segments
- **Update notice** (optional). Set `UPDATE_REPO` in `background.js` to your GitHub repo and the popup shows when a newer release exists

**Not supported, on purpose:** DRM-protected services (Netflix, Disney+, Prime Video and similar), YouTube (shown in the list as unsupported), and live streams.

## Install (developer mode)

1. In this folder, run `npm install` (this also copies ffmpeg into `vendor/`)
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, `opera://extensions`)
3. Turn on **Developer mode**
4. Click **Load unpacked** and pick this folder

## Use

1. Open a page with a video
2. Click the floating button or the toolbar icon
3. Pick a quality if you want, then click **Save**

The Downloads tab opens in the background and does the work. Keep it open until downloads finish. Files are saved in your Downloads folder under **Video Saver**.

## How long videos work

ffmpeg.wasm can use at most 2 GB of memory, so the saver never holds a whole video:

1. Segments are written in order to the extension's private disk storage (OPFS) as they arrive (`store.js`)
2. `mux.js` merges about 256 MB at a time. ffmpeg reads the inputs straight from disk (WORKERFS) and writes fragmented-MP4 pieces that keep their original timestamps (`-copyts`, `frag_discont`). The pieces are appended to one output file on disk
3. The finished file is handed to the browser's downloader, and the scratch files are deleted

## Known limitations

- The Downloads tab must stay open while it works (closing it puts unfinished downloads back in the queue)
- Private or domain-locked Vimeo/Wistia/Loom players may not resolve from page data. Playing the video makes the stream show up instead
- For DASH, only the first period is saved
- On Facebook and Instagram, the separate video and audio files appear as two plain MP4 items

## Tests

```powershell
npm test
```

Browser tests: run `python -m http.server 8765` in this folder and open `http://127.0.0.1:8765/test/run.html`. It runs 16 checks and should end with `DONE PASS: 16`:

- **`job.html`:** runs the real download job against generated streams on a fake signed CDN. Scenarios: HLS master with separate audio, chunked merge, quality pick for HLS and DASH, byte-range HLS, three DASH layouts, Referer-gated file, Wistia embed, DRM refusal, and cancel
- **`chunks.html`:** a 20-second video merged in many parts must match a single-part merge frame for frame
- **`detect.html`:** player detection from markup and page data
- **`queue.html`:** the real Downloads tab logic. Checks the 3-at-a-time limit, failure and cancel

## Licenses

The extension's own code is MIT (see `LICENSE`). The bundled `@ffmpeg/core` is **GPL-2.0-or-later**. That's fine for personal use, but if you publish the extension with ffmpeg included, the package as a whole has to follow the GPL (for example, by sharing the source).

## Responsible use

Only save content you have the right to keep. Check the terms of the site and of the content's creator.
