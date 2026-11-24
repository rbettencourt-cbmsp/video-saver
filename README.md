# Video Saver

A free, open-source browser extension that saves videos from web pages as a single `.mp4` file, so you can watch them offline. It has no account, no trial and no limits.

- Works on most sites that play ordinary video: course platforms (Skool, Kajabi, Teachable, Thinkific…), Loom, Vimeo, Wistia, social sites and more
- Finds the video for you, even before you press play
- Lets you pick the quality
- Merges separate video and audio into one MP4, with no quality loss
- Handles long videos (hours), with a download queue that runs 3 at once
- **YouTube** downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your own computer (optional, Windows; see [YouTube setup](#youtube-setup-optional-windows))

Works in Chrome, Edge, Brave and other Chromium browsers.

> **Please use it responsibly.** Only save videos you own or have permission to keep, and follow the terms of the site and the creator. Video Saver does **not** get around DRM (Netflix, Disney+, Prime Video and similar), logins or paywalls, and never will.

---

## Contents

- [Install](#install)
- [How to use](#how-to-use)
- [YouTube setup (optional, Windows)](#youtube-setup-optional-windows)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [For developers](#for-developers)
- [License](#license)

---

## Install

You need [Node.js](https://nodejs.org) once, to fetch the video-merging component. On Windows, open **PowerShell** and run the commands below in order.

**1. Install Node.js** (skip if `node --version` already prints a version):

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

Then close PowerShell and open a new window, so it can find Node.

**2. Download Video Saver.** Either click **Code → Download ZIP** on the GitHub page and unzip it, or use git:

```powershell
git clone https://github.com/rbettencourt-cbmsp/video-saver.git
```

**3. Go into the folder:**

```powershell
cd video-saver
```

**4. Fetch the video-merging component** (ffmpeg for the browser, about 31 MB):

```powershell
npm install
```

**5. Load it into your browser:**

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`)
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the `video-saver` folder
4. Optional: click the puzzle icon in the toolbar and pin **Video Saver**

> On macOS or Linux, install Node.js from [nodejs.org](https://nodejs.org), then run steps 2–5 in a terminal. Everything except the YouTube button works there.

---

## How to use

1. Open a page with a video. If it doesn't show up straight away, press play
2. Click the round **download button** that appears at the bottom right of the page, or the Video Saver icon in the toolbar
3. Pick the item marked **Full stream (recommended)** or **Full video (recommended)**, choose a quality, and click **Save**
4. A **Downloads** tab opens and shows progress. **Keep that tab open** until it finishes
5. Your video is saved in your **Downloads** folder, under **Video Saver**

Tips:

- **Preview clip** items are short thumbnail animations, not the video
- Items marked **DRM-protected** or **Encrypted** can't be saved (on purpose)
- To hide the round button on a page, hover it and click **×**

---

## YouTube setup (optional, Windows)

On YouTube, Video Saver adds a **Download** button under the video. Browsers don't let extensions run programs, so this button hands the job to [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your computer through a small helper. You set this up **once on each PC** (and once per Windows user). Everything else in Video Saver works without it.

Open **PowerShell in the Video Saver folder** (in File Explorer, Shift + right-click the folder → **Open PowerShell window here**) and run these in order. Each command has a copy button.

**1. Install Node.js** (skip if you already did during install):

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

**2. Install ffmpeg** (needed for 1080p and MP3):

```powershell
winget install -e --id Gyan.FFmpeg
```

**3. Close PowerShell and open a new one in the Video Saver folder**, so the new programs are found.

**4. Download yt-dlp into the folder:**

```powershell
Invoke-WebRequest -Uri https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -OutFile yt-dlp.exe
```

**5. Make sure yt-dlp is up to date** (YouTube changes often; old versions stop working):

```powershell
.\yt-dlp.exe -U
```

**6. Check everything is found.** Each line should print a version:

```powershell
node --version; ffmpeg -version | Select-Object -First 1; .\yt-dlp.exe --version
```

**7. Connect the helper to your browser** (no admin rights needed):

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\install-host.ps1
```

**8. Reload the extension.** In `chrome://extensions`, remove Video Saver, then add it again with **Load unpacked**. Then reload the YouTube tab.

Under the video you should now see **Download**, a quality menu, **Options** and **?**. The status line should read **Ready · yt-dlp …**. Click **?** at any time for these same steps with copy buttons.

**Using it:** choose **Best available**, **1080p**, **720p**, **480p** or **Audio only (MP3)**, then click **Download**. Under **Options** you can change the file name and the folder (it starts as `Downloads\Video Saver`). You'll get a Windows notification when it's done.

If `winget` isn't found, install **App Installer** from the Microsoft Store, or download [Node.js](https://nodejs.org) and [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) by hand. If you keep `yt-dlp.exe` somewhere else, add `-YtDlpPath "D:\tools\yt-dlp.exe"` to the step 7 command. If you move the Video Saver folder, run step 7 again.

---

## Updating

Get the new version (or download the ZIP again and replace the folder):

```powershell
git pull
```

```powershell
npm install
```

Then click the reload icon on Video Saver in `chrome://extensions`. To keep YouTube working, update yt-dlp now and then:

```powershell
.\yt-dlp.exe -U
```

---

## Troubleshooting

| Problem | What to do |
|---|---|
| "No videos found yet" | Press play on the video, wait a second, then click **Rescan** |
| Save fails with "link may have expired" | Reload the page, play the video again, and save again |
| The YouTube panel says "not set up on this PC" | Follow [YouTube setup](#youtube-setup-optional-windows), or click **?** under the video |
| "This extension isn't allowed to use the yt-dlp helper" | Remove the extension and add it again with **Load unpacked** (step 8), then run step 7 again |
| YouTube download fails with "Precondition check failed" or similar | Update yt-dlp with `.\yt-dlp.exe -U` |
| YouTube: "ffmpeg wasn't found" | Install ffmpeg (step 2), then restart the browser |
| A download stopped when I closed a tab | The **Downloads** tab does the work; reopen it from the popup (**Open downloads**) and it carries on with the queue |

The YouTube helper writes a log to `native-host\host.log` if you need more detail.

---

## Uninstall

1. In `chrome://extensions`, click **Remove** on Video Saver
2. If you set up YouTube downloads, remove the helper's registry entries:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\uninstall-host.ps1
```

3. Delete the `video-saver` folder

---

## For developers

- How it all works (detection, formats, the download queue, chunked merging for long videos, the YouTube helper and its security checks): [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)
- Run the tests:

```powershell
npm test
```

Contributions are welcome: open an issue or a pull request.

---

## License

Video Saver is released under the [MIT License](LICENSE): anyone may use, copy, change and share it (including commercially), as long as the copyright and license notice stay with it.

It relies on third-party software that has its own licenses and isn't stored in this repository:

| Component | Used for | License | How you get it |
|---|---|---|---|
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (`@ffmpeg/ffmpeg`, `@ffmpeg/core`) | Merging video and audio in the browser | MIT and **GPL-2.0-or-later** (core) | `npm install` |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | YouTube downloads | Unlicense | You download it (step 4) |
| [ffmpeg](https://ffmpeg.org) | YouTube 1080p and MP3 | LGPL/GPL | You install it (step 2) |

If you publish a build that **includes** `@ffmpeg/core` (for example, a ZIP with the `vendor` folder), that package must follow the GPL, for example by also offering its source. Using it yourself, or sharing this repository, is fine.
