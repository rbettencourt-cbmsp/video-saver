// Stand-in for job.js used by test/queue.html (swapped in with an import map).
// Each job "downloads" for a short while, tracks how many run at once, and obeys cancel.
export const SAVE_FOLDER = "Video Saver";
const q = (globalThis.__queueTest ||= { active: 0, maxActive: 0, started: [] });

export async function runJob(job, { signal, report }) {
  q.active++;
  q.maxActive = Math.max(q.maxActive, q.active);
  q.started.push(job.id);
  try {
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 80));
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      report({ message: `step ${i}`, progress: i / 5, bytes: i * 1000 });
    }
    if (job.name === "fails") throw new Error("Server said no");
    return { downloadId: 1, filename: `Video Saver/${job.name}.mp4` };
  } finally {
    q.active--;
  }
}
