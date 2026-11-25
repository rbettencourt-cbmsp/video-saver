// Service worker:
//  * watches network responses and remembers media URLs per tab (badge shows the count)
//  * owns the download queue: every change goes through here so the popup, the page
//    button and the downloads tab never race. The downloads tab (downloads.html) runs jobs.
//  * optional daily update check against a GitHub repo (see UPDATE_REPO)

// Chrome runs this as a service worker (importScripts); Firefox as background scripts
// listed in its manifest, where compat.js and common.js are already loaded.
if (typeof importScripts === "function") importScripts("compat.js", "common.js");

// Set to "owner/repo" to get a "new version available" notice from GitHub releases.
const UPDATE_REPO = "rbettencourt-cbmsp/video-saver";

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
    // Firefox gives the frame's URL directly; Chrome only the origin, so ask webNavigation.
    const referrer = details.documentUrl || (await frameUrl(tabId, frameId, details.initiator ? details.initiator + "/" : ""));
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
    const from = details.initiator || details.originUrl || "";
    if (/^(chrome|moz)-extension:/.test(from)) return; // our own downloads
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

// A full page load starts a fresh list.
const lastUrl = new Map(); // tabId -> top frame URL without #hash
const noHash = (u) => String(u || "").split("#")[0];
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  lastUrl.set(d.tabId, noHash(d.url));
  clearTab(d.tabId);
});
// In-app navigation (pushState, e.g. the next lesson on a course site) is a new page too:
// forget streams from the previous one. Streams seen just before the URL changed are kept,
// because some sites load the next video first and update the address after.
const NAV_GRACE_MS = 1500;
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  const url = noHash(d.url);
  if (lastUrl.get(d.tabId) === url) return;
  lastUrl.set(d.tabId, url);
  const cutoff = Date.now() - NAV_GRACE_MS;
  serialize(async () => {
    const k = key(d.tabId);
    const { [k]: list = [] } = await chrome.storage.session.get(k);
    const kept = list.filter((m) => (m.seen || 0) >= cutoff);
    if (kept.length === list.length) return;
    await chrome.storage.session.set({ [k]: kept });
    setBadge(d.tabId, kept.length);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  lastUrl.delete(tabId);
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
  // (Filter by hand: Firefox doesn't accept moz-extension:// URLs as a query pattern.)
  const tab = (await chrome.tabs.query({})).find((t) => (t.url || "").startsWith(MANAGER_URL));
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
      if (j.kind === "youtube") {
        if (ytJobs.has(j.id)) ytJobs.get(j.id).port.postMessage({ type: "cancel", jobId: j.id });
        else Object.assign(j, { status: "cancelled", message: "Cancelled" });
      } else if (j.status === "queued") Object.assign(j, { status: "cancelled", message: "Cancelled" });
      else if (j.status === "running") j.status = "cancelling";
    }),
  retryJob: async ({ id }) => {
    const yt = (await getJobs()).find((x) => x.id === id && x.kind === "youtube" && ["error", "cancelled"].includes(x.status));
    if (yt) return startYt(yt.yt, null, yt.id);
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
// Chrome: "Specified native messaging host not found."; Firefox: "No such native application …".
const NOT_INSTALLED_RE = /not found|not exist|forbidden|no such native application/i;
// Chrome reports port errors on runtime.lastError, Firefox on port.error.
const portError = (p) => p?.error?.message || chrome.runtime.lastError?.message || "";

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
    port.onDisconnect.addListener((p) => {
      const e = portError(p);
      finish({ ok: false, notInstalled: NOT_INSTALLED_RE.test(e), error: e || "The yt-dlp helper closed." });
    });
    port.postMessage({ ...message, reqId });
  });
}

