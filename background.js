// Service worker:
//  * watches network responses and remembers media URLs per tab (badge shows the count)
//  * owns the download queue: every change goes through here so the popup, the page
//    button and the downloads tab never race. The downloads tab (downloads.html) runs jobs.
//  * optional daily update check against a GitHub repo (see UPDATE_REPO)

importScripts("common.js");

// Set to "owner/repo" to get a "new version available" notice from GitHub releases.
const UPDATE_REPO = "";

const MAX_PER_TAB = 50;
// Pieces of a segmented stream, not whole videos.
const SEGMENT_RE = /(?:^|[\/_-])(?:seg(?:ment)?|chunk|frag(?:ment)?|part)[-_]?\d+\.(?:mp4|m4[sva])$/i;
const MANAGER_URL = chrome.runtime.getURL("downloads.html");

let queue = Promise.resolve();
function serialize(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// --- Media found per tab ----------------------------------------------------

const key = (tabId) => `tab:${tabId}`;

function setBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a73e8" }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: "mediaCount", count }).catch(() => {});
}

async function frameUrl(tabId, frameId, fallback) {
  try {
    const f = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (f?.url && /^https?:/.test(f.url)) return f.url;
  } catch {}
  return fallback;
}

function addMedia(details, type) {
  const url = type === "file" ? stripRangeParams(details.url) : details.url;
  const { tabId, frameId } = details;
  return serialize(async () => {
    const k = key(tabId);
    const { [k]: list = [] } = await chrome.storage.session.get(k);
    if (list.some((m) => m.url === url)) return;
    const referrer = await frameUrl(tabId, frameId, details.initiator ? details.initiator + "/" : "");
    list.push({ url, type, referrer, inFrame: frameId > 0, source: "network", seen: Date.now() });
    const kept = list.slice(-MAX_PER_TAB);
    await chrome.storage.session.set({ [k]: kept });
    setBadge(tabId, kept.length);
  });
}

function clearTab(tabId) {
  setBadge(tabId, 0);
  return serialize(() => chrome.storage.session.remove(key(tabId)));
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.initiator?.startsWith("chrome-extension://")) return; // our own downloads
    if (details.statusCode >= 400) return;
    const ct = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value || "";
    const type = mediaKind(details.url, ct);
    if (!type) return;
    if (type === "file" && SEGMENT_RE.test(new URL(details.url).pathname)) return;
    addMedia(details, type);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// A full page load starts a fresh list; in-app (pushState) navigation keeps it.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) clearTab(d.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => chrome.storage.session.remove(key(tabId)));
});

// --- Download queue -----------------------------------------------------------
// Job: { id, url, kind, name, referrer, quality, embedId?, hash?, status, progress,
//        bytes, speed, message, warn, error, quality label, downloadId, created }
// status: queued → running → done | error | cancelled   (cancelling while stopping)

async function getJobs() {
  const { jobs = [] } = await chrome.storage.session.get("jobs");
  return jobs;
}

function mutateJobs(fn) {
  return serialize(async () => {
    const jobs = await getJobs();
    const result = fn(jobs);
    await chrome.storage.session.set({ jobs });
    return result;
  });
}

async function ensureManager({ focus = false } = {}) {
  const [tab] = await chrome.tabs.query({ url: MANAGER_URL + "*" });
  if (tab) {
    if (focus) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return tab;
  }
  return chrome.tabs.create({ url: MANAGER_URL, active: focus, index: 0 });
}

const JOB_FIELDS = ["url", "kind", "name", "referrer", "quality", "embedId", "hash", "pageUrl"];

async function enqueue(spec) {
  const job = { id: crypto.randomUUID(), status: "queued", progress: 0, bytes: 0, speed: 0, created: Date.now() };
  for (const f of JOB_FIELDS) if (spec[f] != null) job[f] = spec[f];
  await mutateJobs((jobs) => jobs.push(job));
  await ensureManager();
  return job.id;
}

const handlers = {
  async getMedia({ tabId }) {
    return serialize(async () => (await chrome.storage.session.get(key(tabId)))[key(tabId)] || []);
  },
  clearMedia: ({ tabId }) => clearTab(tabId),
  whoami: (_msg, sender) => ({ tabId: sender.tab?.id, frameId: sender.frameId }),
  enqueue: ({ job }) => enqueue(job),
  updateJob: ({ id, patch }) =>
    mutateJobs((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (j) Object.assign(j, patch);
    }),
  cancelJob: ({ id }) =>
    mutateJobs((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (!j) return;
      if (j.status === "queued") Object.assign(j, { status: "cancelled", message: "Cancelled" });
      else if (j.status === "running") j.status = "cancelling";
    }),
  retryJob: async ({ id }) => {
    await mutateJobs((jobs) => {
      const j = jobs.find((x) => x.id === id);
      if (j && ["error", "cancelled"].includes(j.status)) {
        Object.assign(j, { status: "queued", progress: 0, bytes: 0, speed: 0, message: "", error: "", warn: "" });
      }
    });
    await ensureManager();
  },
  removeJob: ({ id }) =>
    mutateJobs((jobs) => {
      const i = jobs.findIndex((x) => x.id === id && !["running", "cancelling"].includes(x.status));
      if (i >= 0) jobs.splice(i, 1);
    }),
  clearFinished: () =>
    mutateJobs((jobs) => {
      const keep = jobs.filter((j) => !["done", "error", "cancelled"].includes(j.status));
      jobs.splice(0, jobs.length, ...keep);
    }),
  openManager: () => ensureManager({ focus: true }),
  getUpdate: async () => (await chrome.storage.local.get("update")).update || null,
};

