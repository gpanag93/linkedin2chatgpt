// ==UserScript==
// @name         Indeed Role Fit Checker
// @namespace    https://tampermonkey.net/
// @version      1.0.4
// @description  Indeed: adds “Check Suitability” on job pages (SPA-safe). Opens ChatGPT project; ChatGPT clears composer + pastes job text; no auto-send.
// @match        https://nl.indeed.com/*
// @match        https://*.indeed.com/*
// @match        https://chatgpt.com/*/project*
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  // ----- Per-tab singleton -----
  if (window.__IN_RFC__) return;
  window.__IN_RFC__ = {
    tabId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "_" + Math.random().toString(16).slice(2)),
    lastHref: "",
  };

  /* ================= CONFIG ================= */

  const CFG_PROJECT_URL_KEY = "cfg_project_url_v1";

  const STORE_KEY_PREFIX = "in_job_payload_tab_";
  const STORE_TS_PREFIX = "in_job_payload_ts_tab_";

  const MAX_PASTE_TIME_MS = 25_000;
  const POLL_INTERVAL_MS = 200;

  const ROUTER_TICK_MS = 500;
  const DEBUG = true;

  /* ================= UTILS ================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => DEBUG && console.log("[IN→CGPT]", ...a);
  const warn = (...a) => DEBUG && console.warn("[IN→CGPT]", ...a);

  const normalize = (s) =>
    (s || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const qsAny = (sels, root = document) => sels.map((s) => root.querySelector(s)).find(Boolean);

  function isIndeed() {
    return String(location.hostname || "").toLowerCase().endsWith("indeed.com");
  }

  function isChatGPT() {
    return location.host === "chatgpt.com";
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

  function getPayloadSignature(payload) {
    const firstLine = normalize((payload || "").split("\n")[0]);
    return firstLine.slice(0, 40);
  }

  function safeText(el) {
    try {
      return normalize(el?.innerText || el?.textContent || "");
    } catch {
      return "";
    }
  }

  /* ================= TRANSLATION MAPS ================= */

  const LANGUAGE_MAP = Object.freeze({
    Engels: "English",
    Nederlands: "Dutch",
    Duits: "German",
    Frans: "French",
    Spaans: "Spanish",
    Italiaans: "Italian",
    Portugees: "Portuguese",
    Pools: "Polish",
    Roemeens: "Romanian",
    Bulgaars: "Bulgarian",
    Hongaars: "Hungarian",
    Grieks: "Greek",
    Turks: "Turkish",
    Arabisch: "Arabic",
    Chinees: "Chinese",
    Japans: "Japanese",
    Koreaans: "Korean",
    Russisch: "Russian",
    Oekraïens: "Ukrainian",
    Zweeds: "Swedish",
    Noors: "Norwegian",
    Deens: "Danish",
    Fins: "Finnish",
    Tsjechisch: "Czech",
    Slowaaks: "Slovak",
    Kroatisch: "Croatian",
    Servisch: "Serbian",
    Sloveens: "Slovenian",
    Litouws: "Lithuanian",
    Lets: "Latvian",
    Estisch: "Estonian",
    Hebreeuws: "Hebrew",
    Hindi: "Hindi",
    Bengaals: "Bengali",
    Urdu: "Urdu",
    Perzisch: "Persian",
    Vietnamees: "Vietnamese",
    Indonesisch: "Indonesian",
    Maleis: "Malay",
    Thai: "Thai",
  });

  function translateLanguage(label) {
    const s = normalize(label);
    if (!s) return "";
    return LANGUAGE_MAP[s] || s;
  }

  // Work-mode / location terms (extend as needed)
  // NOTE: match on whole "tokens", so keep these as the exact phrases Indeed uses.
  const LOCATION_TERM_MAP = Object.freeze({
    "Hybride werken": "Hybrid",
    "Op locatie": "On-site",
    "Thuiswerk": "Remote",
    "Thuiswerken": "Remote",
  });

  // Country translation (Dutch -> English). Extend gradually.
  const COUNTRY_MAP = Object.freeze({
    Nederland: "Netherlands",
    België: "Belgium",
    Duitsland: "Germany",
    Frankrijk: "France",
    Spanje: "Spain",
    Italië: "Italy",
    Portugal: "Portugal",
    Zwitserland: "Switzerland",
    Oostenrijk: "Austria",
    Polen: "Poland",
    "Verenigd Koninkrijk": "United Kingdom",
    Ierland: "Ireland",
    Zweden: "Sweden",
    Noorwegen: "Norway",
    Denemarken: "Denmark",
    Finland: "Finland",
    Griekenland: "Greece",
    Turkije: "Turkey",
    Roemenië: "Romania",
    Bulgarije: "Bulgaria",
    "Tsjechië": "Czechia",
    Slowakije: "Slovakia",
    Hongarije: "Hungary",
    Kroatië: "Croatia",
    Servië: "Serbia",
    Slovenië: "Slovenia",
    Litouwen: "Lithuania",
    Letland: "Latvia",
    Estland: "Estonia",
  });

  function translateCountryToken(token) {
    const s = normalize(token);
    if (!s) return "";
    return COUNTRY_MAP[s] || s;
  }

  function translateWorkModeToken(token) {
    const s = normalize(token);
    if (!s) return "";
    return LOCATION_TERM_MAP[s] || s;
  }

  // Splits "Nederland • Thuiswerk" (and variants) into clean tokens.
  function splitBullets(text) {
    const s = normalize(text);
    if (!s) return [];
    // Indeed uses • (U+2022), but be tolerant.
    return s
      .split(/•|\u2022|\||,/g)
      .map((x) => normalize(x))
      .filter(Boolean);
  }

  function joinTokens(tokens) {
    return tokens.filter(Boolean).join(" | ");
  }

  /* ================= INDEED: DOM EXTRACTION ================= */

  function cleanJobTitle(raw) {
    let s = normalize(raw);
    s = s.replace(/\s*[-–—]\s*job\s*post\s*$/i, "");
    s = s.replace(/\s*job\s*post\s*$/i, "");
    return normalize(s);
  }

  function getJobTitle() {
    const el = qsAny(['[data-testid="jobsearch-JobInfoHeader-title"]', "h1", "h2"]);
    if (!el) return "";

    const clone = el.cloneNode(true);
    clone.querySelectorAll(".css-8u2krs").forEach((n) => n.remove());
    clone.querySelectorAll("span,div").forEach((n) => {
      const t = normalize(n.textContent);
      if (/job\s*post/i.test(t)) n.remove();
    });

    return cleanJobTitle(normalize(clone.textContent));
  }

  function getCompany() {
    return safeText(qsAny(['[data-testid="inlineHeader-companyName"]', '[data-company-name="true"]']));
  }

  function getCompanyInfoRoot() {
    return qsAny(['[data-testid="jobsearch-CompanyInfoContainer"]']);
  }

  function getLocationFromCompanyInfo() {
    const root = getCompanyInfoRoot();
    if (!root) return "";

    // Prefer explicit address-like node
    const el = qsAny(['[data-testid="job-location"]'], root);
    if (el) return normalize(safeText(el));

    // Fallback: inlineHeader-companyLocation may contain "Nederland • Thuiswerk"
    const el2 = qsAny(['[data-testid="inlineHeader-companyLocation"]'], root);
    if (!el2) return "";

    // Return only the "place-ish" part, NOT the work-mode token(s).
    const tokens = splitBullets(safeText(el2));
    if (!tokens.length) return "";

    // Heuristic: keep tokens that are NOT known work-mode terms.
    const placeTokens = tokens.filter((t) => !LOCATION_TERM_MAP[t]);

    // Translate a pure country token, keep addresses as-is.
    const translated = placeTokens.map((t) => translateCountryToken(t));
    return normalize(translated.join(" • "));
  }

  function getWorkTypeFromCompanyInfo() {
    const root = getCompanyInfoRoot();
    if (!root) return "";

    // Primary: try inlineHeader-companyLocation (often includes work-mode tokens).
    const el = qsAny(['[data-testid="inlineHeader-companyLocation"]'], root);
    const tokens = splitBullets(safeText(el));

    // Secondary: scan whole container (covers your other layout where work mode is in css-1fajx0z)
    const fallbackTokens = tokens.length ? tokens : splitBullets(safeText(root));

    const workModes = [];
    for (const t of fallbackTokens) {
      const mapped = translateWorkModeToken(t);
      if (mapped !== t) workModes.push(mapped);
      else if (LOCATION_TERM_MAP[t]) workModes.push(LOCATION_TERM_MAP[t]); // defensive
    }

    // De-dupe
    const seen = new Set();
    const out = [];
    for (const w of workModes) {
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(w);
    }

    // Usually you want one; if multiple, keep joined.
    return out.join(", ");
  }

  function getLocationFallbackOldSelectors() {
    const el = qsAny([
      '[data-testid="jobsearch-JobInfoHeader-companyLocation"]',
      "#jobLocationText",
      "#jobLocationWrapper",
    ]);
    return normalize(safeText(el));
  }

  function getLocationLine() {
    // Prefer company-info-derived place + work mode split (prevents "Remote | Remote")
    const place = getLocationFromCompanyInfo() || getLocationFallbackOldSelectors();

    // Translate country-only token if place is exactly a known country
    const placeTranslated = translateCountryToken(place);

    const workType = getWorkTypeFromCompanyInfo(); // already translated
    return joinTokens([placeTranslated, workType]);
  }

  function getDescription() {
    return 'About the job\n\n'+safeText(qsAny(["#jobDescriptionText", "div.jobsearch-JobComponent"]));
  }

  function findLanguagesGroupRoot() {
    const byAria = Array.from(document.querySelectorAll('[role="group"][aria-label]')).find((el) =>
      /(talen|languages)/i.test(el.getAttribute("aria-label") || "")
    );
    if (byAria) return byAria;

    const groups = Array.from(document.querySelectorAll('[role="group"]'));
    for (const g of groups) {
      const h3 = g.querySelector("h3");
      const t = normalize(h3?.textContent || "");
      if (/(talen|languages)/i.test(t)) return g;
    }
    return null;
  }

  function getLanguages() {
    const root = findLanguagesGroupRoot();
    if (!root) return [];

    const candidates = Array.from(root.querySelectorAll('button[data-testid$="-tile"]'));

    const labels = candidates
      .map((btn) => {
        const labelSpan =
          btn.querySelector("span.js-match-insights-provider-18uwqyc") ||
          btn.querySelector("span") ||
          btn;
        return safeText(labelSpan);
      })
      .map((s) => normalize(s.replace(/\(\s*vereist\s*\)\s*$/i, "")))
      .map(translateLanguage)
      .filter(Boolean);

    const seen = new Set();
    const out = [];
    for (const l of labels) {
      const key = l.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    return out;
  }

  function buildPayload() {
    const title = getJobTitle();
    const company = getCompany();
    const locationLine = getLocationLine();
    const desc = getDescription();

    const languages = getLanguages();
    const langsLine = languages.length ? `\n\nLanguages: ${languages.join(", ")}` : "";

    const headerBits = [title, company, locationLine].filter(Boolean);
    const header = headerBits.join("\n");

    return normalize([header, "", desc].join("\n")) + langsLine;
  }

  function isLikelyJobContext() {
    return !!qsAny([
      "#jobDescriptionText",
      "div.jobsearch-JobComponent",
      '[data-testid="jobsearch-JobInfoHeader-title"]',
    ]);
  }

  async function waitForDetails({ maxMs = 9000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const title = getJobTitle();
      const desc = getDescription();
      if (title && desc && desc.length > 80) return true;
      await sleep(150);
    }
    return false;
  }

  /* ================= UI INJECTION ================= */

  function ensureStyles() {
    if (document.getElementById("in-rfc-style")) return;
    const style = document.createElement("style");
    style.id = "in-rfc-style";
    style.textContent = `
      .in-rfc-inline {
        margin-left: 10px;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid rgba(0,0,0,0.35);
        background: #ffffff;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
        vertical-align: middle;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureInlineButtonNearTitle() {
    if (!isLikelyJobContext()) return;

    const titleEl = document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"]');
    if (!titleEl) return;

    const container =
      titleEl.closest(".jobsearch-JobInfoHeader-title-container") ||
      titleEl.parentElement ||
      titleEl;

    if (container.querySelector(".in-rfc-inline")) return;

    ensureStyles();

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "in-rfc-inline";
    btn.textContent = "Check Suitability";

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await onCheckSuitability(e);
    });

    if (titleEl.parentNode === container) container.appendChild(btn);
    else titleEl.insertAdjacentElement("afterend", btn);
  }

  function getJobKeyFromUrl() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("vjk") || u.searchParams.get("jk") || u.searchParams.get("jobKey") || "";
    } catch {
      return "";
    }
  }

  async function onCheckSuitability(e) {
    if (!isIndeed()) return;

    const forceConfig = !!(e && e.shiftKey);
    const projectUrl = getOrPromptProjectUrl({ force: forceConfig });
    if (!projectUrl) return;

    const ok = await waitForDetails({ maxMs: 9000 });
    if (!ok) {
      window.alert("Job details are not loaded yet. Open a job and try again.");
      return;
    }

    const payload = buildPayload();
    const sig = getPayloadSignature(payload);

    const tabId = window.__IN_RFC__.tabId;
    const { payloadKey, tsKey } = getTabScopedKeys(tabId);

    GM_setValue(payloadKey, payload);
    GM_setValue(tsKey, Date.now());

    try {
      GM_setClipboard(payload);
    } catch {}

    const jobKey = getJobKeyFromUrl();
    const urlToOpen = appendQuery(projectUrl, { in_rfc_tab: tabId, in_rfc_sig: sig, in_job: jobKey });
    window.open(urlToOpen, "_blank", "noopener");
  }

  function indeedTick() {
    if (!isIndeed()) return;
    if (document.visibilityState !== "visible") return;

    const st = window.__IN_RFC__;
    if (location.href !== st.lastHref) st.lastHref = location.href;

    ensureInlineButtonNearTitle();
  }

  /* ================= CHATGPT: PASTE ONCE (UNCHANGED) ================= */

  function getTabIdFromChatGptUrl() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("li_rfc_tab") || u.searchParams.get("in_rfc_tab") || "";
    } catch {
      return "";
    }
  }

  function getTabScopedKeysFromAnyPrefix(tabId) {
    try {
      const u = new URL(location.href);
      const isIndeedParam = !!u.searchParams.get("in_rfc_tab");
      const prefix = isIndeedParam
        ? { p: STORE_KEY_PREFIX, t: STORE_TS_PREFIX }
        : { p: "li_job_payload_tab_", t: "li_job_payload_ts_tab_" };
      return { payloadKey: prefix.p + tabId, tsKey: prefix.t + tabId };
    } catch {
      return { payloadKey: STORE_KEY_PREFIX + tabId, tsKey: STORE_TS_PREFIX + tabId };
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
      } catch {
        ok = false;
      }
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    return ok;
  }

  async function runChatGPTPasteOnce() {
    if (!isCurrentChatGPTProjectTarget()) return;

    const tabId = getTabIdFromChatGptUrl();
    if (!tabId) return;

    const { payloadKey, tsKey } = getTabScopedKeysFromAnyPrefix(tabId);
    const payload = GM_getValue(payloadKey, "");
    const ts = GM_getValue(tsKey, 0);

    if (!payload || Date.now() - ts > 10 * 60_000) return;

    const sig = getPayloadSignature(payload);
    const start = Date.now();

    while (Date.now() - start < MAX_PASTE_TIME_MS) {
      const box = findComposer();

      if (box) {
        clearComposer(box);
        await sleep(80);

        pasteInto(box, payload);

        await sleep(180);
        const textNow = getComposerText(box);
        const ok = !!sig && (textNow || "").replace(/\u00a0/g, " ").toLowerCase().includes(sig.toLowerCase());

        if (!ok) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        GM_setValue(payloadKey, "");
        GM_setValue(tsKey, 0);
        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    warn("ChatGPT: composer not found or paste not verified within time limit.");
  }

  /* ================= BOOT ================= */

  if (isIndeed()) {
    setInterval(indeedTick, ROUTER_TICK_MS);
    window.addEventListener("pageshow", indeedTick);
    window.addEventListener("focus", indeedTick);
    document.addEventListener("visibilitychange", indeedTick);
    indeedTick();
  }

  if (isChatGPT()) {
    setTimeout(runChatGPTPasteOnce, 1200);
  }
})();
