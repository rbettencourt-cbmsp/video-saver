// Packs a video track (and optional separate audio track) into one MP4 with
// ffmpeg.wasm stream copy: no re-encoding, so quality is unchanged.
//
// Long videos: ffmpeg.wasm can use at most 2 GB of memory, so tracks are merged
// in chunks. Inputs are read straight from disk (WORKERFS), each chunk becomes a
// run of fragmented-MP4 fragments with absolute timestamps (-copyts), and the
// fragments are appended to the output file on disk. Only one chunk's output is
// ever in memory.
import { FFmpeg } from "./vendor/ffmpeg/index.js";

const CORE = new URL("./vendor/core/ffmpeg-core.js", import.meta.url).href;
const WASM = new URL("./vendor/core/ffmpeg-core.wasm", import.meta.url).href;
export const DEFAULT_CHUNK_BYTES = 256 * 1024 * 1024;

/**
 * @typedef {{ file: Blob, segs: {offset:number,size:number,duration:number}[], initSize: number, ext: string }} Track
 *   file: the whole track on disk (init bytes first, then segments in order)
 * @param {{ video: Track, audio: Track|null }} tracks
 * @param {{ append(bytes: Uint8Array): Promise<void> }} out  sequential writer for the MP4
 * @param {{ onStatus?: (msg: string, fraction?: number) => void, chunkBytes?: number, signal?: AbortSignal }} [opts]
 */
export async function mergeToMp4({ video, audio }, out, { onStatus = () => {}, chunkBytes = DEFAULT_CHUNK_BYTES, signal } = {}) {
  const ffmpeg = new FFmpeg();
  const log = [];
  ffmpeg.on("log", ({ message }) => {
    log.push(message);
    if (log.length > 60) log.shift();
  });
  const fail = (what, code) => new Error(`${what} failed (ffmpeg code ${code}):\n${log.slice(-10).join("\n")}`);

  try {
    onStatus("Loading MP4 merger…");
    await ffmpeg.load({ coreURL: CORE, wasmURL: WASM });

    // Skipped optional segments are recorded with size 0; leave them out.
    video = { ...video, segs: video.segs.filter((s) => s.size > 0) };
    if (audio) audio = { ...audio, segs: audio.segs.filter((s) => s.size > 0) };
    if (!video.segs.length) throw new Error("Nothing was downloaded.");
    const chunks = planChunks(video, audio, chunkBytes);

    // Absolute start time of the streams, so every chunk shares one timeline.
    const first = chunks[0];
    const t0 = await probeStart(ffmpeg, log, [
      sliceTrack(video, first.v),
      ...(audio ? [sliceTrack(audio, first.a)] : []),
    ].map((data, i) => ({ name: `${i ? "a" : "v"}.${i ? audio.ext : video.ext}`, data })));

    for (let k = 0; k < chunks.length; k++) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      onStatus(chunks.length > 1 ? `Merging into MP4… part ${k + 1} of ${chunks.length}` : "Merging into MP4…", k / chunks.length);
      const dir = `/c${k}`;
      const blobs = [{ name: `v.${video.ext}`, data: sliceTrack(video, chunks[k].v) }];
      if (audio && chunks[k].a.length) blobs.push({ name: `a.${audio.ext}`, data: sliceTrack(audio, chunks[k].a) });
      await ffmpeg.createDir(dir);
      await ffmpeg.mount("WORKERFS", { blobs }, dir);

      const args = ["-copyts", "-i", `${dir}/${blobs[0].name}`];
      if (blobs[1]) args.push("-i", `${dir}/${blobs[1].name}`, "-map", "0:v:0", "-map", "1:a:0");
      else args.push("-map", "0:v?", "-map", "0:a?");
      // AAC in MPEG-TS carries ADTS headers that MP4 doesn't allow.
      if ([video.ext, audio?.ext].includes("ts")) args.push("-bsf:a", "aac_adtstoasc");
      args.push(
        "-c", "copy",
        "-output_ts_offset", String(-t0),
        "-avoid_negative_ts", "disabled",
        "-video_track_timescale", "90000",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof+frag_discont",
        "-f", "mp4", "out.mp4"
      );
      const code = await ffmpeg.exec(args);
      await ffmpeg.unmount(dir);
      await ffmpeg.deleteDir(dir);
      if (code !== 0) throw fail(`Merging part ${k + 1}`, code);

      const bytes = await ffmpeg.readFile("out.mp4");
      await ffmpeg.deleteFile("out.mp4");
      await out.append(k === 0 ? dropBoxes(bytes, ["mfra"]) : dropBoxes(bytes, ["ftyp", "moov", "mfra"]));
    }
    onStatus("Merged.", 1);
  } finally {
    ffmpeg.terminate();
  }
}

