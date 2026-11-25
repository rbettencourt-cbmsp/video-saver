// Stand-in for store.js used by test/queue.html: start-up clean-up takes a while and
// records when it finished, so the test can check no job started before it.
const q = (globalThis.__queueTest ||= { active: 0, maxActive: 0, started: [] });

export async function clearScratch() {
  await new Promise((r) => setTimeout(r, 300));
  q.clearedAt = performance.now();
}

export const isStorageError = () => false;
export const scratchMode = () => "disk";
export function useMemoryScratch() {}
