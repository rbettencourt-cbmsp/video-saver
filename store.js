// Scratch storage for downloads in progress. Normally on disk, in the extension's Origin
// Private File System (OPFS): videos are written piece by piece so long downloads don't
// sit in memory, and File objects read back from OPFS are disk-backed too.
//
// Some Chrome profiles have an OPFS that stalls or refuses writes ("An operation that
// depends on state cached in an interface object…"). Then scratch files are kept in
// memory instead, for the rest of the session (see useMemoryScratch).

const DIR = "video-saver-jobs";
const CHECK_MS = 5000; // a healthy OPFS answers in milliseconds

let mode = null; // null = not checked yet, "disk" or "memory"
let checking = null;
const memFiles = new Map(); // name -> Blob parts (memory mode)

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

async function jobsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/** Switches to in-memory scratch files for the rest of this page's life. */
export function useMemoryScratch(reason) {
  if (mode !== "memory") console.warn(`[Video Saver] browser file storage isn't working (${reason}); keeping downloads in memory instead.`);
  mode = "memory";
}

export const scratchMode = () => mode;

// Writes and reads back a tiny file once; on failure or a stall, use memory.
function checkDisk() {
  if (mode) return Promise.resolve(mode);
  checking ||= withTimeout(
    (async () => {
      const dir = await jobsDir();
      const h = await dir.getFileHandle("health-check", { create: true });
      const w = await h.createWritable({ keepExistingData: false });
      await w.write(new Uint8Array([1, 2, 3]));
      await w.close();
      const ok = (await (await h.getFile()).arrayBuffer()).byteLength === 3;
      await dir.removeEntry("health-check");
      if (!ok) throw new Error("read-back mismatch");
    })(),
    CHECK_MS,
    "storage check"
  ).then(
    () => (mode ||= "disk"),
    (err) => (useMemoryScratch(err.message), mode)
  );
  return checking;
}

// Scratch file names end in their extension (out.mp4), which gives the File its type.
const TYPES = { mp4: "video/mp4", m4v: "video/mp4", m4s: "video/mp4", m4a: "audio/mp4", ts: "video/mp2t", aac: "audio/aac",
  webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg" };
const typeOf = (name) => TYPES[(/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase()] || "";

function memoryScratch(name) {
  const parts = [];
  memFiles.set(name, parts);
  let size = 0;
  return {
    name,
    get size() {
      return size;
    },
    async append(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      parts.push(bytes);
      size += bytes.byteLength;
    },
    async close() {},
    async abort() {
      memFiles.delete(name);
    },
    file: async () => new File(parts, name, { type: typeOf(name) }),
  };
}

/** Creates (or truncates) a scratch file and returns a sequential writer. */
export async function createScratch(name) {
  if ((await checkDisk()) === "memory") return memoryScratch(name);
  const dir = await jobsDir();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  let size = 0;
  return {
    name,
    get size() {
      return size;
    },
    async append(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await writable.write(bytes);
      size += bytes.byteLength;
    },
    async close() {
      await writable.close();
    },
    async abort() {
      try {
        await writable.abort();
      } catch {}
    },
    file: () => handle.getFile(),
  };
}

export async function removeScratch(name) {
  if (memFiles.delete(name) || mode === "memory") return;
  try {
    const dir = await jobsDir();
    await dir.removeEntry(name);
  } catch {}
}

/** Deletes every scratch file (left over from closed tabs or crashes), in one step. */
export async function clearScratch() {
  memFiles.clear();
  try {
    await withTimeout(
      navigator.storage.getDirectory().then((root) => root.removeEntry(DIR, { recursive: true })),
      CHECK_MS,
      "clean-up"
    );
  } catch (err) {
    if (err.name === "NotFoundError") return; // nothing to clear
    useMemoryScratch(err.message);
  }
}

/** True for errors from a misbehaving browser file storage (worth a retry in memory). */
export const isStorageError = (err) =>
  ["InvalidStateError", "NotReadableError", "NoModificationAllowedError"].includes(err?.name) ||
  /state cached in an interface object|storage check timed out/i.test(err?.message || "");

/**
 * Downloads `items` with `concurrency` workers but appends results to `writer`
 * strictly in order, holding at most `window` finished-but-unwritten items in memory.
 * fetchItem(item, index) -> ArrayBuffer. onItem(index, byteLength) is called after each write.
 */
export async function orderedDownload(items, fetchItem, writer, { concurrency = 4, window = 12, onItem } = {}) {
  const ready = new Map();
  let next = 0;
  let flushed = 0;
  let failed = null;
  let waiters = [];
  const waitForSpace = () => new Promise((r) => waiters.push(r));
  const wakeAll = () => {
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  };

  async function flush() {
    while (ready.has(flushed)) {
      const buf = ready.get(flushed);
      ready.delete(flushed);
      await writer.append(buf);
      onItem?.(flushed, buf.byteLength);
      flushed++;
    }
    wakeAll();
  }

  let flushing = Promise.resolve();
  async function worker() {
    while (!failed && next < items.length) {
      if (next - flushed >= window) {
        await waitForSpace();
        continue;
      }
      const i = next++;
      try {
        ready.set(i, await fetchItem(items[i], i));
      } catch (err) {
        failed = err;
        break;
      }
      flushing = flushing.then(flush);
      await flushing;
    }
    wakeAll();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  await flushing;
  if (failed) throw failed;
}
