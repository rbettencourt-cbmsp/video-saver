// Downloads tab: runs queued jobs (up to MAX_PARALLEL at once) and shows the queue.
// The job list lives in chrome.storage.session; all changes go through background.js.
import { runJob } from "./job.js";
import { clearScratch, isStorageError, scratchMode, useMemoryScratch } from "./store.js";

const MAX_PARALLEL = 3;
const running = new Map(); // id -> { controller, bytes, lastBytes, lastTime }
const send = (msg) => chrome.runtime.sendMessage(msg);
const update = (id, patch) => send({ type: "updateJob", id, patch });

async function getJobs() {
  const { jobs = [] } = await chrome.storage.session.get("jobs");
  return jobs;
}

// --- Scheduling ---------------------------------------------------------------

let scheduling = false;
let again = false;
// No job may start until start-up has cleared old scratch files; otherwise the clean-up
// deletes the files of a job that just started ("state had changed since it was read").
let ready = false;
async function schedule() {
  if (!ready) return;
  if (scheduling) {
    again = true;
    return;
  }
  scheduling = true;
  try {
    const jobs = await getJobs();
    // Ask running jobs that were cancelled to stop.
    for (const j of jobs) {
      if (j.status === "cancelling") running.get(j.id)?.controller.abort();
    }
    for (const j of jobs) {
      if (running.size >= MAX_PARALLEL) break;
      // YouTube jobs run in the background through the yt-dlp helper, not here.
      if (j.status === "queued" && j.kind !== "youtube" && !running.has(j.id)) start(j);
    }
  } finally {
    scheduling = false;
    if (again) {
      again = false;
      schedule();
    }
  }
}

function start(job) {
  console.info(`[Video Saver] starting ${job.name} (${job.kind})`);
  const controller = new AbortController();
  const state = { controller, bytes: 0, lastBytes: 0, lastTime: performance.now(), pending: {}, timer: null };
  running.set(job.id, state);

  // Progress updates are batched (4 per second) to keep storage writes cheap.
  const flush = () => {
    state.timer = null;
    const patch = state.pending;
    state.pending = {};
    if (Object.keys(patch).length) update(job.id, patch);
  };
  const report = (patch) => {
    if (patch.bytes != null) {
      state.bytes = patch.bytes;
      delete patch.bytes;
    }
    Object.assign(state.pending, patch);
    if (!state.timer) state.timer = setTimeout(flush, 250);
  };

  update(job.id, { status: "running", message: "Starting…", progress: 0, error: "", warn: "" });
  // If the browser's file storage fails mid-job, switch to memory and run it once more.
  const run = () =>
    runJob(job, { signal: controller.signal, report }).catch((err) => {
      if (controller.signal.aborted || !isStorageError(err) || scratchMode() === "memory") throw err;
      console.error(`[Video Saver] ${job.name}: browser file storage failed, retrying in memory:`, err);
      useMemoryScratch(err.message);
      report({ message: "Browser storage failed; retrying in memory…", progress: 0 });
      return runJob(job, { signal: controller.signal, report });
    });
  run()
    .then(async ({ downloadId, filename }) => {
      clearTimeout(state.timer);
      flush();
      await update(job.id, { status: "done", progress: 1, speed: 0, message: `Saved to ${filename}`, downloadId });
    })
    .catch(async (err) => {
      console.error(`[Video Saver] ${job.name} failed:`, err);
      clearTimeout(state.timer);
      flush();
      const cancelled = err.name === "AbortError" || controller.signal.aborted;
      await update(job.id, cancelled
        ? { status: "cancelled", speed: 0, message: "Cancelled" }
        : { status: "error", speed: 0, error: err.message, message: "" });
    })
    .finally(() => {
      running.delete(job.id);
      schedule();
    });
}

// Speed: bytes per second over the last second, per running job.
setInterval(() => {
  const now = performance.now();
  for (const [id, s] of running) {
    const speed = ((s.bytes - s.lastBytes) * 1000) / Math.max(1, now - s.lastTime);
    s.lastBytes = s.bytes;
    s.lastTime = now;
    update(id, { speed: Math.round(speed), bytes: s.bytes });
  }
}, 1000);

