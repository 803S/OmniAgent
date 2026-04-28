// ==UserScript==
// @name         OmniAgent Rebuild Baseline Loader
// @namespace    omniagent-rebuild-baseline
// @version      1.2.27
// @description  OmniAgent 轻量加载器，按需从本地服务拉取主面板脚本
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  if (window.top !== window.self) {
    return;
  }
  if (window.__omniagentRebuildLoaderInjected) {
    return;
  }
  window.__omniagentRebuildLoaderInjected = "2026.04.28.4";

  const STORAGE_NAMESPACE = "omniagent_rebuild_baseline_v2";
  const API_BASE_STORAGE_KEY = `${STORAGE_NAMESPACE}_api_base_url`;
  const API_BASE_FALLBACKS = ["http://127.0.0.1:8765", "http://localhost:8765"];
  const APP_SCRIPT_PATH = "/frontend/omniagent.app.js";
  const BUILD_ID = "2026.04.28.4";
  const LOADER_LAUNCHER_ID = "omniagent-v2-loader-launcher";
  const LOADER_STYLE_ID = "omniagent-v2-loader-style";
  const LOADER_LAUNCHER_POSITION_STORAGE_KEY = `${STORAGE_NAMESPACE}_loader_launcher_position`;
  const LOADER_RUNTIME_KEY = "__omniagentRebuildLoaderRuntime";
  const LOADER_PAGE_RUNTIME_KEY = "__omniagentRebuildLoaderPageRuntime";
  const LOADER_PAGE_STATUS_KEY = "__omniagentRebuildLoaderPageStatus";
  let loaderBusy = false;
  let appLoaded = false;
  let appLoadingPromise = null;
  let launcherObserver = null;
  const dragState = {
    active: false,
    moved: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    launcherX: 0,
    launcherY: 0,
  };

  function getPageGlobal() {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow) {
      return unsafeWindow;
    }
    return window;
  }

  function getApiBases() {
    const saved = String(localStorage.getItem(API_BASE_STORAGE_KEY) || "").trim().replace(/\/+$/, "");
    const bases = saved ? [saved, ...API_BASE_FALLBACKS] : API_BASE_FALLBACKS.slice();
    return Array.from(new Set(bases.filter(Boolean)));
  }

  function injectLoaderStyle() {
    if (document.getElementById(LOADER_STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = LOADER_STYLE_ID;
    style.textContent = `
      #${LOADER_LAUNCHER_ID} {
        position: fixed;
        left: calc(100vw - 118px);
        top: calc(100vh - 58px);
        z-index: 2147483647;
        display: inline-flex;
        align-items: center;
        padding: 1px;
        border: 1px solid transparent;
        border-radius: 16px;
        background:
          linear-gradient(135deg, rgba(15, 23, 42, 0.94), rgba(15, 23, 42, 0.88)) padding-box,
          linear-gradient(120deg, #38bdf8, #8b5cf6, #22c55e, #f59e0b, #38bdf8) border-box;
        background-size: 100% 100%, 220% 220%;
        color: #f8fbff;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 14px 30px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
        backdrop-filter: blur(14px);
        overflow: hidden;
      }
      #${LOADER_LAUNCHER_ID}[data-state="loading"] {
        opacity: 0.88;
      }
      #${LOADER_LAUNCHER_ID}[data-dragging="true"] {
        cursor: grabbing;
      }
      #${LOADER_LAUNCHER_ID}[data-state="error"] {
        background:
          linear-gradient(135deg, rgba(127, 29, 29, 0.96), rgba(127, 29, 29, 0.88)) padding-box,
          linear-gradient(120deg, #ef4444, #f97316, #ef4444) border-box;
      }
      #${LOADER_LAUNCHER_ID} .oa2-loader-core {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 15px;
        background: rgba(15, 23, 42, 0.76);
      }
      #${LOADER_LAUNCHER_ID} .oa2-loader-orb {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: linear-gradient(135deg, #38bdf8, #8b5cf6 55%, #f59e0b);
        box-shadow: 0 0 12px rgba(56, 189, 248, 0.5), 0 0 18px rgba(139, 92, 246, 0.26);
        flex: 0 0 auto;
      }
      #${LOADER_LAUNCHER_ID} .oa2-loader-label {
        color: #f8fbff;
        white-space: nowrap;
        font: 600 12px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function clampValue(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    if (max < min) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  function readLauncherPosition() {
    try {
      const raw = localStorage.getItem(LOADER_LAUNCHER_POSITION_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!Number.isFinite(parsed?.x) || !Number.isFinite(parsed?.y)) {
        return null;
      }
      return { x: Number(parsed.x), y: Number(parsed.y) };
    } catch (error) {
      return null;
    }
  }

  function writeLauncherPosition(x, y) {
    try {
      localStorage.setItem(LOADER_LAUNCHER_POSITION_STORAGE_KEY, JSON.stringify({ x, y }));
    } catch (error) {
      // ignore storage write errors
    }
  }

  function resolveLauncherHost() {
    return document.body || document.documentElement;
  }

  function applyLauncherPosition(x, y) {
    const launcher = document.getElementById(LOADER_LAUNCHER_ID);
    if (!launcher) {
      return;
    }
    const margin = 12;
    const width = launcher.offsetWidth || 118;
    const height = launcher.offsetHeight || 42;
    const nextX = clampValue(Math.round(x), margin, window.innerWidth - width - margin);
    const nextY = clampValue(Math.round(y), margin, window.innerHeight - height - margin);
    launcher.style.left = `${nextX}px`;
    launcher.style.top = `${nextY}px`;
    writeLauncherPosition(nextX, nextY);
  }

  function restoreLauncherPosition() {
    const launcher = document.getElementById(LOADER_LAUNCHER_ID);
    if (!launcher) {
      return;
    }
    const saved = readLauncherPosition();
    if (saved) {
      applyLauncherPosition(saved.x, saved.y);
      return;
    }
    const defaultX = window.innerWidth - (launcher.offsetWidth || 118) - 18;
    const defaultY = window.innerHeight - (launcher.offsetHeight || 42) - 18;
    applyLauncherPosition(defaultX, defaultY);
  }

  function onLauncherPointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    const launcher = event.currentTarget;
    if (!(launcher instanceof HTMLElement)) {
      return;
    }
    const rect = launcher.getBoundingClientRect();
    dragState.active = true;
    dragState.moved = false;
    dragState.pointerId = event.pointerId;
    dragState.startX = event.clientX;
    dragState.startY = event.clientY;
    dragState.launcherX = rect.left;
    dragState.launcherY = rect.top;
    launcher.dataset.dragging = "true";
    launcher.setPointerCapture(event.pointerId);
  }

  function onLauncherPointerMove(event) {
    if (!dragState.active || event.pointerId !== dragState.pointerId) {
      return;
    }
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      dragState.moved = true;
    }
    applyLauncherPosition(dragState.launcherX + deltaX, dragState.launcherY + deltaY);
  }

  function resetDragState(pointerId) {
    const launcher = document.getElementById(LOADER_LAUNCHER_ID);
    if (launcher?.hasPointerCapture(pointerId)) {
      launcher.releasePointerCapture(pointerId);
    }
    if (launcher) {
      delete launcher.dataset.dragging;
    }
    dragState.active = false;
    dragState.pointerId = null;
    window.setTimeout(() => {
      dragState.moved = false;
    }, 0);
  }

  function onLauncherPointerUp(event) {
    if (!dragState.active || event.pointerId !== dragState.pointerId) {
      return;
    }
    resetDragState(event.pointerId);
  }

  function restoreLoaderLauncher() {
    const launcher = ensureLoaderLauncher();
    const host = resolveLauncherHost();
    if (launcher && host && launcher.parentNode !== host) {
      host.appendChild(launcher);
    }
    restoreLauncherPosition();
    return launcher;
  }

  function onViewportChange() {
    if (appLoaded) {
      return;
    }
    restoreLoaderLauncher();
  }

  function ensureLoaderLauncher() {
    let launcher = document.getElementById(LOADER_LAUNCHER_ID);
    if (launcher) {
      return launcher;
    }
    injectLoaderStyle();
    launcher = document.createElement("button");
    launcher.id = LOADER_LAUNCHER_ID;
    launcher.type = "button";
    launcher.title = "打开 OmniAgent (Ctrl/Cmd+Shift+A)";
    launcher.dataset.state = "idle";
    launcher.innerHTML = `
      <span class="oa2-loader-core">
        <span class="oa2-loader-orb" aria-hidden="true"></span>
        <span class="oa2-loader-label">OmniAgent</span>
      </span>
    `;
    launcher.addEventListener("click", async () => {
      if (dragState.moved) {
        return;
      }
      await bootApp({ command: "open" });
    });
    launcher.addEventListener("pointerdown", onLauncherPointerDown);
    const host = resolveLauncherHost();
    host?.appendChild(launcher);
    restoreLauncherPosition();
    return launcher;
  }

  function setLauncherState(state, title) {
    const launcher = restoreLoaderLauncher();
    launcher.dataset.state = state;
    if (title) {
      launcher.title = title;
    }
  }

  function removeLoaderLauncher() {
    if (launcherObserver) {
      launcherObserver.disconnect();
      launcherObserver = null;
    }
    document.getElementById(LOADER_LAUNCHER_ID)?.remove();
  }

  function requestText(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: timeoutMs,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(String(response.responseText || ""));
            return;
          }
          reject(new Error(`HTTP ${response.status}`));
        },
        ontimeout: () => reject(new Error("timeout")),
        onerror: () => reject(new Error("network error")),
      });
    });
  }

  function getCspNonce() {
    const script = document.querySelector("script[nonce]");
    if (!(script instanceof HTMLScriptElement)) {
      return "";
    }
    return String(script.nonce || script.getAttribute("nonce") || "").trim();
  }

  function exposeRuntimeToPage(root) {
    const pageRuntime = {
      GM_addStyle: typeof GM_addStyle === "function" ? (...args) => GM_addStyle(...args) : null,
      GM_xmlhttpRequest: typeof GM_xmlhttpRequest === "function" ? (...args) => GM_xmlhttpRequest(...args) : null,
    };
    try {
      if (typeof cloneInto === "function") {
        root[LOADER_PAGE_RUNTIME_KEY] = cloneInto(pageRuntime, root, { cloneFunctions: true });
        return;
      }
    } catch (error) {
      // ignore cloneInto failures and fall back to direct assignment
    }
    root[LOADER_PAGE_RUNTIME_KEY] = pageRuntime;
  }

  function cleanupPageRuntime(root) {
    try {
      delete root[LOADER_PAGE_RUNTIME_KEY];
    } catch (error) {
      root[LOADER_PAGE_RUNTIME_KEY] = null;
    }
    try {
      delete root[LOADER_PAGE_STATUS_KEY];
    } catch (error) {
      root[LOADER_PAGE_STATUS_KEY] = null;
    }
  }

  function executeAppSourceWithNonce(source, debugLabel) {
    const root = getPageGlobal();
    const nonce = getCspNonce();
    if (!nonce) {
      throw new Error("missing CSP nonce");
    }
    exposeRuntimeToPage(root);
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.nonce = nonce;
    script.textContent = `
      (() => {
        const __oaLoaderRuntime = window.${LOADER_PAGE_RUNTIME_KEY} || {};
        const unsafeWindow = window;
        const GM_addStyle = typeof __oaLoaderRuntime.GM_addStyle === "function" ? __oaLoaderRuntime.GM_addStyle : undefined;
        const GM_xmlhttpRequest = typeof __oaLoaderRuntime.GM_xmlhttpRequest === "function" ? __oaLoaderRuntime.GM_xmlhttpRequest : undefined;
        try {
          ${String(source || "")}
          window.${LOADER_PAGE_STATUS_KEY} = {
            ok: true,
            hasAppInjected: Boolean(window.__omniagentRebuildInjected),
            hasBridge: Boolean(window.__omniagentRebuildBridge),
          };
        } catch (error) {
          window.${LOADER_PAGE_STATUS_KEY} = {
            ok: false,
            name: error?.name || "Error",
            message: error?.message || String(error || "unknown error"),
          };
          throw error;
        }
      })();
      //# sourceURL=${debugLabel}
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    const status = root[LOADER_PAGE_STATUS_KEY];
    cleanupPageRuntime(root);
    if (!status) {
      throw new Error("page script injection blocked");
    }
    if (!status.ok) {
      throw new Error(`${status.name || "Error"}: ${status.message || "page script execution failed"}`);
    }
  }

  async function executeAppSource(source, debugLabel) {
    const nonce = getCspNonce();
    if (nonce) {
      executeAppSourceWithNonce(source, debugLabel);
      return;
    }
    const runtime = {
      unsafeWindow: getPageGlobal(),
      GM_addStyle: typeof GM_addStyle === "function" ? GM_addStyle : null,
      GM_xmlhttpRequest: typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : null,
    };
    globalThis[LOADER_RUNTIME_KEY] = runtime;
    const prelude = `
      const __oaLoaderRuntime = globalThis.${LOADER_RUNTIME_KEY} || {};
      const unsafeWindow = typeof __oaLoaderRuntime.unsafeWindow !== "undefined" ? __oaLoaderRuntime.unsafeWindow : undefined;
      const GM_addStyle = typeof __oaLoaderRuntime.GM_addStyle === "function" ? __oaLoaderRuntime.GM_addStyle : globalThis.GM_addStyle;
      const GM_xmlhttpRequest = typeof __oaLoaderRuntime.GM_xmlhttpRequest === "function" ? __oaLoaderRuntime.GM_xmlhttpRequest : globalThis.GM_xmlhttpRequest;
    `;
    const moduleBlob = new Blob([`${prelude}\n${String(source || "")}\n//# sourceURL=${debugLabel}`], { type: "text/javascript" });
    const moduleUrl = URL.createObjectURL(moduleBlob);
    try {
      await import(moduleUrl);
    } finally {
      delete globalThis[LOADER_RUNTIME_KEY];
      window.setTimeout(() => URL.revokeObjectURL(moduleUrl), 0);
    }
  }

  async function loadAppScript() {
    if (appLoaded) {
      return true;
    }
    if (appLoadingPromise) {
      return appLoadingPromise;
    }
    appLoadingPromise = (async () => {
      const bases = getApiBases();
      let lastError = null;
      for (const base of bases) {
        const normalizedBase = String(base || "").trim().replace(/\/+$/, "");
        const url = `${normalizedBase}${APP_SCRIPT_PATH}?v=${encodeURIComponent(BUILD_ID)}`;
        try {
          const source = await requestText(url, 12000);
          localStorage.setItem(API_BASE_STORAGE_KEY, normalizedBase);
          await executeAppSource(source, "omniagent-app.js");
          appLoaded = true;
          return true;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error("main app unavailable");
    })()
      .finally(() => {
        appLoadingPromise = null;
      });
    return appLoadingPromise;
  }

  async function waitForBridge(timeoutMs = 4000) {
    const root = getPageGlobal();
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const bridge =
        root?.__omniagentRebuildBridge ||
        window?.__omniagentRebuildBridge ||
        globalThis?.__omniagentRebuildBridge;
      if (bridge && typeof bridge.getBuildId === "function") {
        return bridge;
      }
      const legacyDetected =
        Boolean(root.__omniagentV2Injected) ||
        Boolean(document.getElementById("omniagent-v2-panel")) ||
        Boolean(document.getElementById("omniagent-v2-launcher"));
      if (legacyDetected) {
        throw new Error("检测到旧版 OmniAgent V2 已注入，请先禁用旧脚本/扩展后再加载重构版。");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    const legacyDetected =
      Boolean(root.__omniagentV2Injected) ||
      Boolean(document.getElementById("omniagent-v2-panel")) ||
      Boolean(document.getElementById("omniagent-v2-launcher"));
    if (legacyDetected) {
      throw new Error("检测到旧版 OmniAgent V2 已注入，请先禁用旧脚本/扩展后再加载重构版。");
    }
    const appInjected = Boolean(window.__omniagentRebuildInjected);
    throw new Error(
      appInjected
        ? "bridge unavailable（主脚本已执行但未暴露 bridge；常见原因：脚本管理器的 unsafeWindow 隔离/注入策略、或页面 CSP/扩展拦截导致属性无法挂到页面 window）"
        : "bridge unavailable（主脚本未执行或提前 return；常见原因：脚本未在 top frame 执行、或页面里存在残留的旧版注入标记/DOM）",
    );
  }

  async function bootApp(options = {}) {
    if (loaderBusy) {
      return false;
    }
    loaderBusy = true;
    const command = String(options.command || "open").trim().toLowerCase();
    try {
      setLauncherState("loading", command === "analyze" ? "正在加载 OmniAgent 并开始分析..." : "正在加载 OmniAgent...");
      await loadAppScript();
      const bridge = await waitForBridge();
      removeLoaderLauncher();
      if (command === "analyze" && typeof bridge.analyzePage === "function") {
        await bridge.analyzePage();
      } else if (typeof bridge.openPanel === "function") {
        bridge.openPanel();
      }
      return true;
    } catch (error) {
      console.warn("[OmniAgent Loader] main app load failed:", error);
      try {
        const root = getPageGlobal();
        console.warn("[OmniAgent Loader] bridge debug:", {
          hasUnsafeWindow: typeof unsafeWindow !== "undefined" && Boolean(unsafeWindow),
          pageGlobalIsWindow: root === window,
          cspNoncePresent: Boolean(getCspNonce()),
          appInjectedFlag: Boolean(window.__omniagentRebuildInjected),
          hasBridgeOnPageGlobal: Boolean(root?.__omniagentRebuildBridge),
          hasBridgeOnWindow: Boolean(window?.__omniagentRebuildBridge),
          hasBridgeOnGlobalThis: Boolean(globalThis?.__omniagentRebuildBridge),
        });
      } catch (debugError) {
        // ignore debug failures
      }
      setLauncherState("error", `OmniAgent 加载失败：${error?.message || "unknown error"}`);
      return false;
    } finally {
      loaderBusy = false;
    }
  }

  function ensureLauncherObserver() {
    if (launcherObserver || appLoaded) {
      return;
    }
    const root = document.documentElement;
    if (!root) {
      return;
    }
    launcherObserver = new MutationObserver(() => {
      if (appLoaded || document.getElementById("omniagent-v2-launcher")) {
        return;
      }
      if (!document.getElementById(LOADER_LAUNCHER_ID)) {
        restoreLoaderLauncher();
      }
    });
    launcherObserver.observe(root, { childList: true, subtree: true });
  }

  window.addEventListener("keydown", async (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || String(event.key || "").toLowerCase() !== "a") {
      return;
    }
    if (event.defaultPrevented || event.altKey) {
      return;
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof Element && target.closest("[contenteditable=''], [contenteditable='true']"))
    ) {
      return;
    }
    event.preventDefault();
    await bootApp({ command: "analyze" });
  }, true);

  window.addEventListener("pointermove", onLauncherPointerMove, true);
  window.addEventListener("pointerup", onLauncherPointerUp, true);
  window.addEventListener("resize", onViewportChange, true);
  window.addEventListener("pageshow", onViewportChange, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      restoreLoaderLauncher();
      ensureLauncherObserver();
    }, { once: true });
  } else {
    restoreLoaderLauncher();
    ensureLauncherObserver();
  }
})();