// --- YouTube via the local yt-dlp helper (native messaging) ------------------------
// Extension → native host (native-host/host.js) → your yt-dlp.exe → file on disk.
// One native connection per download; closing it stops yt-dlp.

const YT_HOST = "com.videosaver.ytdlp";
const YT_QUALITIES = ["best", "1080", "720", "480", "audio"];
const ytJobs = new Map(); // jobId -> { port, tabId, title }

function ytVideoId(url) {
  try {
    const u = new URL(url);
    if (!/^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/.test(u.hostname)) return null;
    const id = u.hostname === "youtu.be" ? u.pathname.slice(1)
      : u.pathname === "/watch" ? u.searchParams.get("v")
      : (/^\/(?:shorts|live)\/([^/?#]+)/.exec(u.pathname) || [])[1];
    return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
  } catch {
    return null;
  }
}

// One request → one reply over a short-lived connection (ping, folder picker).
function ytRequest(message, replyType, timeoutMs) {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(YT_HOST);
    } catch (err) {
      return resolve({ ok: false, notInstalled: true, error: err.message });
    }
    const reqId = crypto.randomUUID();
    const timer = setTimeout(() => finish({ ok: false, error: "The yt-dlp helper didn't answer." }), timeoutMs);
    function finish(result) {
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {}
      resolve(result);
    }
    port.onMessage.addListener((m) => {
      if (m.type === replyType && m.reqId === reqId) finish(m);
      else if (m.type === "error") finish({ ok: false, error: m.error });
    });
    port.onDisconnect.addListener(() => {
      const e = chrome.runtime.lastError?.message || "";
      finish({ ok: false, notInstalled: /not found|not exist|forbidden/i.test(e), error: e || "The yt-dlp helper closed." });
    });
    port.postMessage({ ...message, reqId });
  });
}

function ytNotify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 });
}

function ytForward(tabId, { type: hostType, ...rest }) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, { ...rest, type: "yt:event", hostType }).catch(() => {});
}

Object.assign(handlers, {
  ytPing: () => ytRequest({ type: "ping" }, "pong", 30000),
  ytPickFolder: ({ initial }) => ytRequest({ type: "pickFolder", initial: String(initial || "") }, "folder", 10 * 60 * 1000),

  async ytStart({ url, quality, folder, filename, title }, sender) {
    const id = ytVideoId(url);
    if (!id) return { error: "That isn't a YouTube video page." };
    if (!YT_QUALITIES.includes(quality)) return { error: "Unknown quality option." };
    const jobId = crypto.randomUUID();
    const tabId = sender.tab?.id;
    let port;
    try {
      port = chrome.runtime.connectNative(YT_HOST);
    } catch (err) {
      return { error: err.message, notInstalled: true };
    }
    const job = { port, tabId, title: String(title || "YouTube video").slice(0, 200) };
    ytJobs.set(jobId, job);
    const end = () => {
      ytJobs.delete(jobId);
      try {
        port.disconnect();
      } catch {}
    };
    port.onMessage.addListener((m) => {
      if (m.jobId && m.jobId !== jobId) return;
      ytForward(tabId, { ...m, jobId });
      if (m.type === "done") {
        ytNotify("Download complete", `${job.title}\n${m.file || ""}`);
        end();
      } else if (m.type === "error") {
        ytNotify("Download failed", `${job.title}\n${m.error}`);
        end();
      } else if (m.type === "cancelled") end();
    });
    port.onDisconnect.addListener(() => {
      if (!ytJobs.has(jobId)) return;
      ytJobs.delete(jobId);
      const e = chrome.runtime.lastError?.message || "The yt-dlp helper stopped unexpectedly.";
      ytForward(tabId, { type: "error", jobId, error: e, notInstalled: /not found|not exist/i.test(e) });
    });
    port.postMessage({
      type: "download", jobId,
      url: `https://www.youtube.com/watch?v=${id}`,
      quality,
      folder: String(folder || ""),
      filename: String(filename || "").slice(0, 200),
    });
    return { jobId };
  },

  ytCancel: ({ jobId }) => {
    ytJobs.get(jobId)?.port.postMessage({ type: "cancel", jobId });
  },
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return;
  Promise.resolve(h(msg, sender)).then(
    (r) => sendResponse(r ?? true),
    (err) => sendResponse({ error: err.message })
  );
  return true; // async response
});

// --- Update check -------------------------------------------------------------

const newer = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
};

async function checkForUpdate() {
  if (!UPDATE_REPO) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    if (!res.ok) return;
    const rel = await res.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const current = chrome.runtime.getManifest().version;
    await chrome.storage.local.set({
      update: latest && newer(latest, current) ? { version: latest, url: rel.html_url } : null,
    });
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("update-check", { periodInMinutes: 24 * 60, delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "update-check") checkForUpdate();
});
