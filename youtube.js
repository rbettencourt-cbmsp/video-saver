// YouTube watch pages: a Download panel under the video that sends the request to the
// local yt-dlp helper (see native-host/). Quality, audio-only, folder and file name
// are chosen here; progress and errors come back from the helper.
// YouTube is a single-page app, so the panel re-attaches whenever the video changes.

(() => {
  if (globalThis.__videoSaverYouTube) return;
  globalThis.__videoSaverYouTube = true;

  const QUALITY_OPTIONS = [
    ["best", "Best available"],
    ["1080", "1080p"],
    ["720", "720p"],
    ["480", "480p"],
    ["audio", "Audio only (MP3)"],
  ];

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  };

  function downloadIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M12 4v11M6.5 10.5 12 16l5.5-5.5M5 20h14");
    svg.append(p);
    return svg;
  }

  // --- State -----------------------------------------------------------------------

  let panel = null;
  let ui = {};
  let helper = null; // ping result
  let currentVideo = null;
  let activeJob = null; // { jobId, videoId }

  const videoIdFromLocation = () => {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = /^\/shorts\/([^/?#]+)/.exec(u.pathname);
    return m ? m[1] : null;
  };

  const videoTitle = () =>
    (document.querySelector("ytd-watch-metadata h1")?.textContent ||
      document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube$/, "")).trim();

  // --- UI ----------------------------------------------------------------------------

  function build() {
    ui.quality = el("select", { title: "Quality" }, ...QUALITY_OPTIONS.map(([v, t]) => el("option", { value: v, text: t })));
    ui.download = el("button", { class: "vs-primary", title: "Download with yt-dlp", onclick: start }, downloadIcon(), el("span", { text: "Download" }));
    ui.cancel = el("button", { text: "Cancel", onclick: cancel });
    ui.cancel.hidden = true;
    ui.optionsToggle = el("button", { class: "vs-link", text: "Options", onclick: () => panel.classList.toggle("vs-show-options") });
    ui.filename = el("input", { type: "text", spellcheck: "false", placeholder: "File name (optional)" });
    ui.folderText = el("span", { text: "…" });
    ui.folderBtn = el("button", { text: "Change…", onclick: chooseFolder });
    ui.bar = el("div");
    ui.status = el("div", { class: "vs-status" });
    ui.helpBtn = el("button", {
      class: "vs-help-btn", text: "?", title: "How YouTube downloads work / setup on a new PC",
      "aria-label": "Setup help", "aria-expanded": "false", onclick: () => toggleHelp(),
    });
    ui.help = buildHelp();

    panel = el(
      "div",
      { class: "vs-yt", id: "video-saver-yt" },
      el("div", { class: "vs-row" }, ui.download, ui.quality, ui.cancel, ui.optionsToggle, ui.helpBtn),
      ui.help,
      el(
        "div",
        { class: "vs-options" },
        el("label", {}, "File name", ui.filename),
        el("label", {}, "Save to", el("div", { class: "vs-folder" }, ui.folderText, ui.folderBtn))
      ),
      el("div", { class: "vs-progress" }, ui.bar),
      ui.status
    );
    chrome.storage.local.get(["ytQuality", "ytFolder"]).then(({ ytQuality, ytFolder }) => {
      if (ytQuality) ui.quality.value = ytQuality;
      ui.folderText.textContent = ytFolder || helper?.defaultFolder || "Downloads\\Video Saver";
      ui.folderText.title = ui.folderText.textContent;
    });
    ui.quality.addEventListener("change", () => chrome.storage.local.set({ ytQuality: ui.quality.value }));
  }

  // "?" panel: the one-time, per-PC setup the YouTube button needs, as copyable
  // PowerShell commands in the order to run them.
  const SETUP_STEPS = [
    {
      title: "Install Node.js (runs the helper)",
      commands: ["winget install -e --id OpenJS.NodeJS.LTS"],
    },
    {
      title: "Install ffmpeg (needed for 1080p and MP3)",
      commands: ["winget install -e --id Gyan.FFmpeg"],
    },
    {
      title: "Close PowerShell, then open a new one in the Video Saver folder (Shift + right-click the folder → Open PowerShell window here), so the new programs are found.",
      commands: [],
    },
    {
      title: "Download yt-dlp.exe into the folder (skip if it's already there), then make sure it's up to date",
      commands: [
        "Invoke-WebRequest -Uri https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -OutFile yt-dlp.exe",
        ".\\yt-dlp.exe -U",
      ],
    },
    {
      title: "Check everything is found (each line should print a version)",
      commands: ["node --version; ffmpeg -version | Select-Object -First 1; .\\yt-dlp.exe --version"],
    },
    {
      title: "Connect the helper to Chrome",
      commands: ["powershell -ExecutionPolicy Bypass -File .\\native-host\\install-host.ps1"],
    },
    {
      title: "In chrome://extensions, remove Video Saver and add it again with Load unpacked, then reload this page.",
      commands: [],
    },
  ];

  function copyRow(command) {
    const copy = el("button", { text: "Copy", title: "Copy this command" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command);
        copy.textContent = "Copied ✓";
      } catch {
        copy.textContent = "Select and copy it";
      }
      setTimeout(() => (copy.textContent = "Copy"), 2000);
    });
    return el("div", { class: "vs-cmd" }, el("code", { text: command }), copy);
  }

  function buildHelp() {
    ui.helpState = el("div", { class: "vs-help-state" });
    return el(
      "div",
      { class: "vs-help", role: "region", "aria-label": "Setup help" },
      el("div", { class: "vs-help-title", text: "YouTube downloads need a one-time setup on each PC" }),
      el("p", {
        text: "Chrome can't run programs on its own, so this button hands the download to yt-dlp.exe on this computer " +
          "through a small helper. The rest of Video Saver works without it.",
      }),
      ui.helpState,
      el("div", { class: "vs-help-sub", text: "On a new PC, run these in PowerShell, in order:" }),
      el("ol", {}, ...SETUP_STEPS.map((s) => el("li", {}, el("div", { text: s.title }), ...s.commands.map(copyRow)))),
      el("p", {
        class: "vs-help-note",
        text: "Moved the Video Saver folder? Run step 6 again. If winget isn't found, install “App Installer” from the Microsoft Store. Full details are in the README.",
      })
    );
  }

  function toggleHelp(open = !panel.classList.contains("vs-show-help")) {
    panel.classList.toggle("vs-show-help", open);
    ui.helpBtn.setAttribute("aria-expanded", String(open));
  }

  function showHelperState() {
    if (!ui.helpState) return;
    if (helper?.ok) {
      ui.helpState.textContent = `This PC: set up ✓ · yt-dlp ${helper.ytDlpVersion} · ffmpeg ${helper.ffmpeg ? "found" : "not found (1080p/MP3 limited)"}`;
      ui.helpState.className = "vs-help-state vs-ok";
    } else {
      ui.helpState.textContent = helper?.notInstalled
        ? "This PC: not set up yet. Follow the steps below."
        : `This PC: helper found but not working (${helper?.error || "no answer"}).`;
      ui.helpState.className = "vs-help-state vs-error";
    }
  }

  function setStatus(text, kind = "") {
    ui.status.textContent = text;
    ui.status.className = `vs-status ${kind ? `vs-${kind}` : ""}`;
  }

  function setBusy(busy) {
    panel.classList.toggle("vs-busy", busy);
    ui.download.disabled = busy || !helper?.ok;
    ui.quality.disabled = busy;
    ui.cancel.hidden = !busy;
    if (!busy) ui.bar.style.width = "0";
  }

  // Light or dark: YouTube marks dark mode with <html dark>; as a fallback, measure the
  // brightness of the page background.
  function pageIsDark() {
    if (document.documentElement.hasAttribute("dark")) return true;
    for (const node of [document.querySelector("ytd-app"), document.body, document.documentElement]) {
      if (!node) continue;
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(getComputedStyle(node).backgroundColor);
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue; // transparent: look further up
      const lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
      return lum < 0.5;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme() {
    panel?.classList.toggle("vs-dark", pageIsDark());
  }

  // Under the video on desktop; a small floating card elsewhere (Shorts, mobile layout).
  function attach() {
    applyTheme();
    const below = document.querySelector("ytd-watch-flexy #below");
    if (below) {
      panel.classList.remove("vs-floating");
      if (panel.parentElement !== below) below.prepend(panel);
    } else {
      panel.classList.add("vs-floating");
      if (panel.parentElement !== document.body) document.body.append(panel);
    }
  }

  async function checkHelper() {
    helper = await send({ type: "ytPing" });
    showHelperState();
    if (!helper?.ok) {
      ui.download.disabled = true;
      setStatus(
        helper?.notInstalled
          ? "YouTube downloads aren't set up on this PC yet. See the steps above (or click ?)."
          : `yt-dlp helper problem: ${helper?.error || "no answer"}. Click ? for setup help.`,
        "error"
      );
      if (helper?.notInstalled) toggleHelp(true);
      return;
    }
    ui.download.disabled = false;
    const { ytFolder } = await chrome.storage.local.get("ytFolder");
    if (!ytFolder) {
      ui.folderText.textContent = helper.defaultFolder;
      ui.folderText.title = helper.defaultFolder;
    }
    if (!helper.ffmpeg) setStatus("ffmpeg wasn't found: 1080p and MP3 need it, so lower-quality single files will be used.", "error");
    else if (!activeJob) setStatus(`Ready · yt-dlp ${helper.ytDlpVersion}`);
  }

  function onVideoChange() {
    const id = videoIdFromLocation();
    if (!id) {
      panel?.remove();
      currentVideo = null;
      return;
    }
    if (!panel) build();
    attach();
    if (id !== currentVideo) {
      currentVideo = id;
      // Fill in the title once YouTube has rendered it.
      setTimeout(() => {
        if (currentVideo === id && !ui.filename.matches(":focus")) ui.filename.value = videoTitle();
      }, 1200);
      if (!activeJob) {
        setBusy(false);
        if (helper?.ok) setStatus(`Ready · yt-dlp ${helper.ytDlpVersion}`);
      }
    }
    if (!helper) checkHelper();
  }

  // --- Actions ----------------------------------------------------------------------

  async function chooseFolder() {
    ui.folderBtn.disabled = true;
    setStatus("Choose a folder in the window that opened…");
    const { ytFolder } = await chrome.storage.local.get("ytFolder");
    const res = await send({ type: "ytPickFolder", initial: ytFolder || helper?.defaultFolder || "" });
    ui.folderBtn.disabled = false;
    if (res?.folder) {
      await chrome.storage.local.set({ ytFolder: res.folder });
      ui.folderText.textContent = res.folder;
      ui.folderText.title = res.folder;
      setStatus("Folder saved.");
    } else {
      setStatus(res?.error ? `Couldn't open the folder picker: ${res.error}` : "Folder unchanged.", res?.error ? "error" : "");
    }
  }

  async function start() {
    const id = videoIdFromLocation();
    if (!id) return;
    const { ytFolder } = await chrome.storage.local.get("ytFolder");
    setBusy(true);
    setStatus("Starting yt-dlp…");
    const res = await send({
      type: "ytStart",
      url: location.href,
      quality: ui.quality.value,
      folder: ytFolder || "",
      filename: ui.filename.value.trim(),
      title: videoTitle(),
    });
    if (!res || res.error) {
      setBusy(false);
      setStatus(res?.error || "Couldn't reach the extension.", "error");
      return;
    }
    activeJob = { jobId: res.jobId, videoId: id };
  }

  function cancel() {
    if (activeJob) send({ type: "ytCancel", jobId: activeJob.jobId });
    setStatus("Cancelling…");
  }

  // Events from the helper, forwarded by background.js as { type: "yt:event", hostType, jobId, … }.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "yt:event") handleEvent(msg);
  });

  function handleEvent(m) {
    if (!activeJob || m.jobId !== activeJob.jobId || !panel) return;
    switch (m.hostType) {
      case "started":
        setStatus(m.ffmpeg ? "Downloading…" : "Downloading (no ffmpeg: single-file format)…");
        break;
      case "progress": {
        ui.bar.style.width = `${Math.max(0, Math.min(100, m.percent))}%`;
        const part = m.stage > 0 ? " (audio)" : "";
        setStatus(`Downloading${part}… ${m.percent.toFixed(1)}%${m.speed ? ` · ${m.speed}` : ""}${m.eta && m.eta !== "Unknown" ? ` · ${m.eta} left` : ""}`);
        break;
      }
      case "status":
        ui.bar.style.width = "100%";
        setStatus(m.message);
        break;
      case "done":
        activeJob = null;
        setBusy(false);
        setStatus(`Saved${m.file ? `: ${m.file}` : ""}${m.warning ? ` (${m.warning})` : ""}`, "ok");
        break;
      case "cancelled":
        activeJob = null;
        setBusy(false);
        setStatus("Download cancelled.");
        break;
      case "error":
        activeJob = null;
        setBusy(false);
        setStatus(`Download failed: ${m.error}`, "error");
        break;
    }
  }
  // --- Navigation ---------------------------------------------------------------------

  document.addEventListener("yt-navigate-finish", () => setTimeout(onVideoChange, 300));
  let lastUrl = location.href;
  setInterval(() => {
    applyTheme(); // follows YouTube's theme switch without a reload
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onVideoChange();
    } else if (panel && currentVideo && !panel.isConnected) {
      attach(); // YouTube re-rendered the area under the video
    } else if (panel && panel.classList.contains("vs-floating") && document.querySelector("ytd-watch-flexy #below")) {
      attach(); // the watch layout finished loading
    }
  }, 1000);
  onVideoChange();
})();
