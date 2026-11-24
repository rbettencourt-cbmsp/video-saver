# How Video Saver works

This is the technical companion to the [README](../README.md).

## Files at a glance

| File | Role |
|---|---|
| `manifest.json` | Manifest V3. The `key` fixes the extension ID at `doocigjijigkklclednoibneaenlmmnj`, which the YouTube helper trusts |
| `background.js` | Service worker. Watches network traffic for media, owns the download queue, bridges to the YouTube helper, and runs the optional update check |
| `detect.js` | Content script (all frames). Finds `<video>` sources and Wistia/Vimeo/Loom/YouTube players in markup and page data |
| `content.js` | Floating download button (top frame; skipped on YouTube) |
| `popup.html/js/css` | Toolbar popup, also shown inside pages by the floating button |
| `downloads.html/js` | Downloads tab. Runs up to 3 jobs at once |
| `job.js` | One download: resolve → manifest → quality → download to disk → merge → save |
| `hls.js`, `dash.js` | HLS and DASH parsers (no dependencies) |
| `resolvers.js` | Wistia/Vimeo/Loom player ID → stream URL |
| `store.js` | Disk-backed scratch files (OPFS) and in-order parallel downloading |
| `mux.js` | Chunked merge to MP4 with ffmpeg.wasm |
| `youtube.js/css` | Download panel on YouTube watch pages |
| `native-host/` | YouTube helper (`host.js`) and its install/uninstall scripts |

## Chrome and Firefox

The same source runs in both browsers. `npm run build:firefox` copies it to `dist/firefox` with a Firefox manifest. The differences:

| | Chrome / Edge / Brave | Firefox |
|---|---|---|
| Background | service worker (`importScripts`) | background scripts listed in the manifest |
| API namespace | `chrome` | `browser`; `compat.js` points `chrome` at it, and all shared code uses promises, not callbacks |
| Fixed ID | `key` → `doocigjijigkklclednoibneaenlmmnj` | `browser_specific_settings.gecko.id` → `video-saver@rbettencourt-cbmsp` |
| Referer for downloads | `declarativeNetRequest` session rule per job | blocking `webRequest.onBeforeSendHeaders` in `background.js`, because Firefox doesn't apply DNR rules to an extension's own requests |
| Request source | `initiator` (origin only) | `originUrl` / `documentUrl` |
| Native helper | `allowed_origins`; the caller origin is the first argument | `allowed_extensions`; the host manifest path and then the add-on ID are the arguments |
| Helper registry key | `HKCUSoftwareGoogleChrome…` (also Edge, Brave) | `HKCUSoftwareMozillaNativeMessagingHosts…` |

`npm run lint:firefox` runs Mozilla's `web-ext lint` on the build. It currently reports 0 errors, and one warning about a dynamic `import` inside the bundled ffmpeg.wasm worker.

## Finding videos

- **Network:** `background.js` checks every response in each tab, including player iframes. A response counts as media by its URL ending (`.m3u8`, `.mpd`, `.mp4`, `.webm`, `.mov`, `.m4v`) or its `Content-Type` (HLS/DASH manifests). Stream segments are ignored. The frame's URL is kept as the Referer to use later
- **Page:** `detect.js` looks at `<video>` elements, iframe URLs, Wistia's `wistia_async_*` classes and `<wistia-player>`, links, and JSON page data such as Next.js `__NEXT_DATA__` (where Skool keeps lesson video links). This finds players before playback starts
- **Labelling:** the popup reads each manifest to label full streams, single tracks, preview clips and DRM/encrypted streams, and to list the available qualities

## Formats

