// Packs a video track (and optional separate audio track) into one MP4 using
// ffmpeg.wasm with stream copy: no re-encoding, so quality is unchanged.
import { FFmpeg } from "./vendor/ffmpeg/index.js";

const CORE = new URL("./vendor/core/ffmpeg-core.js", import.meta.url).href;
const WASM = new URL("./vendor/core/ffmpeg-core.wasm", import.meta.url).href;

/**
 * @param {{blob: Blob, ext: string}} video
 * @param {{blob: Blob, ext: string} | null} audio
 * @param {(msg: string) => void} [onStatus]
 * @returns {Promise<Blob>} MP4
 */
export async function toMp4(video, audio, onStatus = () => {}) {
  const ffmpeg = new FFmpeg();
  const log = [];
  ffmpeg.on("log", ({ message }) => {
    log.push(message);
    if (log.length > 30) log.shift();
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (progress > 0 && progress <= 1) onStatus(`Merging into MP4… ${Math.round(progress * 100)}%`);
  });

  try {
    onStatus("Loading MP4 merger…");
    await ffmpeg.load({ coreURL: CORE, wasmURL: WASM });

    const vIn = `video.${video.ext}`;
    await ffmpeg.writeFile(vIn, new Uint8Array(await video.blob.arrayBuffer()));
    const args = ["-i", vIn];
    if (audio) {
      const aIn = `audio.${audio.ext}`;
      await ffmpeg.writeFile(aIn, new Uint8Array(await audio.blob.arrayBuffer()));
      args.push("-i", aIn, "-map", "0:v:0", "-map", "1:a:0");
    } else {
      args.push("-map", "0:v?", "-map", "0:a?");
    }
    args.push("-c", "copy", "out.mp4");

    onStatus("Merging into MP4…");
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}:\n${log.slice(-8).join("\n")}`);

    const data = await ffmpeg.readFile("out.mp4");
    return new Blob([data], { type: "video/mp4" });
  } finally {
    ffmpeg.terminate();
  }
}
