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
    // Opt-in: let yt-dlp use this browser's YouTube sign-in (fixes "confirm you're not a bot").
    ui.signIn = el("input", { type: "checkbox", id: "vs-sign-in" });
    ui.signInRow = el(
      "div",
      { class: "vs-signin" },
      el("label", { class: "vs-check", for: "vs-sign-in" }, ui.signIn, el("span", { text: "Use my YouTube sign-in" })),
      el("div", {
        class: "vs-signin-note",
        text: "Only needed if YouTube says “Sign in to confirm you're not a bot”. Your youtube.com cookies (nothing else) " +
          "are given to yt-dlp for that download only. YouTube may restrict accounts used with download tools, so a spare account is safest.",
      })
    );
    ui.signIn.addEventListener("change", () => chrome.storage.local.set({ ytUseSignIn: ui.signIn.checked }));
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
        el("label", {}, "Save to", el("div", { class: "vs-folder" }, ui.folderText, ui.folderBtn)),
        ui.signInRow
      ),
      el("div", { class: "vs-progress" }, ui.bar),
      ui.status
    );
    chrome.storage.local.get(["ytQuality", "ytFolder", "ytUseSignIn"]).then(({ ytQuality, ytFolder, ytUseSignIn }) => {
      if (ytQuality) ui.quality.value = ytQuality;
      ui.signIn.checked = ytUseSignIn === true; // off unless the user turned it on
      ui.folderText.textContent = ytFolder || helper?.defaultFolder || "Downloads\\Video Saver";
      ui.folderText.title = ui.folderText.textContent;
    });
    ui.quality.addEventListener("change", () => chrome.storage.local.set({ ytQuality: ui.quality.value }));
  }

  // "?" panel: the one-time, per-computer setup the YouTube button needs, as copyable
  // commands in the order to run them, for the system this browser runs on.
  const RELOAD_STEP = {
    title: "Reload Video Saver: on the extensions page remove it and add it again (Firefox: reload it in about:debugging), then reload this page.",
    commands: [],
  };
  const SETUP = {
    windows: {
      shell: "PowerShell",
      steps: [
        { title: "Install Node.js (runs the helper)", commands: ["winget install -e --id OpenJS.NodeJS.LTS"] },
        { title: "Install ffmpeg (needed for 1080p and MP3)", commands: ["winget install -e --id Gyan.FFmpeg"] },
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
        { title: "Connect the helper to your browsers", commands: ["powershell -ExecutionPolicy Bypass -File .\\native-host\\install-host.ps1"] },
        RELOAD_STEP,
      ],
      note: "Moved the Video Saver folder? Run step 6 again. If winget isn't found, install “App Installer” from the Microsoft Store. Keep yt-dlp current with “.\\yt-dlp.exe -U”.",
    },
    mac: {
      shell: "Terminal",
      steps: [
        {
          title: "Install Homebrew, the Mac package manager (skip this if you already have it). When it finishes, run the “Next steps” commands it prints.",
          commands: ['/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'],
        },
        { title: "Install Node.js, ffmpeg and yt-dlp", commands: ["brew install node ffmpeg yt-dlp"] },
        {
          title: "Go to the Video Saver folder: type “cd ” (with a space), drag the folder from Finder into Terminal, and press Return.",
          commands: [],
        },
        {
          title: "Check everything is found (each line should print a version)",
          commands: ["node --version; ffmpeg -version | head -n 1; yt-dlp --version"],
        },
        { title: "Connect the helper to your browsers", commands: ["bash native-host/install-host.sh"] },
        RELOAD_STEP,
      ],
      note: "Moved the Video Saver folder? Run step 5 again. Keep yt-dlp current with “brew upgrade yt-dlp”.",
    },
    linux: {
      shell: "a terminal",
      steps: [
        { title: "Install Node.js and ffmpeg (Ubuntu/Debian; use your distribution's package manager otherwise)", commands: ["sudo apt install -y nodejs ffmpeg curl python3"] },
        {
          title: "Install yt-dlp for your user",
          commands: ["mkdir -p ~/.local/bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod a+rx ~/.local/bin/yt-dlp"],
        },
        { title: "Go to the Video Saver folder (right-click it → Open in Terminal, or use cd).", commands: [] },
        {
          title: "Check everything is found (each line should print a version)",
          commands: ["node --version; ffmpeg -version | head -n 1; ~/.local/bin/yt-dlp --version"],
        },
        { title: "Connect the helper to your browsers", commands: ["bash native-host/install-host.sh"] },
        RELOAD_STEP,
      ],
      note: "Moved the Video Saver folder? Run step 5 again. Keep yt-dlp current with “~/.local/bin/yt-dlp -U”.",
    },
  };

  function thisSystem() {
    const p = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""}`.toLowerCase();
    if (p.includes("mac")) return "mac";
    if (p.includes("linux") && !p.includes("android")) return "linux";
    return "windows";
  }

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
    const steps = el("ol");
    const sub = el("div", { class: "vs-help-sub" });
    const note = el("p", { class: "vs-help-note" });
    const tabs = el("div", { class: "vs-os-tabs", role: "tablist", "aria-label": "Your system" });
    const labels = { windows: "Windows", mac: "Mac", linux: "Linux" };

    function show(os) {
      const s = SETUP[os];
      sub.textContent = `On a new ${os === "windows" ? "PC" : "computer"}, run these in ${s.shell}, in order:`;
      steps.replaceChildren(...s.steps.map((st) => el("li", {}, el("div", { text: st.title }), ...st.commands.map(copyRow))));
      note.textContent = `${s.note} Full details are in the README.`;
      for (const b of tabs.children) {
        const on = b.dataset.os === os;
        b.classList.toggle("vs-on", on);
        b.setAttribute("aria-selected", String(on));
      }
    }
    for (const os of Object.keys(SETUP)) {
      tabs.append(el("button", { text: labels[os], role: "tab", "data-os": os, onclick: () => show(os) }));
    }
    show(thisSystem());

    return el(
      "div",
      { class: "vs-help", role: "region", "aria-label": "Setup help" },
      el("div", { class: "vs-help-title", text: "YouTube downloads need a one-time setup on each computer" }),
      el("p", {
        text: "Browsers can't run programs on their own, so this button hands the download to yt-dlp on this computer " +
          "through a small helper. The rest of Video Saver works without it.",
      }),
      ui.helpState,
      tabs,
      sub,
      steps,
      note
    );
  }

  function toggleHelp(open = !panel.classList.contains("vs-show-help")) {
    panel.classList.toggle("vs-show-help", open);
    ui.helpBtn.setAttribute("aria-expanded", String(open));
  }

  function showHelperState() {
    if (!ui.helpState) return;
    if (helper?.ok) {
      ui.helpState.textContent = `This computer: set up ✓ · yt-dlp ${helper.ytDlpVersion} · ffmpeg ${helper.ffmpeg ? "found" : "not found (1080p/MP3 limited)"}`;
      ui.helpState.className = "vs-help-state vs-ok";
    } else {
      ui.helpState.textContent = helper?.notInstalled
        ? "This computer: not set up yet. Follow the steps below."
        : `This computer: helper found but not working (${helper?.error || "no answer"}).`;
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
          ? "YouTube downloads aren't set up on this computer yet. See the steps above (or click ?)."
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
      useSignIn: ui.signIn.checked,
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
        if (/confirm you.?re not a bot|Sign in to confirm/i.test(m.error || "")) {
          // YouTube's bot check: point to the opt-in sign-in setting instead of yt-dlp's cookie advice.
          setStatus(
            ui.signIn.checked
              ? "YouTube still wants a sign-in check. Make sure you're signed in to YouTube in this window, reload the page, and try again (turning off a VPN can also help)."
              : "YouTube wants a sign-in check for this download. Try again with your VPN off, or open Options and turn on “Use my YouTube sign-in”.",
            "error"
          );
          if (!ui.signIn.checked) panel.classList.add("vs-show-options");
        } else {
          setStatus(`Download failed: ${m.error}`, "error");
        }
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