- **HLS:** master playlists (quality by height or bandwidth), separate audio renditions (`EXT-X-MEDIA`), MPEG-TS and fMP4 (`EXT-X-MAP`), and byte ranges (`EXT-X-BYTERANGE`). Streams with `METHOD` other than `NONE` are refused
- **DASH:** static MPDs with `SegmentTemplate` (`$Number$`/`$Time$`, with or without `SegmentTimeline`), `SegmentList` (with `mediaRange`), or one file per representation (`BaseURL`/`SegmentBase`). `ContentProtection` (DRM) and `type="dynamic"` (live) are refused. Only the first period is saved
- **Direct files:** `bytestart`/`byteend` query parameters (Facebook/Instagram) are removed to get the whole file
- **Signed URLs:** relative segment URLs inherit the manifest's query string on the same origin (CloudFront `Policy`/`Signature`/`Key-Pair-Id`)
- **Referer:** each job adds a temporary `declarativeNetRequest` session rule that sets `Referer` to the page or player URL, only for the extension's own requests to the media hosts

## Download queue

Jobs live in `chrome.storage.session`. Every change goes through `background.js`, so the popup, page button and Downloads tab never conflict. The Downloads tab runs up to 3 jobs at once. It reports progress about 4 times a second and speed every second, and supports cancel and retry. If the tab is closed, running jobs go back to the queue the next time it opens.

## Long videos (chunked merge)

ffmpeg.wasm can address at most 2 GB of memory, so a whole video is never held at once:

1. Segments download 4 at a time but are written **in order** to scratch files in the extension's private file system (OPFS). At most 12 finished segments wait in memory (`store.js`)
2. `mux.js` splits the video segments into chunks of about 256 MB. Audio segments are assigned to chunks by start time
3. For each chunk, ffmpeg reads the inputs **straight from disk** (WORKERFS mount) and stream-copies them to fragmented MP4. It uses `-copyts` with a shared `-output_ts_offset` and `+frag_discont`, so every fragment keeps its absolute timestamp
4. Chunk 1 is written whole. Later chunks have their `ftyp`/`moov` boxes removed, and the fragments are appended to one output file on disk
5. The finished file goes to `chrome.downloads`, and scratch files are deleted (also on cancel or error)

`test/chunks.html` checks that a 20-second stream merged in many parts matches a single-part merge exactly: the same frames, the same audio packets, the same duration, and no decode errors.

## YouTube helper

```
youtube.js → background.js → chrome.runtime.connectNative("com.videosaver.ytdlp")
           → native-host/host.bat → node host.js → yt-dlp.exe → file
```

- **Protocol:** Chrome's native messaging (JSON with a 4-byte length prefix over stdin/stdout). Each download uses its own connection, and closing it ends yt-dlp and any ffmpeg it started
- **Commands:** `ping` (yt-dlp version, ffmpeg found), `pickFolder` (Windows folder dialog), `download`, `cancel`. There are no others
- **Arguments:** fixed except for the video ID, the quality (one of `best`, `1080`, `720`, `480`, `audio`), the folder and the file name:
  - quality is selected with `-f "bestvideo[height<=N]+bestaudio/best[height<=N]"` and `--merge-output-format mp4`, or with `-x --audio-format mp3` for audio only
  - for yt-dlp 2025.11 or later, `--js-runtimes node:<node.exe>` is added (current yt-dlp needs a JavaScript runtime for YouTube)
  - progress comes back through `--progress-template`, and the final path through `--print after_move:`

### Install script

`install-host.ps1` computes the extension ID from the manifest `key`. It then writes:

- `config.json`: the yt-dlp path, the default folder and the allowed origin
- `host.bat`: starts `host.js` with your `node.exe`
- the host manifest `com.videosaver.ytdlp.json`, whose `allowed_origins` contains only that ID

It points these registry keys (default value) at the host manifest:

- `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videosaver.ytdlp`
- `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.videosaver.ytdlp`
- `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.videosaver.ytdlp`

Options:

- `-YtDlpPath "D:\tools\yt-dlp.exe"`
- `-FfmpegPath "C:\ffmpeg\bin"`
- `-DefaultFolder "D:\Videos"`

