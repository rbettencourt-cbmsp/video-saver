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

## YouTube downloads (with your own yt-dlp.exe)

On YouTube watch pages, a **Download** panel appears under the video. It hands the download to your local `yt-dlp.exe` through a small helper program, because Chrome extensions can't run `.exe` files themselves:

```
YouTube page panel (youtube.js) → background.js → native messaging → native-host/host.js → yt-dlp.exe → file
```

Options: **Best available**, **1080p**, **720p**, **480p**, **Audio only (MP3)**. Under **Options** you can set the file name and choose a folder (a Windows folder picker opens). Progress, completion and errors show in the panel, and a Windows notification appears when a download finishes or fails.

### Requirements

- Windows, with Chrome, Edge or Brave
- [Node.js](https://nodejs.org) (runs the helper)
- `yt-dlp.exe`. By default the helper uses the one in this folder
- `ffmpeg` on PATH or next to `yt-dlp.exe`. It's needed for 1080p (video and audio are merged) and for MP3. Without it, the helper falls back to single-file formats (often 360p) and M4A audio
- An **up-to-date** yt-dlp. YouTube changes often, and old versions fail with errors like "Precondition check failed". Update with:

```powershell
.\yt-dlp.exe -U
```

### Install the helper (one time, no admin needed)

Run from this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\install-host.ps1
```

If your `yt-dlp.exe` is somewhere else:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\install-host.ps1 -YtDlpPath "D:\tools\yt-dlp.exe"
```

Optional parameters: `-FfmpegPath "C:\ffmpeg\bin"` (to use a specific ffmpeg) and `-DefaultFolder "D:\Videos"`.

The script:

1. Writes `native-host\config.json` with the yt-dlp path, the default folder, and the one extension ID allowed to connect
2. Writes `native-host\host.bat`, which starts `host.js` with your `node.exe`
3. Writes the host manifest `native-host\com.videosaver.ytdlp.json`, whose `allowed_origins` contains only this extension's ID
4. Creates these registry keys (current user only), each pointing at that manifest:
   - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videosaver.ytdlp`
   - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.videosaver.ytdlp`
   - `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videosaver.ytdlp`

To change the yt-dlp path later, re-run the script with `-YtDlpPath`, or edit `ytDlpPath` in `native-host\config.json` (use `\\` in JSON paths). To remove everything:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\uninstall-host.ps1
```

**Doing it by hand instead of the script:** create the manifest JSON yourself (`name`, `description`, `path` to `host.bat`, `"type": "stdio"`, `allowed_origins: ["chrome-extension://doocigjijigkklclednoibneaenlmmnj/"]`). Then set the default value of the registry key above to the manifest's full path, for example:

```powershell
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videosaver.ytdlp" /ve /t REG_SZ /d "C:\DevLocal\video-saver\native-host\com.videosaver.ytdlp.json" /f
```

### Load and test

1. Run `.\yt-dlp.exe -U`, then the install script
2. In `chrome://extensions`, remove any older unpacked copy of Video Saver, click **Load unpacked**, and pick this folder. Its ID must be `doocigjijigkklclednoibneaenlmmnj` (fixed by the `key` in `manifest.json`)
3. Open a YouTube video you own or are allowed to download. Under the video it should say **Ready · yt-dlp <version>**
4. Choose a quality, optionally open **Options** to set the name or folder, then click **Download**
5. Watch the progress bar. When it finishes, you get a notification and the panel shows the saved path

If something goes wrong, check `native-host\host.log` (the helper logs what it runs and any rejected callers). `npm test` includes tests that start the helper exactly the way Chrome does.

### Security

- Only this extension can start the helper. Chrome enforces `allowed_origins`, and the helper also checks the caller ID Chrome passes in
- The helper accepts only four commands: `ping`, `pickFolder`, `download` and `cancel`. There's no way to pass yt-dlp options or run other programs
- The URL is reduced to an 11-character video ID and rebuilt as `https://www.youtube.com/watch?v=<id>`. Quality comes from a fixed list. The folder must be an existing local absolute path, and the file name is cleaned of path and template characters
- yt-dlp runs without a shell, with `--ignore-config --no-exec`, and with the URL after `--`
- No cookies or logins are passed, so yt-dlp sees only what a signed-out viewer can. Nothing here bypasses DRM or access controls

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
