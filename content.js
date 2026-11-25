// Content script (top frame): a floating "download" button that appears when the page
// has videos. Clicking it opens the same panel as the toolbar popup, inside the page.

(() => {
  if (window !== top || globalThis.__videoSaverButton) return;
  // YouTube has its own Download panel (youtube.js), and its Trusted Types policy blocks this markup.
  if (/(^|\.)youtube\.com$/.test(location.hostname)) return;
  globalThis.__videoSaverButton = true;

  let host, panel, button, count = 0, dismissed = false, tabId = null;

  function build() {
    host = document.createElement("div");
    host.style.cssText = "all: initial; position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        .btn { width: 48px; height: 48px; border-radius: 50%; border: none; cursor: pointer;
               background: #1a73e8; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35);
               display: grid; place-items: center; position: relative; }
        .btn:hover { background: #1765cc; }
        .count { position: absolute; top: -4px; right: -4px; background: #fff; color: #1a73e8;
                 font: 700 11px system-ui; border-radius: 9px; min-width: 18px; height: 18px;
                 display: grid; place-items: center; padding: 0 4px; box-sizing: border-box; }
        .close { position: absolute; top: -8px; left: -8px; width: 18px; height: 18px; border-radius: 50%;
                 border: none; background: #444; color: #fff; font: 12px/18px system-ui; cursor: pointer;
                 display: none; padding: 0; }
        .wrap:hover .close { display: block; }
        iframe { position: absolute; right: 0; bottom: 60px; width: 404px; height: 520px; border: none;
                 border-radius: 10px; box-shadow: 0 6px 28px rgba(0,0,0,.35); background: #fff; display: none; }
        iframe.open { display: block; }
      </style>
      <div class="wrap">
        <iframe title="Video Saver"></iframe>
        <button class="close" title="Hide on this page">×</button>
        <button class="btn" title="Save video (Video Saver)">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 4v11M6.5 10.5 12 16l5.5-5.5M5 20h14"/></svg>
          <span class="count"></span>
        </button>
      </div>`;
    panel = root.querySelector("iframe");
    button = root.querySelector(".btn");
    button.addEventListener("click", toggle);
    root.querySelector(".close").addEventListener("click", () => {
      dismissed = true;
      host.remove();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") panel.classList.remove("open");
    });
    document.documentElement.append(host);
  }

  async function toggle() {
    if (panel.classList.contains("open")) {
      panel.classList.remove("open");
      return;
    }
    if (tabId == null) tabId = (await chrome.runtime.sendMessage({ type: "whoami" }))?.tabId;
    panel.src = chrome.runtime.getURL(`popup.html?tabId=${tabId}&embedded=1&t=${Date.now()}`);
    panel.classList.add("open");
  }

  function show(n) {
    if (dismissed || n <= 0) return;
    count = Math.max(count, n);
    if (!host) build();
    if (!host.isConnected) document.documentElement.append(host);
    button.querySelector(".count").textContent = String(count);
  }

  function scan() {
    const items = globalThis.videoSaverDetect?.() || [];
    show(items.length);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "mediaCount") {
      if (msg.count === 0) {
        count = 0;
        host?.remove();
        setTimeout(scan, 1500); // new page in a single-page app: look again
      } else show(msg.count);
    }
  });

  // Players often load after the page; re-scan a few times as the page changes.
  let pending = null;
  let scans = 0;
  new MutationObserver(() => {
    if (pending || scans > 30) return;
    pending = setTimeout(() => {
      pending = null;
      scans++;
      scan();
    }, 1500);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