// --- Rendering ------------------------------------------------------------------

const listEl = document.getElementById("list");
const fmtBytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`);

function button(label, onClick, primary = false) {
  const b = document.createElement("button");
  b.textContent = label;
  if (primary) b.className = "primary";
  b.addEventListener("click", onClick);
  return b;
}

function render(jobs) {
  const active = jobs.filter((j) => ["running", "cancelling"].includes(j.status)).length;
  const waiting = jobs.filter((j) => j.status === "queued").length;
  document.getElementById("summary").textContent = jobs.length
    ? `${active} downloading · ${waiting} waiting · ${jobs.filter((j) => j.status === "done").length} done`
    : "";
  listEl.replaceChildren();
  if (!jobs.length) {
    const p = document.createElement("li");
    p.className = "empty";
    p.textContent = "No downloads yet. Open a page with a video, click the Video Saver icon, and choose Save.";
    listEl.append(p);
    return;
  }
  for (const j of [...jobs].reverse()) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = j.name || "video";
    name.title = j.url || j.pageUrl || "";
    const q = document.createElement("span");
    q.className = "q";
    q.textContent = j.qualityLabel || "";
    row.append(name, q);
    if (["queued", "running"].includes(j.status)) row.append(button("Cancel", () => send({ type: "cancelJob", id: j.id })));
    if (["error", "cancelled"].includes(j.status)) row.append(button("Retry", () => send({ type: "retryJob", id: j.id }), true));
    if (j.status === "done" && j.downloadId != null) row.append(button("Show in folder", () => chrome.downloads.show(j.downloadId)));
    if (!["running", "cancelling"].includes(j.status)) row.append(button("Remove", () => send({ type: "removeJob", id: j.id })));
    li.append(row);

    if (["running", "cancelling", "queued"].includes(j.status)) {
      const bar = document.createElement("progress");
      bar.max = 1;
      if (j.status !== "queued") bar.value = j.progress || 0;
      li.append(bar);
    }
    const status = document.createElement("div");
    status.className = `status ${j.status === "error" ? "error" : j.status === "done" ? "done" : ""}`;
    const bits = [];
    if (j.status === "queued") bits.push("Waiting…");
    else if (j.status === "cancelling") bits.push("Stopping…");
    else if (j.status === "error") bits.push(j.error);
    else bits.push(j.message || "");
    if (j.status === "running") {
      if (j.progress) bits.push(`${Math.round(j.progress * 100)}%`);
      if (j.bytes) bits.push(fmtBytes(j.bytes));
      if (j.speed) bits.push(`${fmtBytes(j.speed)}/s`);
    }
    status.textContent = bits.filter(Boolean).join(" · ");
    li.append(status);
    if (j.warn) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = j.warn;
      li.append(w);
    }
    listEl.append(li);
  }
}

document.getElementById("clear").addEventListener("click", () => send({ type: "clearFinished" }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.jobs) {
    render(changes.jobs.newValue || []);
    schedule();
  }
});

// Leaving the tab cancels running downloads, so warn first.
addEventListener("beforeunload", (e) => {
  if (running.size) e.preventDefault();
});

// Chrome's Memory Saver unloads background tabs that use a lot of memory, which stops
// every download in this one. Ask Chrome to keep it loaded.
chrome.tabs.getCurrent().then((t) => t && chrome.tabs.update(t.id, { autoDiscardable: false })).catch(() => {});

// Start-up: jobs marked running belong to a closed tab; put them back in line.
(async () => {
  const jobs = await getJobs();
  for (const j of jobs) {
    if (["running", "cancelling"].includes(j.status) && j.kind !== "youtube") {
      await update(j.id, j.status === "running"
        ? { status: "queued", message: "", progress: 0 }
        : { status: "cancelled", message: "Cancelled" });
    }
  }
  const t = performance.now();
  await clearScratch();
  console.info(`[Video Saver] start-up clean-up took ${Math.round(performance.now() - t)} ms`);
  ready = true;
  render(await getJobs());
  schedule();
})();
