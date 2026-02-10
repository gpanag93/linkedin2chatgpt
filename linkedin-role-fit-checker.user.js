// ==UserScript==
// @name         LinkedIn Role Fit Checker
// @namespace    https://tampermonkey.net/
// @version      3.3.3
// @description  LinkedIn: adds “Check Suitability” on SPA navigation (jobs/search only). Prompts once for ChatGPT project URL (stored via GM_*). Opens project; ChatGPT clears composer + pastes text; no auto-send; terminates after paste.
// @match        https://www.linkedin.com/*
// @match        https://chatgpt.com/*/project*
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  /* ================= CONFIG ================= */

  const CFG_PROJECT_URL_KEY = "cfg_project_url_v1";

  const STORE_KEY = "li_job_payload_final";
  const STORE_TS_KEY = "li_job_payload_ts_final";

  const MAX_PASTE_TIME_MS = 25_000;
  const POLL_INTERVAL_MS = 200;

  // LinkedIn injection: poll until it succeeds, then stop. Re-arm on SPA route changes.
  const LI_POLL_MS = 1000;
  const LI_POLL_MAX_MS = 60_000;

  // URL watcher (we will STOP it when button is present; restart on navigation events)
  const LI_URL_WATCH_MS = 1000;

  const DEBUG = true;

  /* ================= UTILS ================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => DEBUG && console.log("[LI→CGPT]", ...a);
  const warn = (...a) => DEBUG && console.warn("[LI→CGPT]", ...a);

  const normalize = (s) =>
    (s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const qsAny = (sels, root = document) =>
    sels.map((s) => root.querySelector(s)).find(Boolean);

  function validateProjectUrl(url) {
    const u = (url || "").trim();
    if (!u) return { ok: false, reason: "empty" };

    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      return { ok: false, reason: "not-a-url" };
    }

    if (parsed.protocol !== "https:") return { ok: false, reason: "not-https" };
    if (parsed.host !== "chatgpt.com") return { ok: false, reason: "not-chatgpt.com" };
    if (!parsed.pathname.includes("/project")) return { ok: false, reason: "missing-/project" };

    parsed.hash = "";
    return { ok: true, url: parsed.toString(), parsed };
  }

  function getOrPromptProjectUrl({ force = false } = {}) {
    const existing = GM_getValue(CFG_PROJECT_URL_KEY, "");
    if (!force) {
      const v = validateProjectUrl(existing);
      if (v.ok) return v.url;
    }

    const message =
      "Enter your ChatGPT Project URL (must be a chatgpt.com/.../project link).\n\n" +
      "Example:\nhttps://chatgpt.com/g/<your-project-id>/project\n\n" +
      "Tip: Shift+Click the button to reconfigure later.";

    const input = window.prompt(message, existing || "");
    const v = validateProjectUrl(input);

    if (!v.ok) {
      window.alert(
        "Invalid URL.\n\n" +
          "Requirements:\n" +
          "- https://chatgpt.com/...\n" +
          "- URL path contains /project\n\n" +
          "Reason: " +
          v.reason
      );
      return null;
    }

    GM_setValue(CFG_PROJECT_URL_KEY, v.url);
    log("Config: saved project URL:", v.url);
    return v.url;
  }

  function isCurrentChatGPTProjectTarget() {
    const cfg = GM_getValue(CFG_PROJECT_URL_KEY, "");
    const v = validateProjectUrl(cfg);
    if (!v.ok) return false;

    try {
      const current = new URL(location.href);
      const target = new URL(v.url);

      if (current.origin !== target.origin) return false;
      if (!current.pathname.startsWith(target.pathname)) return false;

      return true;
    } catch {
      return false;
    }
  }

  // IMPORTANT: runtime guard — only run LinkedIn button logic on jobs search pages
  function isLinkedInJobsSearchPage() {
    return location.host === "www.linkedin.com" && (location.pathname.startsWith("/jobs/search") || location.pathname.startsWith("/jobs/collections"));
  }

  /* ================= LINKEDIN ================= */

  function getJobTitle() {
    return normalize(
      qsAny([
        ".job-details-jobs-unified-top-card__job-title h1 a",
        ".job-details-jobs-unified-top-card__job-title h1",
        "h1",
      ])?.innerText
    );
  }

  function getLocation() {
    const el = qsAny([
      ".job-details-jobs-unified-top-card__primary-description-container .tvm__text--low-emphasis",
      ".jobs-unified-top-card__subtitle-primary-grouping span",
    ]);
    return normalize(el?.innerText?.split("\n")[0]);
  }

  function getDescription() {
    return normalize(
      qsAny([
        "#job-details",
        ".jobs-description__content",
        ".jobs-description-content__text--stretch",
      ])?.innerText
    );
  }

  async function waitForJob() {
    for (let i = 0; i < 40; i++) {
      if (getJobTitle() && getDescription()) return true;
      await sleep(200);
    }
    return false;
  }

  function buildPayload() {
    return normalize([getJobTitle(), getLocation(), "", getDescription()].join("\n"));
  }

  // Used for better paste verification
  function getPayloadSignature(payload) {
    const firstLine = normalize((payload || "").split("\n")[0]);
    return firstLine.slice(0, 40); // stable, short signature
  }

  function injectButton() {
    // Do nothing if we’re not on jobs/search (safety)
    if (!isLinkedInJobsSearchPage()) return false;

    const host = qsAny([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__title-container h2",
    ]);

    if (!host) return false;
    if (host.querySelector(".li-check-suitability")) return true;

    const btn = document.createElement("button");
    btn.textContent = "Check Suitability";
    btn.className = "li-check-suitability";
    btn.style.cssText = `
      margin-left:10px;
      padding:4px 10px;
      border-radius:999px;
      border:1px solid #999;
      background:#fff;
      cursor:pointer;
      font-size:12px;
      white-space:nowrap;
    `;

    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const forceConfig = !!e.shiftKey;

      btn.disabled = true;
      btn.textContent = forceConfig ? "Config…" : "Preparing…";

      const projectUrl = getOrPromptProjectUrl({ force: forceConfig });
      if (!projectUrl) {
        btn.textContent = "Check Suitability";
        btn.disabled = false;
        return;
      }

      const ok = await waitForJob();
      if (!ok) {
        btn.textContent = "Failed";
        setTimeout(() => {
          btn.textContent = "Check Suitability";
          btn.disabled = false;
        }, 1000);
        return;
      }

      const payload = buildPayload();
      GM_setValue(STORE_KEY, payload);
      GM_setValue(STORE_TS_KEY, Date.now());

      try {
        GM_setClipboard(payload);
      } catch {}

      window.open(projectUrl, "_blank", "noopener");

      btn.textContent = "Opened";
      setTimeout(() => (btn.textContent = "Check Suitability"), 800);
      btn.disabled = false;
    };

    host.appendChild(btn);
    log("LinkedIn: button injected.");
    return true;
  }

  // Polling injector that stops once it succeeds (or times out), but can be restarted.
  let liPollTimer = null;
  function startLinkedInInjector(reason) {
    if (!isLinkedInJobsSearchPage()) return;
    if (liPollTimer) return;

    const startedAt = Date.now();
    log("LinkedIn: start injector:", reason);

    // Try immediately
    if (injectButton()) return;

    liPollTimer = setInterval(() => {
      // Abort if we navigated away
      if (!isLinkedInJobsSearchPage()) {
        clearInterval(liPollTimer);
        liPollTimer = null;
        return;
      }

      const ok = injectButton();
      const elapsed = Date.now() - startedAt;

      if (ok) {
        clearInterval(liPollTimer);
        liPollTimer = null;
        return;
      }

      if (elapsed > LI_POLL_MAX_MS) {
        clearInterval(liPollTimer);
        liPollTimer = null;
        warn("LinkedIn: injector timed out (button not found).");
      }
    }, LI_POLL_MS);
  }

  // Detect SPA navigation on LinkedIn and re-run injector.
  function hookLinkedInSpaNavigation() {
    let lastUrl = location.href;

    // URL watcher stops once button is present; restarts only on navigation events
    let urlWatchTimer = null;

    const stopUrlWatch = () => {
      if (!urlWatchTimer) return;
      clearInterval(urlWatchTimer);
      urlWatchTimer = null;
      log("LinkedIn: URL watcher stopped (button present).");
    };

    const startUrlWatch = () => {
      if (urlWatchTimer) return;

      urlWatchTimer = setInterval(() => {
        if (document.hidden) return;

        // Only watch when we are on jobs/search
        if (!isLinkedInJobsSearchPage()) return;

        // If button is already injected, stop the watcher.
        const already = !!document.querySelector(".li-check-suitability");
        if (already) {
          stopUrlWatch();
          return;
        }

        fireIfUrlChanged();
      }, LI_URL_WATCH_MS);

      log("LinkedIn: URL watcher started.");
    };

    const fireIfUrlChanged = () => {
      const now = location.href;
      if (now !== lastUrl) {
        lastUrl = now;

        // IMPORTANT: when we ENTER jobs/search via SPA from /feed,
        // this is the moment we must arm the injector (no reload needed).
        if (isLinkedInJobsSearchPage()) {
          setTimeout(() => startLinkedInInjector("url-changed"), 300);
          startUrlWatch();
        } else {
          // Leaving jobs/search: stop watcher to keep background cost minimal
          stopUrlWatch();
        }
      }
    };

    const _pushState = history.pushState;
    history.pushState = function () {
      _pushState.apply(this, arguments);
      fireIfUrlChanged();
    };

    const _replaceState = history.replaceState;
    history.replaceState = function () {
      _replaceState.apply(this, arguments);
      fireIfUrlChanged();
    };

    window.addEventListener("popstate", fireIfUrlChanged);

    // bfcache / restore navigation
    window.addEventListener("pageshow", (ev) => {
      if (!isLinkedInJobsSearchPage()) return;

      log("LinkedIn: pageshow (persisted=" + !!ev.persisted + ") → re-arming injector");
      startLinkedInInjector("pageshow");
      if (!document.querySelector(".li-check-suitability")) startUrlWatch();
    });

    // On tab focus, re-arm if we're on jobs/search and button isn't present.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (!isLinkedInJobsSearchPage()) return;

      if (!document.querySelector(".li-check-suitability")) {
        startUrlWatch();
        startLinkedInInjector("visibilitychange");
      }
    });

    // If we already loaded directly on jobs/search, arm immediately.
    if (isLinkedInJobsSearchPage()) {
      startUrlWatch();
      startLinkedInInjector("init-direct");
    }
  }

  function initLinkedIn() {
    // IMPORTANT CHANGE: do NOT early-return here.
    // The script must hook SPA navigation even when initially loaded on /feed/,
    // so it can react when you navigate into /jobs/search/ without a hard refresh.
    hookLinkedInSpaNavigation();

    // If the user hard-loads directly on /jobs/search/, also arm on load.
    window.addEventListener("load", () => {
      if (isLinkedInJobsSearchPage()) startLinkedInInjector("window-load");
    });
  }

  /* ================= CHATGPT ================= */

  function findComposer() {
    return (
      document.querySelector("div#prompt-textarea[contenteditable]") ||
      document.querySelector("div.ProseMirror[contenteditable]") ||
      document.querySelector("textarea#prompt-textarea")
    );
  }

  function getComposerText(el) {
    try {
      if (!el) return "";
      if (el.tagName === "TEXTAREA") return el.value || "";
      return el.innerText || el.textContent || "";
    } catch {
      return "";
    }
  }

  function clearComposer(el) {
    if (el.tagName === "TEXTAREA") {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    el.focus();
    try {
      document.execCommand("selectAll");
      document.execCommand("delete");
    } catch {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function pasteInto(el, text) {
    if (el.tagName === "TEXTAREA") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    el.focus();

    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }

    if (!ok) {
      try {
        el.textContent = text;
        ok = true;
        log("ChatGPT: execCommand(insertText) failed; used textContent fallback.");
      } catch {
        ok = false;
      }
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    return ok;
  }

  async function runChatGPTPasteOnce() {
    if (!isCurrentChatGPTProjectTarget()) {
      log("ChatGPT: not configured target project page; skipping.");
      return;
    }

    const payload = GM_getValue(STORE_KEY, "");
    const ts = GM_getValue(STORE_TS_KEY, 0);

    if (!payload || Date.now() - ts > 10 * 60_000) {
      log("ChatGPT: no payload found.");
      return;
    }

    // Verify paste by matching payload signature (job title prefix)
    const sig = getPayloadSignature(payload);
    log("ChatGPT: expecting signature:", sig);

    const start = Date.now();

    while (Date.now() - start < MAX_PASTE_TIME_MS) {
      const box = findComposer();

      if (box) {
        log("ChatGPT: composer found → clearing");
        clearComposer(box);
        await sleep(80);

        log("ChatGPT: pasting payload");
        pasteInto(box, payload);

        // Verify it "stuck" by checking signature, not just non-empty.
        await sleep(150);
        const textNow = getComposerText(box);
        const ok =
          !!sig &&
          (textNow || "").replace(/\u00a0/g, " ").toLowerCase().includes(sig.toLowerCase());

        if (!ok) {
          warn("ChatGPT: signature not found after paste; retrying…");
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        log("ChatGPT: paste verified → terminating script.");
        GM_setValue(STORE_KEY, "");
        GM_setValue(STORE_TS_KEY, 0);
        return; // termination
      }

      await sleep(POLL_INTERVAL_MS);
    }

    warn("ChatGPT: composer not found or paste not verified within time limit.");
  }

  /* ================= ROUTER ================= */

  if (location.host === "www.linkedin.com") {
    initLinkedIn();
  }

  if (location.host === "chatgpt.com") {
    setTimeout(runChatGPTPasteOnce, 1200);
  }
})();
