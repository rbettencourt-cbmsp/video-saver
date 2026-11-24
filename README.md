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

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and pick this folder

## Use

1. Open the page and start playing the video
2. Click the extension icon; the sources it found are listed (streams first)
3. Click **Save**

## Convert .ts to .mp4 (optional)

```powershell
ffmpeg -i input.ts -c copy output.mp4
```

## Known limitations

- HLS streams with audio in a separate track save without sound (the saver warns you)
- Byte-range HLS isn't supported yet
- The whole video is held in memory before saving, so very long videos use a lot of RAM

## Tests

```powershell
node --test
```

## Responsible use

Only save content you have the right to keep. Check the terms of the site and of the content's creator.
