# Video Saver

A free, open-source browser extension that saves videos from web pages as a single `.mp4` file, so you can watch them offline. It has no account, no trial and no limits.

- Works on most sites that play ordinary video: course platforms (Skool, Kajabi, Teachable, Thinkific…), Loom, Vimeo, Wistia, social sites and more
- Finds the video for you, even before you press play
- Lets you pick the quality
- Merges separate video and audio into one MP4, with no quality loss
- Handles long videos (hours), with a download queue that runs 3 at once
- **YouTube** downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your own computer (optional, Windows; see [YouTube setup](#youtube-setup-optional-windows))

> **Please use it responsibly.** Only save videos you own or have permission to keep, and follow the terms of the site and the creator. Video Saver does **not** get around DRM (Netflix, Disney+, Prime Video and similar), logins or paywalls, and never will.

---

## Contents

- [Supported browsers](#supported-browsers)
- [Install](#install)
  - [Chrome](#chrome)
  - [Microsoft Edge](#microsoft-edge)
  - [Brave](#brave)
  - [Opera and Vivaldi](#opera-and-vivaldi)
  - [Firefox](#firefox)
  - [Safari](#safari)
- [How to use](#how-to-use)
- [YouTube setup (optional, Windows)](#youtube-setup-optional-windows)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [For developers](#for-developers)
- [License](#license)

---

## Supported browsers

| Browser | Video Saver | YouTube button | Download |
|---|---|---|---|
| **Google Chrome** | ✅ Supported | ✅ Windows | `video-saver-chrome-<version>.zip` |
| **Microsoft Edge** | ✅ Supported | ✅ Windows | `video-saver-chrome-<version>.zip` |
| **Brave** | ✅ Supported | ✅ Windows | `video-saver-chrome-<version>.zip` |
| **Opera, Vivaldi** and other Chromium browsers | ⚠️ Should work (not tested) | ⚠️ Not set up by the installer | `video-saver-chrome-<version>.zip` |
| **Firefox** 128 or newer | ✅ Supported | ✅ Windows | `video-saver-firefox-<version>.zip` |
| **Safari** (Mac, iPhone, iPad) | ❌ Not supported ([why](#safari)) | ❌ | – |
| **Mobile browsers** (Android, iOS) | ❌ Not supported | ❌ | – |

All downloads are on the **[Releases page](https://github.com/rbettencourt-cbmsp/video-saver/releases/latest)**. Video Saver isn't in the Chrome Web Store or Firefox Add-ons store, so you install it from the ZIP as described below. It works on Windows, macOS and Linux; only the optional YouTube button is Windows-only.

---

## Install

### Chrome

1. On the [Releases page](https://github.com/rbettencourt-cbmsp/video-saver/releases/latest), download **`video-saver-chrome-<version>.zip`**
2. Unzip it into a folder you'll keep, for example `Documents\video-saver`. **Don't delete or move this folder afterwards**: Chrome loads the extension from it
3. Open `chrome://extensions`
4. Turn on **Developer mode** (top right)
5. Click **Load unpacked** and choose the unzipped folder (the one that contains `manifest.json`)
6. Optional: click the puzzle icon in the toolbar and pin **Video Saver**

### Microsoft Edge

1. Download and unzip **`video-saver-chrome-<version>.zip`**, as for Chrome. Edge uses the same package
2. Open `edge://extensions`
3. Turn on **Developer mode** (left side, or at the bottom of the menu)
4. Click **Load unpacked** and choose the unzipped folder
5. Optional: click the puzzle icon and choose **Show in toolbar** for Video Saver

### Brave

1. Download and unzip **`video-saver-chrome-<version>.zip`**
2. Open `brave://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and choose the unzipped folder

### Opera and Vivaldi

These are built on the same engine as Chrome, so the Chrome package should work. It hasn't been tested, though.

1. Download and unzip **`video-saver-chrome-<version>.zip`**
2. Open `opera://extensions` (Opera) or `vivaldi://extensions` (Vivaldi)
3. Turn on **Developer mode**
4. Click **Load unpacked** and choose the unzipped folder

The YouTube helper installer only registers Chrome, Edge, Brave and Firefox, so the YouTube button may not work in these browsers.

### Firefox

Firefox 128 or newer.

**Quick (temporary) install.** Firefox removes it again when you close the browser:

1. Download and unzip **`video-saver-firefox-<version>.zip`**
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…** and choose `manifest.json` in the unzipped folder
4. If the Video Saver popup asks for access to websites, click **Allow access to all sites**

**Permanent install.** Firefox only keeps add-ons that Mozilla has signed. Signing is free and doesn't publish the add-on:

1. Create a developer account at [addons.mozilla.org](https://addons.mozilla.org/developers/)
2. Choose **Submit a New Add-on → On your own**, and upload **`video-saver-firefox-<version>.zip`** (no need to unzip it)
3. When it's approved (usually within minutes), download the signed **`.xpi`** file Mozilla gives you
4. Drag the `.xpi` file into Firefox and click **Add**

For the YouTube button in Firefox, also follow [YouTube setup](#youtube-setup-optional-windows). Do it in the folder from **`video-saver-youtube-helper-<version>.zip`**, because the Firefox package doesn't contain the helper.

### Safari

**Safari isn't supported.** Safari's extension system lacks features Video Saver depends on:

- It has no `downloads` API, so an extension can't save the finished MP4 file
- It only partly supports watching network requests, which is how Video Saver finds most streams
- Extensions can only talk to programs packaged inside a signed Mac app, so the YouTube helper can't work as it does on Windows

Shipping a Safari version also needs a Mac with Xcode and a paid Apple Developer account. On a Mac, use **Chrome**, **Edge**, **Brave** or **Firefox** instead; Video Saver works in all of them on macOS.

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

Open **PowerShell in the Video Saver folder**: the unzipped Chrome package, or for Firefox the unzipped `video-saver-youtube-helper` package. In File Explorer, Shift + right-click the folder → **Open PowerShell window here**. Then run these commands in order; each one has a copy button.

**1. Install Node.js** (runs the helper):

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

**2. Install ffmpeg** (needed for 1080p and MP3):

```powershell
winget install -e --id Gyan.FFmpeg
```

**3. Close PowerShell and open a new one in the same folder**, so the new programs are found.

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

**7. Connect the helper to your browsers** (Chrome, Edge, Brave and Firefox; no admin rights needed):

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\install-host.ps1
```

**8. Reload the extension and the YouTube tab.**

- **Chrome, Edge, Brave:** remove Video Saver on the extensions page, then add it again with **Load unpacked**
- **Firefox:** reload it from `about:debugging`

Under the video you should now see **Download**, a quality menu, **Options** and **?**, and the status line should read **Ready · yt-dlp …**. Click **?** at any time for these same steps with copy buttons.

**Using it:** choose **Best available**, **1080p**, **720p**, **480p** or **Audio only (MP3)**, then click **Download**. Under **Options** you can change the file name and the folder (it starts as `Downloads\Video Saver`). You'll get a notification when it's done.

If `winget` isn't found, install **App Installer** from the Microsoft Store, or download [Node.js](https://nodejs.org) and [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) by hand. If you keep `yt-dlp.exe` somewhere else, add `-YtDlpPath "D:\tools\yt-dlp.exe"` to the step 7 command. If you move the folder, run step 7 again.

---

## Updating

1. Download the new ZIP from the [Releases page](https://github.com/rbettencourt-cbmsp/video-saver/releases/latest)
2. Unzip it over your existing folder, replacing the files. Keep `yt-dlp.exe` and `native-host\config.json` if you set up YouTube
3. Reload the extension:
   - **Chrome, Edge, Brave:** click the reload icon on Video Saver on the extensions page
   - **Firefox:** reload it in `about:debugging`, or install the newly signed `.xpi`

The Video Saver popup shows a notice when a new version is out. To keep YouTube working, update yt-dlp now and then:

```powershell
.\yt-dlp.exe -U
```

---

## Troubleshooting

| Problem | What to do |
|---|---|
| "No videos found yet" | Press play on the video, wait a second, then click **Rescan** |
| Save fails with "link may have expired" | Reload the page, play the video again, and save again |
| Firefox: nothing is found on any page | Open the Video Saver popup and click **Allow access to all sites** |
| Firefox: Video Saver disappeared after a restart | Temporary add-ons are removed when Firefox closes. Load it again, or use the [permanent install](#firefox) |
| The YouTube panel says "not set up on this PC" | Follow [YouTube setup](#youtube-setup-optional-windows), or click **?** under the video |
| "This extension isn't allowed to use the yt-dlp helper" | Run step 7 of YouTube setup again, then reload the extension |
| YouTube download fails with "Precondition check failed" or similar | Update yt-dlp: `.\yt-dlp.exe -U` |
| YouTube: "ffmpeg wasn't found" | Install ffmpeg (YouTube setup step 2), then restart the browser |
| A download stopped when I closed a tab | The **Downloads** tab does the work. Reopen it from the popup (**Open downloads**) and the queue carries on |

The YouTube helper writes a log to `native-host\host.log` if you need more detail.

---

## Uninstall

1. Remove Video Saver from the browser's extensions page (`about:addons` in Firefox)
2. If you set up YouTube downloads, remove the helper's registry entries from the Video Saver folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\native-host\uninstall-host.ps1
```

3. Delete the Video Saver folder

---

## For developers

### Run from source

```powershell
git clone https://github.com/rbettencourt-cbmsp/video-saver.git
```

```powershell
cd video-saver
```

```powershell
npm install
```

Then load the folder with **Load unpacked** (Chromium browsers). For Firefox, build it first and load `dist\firefox`:

```powershell
npm run build:firefox
```

### Tests and builds

```powershell
npm test
```

```powershell
npm run build
```

`npm run build` writes to `dist\`:

- `dist\chrome` and `dist\video-saver-chrome-<version>.zip`
- `dist\firefox` and `dist\video-saver-firefox-<version>.zip`
- `dist\youtube-helper` and `dist\video-saver-youtube-helper-<version>.zip`

How everything works (detection, formats, the queue, chunked merging, Chrome vs Firefox, the YouTube helper and its security checks) is in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

### Publishing a release

GitHub builds the packages for you (see [`.github/workflows/release.yml`](.github/workflows/release.yml)):

1. Raise `"version"` in `manifest.json` and `package.json` (for example `0.6.0`), then commit and push
2. On GitHub, open **Releases → Draft a new release**
3. Under **Choose a tag**, type `v0.6.0` (the same version, with a `v` in front) and choose **Create new tag**
4. Add a title and notes, then click **Publish release**
5. Open the **Actions** tab and watch **Build packages**. When it finishes (about 3 minutes), the three ZIPs are attached to the release

If the tag and `manifest.json` don't match, the build stops with an error saying so. You can also run the build by hand: **Actions → Build packages → Run workflow**. The ZIPs then appear under **Artifacts** on that run's page.

Contributions are welcome: open an issue or a pull request.

---

## License

Video Saver is released under the [MIT License](LICENSE): anyone may use, copy, change and share it (including commercially), as long as the copyright and license notice stay with it.

The release ZIPs also contain [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), which merges video and audio in the browser. Its core is licensed **GPL-2.0-or-later**; see [`licenses/THIRD-PARTY-NOTICES.md`](licenses/THIRD-PARTY-NOTICES.md) and [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt), which are included in every package. The optional YouTube feature uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), [FFmpeg](https://ffmpeg.org) (LGPL/GPL) and [Node.js](https://nodejs.org) (MIT), which you install yourself.
