// ==UserScript==
// @name         LinkedIn Role Fit Checker
// @namespace    https://tampermonkey.net/
// @version      3.4.0
// @description  LinkedIn: adds “Check Suitability” on Jobs Search/Collections (SPA-safe). Prompts once for ChatGPT project URL (stored via GM_*). Opens project; ChatGPT clears composer + pastes job text; no auto-send; terminates after paste.
// @match        https://www.linkedin.com/*
// @match        https://chatgpt.com/*/project*
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ----- Per-tab singleton -----
  if (window.__LI_RFC__) return;
  window.__LI_RFC__ = {
    tabId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "_" + Math.random().toString(16).slice(2)),
    lastHref: "",
    uiReady: false,
    lastWarnAt: 0,
  };

  /* ================= CONFIG ================= */

  const CFG_PROJECT_URL_KEY = "cfg_project_url_v1";

  // Tab-scoped payload keys to avoid multi-tab collisions
  const STORE_KEY_PREFIX = "li_job_payload_tab_";
  const STORE_TS_PREFIX = "li_job_payload_ts_tab_";

  const MAX_PASTE_TIME_MS = 25_000;
  const POLL_INTERVAL_MS = 200;

  // Lightweight SPA router tick (no history monkeypatching)
  const ROUTER_TICK_MS = 500;

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

  const qsAny = (sels, root = document) => sels.map((s) => root.querySelector(s)).find(Boolean);

  function isLinkedIn() {
    return location.host === "www.linkedin.com";
  }

  function isChatGPT() {
    return location.host === "chatgpt.com";
  }

  function isLinkedInJobsSurface() {
    return (
      isLinkedIn() &&
      (location.pathname.startsWith("/jobs/search") || location.pathname.startsWith("/jobs/collections"))
    );
  }

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
      "Tip: Shift+Click to reconfigure later.";

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

  function getTabScopedKeys(tabId) {
    return {
      payloadKey: STORE_KEY_PREFIX + tabId,
      tsKey: STORE_TS_PREFIX + tabId,
    };
  }

  function appendQuery(url, obj) {
    try {
      const u = new URL(url);
      for (const [k, v] of Object.entries(obj)) u.searchParams.set(k, String(v));
      return u.toString();
    } catch {
      return url;
    }
  }

  /* ================= LINKEDIN: RELIABLE UI ================= */

  function ensureStyles() {
    if (document.getElementById("li-rfc-style")) return;
    const style = document.createElement("style");
    style.id = "li-rfc-style";
    style.textContent = `
      #li-rfc-fab {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483646;
        padding: 10px 14px;
        border-radius: 999px;
        border: 1px solid rgba(0,0,0,0.25);
        background: #ffffff;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 6px 18px rgba(0,0,0,0.18);
        user-select: none;
      }
      #li-rfc-fab[hidden] { display: none !important; }

      .li-rfc-inline {
        margin-left:10px;
        padding:4px 10px;
        border-radius:999px;
        border:1px solid #999;
        background:#fff;
        cursor:pointer;
        font-size:12px;
        white-space:nowrap;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureFab() {
    ensureStyles();

    let btn = document.getElementById("li-rfc-fab");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "li-rfc-fab";
      btn.type = "button";
      btn.textContent = "Check Suitability";
      btn.hidden = true;

      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await onCheckSuitability(e);
      });

      document.documentElement.appendChild(btn);
    }

    btn.hidden = !isLinkedInJobsSurface();
  }

  function ensureInlineButtonIfPossible() {
    if (!isLinkedInJobsSurface()) return;

    const host = qsAny([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__title-container h2",
      ".jobs-unified-top-card__job-title h1",
    ]);

    if (!host) return;
    if (host.querySelector(".li-rfc-inline")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "li-rfc-inline";
    btn.textContent = "Check Suitability";

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await onCheckSuitability(e);
    });

    host.appendChild(btn);
  }

  function getJobTitle() {
    return normalize(
      qsAny([
        ".job-details-jobs-unified-top-card__job-title h1 a",
        ".job-details-jobs-unified-top-card__job-title h1",
        ".jobs-unified-top-card__job-title h1",
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
        ".jobs-box__html-content",
      ])?.innerText
    );
  }

  function buildPayload() {
    return normalize([getJobTitle(), getLocation(), "", getDescription()].join("\n"));
  }

  function getPayloadSignature(payload) {
    const firstLine = normalize((payload || "").split("\n")[0]);
    return firstLine.slice(0, 40);
  }

  function getCurrentJobIdFromUrl() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("currentJobId") || "";
    } catch {
      return "";
    }
  }

  function findFirstJobCard() {
    // This is intentionally broad and resilient.
    return (
      document.querySelector("li.jobs-search-results__list-item") ||
      document.querySelector("div.job-card-container--clickable") ||
      document.querySelector("li.scaffold-layout__list-item")
    );
  }

  function clickCard(el) {
    if (!el) return false;
    const clickable = el.querySelector("a,button") || el;
    try {
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {
      return false;
    }
  }

  async function waitForDetails({ maxMs = 8000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const title = getJobTitle();
      const desc = getDescription();
      if (title && desc && desc.length > 50) return true;
      await sleep(150);
    }
    return false;
  }

  async function ensureAJobIsSelected() {
    // If there is already currentJobId, LinkedIn should mount details soon.
    const jobId = getCurrentJobIdFromUrl();
    if (jobId) return true;

    // Otherwise, try selecting the first visible card.
    const first = findFirstJobCard();
    if (!first) return false;

    clickCard(first);
    return true;
  }

  async function onCheckSuitability(e) {
    if (!isLinkedInJobsSurface()) return;

    const forceConfig = !!(e && e.shiftKey);

    const projectUrl = getOrPromptProjectUrl({ force: forceConfig });
    if (!projectUrl) return;

    // Core fix: if details pane isn't mounted, select a job first.
    const didSelect = await ensureAJobIsSelected();
    if (!didSelect) {
      window.alert("No job results found to select. Try a search first, then click “Check Suitability”.");
      return;
    }

    const ok = await waitForDetails({ maxMs: 9000 });
    if (!ok) {
      window.alert("Job details are not loaded yet. Click a job in the results first, then try again.");
      return;
    }

    const payload = buildPayload();
    const sig = getPayloadSignature(payload);

    const tabId = window.__LI_RFC__.tabId;
    const { payloadKey, tsKey } = getTabScopedKeys(tabId);

    GM_setValue(payloadKey, payload);
    GM_setValue(tsKey, Date.now());

    try {
      GM_setClipboard(payload);
    } catch {}

    // Pass tabId so ChatGPT reads the correct payload even with multiple LinkedIn tabs open
    const urlToOpen = appendQuery(projectUrl, { li_rfc_tab: tabId, li_rfc_sig: sig });
    window.open(urlToOpen, "_blank", "noopener");
  }

  function linkedinTick() {
    if (!isLinkedIn()) return;
    if (document.visibilityState !== "visible") return;

    const st = window.__LI_RFC__;
    if (location.href !== st.lastHref) {
      st.lastHref = location.href;
      st.uiReady = false;
    }

    ensureFab();

    if (!isLinkedInJobsSurface()) return;

    // Best effort: inline button near title if header exists
    ensureInlineButtonIfPossible();
    st.uiReady = true;
  }

  /* ================= CHATGPT: PASTE ONCE ================= */

  function getTabIdFromChatGptUrl() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("li_rfc_tab") || "";
    } catch {
      return "";
    }
  }

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

    const tabId = getTabIdFromChatGptUrl();
    if (!tabId) {
      log("ChatGPT: missing li_rfc_tab param; skipping.");
      return;
    }

    const { payloadKey, tsKey } = getTabScopedKeys(tabId);
    const payload = GM_getValue(payloadKey, "");
    const ts = GM_getValue(tsKey, 0);

    if (!payload || Date.now() - ts > 10 * 60_000) {
      log("ChatGPT: no payload found (or too old).");
      return;
    }

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

        await sleep(180);
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
        GM_setValue(payloadKey, "");
        GM_setValue(tsKey, 0);
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    warn("ChatGPT: composer not found or paste not verified within time limit.");
  }

  /* ================= BOOT ================= */

  if (isLinkedIn()) {
    setInterval(linkedinTick, ROUTER_TICK_MS);
    window.addEventListener("pageshow", linkedinTick);
    window.addEventListener("focus", linkedinTick);
    document.addEventListener("visibilitychange", linkedinTick);
    linkedinTick();
  }

  if (isChatGPT()) {
    setTimeout(runChatGPTPasteOnce, 1200);
  }
})();