// Opt-in "Use my YouTube sign-in": this browser window's youtube.com cookies (only those),
// as Netscape cookie-file text for yt-dlp --cookies. Null if not signed in.
const YT_SIGNED_IN = /^(SID|SAPISID|LOGIN_INFO|__Secure-1PSID|__Secure-3PSID)$/;
async function ytCookieText(tab) {
  let storeId = tab?.cookieStoreId; // Firefox (containers, private windows)
  if (!storeId && chrome.cookies.getAllCookieStores) {
    const stores = await chrome.cookies.getAllCookieStores();
    storeId = stores.find((s) => (s.tabIds || []).includes(tab?.id))?.id; // Chrome: normal or incognito
  }
  const all = await chrome.cookies.getAll({ domain: "youtube.com", ...(storeId ? { storeId } : {}) });
  const cookies = all.filter(
    (c) => /(^|\.)youtube\.com$/i.test(c.domain.replace(/^\./, "")) && !/[\t\r\n]/.test(c.name + c.value)
  );
  if (!cookies.some((c) => YT_SIGNED_IN.test(c.name))) return null;
  const lines = cookies.map((c) => {
    const domain = c.hostOnly ? c.domain.replace(/^\./, "") : `.${c.domain.replace(/^\./, "")}`;
    const expires = c.session || !c.expirationDate ? 0 : Math.floor(c.expirationDate);
    return [
      `${c.httpOnly ? "#HttpOnly_" : ""}${domain}`,
      c.hostOnly ? "FALSE" : "TRUE",
      c.path || "/",
      c.secure ? "TRUE" : "FALSE",
      expires,
      c.name,
      c.value,
    ].join("\t");
  });
  return ["# Netscape HTTP Cookie File", ...lines].join("\n") + "\n";
}

function ytNotify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 });
}

function ytForward(tabId, { type: hostType, ...rest }) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, { ...rest, type: "yt:event", hostType }).catch(() => {});
}

// Starts one yt-dlp download. With `queue`, it's also a job in the download queue
// (kind "youtube"; background.js runs it, not the downloads tab) so it shows up there.
async function startYt({ url, quality, folder, filename, title, useSignIn, queue, pageUrl }, tab, retryOf) {
  const id = ytVideoId(url);
  if (!id) return { error: "That isn't a YouTube video page." };
  if (!YT_QUALITIES.includes(quality)) return { error: "Unknown quality option." };
  let cookies;
  if (useSignIn) {
    cookies = await ytCookieText(tab);
    if (!cookies) {
      return { error: "You're not signed in to YouTube in this window. Sign in, reload the page, and try again." };
    }
  }
  const jobId = retryOf || crypto.randomUUID();
  const tabId = queue ? null : tab?.id; // queued jobs report through the queue, not the page panel
  const name = String(title || "YouTube video").slice(0, 200);
  const patchJob = (patch) =>
    queue &&
    mutateJobs((jobs) => {
      const j = jobs.find((x) => x.id === jobId);
      if (j) Object.assign(j, patch);
    });
  if (queue) {
    const spec = { url: `https://www.youtube.com/watch?v=${id}`, quality, folder, filename, title: name, useSignIn, queue: true, pageUrl };
    const fields = {
      status: "running", progress: 0, bytes: 0, speed: 0, message: "Starting yt-dlp…", error: "", warn: "",
      kind: "youtube", name, url: spec.url, pageUrl, qualityLabel: quality === "best" ? "Best" : quality === "audio" ? "MP3" : `${quality}p`, yt: spec,
    };
    await mutateJobs((jobs) => {
      const j = jobs.find((x) => x.id === jobId);
      if (j) Object.assign(j, fields);
      else jobs.push({ id: jobId, created: Date.now(), ...fields });
    });
  }
  let port;
  try {
    port = chrome.runtime.connectNative(YT_HOST);
  } catch (err) {
    await patchJob({ status: "error", error: "The YouTube helper isn't installed (see the README)." });
    return { error: err.message, notInstalled: true };
  }
  const job = { port, tabId, title: name };
  ytJobs.set(jobId, job);
  const end = () => {
    ytJobs.delete(jobId);
    try {
      port.disconnect();
    } catch {}
  };
  const failText = (e) =>
    /confirm you.?re not a bot|Sign in to confirm/i.test(e || "")
      ? "YouTube wants a sign-in check. Turn off a VPN, or turn on “Use my YouTube sign-in” in the Download panel on youtube.com, then Retry."
      : e;
  port.onMessage.addListener((m) => {
    if (m.jobId && m.jobId !== jobId) return;
    ytForward(tabId, { ...m, jobId });
    if (m.type === "started") patchJob({ message: "Downloading…" });
    else if (m.type === "progress") {
      patchJob({
        progress: Math.max(0, Math.min(1, (m.percent || 0) / 100)),
        message: `Downloading${m.stage > 0 ? " (audio)" : ""}…${m.speed ? ` ${m.speed}` : ""}${m.eta && m.eta !== "Unknown" ? ` · ${m.eta} left` : ""}`,
      });
    } else if (m.type === "status") patchJob({ message: m.message });
    else if (m.type === "done") {
      patchJob({ status: "done", progress: 1, message: `Saved to ${m.file || "your YouTube folder"}`, ...(m.warning ? { warn: m.warning } : {}) });
      ytNotify("Download complete", `${job.title}
${m.file || ""}`);
      end();
    } else if (m.type === "error") {
      patchJob({ status: "error", error: failText(m.error) });
      ytNotify("Download failed", `${job.title}
${m.error}`);
      end();
    } else if (m.type === "cancelled") {
      patchJob({ status: "cancelled", message: "Cancelled" });
      end();
    }
  });
  port.onDisconnect.addListener((p) => {
    if (!ytJobs.has(jobId)) return;
    ytJobs.delete(jobId);
    const e = portError(p) || "The yt-dlp helper stopped unexpectedly.";
    const notInstalled = NOT_INSTALLED_RE.test(e);
    patchJob({ status: "error", error: notInstalled ? "The YouTube helper isn't installed on this computer (see the README)." : e });
    ytForward(tabId, { type: "error", jobId, error: e, notInstalled });
  });
  port.postMessage({
    type: "download", jobId,
    url: `https://www.youtube.com/watch?v=${id}`,
    quality,
    folder: String(folder || ""),
    filename: String(filename || "").slice(0, 200),
    ...(cookies ? { cookies } : {}),
  });
  return { jobId };
}