// Splits the video segments into chunks of about `chunkBytes`, and gives each chunk
// the audio segments that start inside its time window.
export function planChunks(video, audio, chunkBytes) {
  const vIdx = [[]];
  let bytes = 0;
  video.segs.forEach((s, i) => {
    if (bytes >= chunkBytes && vIdx.at(-1).length) {
      vIdx.push([]);
      bytes = 0;
    }
    vIdx.at(-1).push(i);
    bytes += s.size;
  });
  const chunks = vIdx.map((v) => ({ v, a: [] }));
  if (!audio) return chunks;

  const starts = (segs) => {
    let t = 0;
    return segs.map((s) => ((t += s.duration || 0), t - (s.duration || 0)));
  };
  const known = video.segs.every((s) => s.duration > 0) && audio.segs.every((s) => s.duration > 0);
  if (known) {
    const vStart = starts(video.segs);
    const bounds = chunks.map((c) => vStart[c.v[0]]);
    starts(audio.segs).forEach((t, i) => {
      let k = 0;
      while (k + 1 < bounds.length && t >= bounds[k + 1] - 1e-6) k++;
      chunks[k].a.push(i);
    });
  } else {
    // No durations: split audio in the same proportions as video.
    audio.segs.forEach((_, i) => {
      const pos = (i / audio.segs.length) * video.segs.length;
      const k = chunks.findIndex((c) => pos < c.v.at(-1) + 1);
      chunks[k === -1 ? chunks.length - 1 : k].a.push(i);
    });
  }
  return chunks;
}

// The bytes for segment indexes `idx` (consecutive), with the init section in front.
function sliceTrack(track, idx) {
  const parts = [];
  if (track.initSize) parts.push(track.file.slice(0, track.initSize));
  if (idx.length) {
    const a = track.segs[idx[0]];
    const b = track.segs[idx.at(-1)];
    parts.push(track.file.slice(a.offset, b.offset + b.size));
  }
  return new Blob(parts);
}

async function probeStart(ffmpeg, log, blobs) {
  await ffmpeg.createDir("/probe");
  await ffmpeg.mount("WORKERFS", { blobs }, "/probe");
  log.length = 0;
  const args = [];
  for (const b of blobs) args.push("-i", `/probe/${b.name}`);
  await ffmpeg.exec(args); // no output: exits non-zero after printing input info
  await ffmpeg.unmount("/probe");
  await ffmpeg.deleteDir("/probe");
  const starts = log.map((l) => /start: (-?[\d.]+)/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  return starts.length ? Math.min(...starts) : 0;
}

// Removes top-level MP4 boxes of the given types.
export function dropBoxes(bytes, types) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (size === 1) size = Number(view.getBigUint64(pos + 8));
    else if (size === 0) size = bytes.length - pos;
    if (size < 8) throw new Error(`Corrupt MP4 box "${type}"`);
    if (!types.includes(type)) keep.push(bytes.subarray(pos, pos + size));
    pos += size;
  }
  if (keep.length === 1) return keep[0];
  const outBytes = new Uint8Array(keep.reduce((n, k) => n + k.length, 0));
  let o = 0;
  for (const k of keep) {
    outBytes.set(k, o);
    o += k.length;
  }
  return outBytes;
}
