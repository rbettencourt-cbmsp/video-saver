# Third-party software in Video Saver packages

Video Saver's own code is under the MIT License (see `LICENSE`). The ready-to-install
ZIPs on the Releases page also contain the following third-party files, under their own licenses.

## ffmpeg.wasm (folder `vendor/`)

- `vendor/ffmpeg/`: [@ffmpeg/ffmpeg](https://www.npmjs.com/package/@ffmpeg/ffmpeg) 0.12.15. License: **MIT**
- `vendor/core/`: [@ffmpeg/core](https://www.npmjs.com/package/@ffmpeg/core) 0.12.10, a WebAssembly build of FFmpeg. License: **GPL-2.0-or-later** (full text: `licenses/GPL-2.0.txt`)

Source code: https://github.com/ffmpegwasm/ffmpeg.wasm (the release tags match the versions above), which builds on FFmpeg (https://ffmpeg.org, https://git.ffmpeg.org/ffmpeg.git).

Video Saver uses these files unmodified, only to merge downloaded video and audio inside your browser. You may get the corresponding source from the links above. If you redistribute a package that contains `vendor/core/`, you must also follow the GPL for that part.

## Not included, installed by you (optional YouTube feature)

- [yt-dlp](https://github.com/yt-dlp/yt-dlp): Unlicense
- [FFmpeg](https://ffmpeg.org): LGPL/GPL, depending on the build
- [Node.js](https://nodejs.org): MIT