Object.assign(handlers, {
  ytPing: () => ytRequest({ type: "ping" }, "pong", 30000),
  ytPickFolder: ({ initial }) => ytRequest({ type: "pickFolder", initial: String(initial || "") }, "folder", 10 * 60 * 1000),

  // From youtube.js (sender.tab) or from the popup for a YouTube player embedded in
  // another site (msg.tabId, msg.queue: also listed in the download queue).
  async ytStart(msg, sender) {
    const tab = sender.tab || (msg.tabId != null ? await chrome.tabs.get(msg.tabId).catch(() => null) : null);
    return startYt(msg, tab);
  },

  ytCancel: ({ jobId }) => {
    ytJobs.get(jobId)?.port.postMessage({ type: "cancel", jobId });
  },
});

// --- Firefox: Referer for our own downloads --------------------------------------
// Chrome uses declarativeNetRequest session rules (see job.js). Firefox doesn't apply
// those to an extension's own requests, so here a blocking webRequest listener sets
// Referer on requests from our pages to the hosts a running job registered.
const refererRules = new Map(); // jobId -> { hosts: Set, referrer }
if (globalThis.VS_IS_FIREFOX && chrome.webRequest?.onBeforeSendHeaders) {
  const ownBase = chrome.runtime.getURL("");
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (d) => {
      if (!refererRules.size || !(d.originUrl || "").startsWith(ownBase)) return;
      const host = new URL(d.url).hostname;
      const rule = [...refererRules.values()].find((r) => r.hosts.has(host));
      if (!rule) return;
      const headers = d.requestHeaders.filter((h) => h.name.toLowerCase() !== "referer");
      headers.push({ name: "Referer", value: rule.referrer });
      return { requestHeaders: headers };
    },
    { urls: ["<all_urls>"] },
    ["blocking", "requestHeaders"]
  );
}
Object.assign(handlers, {
  setReferer: ({ id, hosts, referrer }) => {
    refererRules.set(String(id), { hosts: new Set(hosts), referrer: String(referrer) });
  },
  clearReferer: ({ id }) => {
    refererRules.delete(String(id));
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
