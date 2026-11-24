// Disk-backed scratch storage in the extension's Origin Private File System (OPFS).
// Videos are written here piece by piece so long downloads don't sit in memory;
// File objects read back from OPFS are disk-backed too.

const DIR = "video-saver-jobs";

async function jobsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

/** Creates (or truncates) a scratch file and returns a sequential writer. */
export async function createScratch(name) {
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
  try {
    const dir = await jobsDir();
    await dir.removeEntry(name);
  } catch {}
}

/** Deletes every scratch file (left over from closed tabs or crashes). */
export async function clearScratch(keep = []) {
  try {
    const dir = await jobsDir();
    for await (const name of dir.keys()) {
      if (!keep.some((k) => name.startsWith(k))) await dir.removeEntry(name).catch(() => {});
    }
  } catch {}
}

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