All generated files are git-ignored.

To register by hand, write the host manifest yourself, then:

```powershell
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.videosaver.ytdlp" /ve /t REG_SZ /d "C:\path\to\video-saver\native-host\com.videosaver.ytdlp.json" /f
```

### macOS and Linux

`install-host.sh` does the same job without PowerShell or a registry:

- It finds Node, yt-dlp and ffmpeg in the usual places (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, PATH), or uses `--yt-dlp`/`--ffmpeg`. It also clears the macOS quarantine flag on a downloaded yt-dlp
- It writes `config.json` and a `host.sh` launcher. Browsers start helpers with a minimal PATH, so `host.sh` sets one that includes Homebrew's folders before running `host.js` with your Node. That way yt-dlp can find ffmpeg
- It copies `com.videosaver.ytdlp.json` into each installed browser's helper folder. Only browsers whose profile folder exists are registered:

| | macOS | Linux |
|---|---|---|
| Chrome | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` | `~/.config/google-chrome/NativeMessagingHosts/` |
| Edge | `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/` | `~/.config/microsoft-edge/NativeMessagingHosts/` |
| Brave | `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/` | `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/` |
| Chromium, Vivaldi | `~/Library/Application Support/{Chromium,Vivaldi}/NativeMessagingHosts/` | `~/.config/{chromium,vivaldi}/NativeMessagingHosts/` |
| Firefox | `~/Library/Application Support/Mozilla/NativeMessagingHosts/` | `~/.mozilla/native-messaging-hosts/` |

In `host.js`, the platform-specific parts are:

- **Stopping a download:** yt-dlp is started in its own process group, and cancel signals the whole group (Windows uses `taskkill /T`)
- **Finding ffmpeg:** `which` instead of `where`
- **The folder picker:** `osascript` (`choose folder`) on macOS, and `zenity` or `kdialog` on Linux

The Linux path is tested end to end in WSL (Ubuntu 24.04) with a stand-in yt-dlp. It covers install, registration, ping, download with progress, cancel (which also stops the child process), Firefox-style arguments, rejecting other extensions, and uninstall. The macOS-only parts (Homebrew paths, `osascript`) haven't been run on a Mac yet.

### Security

- **Only this extension:** Chrome only lets extensions listed in `allowed_origins` start the helper, and `host.js` also checks the caller origin Chrome passes as the first argument
- **URL:** reduced to an 11-character video ID and rebuilt as `https://www.youtube.com/watch?v=<id>`. Look-alike domains and other URLs are rejected
- **Folder and file name:** the folder must be an existing local absolute path (no UNC or relative paths). The file name has path characters, `%` (yt-dlp template syntax), leftover `..` and reserved device names removed
- **No command injection:** yt-dlp runs without a shell, with `--ignore-config --no-exec --no-playlist`, and the URL comes after `--`. Job IDs are restricted to `[A-Za-z0-9_-]`
- **No logins:** no cookies or credentials are passed, so yt-dlp sees only what a signed-out viewer sees

## Optional update notice

Set `UPDATE_REPO = "owner/repo"` in `background.js`. Once a day it checks that repository's latest GitHub release and shows a notice in the popup when the release tag is newer than the manifest version.

## Tests

Unit and protocol tests run in Node. They cover the parsers, helpers and URL handling, plus the YouTube helper's validation and its real stdio protocol against `yt-dlp.exe` if it's present:

```powershell
npm test
```

Browser tests run the real download code against streams generated with ffmpeg.wasm on a fake signed CDN. Start a local server:

```powershell
python -m http.server 8765
```

Then open `http://127.0.0.1:8765/test/run.html`. It should end with `DONE PASS: 16`.

Visual previews, served the same way:

- `test/popup.html`: the popup with sample data
- `test/youtube.html?state=ok`: the YouTube panel with the helper set up
- `test/youtube.html?state=missing`: the YouTube panel with the helper missing
