// ==UserScript==
// @name         OmniAgent Rebuild Baseline
// @namespace    omniagent-rebuild-baseline
// @version      1.2.27
// @description  OmniAgent 重构基线版浏览器副驾面板
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
  if (window.__omniagentV2Injected || document.getElementById("omniagent-v2-panel") || document.getElementById("omniagent-v2-launcher")) {
    console.warn("[OmniAgent Rebuild] 检测到页面已存在旧版 OmniAgent 注入，当前重构脚本跳过加载，避免双脚本冲突。");
    return;
  }
  if (window.__omniagentRebuildInjected) {
    return;
  }
  window.__omniagentRebuildInjected = "2026.04.28.4";

  const STORAGE_NAMESPACE = "omniagent_rebuild_baseline_v2";
  const API_BASE_STORAGE_KEY = `${STORAGE_NAMESPACE}_api_base_url`;
  let API_BASE = localStorage.getItem(API_BASE_STORAGE_KEY) || "http://127.0.0.1:8765";
  const API_BASE_FALLBACKS = ["http://127.0.0.1:8765", "http://localhost:8765"];
  const API_REQUEST_TIMEOUT_MS = 7000;
  const API_REQUEST_TIMEOUTS = {
    default: API_REQUEST_TIMEOUT_MS,
    quick: 5000,
    standard: 12000,
    long: 30000,
    xlong: 45000,
    vision: 60000,
  };
  const BUILD_ID = "2026.04.28.4";
  const RESIZE_OBSERVER_WARNINGS = new Set([
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
  ]);
  const LAUNCHER_POSITION_KEY = `${STORAGE_NAMESPACE}_launcher_position`;
  const PANEL_POSITION_KEY = `${STORAGE_NAMESPACE}_panel_position`;
  const PANEL_SIZE_KEY = `${STORAGE_NAMESPACE}_panel_size`;
  const PANEL_LAYOUT_BREAKPOINTS = {
    compactMax: 479,
    wideMin: 900,
  };
  const SCOPE_MEMORY_KEY = `${STORAGE_NAMESPACE}_scope_memory`;
  const MAX_FALLBACK_WORKFLOW_ACTIONS = 2;
  const PAGE_AGENT_DOM_CANDIDATE_LIMIT = 280;
  const PAGE_AGENT_BROWSER_STATE_CANDIDATE_LIMIT = 72;
  const PAGE_AGENT_INTERACTIVE_SUMMARY_LIMIT = 14;
  const DOM_CANDIDATE_OVERFLOW_SUMMARY_LIMIT = 16;
  const FALLBACK_DOM_CANDIDATE_LIMIT = 180;
  const PAGE_AGENT_TASK_STEP_TYPE = "page_agent_task";
  const state = {
    isOpen: false,
    activeView: "results",
    lastContextKey: "",
    lastAnalysis: null,
    lastTeachDraft: null,
    lastCapabilities: null,
    statusHistory: [],
    extractedExpanded: false,
    actionsExpanded: false,
    panelState: {
      results: {
        mode: "idle",
        title: "",
        detail: "",
        actions: [],
      },
      teach: {
        mode: "idle",
        title: "",
        detail: "",
        actions: [],
      },
    },
    sessionByContext: new Map(),
    teachMessagesByContext: new Map(),
    elementRegistry: new Map(),
    evidenceHighlights: [],
    analysisContextMediaByContext: new Map(),
    memoryPopoverOpen: false,
    review: {
      loading: false,
      loadedAt: "",
    },
    pageController: null,
    pageAgentNativeController: null,
    pageAgentVendorLoading: null,
    pageAgentVendorReady: false,
    pageAgentSnapshot: null,
    health: {
      status: "idle",
      message: "未检查",
    },
    lastTransport: "unknown",
    scope: {
      picking: false,
      root: null,
      hover: null,
      modal: null,
      cleanup: null,
      signature: "",
      candidateChain: [],
      chainIndex: -1,
      frozen: false,
    },
    valueHighlights: [],
    recorder: {
      active: false,
      steps: [],
      inspecting: false,
      cleanup: null,
    },
    healing: {
      active: false,
      cleanup: null,
      pending: null,
      candidateElements: [],
    },
    drag: {
      active: false,
      moved: false,
      startX: 0,
      startY: 0,
      launcherX: 0,
      launcherY: 0,
      pointerId: null,
    },
    panelDrag: {
      active: false,
      moved: false,
      startX: 0,
      startY: 0,
      panelX: 0,
      panelY: 0,
      pointerId: null,
      locked: false,
    },
    runtime: {
      active: false,
      mode: "idle",
      expanded: false,
      holdOpen: false,
      cancelRequested: false,
      pendingChoice: null,
      history: [],
      drag: {
        active: false,
        moved: false,
        startX: 0,
        startY: 0,
        calloutX: 0,
        calloutY: 0,
        pointerId: null,
        locked: false,
      },
    },
  };

  GM_addStyle(`
    #omniagent-v2-panel,
    #omniagent-v2-launcher,
    #oa2-scope-toolbar {
      --oa2-bg-panel: rgba(255, 255, 255, 0.78);
      --oa2-bg-surface: rgba(255, 255, 255, 0.4);
      --oa2-bg-surface-strong: rgba(255, 255, 255, 0.26);
      --oa2-bg-surface-hover: rgba(255, 255, 255, 0.58);
      --oa2-bg-soft: rgba(15, 23, 42, 0.028);
      --oa2-text-primary: #0f172a;
      --oa2-text-secondary: #526071;
      --oa2-text-muted: #64748b;
      --oa2-border: rgba(15, 23, 42, 0.055);
      --oa2-border-strong: rgba(15, 23, 42, 0.075);
      --oa2-blue: #2563eb;
      --oa2-blue-strong: #1e40af;
      --oa2-blue-soft: rgba(37, 99, 235, 0.08);
      --oa2-green: #059669;
      --oa2-green-soft: rgba(5, 150, 105, 0.08);
      --oa2-user-bubble: rgba(37, 99, 235, 0.08);
      --oa2-assistant-bubble: rgba(255, 255, 255, 0.34);
      --oa2-shadow-panel: 0 10px 28px rgba(15, 23, 42, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.56) inset;
      --oa2-shadow-soft: 0 1px 2px rgba(15, 23, 42, 0.04);
      --oa2-radius-sm: 7px;
      --oa2-radius-md: 10px;
      --oa2-radius-lg: 12px;
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      #omniagent-v2-panel,
      #omniagent-v2-launcher,
      #oa2-scope-toolbar {
        --oa2-bg-panel: rgba(15, 23, 42, 0.72);
        --oa2-bg-surface: rgba(30, 41, 59, 0.34);
        --oa2-bg-surface-strong: rgba(15, 23, 42, 0.26);
        --oa2-bg-surface-hover: rgba(51, 65, 85, 0.5);
        --oa2-bg-soft: rgba(148, 163, 184, 0.06);
        --oa2-text-primary: #e5edf6;
        --oa2-text-secondary: #cbd5e1;
        --oa2-text-muted: #93a4bd;
        --oa2-border: rgba(148, 163, 184, 0.1);
        --oa2-border-strong: rgba(148, 163, 184, 0.14);
        --oa2-blue: #60a5fa;
        --oa2-blue-strong: #93c5fd;
        --oa2-blue-soft: rgba(96, 165, 250, 0.1);
        --oa2-green: #34d399;
        --oa2-green-soft: rgba(52, 211, 153, 0.1);
        --oa2-user-bubble: rgba(59, 130, 246, 0.16);
        --oa2-assistant-bubble: rgba(255, 255, 255, 0.04);
        --oa2-shadow-panel: 0 14px 32px rgba(2, 6, 23, 0.3), 0 0 0 1px rgba(148, 163, 184, 0.06);
        --oa2-shadow-soft: 0 1px 2px rgba(2, 6, 23, 0.16);
      }
    }
    #omniagent-v2-launcher {
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
      touch-action: none;
      box-shadow: 0 14px 30px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
      backdrop-filter: blur(14px);
      text-shadow: none;
      overflow: hidden;
      isolation: isolate;
      animation: oa2GradientShift 5.4s linear infinite;
    }
    #omniagent-v2-launcher:hover {
      box-shadow: 0 18px 36px rgba(15, 23, 42, 0.28), 0 0 22px rgba(56, 189, 248, 0.18);
      transform: translateY(-1px);
    }
    #omniagent-v2-launcher::before {
      content: "";
      position: absolute;
      inset: -30%;
      background: conic-gradient(from 0deg, rgba(56, 189, 248, 0.55), rgba(139, 92, 246, 0.48), rgba(34, 197, 94, 0.4), rgba(245, 158, 11, 0.4), rgba(56, 189, 248, 0.55));
      filter: blur(18px);
      opacity: 0.55;
      z-index: -2;
      animation: oa2GradientSpin 6s linear infinite;
      pointer-events: none;
    }
    #omniagent-v2-launcher::after {
      content: "";
      position: absolute;
      inset: 1px;
      border-radius: 15px;
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.94), rgba(30, 41, 59, 0.9));
      z-index: -1;
      pointer-events: none;
    }
    .oa2-launcher-core {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      padding: 8px 13px;
      font: 700 12px/1 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0.01em;
    }
    .oa2-launcher-orb {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(135deg, #38bdf8, #8b5cf6 55%, #f59e0b);
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.5), 0 0 18px rgba(139, 92, 246, 0.26);
      animation: oa2LauncherPulse 1.8s ease-in-out infinite;
      flex: 0 0 auto;
    }
    .oa2-launcher-label {
      color: #f8fbff;
      white-space: nowrap;
      text-shadow: 0 1px 10px rgba(56, 189, 248, 0.18);
    }
    #omniagent-v2-panel {
      position: fixed;
      left: calc(100vw - 392px);
      top: calc(100vh - 486px);
      width: 392px;
      min-width: 320px;
      min-height: 288px;
      max-width: min(92vw, 1440px);
      max-height: 94vh;
      overflow: hidden;
      overscroll-behavior: contain;
      z-index: 2147483646;
      display: none;
      flex-direction: column;
      resize: both;
      background: var(--oa2-bg-panel);
      color: var(--oa2-text-primary);
      border: 1px solid var(--oa2-border);
      border-radius: 18px;
      box-shadow: var(--oa2-shadow-panel);
      font-family: "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      backdrop-filter: blur(18px);
    }
    #omniagent-v2-panel.open {
      display: flex;
    }
    .oa2-header {
      padding: 8px 10px 4px;
      border-bottom: 0;
      background: transparent;
      cursor: move;
      user-select: none;
      touch-action: none;
    }
    .oa2-header-main {
      min-width: 0;
    }
    .oa2-contextbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .oa2-context-left,
    .oa2-context-right {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .oa2-context-sep {
      color: var(--oa2-text-muted);
      font: 500 10px/1 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      flex: 0 0 auto;
    }
    .oa2-chip {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      max-width: 138px;
      padding: 2px 0;
      border-radius: 0;
      background: transparent;
      border: 0;
      color: var(--oa2-text-secondary);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .oa2-chip-persona {
      background: var(--oa2-blue-soft);
      border: 0;
      padding: 3px 7px;
      border-radius: 999px;
      color: var(--oa2-blue-strong);
    }
    .oa2-memory-link {
      border: 0;
      border-radius: 999px;
      background: rgba(5, 150, 105, 0.08);
      color: var(--oa2-green);
      padding: 3px 8px;
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      cursor: pointer;
    }
    .oa2-health-chip {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 999px;
      border: 0;
      background: rgba(15, 23, 42, 0.04);
      color: var(--oa2-text-secondary);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      white-space: nowrap;
    }
    .oa2-health-chip.ok {
      border-color: rgba(16, 185, 129, 0.2);
      background: var(--oa2-green-soft);
      color: var(--oa2-green);
    }
    .oa2-health-chip.pending {
      border-color: rgba(14, 165, 233, 0.2);
      background: var(--oa2-blue-soft);
      color: var(--oa2-blue-strong);
    }
    .oa2-health-chip.error {
      border-color: rgba(239, 68, 68, 0.18);
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }
    .oa2-close {
      width: 26px;
      height: 26px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--oa2-text-primary);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .oa2-subtitle {
      margin-bottom: 3px;
      color: var(--oa2-text-muted);
      font: 500 10px/1.35 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-build-tag {
      display: inline-block;
      margin-left: 6px;
      color: var(--oa2-text-muted);
      font: 500 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      opacity: 0.72;
    }
    .oa2-scope-banner {
      padding: 3px 2px 0;
      border-radius: 0;
      border: 0;
      background: transparent;
      color: var(--oa2-text-secondary);
      font-size: 10px;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .oa2-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .oa2-help-tip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      border-radius: 999px;
      border: 1px solid var(--oa2-border-strong);
      background: rgba(15, 23, 42, 0.04);
      color: var(--oa2-text-muted);
      font: 700 10px/1 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      cursor: help;
      flex: 0 0 auto;
      user-select: none;
    }
    .oa2-body {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      overscroll-behavior: contain;
      background: transparent;
    }
    .oa2-view {
      display: none;
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      overscroll-behavior: contain;
      padding: 10px;
      animation: oa2FadeIn 0.14s ease-out;
    }
    #omniagent-v2-panel[data-view="teach"] .oa2-contextbar,
    #omniagent-v2-panel[data-view="teach"] .oa2-scope-banner,
    #omniagent-v2-panel[data-view="memory"] .oa2-contextbar,
    #omniagent-v2-panel[data-view="memory"] .oa2-scope-banner,
    #omniagent-v2-panel[data-view="review"] .oa2-contextbar,
    #omniagent-v2-panel[data-view="review"] .oa2-scope-banner {
      display: none;
    }
    .oa2-view.is-active {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .oa2-quickbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .oa2-btn,
    .oa2-locate-btn,
    .oa2-action-btn,
    .oa2-dock-btn,
    .oa2-scope-btn {
      transition: background 150ms ease-out, color 150ms ease-out, border-color 150ms ease-out, transform 150ms ease-out;
    }
    .oa2-btn {
      padding: 6px 9px;
      border-radius: 8px;
      border: 1px solid rgba(37, 99, 235, 0.08);
      background: rgba(37, 99, 235, 0.08);
      color: var(--oa2-blue-strong);
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
    }
    .oa2-btn.secondary {
      background: transparent;
      color: var(--oa2-text-secondary);
      border-color: transparent;
    }
    .oa2-btn.warn {
      background: #ef4444;
      color: white;
    }
    .oa2-card,
    .oa2-summary-card,
    .oa2-teach-intro,
    .oa2-recorder-card,
    .oa2-memory-card {
      background: var(--oa2-bg-surface-strong);
      border: 1px solid var(--oa2-border);
      border-radius: 12px;
      box-shadow: none;
      padding: 9px 10px;
    }
    .oa2-memory-stack {
      display: grid;
      gap: 12px;
    }
    .oa2-review-view.is-active {
      display: block;
    }
    .oa2-review-shell {
      display: grid;
      gap: 12px;
    }
    .oa2-review-hero {
      display: grid;
      gap: 12px;
    }
    .oa2-review-stat-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .oa2-review-stat {
      border: 1px solid var(--oa2-border);
      border-radius: var(--oa2-radius-md);
      background: var(--oa2-bg-surface);
      padding: 12px;
      box-shadow: var(--oa2-shadow-soft);
    }
    .oa2-review-stat-label {
      font-size: 11px;
      color: var(--oa2-text-muted);
      margin-bottom: 6px;
    }
    .oa2-review-stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--oa2-text-primary);
      line-height: 1.1;
    }
    .oa2-review-stat-meta {
      margin-top: 6px;
      font-size: 11px;
      color: var(--oa2-text-secondary);
    }
    .oa2-review-section {
      display: grid;
      gap: 10px;
    }
    .oa2-review-item {
      border: 1px solid var(--oa2-border);
      border-radius: var(--oa2-radius-md);
      background: var(--oa2-bg-surface);
      padding: 12px;
      box-shadow: var(--oa2-shadow-soft);
    }
    .oa2-review-item-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 6px;
    }
    .oa2-review-item-title {
      font-weight: 600;
      color: var(--oa2-text-primary);
    }
    .oa2-review-badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(245, 158, 11, 0.14);
      color: #b45309;
      border: 1px solid rgba(245, 158, 11, 0.2);
    }
    .oa2-review-badge.good {
      background: var(--oa2-green-soft);
      color: var(--oa2-green);
      border-color: rgba(5, 150, 105, 0.16);
    }
    .oa2-review-item-reason {
      color: var(--oa2-text-secondary);
      font-size: 13px;
      line-height: 1.55;
    }
    .oa2-review-item-meta {
      margin-top: 8px;
      color: var(--oa2-text-muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .oa2-review-empty {
      border: 1px dashed var(--oa2-border-strong);
      border-radius: var(--oa2-radius-md);
      background: var(--oa2-bg-soft);
      color: var(--oa2-text-secondary);
      padding: 14px;
      line-height: 1.55;
    }
    .oa2-memory-section {
      display: grid;
      gap: 8px;
      padding-top: 10px;
      border-top: 1px solid var(--oa2-border);
    }
    .oa2-memory-section:first-child {
      padding-top: 0;
      border-top: 0;
    }
    .oa2-memory-section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .oa2-memory-section-title {
      color: var(--oa2-text-primary);
      font: 600 11px/1.3 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-memory-section-meta {
      color: var(--oa2-text-muted);
      font: 500 10px/1.3 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      white-space: nowrap;
    }
    .oa2-memory-stat-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .oa2-memory-usage-card {
      display: grid;
      gap: 10px;
      margin-bottom: 12px;
      padding: 10px;
      border-radius: 12px;
      border: 1px solid var(--oa2-border);
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(15, 23, 42, 0.02));
    }
    .oa2-memory-usage-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .oa2-memory-usage-item {
      min-width: 0;
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, 0.06);
      background: rgba(255, 255, 255, 0.34);
    }
    .oa2-memory-usage-label {
      color: var(--oa2-text-muted);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-memory-usage-value {
      margin-top: 6px;
      color: var(--oa2-text-primary);
      font: 700 14px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-memory-usage-meta {
      color: var(--oa2-text-secondary);
      font-size: 11px;
      line-height: 1.45;
    }
    .oa2-memory-lines {
      display: grid;
      gap: 7px;
    }
    .oa2-memory-line {
      color: var(--oa2-text-secondary);
      font-size: 10px;
      line-height: 1.5;
      word-break: break-word;
    }
    .oa2-summary-card {
      background: linear-gradient(90deg, rgba(37, 99, 235, 0.08), rgba(37, 99, 235, 0.01) 62%);
      border-color: transparent;
      box-shadow: inset 2px 0 0 rgba(37, 99, 235, 0.22);
      position: sticky;
      top: 0;
      z-index: 3;
    }
    .oa2-next-card {
      background:
        radial-gradient(circle at top right, rgba(16, 185, 129, 0.12), transparent 28%),
        linear-gradient(135deg, rgba(37, 99, 235, 0.08), rgba(37, 99, 235, 0.02));
      border-color: rgba(37, 99, 235, 0.12);
    }
    .oa2-next-summary {
      color: var(--oa2-text-primary);
      font-size: 14px;
      line-height: 1.5;
      font-weight: 700;
    }
    .oa2-next-meta {
      margin-top: 8px;
      color: var(--oa2-text-secondary);
      font-size: 11px;
      line-height: 1.55;
    }
    .oa2-next-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    #oa2-actions-card {
      padding: 0;
      border: 0;
      background: transparent;
    }
    #oa2-actions-card .oa2-card-title {
      padding: 0 1px;
    }
    .oa2-recorder-card.oa2-recorder-fold {
      padding: 0;
      overflow: hidden;
    }
    .oa2-recorder-card.oa2-recorder-fold summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
    }
    .oa2-recorder-card.oa2-recorder-fold summary::-webkit-details-marker {
      display: none;
    }
    .oa2-recorder-card.oa2-recorder-fold[open] summary {
      border-bottom: 1px solid var(--oa2-border);
    }
    .oa2-recorder-fold-body {
      display: grid;
      gap: 8px;
      padding: 0 9px 9px;
    }
    .oa2-recorder-fold-meta {
      color: var(--oa2-text-muted);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      white-space: nowrap;
    }
    .oa2-card-title,
    .oa2-summary-label {
      margin: 0 0 6px;
      color: var(--oa2-text-muted);
      font: 600 11px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0;
      text-transform: none;
    }
    .oa2-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .oa2-card-head .oa2-card-title {
      margin-bottom: 0;
    }
    .oa2-card-toggle {
      padding: 0;
      border: 0;
      background: none;
      color: var(--oa2-blue);
      cursor: pointer;
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    #oa2-summary {
      color: var(--oa2-text-primary);
      font-size: 13px;
      line-height: 1.45;
      font-weight: 600;
    }
    .oa2-summary-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .oa2-summary-stat {
      padding: 3px 7px;
      border-radius: 999px;
      background: rgba(37, 99, 235, 0.08);
      color: var(--oa2-text-secondary);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      white-space: nowrap;
    }
    .oa2-actions-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 1px;
      margin-bottom: 8px;
    }
    .oa2-actions-head .oa2-card-title {
      margin: 0;
    }
    .oa2-action-strip {
      display: grid;
      gap: 10px;
    }
    .oa2-action-item {
      padding: 10px 11px;
      border-radius: 14px;
      border: 1px solid rgba(37, 99, 235, 0.08);
      background: rgba(255, 255, 255, 0.54);
    }
    .oa2-action-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .oa2-action-title {
      color: var(--oa2-text-primary);
      font-size: 12px;
      line-height: 1.45;
      font-weight: 700;
    }
    .oa2-action-kind {
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(37, 99, 235, 0.08);
      color: var(--oa2-blue-strong);
      font: 700 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      white-space: nowrap;
    }
    .oa2-action-summary {
      color: var(--oa2-text-primary);
      font-size: 11px;
      line-height: 1.55;
    }
    .oa2-action-meta {
      margin-top: 6px;
      color: var(--oa2-text-secondary);
      font-size: 10px;
      line-height: 1.5;
    }
    .oa2-action-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .oa2-action-btn {
      padding: 6px 9px;
      border: 1px solid rgba(37, 99, 235, 0.08);
      border-radius: 8px;
      background: rgba(37, 99, 235, 0.06);
      color: var(--oa2-blue-strong);
      font-size: 10px;
      cursor: pointer;
      max-width: 100%;
    }
    .oa2-action-btn.primary {
      border-color: rgba(37, 99, 235, 0.1);
      background: rgba(37, 99, 235, 0.1);
      color: var(--oa2-blue-strong);
    }
    .oa2-action-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      filter: grayscale(0.1);
    }
    .oa2-fold-card {
      border: 0;
      border-top: 1px solid var(--oa2-border);
      border-radius: 0;
      background: transparent;
      overflow: visible;
    }
    .oa2-fold-card summary {
      list-style: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 1px 7px;
      cursor: pointer;
      user-select: none;
      color: var(--oa2-text-secondary);
    }
    .oa2-fold-card summary::-webkit-details-marker {
      display: none;
    }
    .oa2-fold-card[open] summary {
      border-bottom: 0;
    }
    .oa2-fold-title {
      font: 600 11px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      color: var(--oa2-text-muted);
    }
    .oa2-fold-meta {
      color: var(--oa2-text-muted);
      font: 500 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      white-space: nowrap;
    }
    .oa2-fold-body {
      padding: 1px 1px 0;
      background: transparent;
    }
    .oa2-extracted-grid {
      display: grid;
      grid-template-columns: minmax(72px, 96px) minmax(0, 1fr);
      gap: 7px 9px;
      align-items: start;
    }
    .oa2-field-key {
      color: var(--oa2-text-muted);
      font: 600 10px/1.35 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      word-break: break-word;
    }
    .oa2-field-value {
      color: var(--oa2-text-primary);
      font-size: 11px;
      line-height: 1.5;
      word-break: break-word;
    }
    .oa2-field-value.truncated {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }
    .oa2-empty,
    .oa2-muted {
      color: var(--oa2-text-secondary);
      font-size: 11px;
      line-height: 1.5;
    }
    .oa2-list {
      display: grid;
      gap: 8px;
    }
    .oa2-item {
      padding: 8px 9px;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.022);
      border: 1px solid rgba(15, 23, 42, 0.04);
      color: var(--oa2-text-primary);
      font-size: 11px;
      line-height: 1.45;
    }
    .oa2-trace-card {
      display: grid;
      gap: 6px;
      padding: 9px 10px;
      border-radius: 10px;
      background: rgba(37, 99, 235, 0.035);
      border: 1px solid rgba(37, 99, 235, 0.08);
    }
    .oa2-trace-topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .oa2-trace-id {
      color: var(--oa2-text-primary);
      font: 600 11px/1.4 "JetBrains Mono", "Fira Code", monospace;
      word-break: break-word;
    }
    .oa2-trace-state {
      color: var(--oa2-text-secondary);
      font-size: 10px;
      line-height: 1.4;
      white-space: nowrap;
    }
    .oa2-trace-meta {
      color: var(--oa2-text-secondary);
      font-size: 11px;
      line-height: 1.5;
      word-break: break-word;
    }
    .oa2-trace-reason {
      color: var(--oa2-text-primary);
      font-size: 11px;
      line-height: 1.5;
      word-break: break-word;
    }
    .oa2-trace-card summary {
      list-style: none;
      cursor: pointer;
    }
    .oa2-trace-card summary::-webkit-details-marker {
      display: none;
    }
    .oa2-trace-detail {
      color: var(--oa2-text-secondary);
      font-size: 10px;
      line-height: 1.5;
      word-break: break-word;
    }
    .oa2-inline-link {
      appearance: none;
      border: 0;
      background: none;
      padding: 0;
      margin: 0;
      color: var(--oa2-blue);
      font: inherit;
      cursor: pointer;
      text-align: left;
    }
    .oa2-inline-link:hover {
      color: var(--oa2-blue-strong);
      text-decoration: underline;
    }
    .oa2-inline-copy {
      appearance: none;
      border: 1px solid var(--oa2-border-strong);
      background: var(--oa2-bg-surface);
      color: var(--oa2-text-secondary);
      padding: 2px 6px;
      border-radius: 999px;
      font-size: 10px;
      line-height: 1.2;
      cursor: pointer;
    }
    .oa2-inline-copy:hover {
      color: var(--oa2-text-primary);
      border-color: rgba(37, 99, 235, 0.22);
      background: var(--oa2-blue-soft);
    }
    .oa2-inline-copy.is-success {
      color: var(--oa2-green);
      border-color: rgba(5, 150, 105, 0.22);
      background: var(--oa2-green-soft);
    }
    .oa2-item.is-highlighted,
    .oa2-trace-card.is-highlighted {
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.18);
      border-color: rgba(37, 99, 235, 0.22);
      background: rgba(37, 99, 235, 0.06);
    }
    .oa2-mono {
      font-family: "JetBrains Mono", "Fira Code", monospace;
      font-size: 11px;
      word-break: break-word;
    }
    .oa2-evidence-list {
      display: grid;
      gap: 10px;
    }
    .oa2-evidence-item {
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      background: rgba(37, 99, 235, 0.035);
      box-shadow: inset 2px 0 0 rgba(37, 99, 235, 0.28);
    }
    .oa2-evidence-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .oa2-evidence-title {
      color: var(--oa2-text-primary);
      font-size: 11px;
      font-weight: 600;
    }
    .oa2-evidence-quote {
      color: var(--oa2-text-primary);
      font-size: 11px;
      line-height: 1.55;
      margin-bottom: 4px;
    }
    .oa2-evidence-reason {
      color: var(--oa2-text-secondary);
      font-size: 10px;
      line-height: 1.45;
    }
    .oa2-locate-btn {
      padding: 3px 7px;
      border: 1px solid rgba(14, 165, 233, 0.14);
      border-radius: 999px;
      background: var(--oa2-blue-soft);
      color: var(--oa2-blue-strong);
      cursor: pointer;
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-status-log {
      border: 0;
      border-top: 1px solid var(--oa2-border);
      border-radius: 0;
      overflow: visible;
      background: transparent;
    }
    .oa2-status-log summary {
      list-style: none;
      cursor: pointer;
      padding: 9px 1px 7px;
      color: var(--oa2-text-muted);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      user-select: none;
    }
    .oa2-status-log summary::-webkit-details-marker {
      display: none;
    }
    .oa2-status-log[open] summary {
      border-bottom: 0;
    }
    .oa2-status-log-inner {
      display: grid;
      gap: 6px;
      padding: 1px 1px 0;
      background: transparent;
      color: var(--oa2-text-secondary);
      font: 500 10px/1.45 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-log-line {
      white-space: pre-wrap;
      word-break: break-word;
    }
    #oa2-debug-text {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--oa2-border);
      color: var(--oa2-text-muted);
    }
    .oa2-memory-pop {
      display: none;
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px solid rgba(16, 185, 129, 0.08);
      background: rgba(5, 150, 105, 0.04);
      box-shadow: none;
    }
    .oa2-memory-pop.open {
      display: block;
    }
    .oa2-memory-pop-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .oa2-memory-pop-item {
      padding: 8px 9px;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.02);
      border: 1px solid rgba(15, 23, 42, 0.04);
      color: var(--oa2-text-primary);
      font-size: 11px;
      line-height: 1.45;
    }
    .oa2-teach-shell {
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
      gap: 8px;
    }
    .oa2-teach-view.is-active {
      overflow: auto;
    }
    .oa2-teach-intro {
      padding: 8px 9px;
      flex: 0 0 auto;
    }
    .oa2-teach-recorder-inline,
    .oa2-teach-draftbar,
    .oa2-teach-bridge {
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      background: rgba(15, 23, 42, 0.02);
      color: var(--oa2-text-primary);
      flex: 0 0 auto;
    }
    .oa2-teach-recorder-inline {
      display: grid;
      gap: 8px;
    }
    .oa2-teach-recorder-inline.is-compact {
      padding: 6px 8px;
      gap: 6px;
    }
    .oa2-teach-bridge {
      display: grid;
      gap: 8px;
    }
    .oa2-teach-inline-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .oa2-teach-inline-meta {
      color: var(--oa2-text-muted);
      font: 600 10px/1.35 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-chat-thread {
      flex: 1 1 auto;
      min-height: 140px;
      max-height: none;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding-right: 2px;
    }
    .oa2-chat-msg {
      max-width: 86%;
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      background: var(--oa2-assistant-bubble);
      color: var(--oa2-text-primary);
      box-shadow: none;
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
      align-self: flex-start;
    }
    .oa2-chat-msg.user {
      align-self: flex-end;
      background: var(--oa2-user-bubble);
      border-color: rgba(14, 165, 233, 0.18);
      color: #0f172a;
    }
    @media (prefers-color-scheme: dark) {
      .oa2-chat-msg.user {
        color: #f8fafc;
      }
    }
    .oa2-chat-role {
      display: block;
      margin-bottom: 3px;
      color: var(--oa2-text-muted);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .oa2-rule-proposal {
      padding: 9px 10px;
      border-radius: 12px;
      border: 1px solid rgba(14, 165, 233, 0.08);
      background: rgba(14, 165, 233, 0.035);
      box-shadow: none;
    }
    .oa2-rule-proposal-body {
      margin-top: 8px;
      color: var(--oa2-text-primary);
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .oa2-rule-proposal-meta {
      margin-top: 8px;
      color: var(--oa2-text-muted);
      font: 600 10px/1.35 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-teach-result {
      padding: 8px 9px;
      border-radius: 10px;
      background: rgba(15, 23, 42, 0.02);
      border: 1px solid rgba(15, 23, 42, 0.04);
      color: var(--oa2-text-secondary);
      font-size: 11px;
      line-height: 1.5;
    }
    .oa2-chat-shortcuts {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      flex: 0 0 auto;
    }
    .oa2-shortcut {
      padding: 5px 8px;
      border-radius: 8px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      background: transparent;
      color: var(--oa2-text-secondary);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      cursor: pointer;
    }
    .oa2-chat-composer {
      margin-top: 0;
      padding: 7px 8px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(15, 23, 42, 0.04);
      box-shadow: none;
      flex: 0 0 auto;
    }
    .oa2-recorder-card.is-hidden {
      display: none;
    }
    .oa2-textarea {
      width: 100%;
      min-height: 42px;
      max-height: 84px;
      resize: vertical;
      box-sizing: border-box;
      padding: 8px 9px;
      border-radius: 9px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      background: rgba(255, 255, 255, 0.44);
      color: var(--oa2-text-primary);
      font: 500 12px/1.45 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-input {
      width: 100%;
      box-sizing: border-box;
      margin-bottom: 8px;
      padding: 8px 9px;
      border-radius: 9px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      background: rgba(255, 255, 255, 0.44);
      color: var(--oa2-text-primary);
      font: 500 11px/1.4 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-inline-buttons,
    .oa2-composer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .oa2-dock {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: center;
      gap: 8px;
      padding: 2px 10px 8px;
      border-top: 0;
      background: linear-gradient(180deg, transparent, rgba(15, 23, 42, 0.02));
    }
    .oa2-dock-btn {
      width: 100%;
      padding: 6px 1px;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: var(--oa2-text-secondary);
      font-size: 10px;
      font-weight: 500;
      cursor: pointer;
      text-align: center;
    }
    .oa2-idle-card {
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px dashed rgba(15, 23, 42, 0.06);
      background: rgba(15, 23, 42, 0.018);
      color: var(--oa2-text-secondary);
      font-size: 11px;
      line-height: 1.5;
    }
    .oa2-state-card,
    .oa2-teach-result {
      padding: 8px 9px;
      border-radius: 10px;
      border: 1px solid rgba(15, 23, 42, 0.04);
      background: rgba(15, 23, 42, 0.02);
      color: var(--oa2-text-primary);
      font-size: 11px;
      line-height: 1.5;
    }
    .oa2-state-card[data-mode="loading"],
    .oa2-teach-result[data-mode="loading"] {
      border-color: rgba(37, 99, 235, 0.12);
      background: rgba(37, 99, 235, 0.05);
    }
    .oa2-state-card[data-mode="success"],
    .oa2-teach-result[data-mode="success"] {
      border-color: rgba(16, 185, 129, 0.14);
      background: rgba(16, 185, 129, 0.06);
    }
    .oa2-state-card[data-mode="error"],
    .oa2-teach-result[data-mode="error"] {
      border-color: rgba(239, 68, 68, 0.16);
      background: rgba(239, 68, 68, 0.06);
    }
    .oa2-state-title {
      color: var(--oa2-text-primary);
      font: 700 12px/1.35 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-state-detail {
      margin-top: 5px;
      color: var(--oa2-text-secondary);
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .oa2-card.is-hidden,
    .oa2-fold-card.is-hidden,
    .oa2-summary-card.is-hidden,
    .oa2-idle-card.is-hidden,
    .oa2-state-card.is-hidden,
    .oa2-teach-recorder-inline.is-hidden,
    .oa2-teach-bridge.is-hidden,
    .oa2-teach-draftbar.is-hidden,
    .oa2-teach-result.is-hidden,
    .oa2-teach-intro.is-hidden {
      display: none;
    }
    .oa2-dock-btn.is-active {
      background: transparent;
      border-color: transparent;
      color: var(--oa2-blue-strong);
      font-weight: 600;
      box-shadow: inset 0 -2px 0 rgba(37, 99, 235, 0.28);
    }
    .oa2-btn:hover,
    .oa2-action-btn:hover,
    .oa2-shortcut:hover,
    .oa2-memory-link:hover,
    .oa2-fold-card summary:hover,
    .oa2-status-log summary:hover {
      background: rgba(15, 23, 42, 0.04);
    }
    .oa2-highlight {
      outline: 2px solid var(--oa2-blue) !important;
      outline-offset: 2px !important;
    }
    .oa2-scope-hover {
      outline: 3px dashed var(--oa2-blue) !important;
      outline-offset: 3px !important;
      background: rgba(37, 99, 235, 0.12) !important;
      cursor: crosshair !important;
    }
    .oa2-scope-selected {
      outline: 3px solid var(--oa2-green) !important;
      outline-offset: 3px !important;
      background: rgba(16, 185, 129, 0.12) !important;
      box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.18) !important;
    }
    .oa2-selected-has-image {
      box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.28) !important;
      background: rgba(251, 191, 36, 0.12) !important;
    }
    #oa2-scope-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483644;
      pointer-events: none;
      display: none;
    }
    #oa2-scope-box {
      position: fixed;
      border: 2px solid var(--oa2-blue);
      background: rgba(14, 165, 233, 0.1);
      box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.08);
      border-radius: 10px;
      pointer-events: none;
      display: none;
    }
    #oa2-scope-toolbar {
      position: fixed;
      z-index: 2147483645;
      display: none;
      align-items: center;
      gap: 8px;
      max-width: min(92vw, 720px);
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid var(--oa2-border);
      background: var(--oa2-bg-panel);
      color: var(--oa2-text-primary);
      box-shadow: var(--oa2-shadow-panel);
      pointer-events: auto;
      font-size: 12px;
      backdrop-filter: blur(16px);
    }
    .oa2-scope-meta {
      flex: 1;
      min-width: 0;
      line-height: 1.45;
    }
    .oa2-scope-desc {
      color: var(--oa2-text-primary);
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .oa2-scope-hint {
      color: var(--oa2-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .oa2-scope-btn {
      border: 1px solid var(--oa2-border);
      border-radius: 999px;
      background: var(--oa2-bg-surface);
      color: var(--oa2-text-primary);
      padding: 7px 11px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .oa2-scope-btn.primary {
      background: linear-gradient(180deg, var(--oa2-blue), var(--oa2-blue-strong));
      color: white;
      border-color: transparent;
    }
    .oa2-scope-btn.warn {
      background: #ef4444;
      color: white;
      border-color: transparent;
    }
    #oa2-healing-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      display: none;
      pointer-events: none;
    }
    #oa2-healing-overlay.active {
      display: block;
    }
    #oa2-runtime-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: none;
      pointer-events: none;
    }
    #oa2-runtime-overlay.active {
      display: block;
    }
    #oa2-runtime-backdrop {
      position: absolute;
      inset: 0;
      background: transparent;
      pointer-events: auto;
    }
    #oa2-runtime-highlight {
      position: fixed;
      display: none;
      border: 3px solid rgba(56, 189, 248, 0.98);
      border-radius: 12px;
      background: rgba(56, 189, 248, 0.16);
      box-shadow:
        0 0 0 2px rgba(255, 255, 255, 0.82),
        0 0 0 9999px rgba(15, 23, 42, 0.08),
        0 0 28px rgba(56, 189, 248, 0.3);
      pointer-events: none;
      transition: left 140ms ease-out, top 140ms ease-out, width 140ms ease-out, height 140ms ease-out;
    }
    #oa2-runtime-target-tag {
      position: fixed;
      display: none;
      max-width: min(48vw, 420px);
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid rgba(125, 211, 252, 0.45);
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.92));
      color: #f8fafc;
      font: 600 11px/1.2 "JetBrains Mono", "Fira Code", monospace;
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.28);
    }
    #oa2-runtime-callout {
      position: fixed;
      left: 50%;
      top: 0;
      width: min(392px, calc(100vw - 28px));
      color: #f8fbff;
      pointer-events: auto;
      user-select: none;
      --oa2-runtime-accent: #39b6ff;
      --oa2-runtime-accent-2: #bd45fb;
      --oa2-runtime-accent-3: rgba(255, 87, 51, 0.78);
      --oa2-runtime-surface: rgba(16, 22, 38, 0.82);
      --oa2-runtime-border: rgba(255, 255, 255, 0.3);
      --oa2-runtime-muted: rgba(233, 240, 250, 0.76);
    }
    #oa2-runtime-callout::before {
      content: "";
      position: absolute;
      inset: -2px -8px;
      border-radius: 18px;
      background: linear-gradient(135deg, rgba(57, 182, 255, 0.42), rgba(189, 69, 251, 0.28), rgba(57, 182, 255, 0.36));
      filter: blur(16px);
      opacity: 0.9;
      z-index: 0;
      pointer-events: none;
    }
    #oa2-runtime-callout::after {
      content: "";
      position: absolute;
      inset: -1px;
      border-radius: 18px;
      background: linear-gradient(120deg, rgba(56, 189, 248, 0.28), rgba(139, 92, 246, 0.2), rgba(34, 197, 94, 0.18), rgba(245, 158, 11, 0.16));
      opacity: 0.72;
      z-index: 0;
      pointer-events: none;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      padding: 1px;
    }
    #oa2-runtime-callout.expanded #oa2-runtime-history-wrap {
      max-height: 360px;
      opacity: 1;
      margin-top: 8px;
      visibility: visible;
    }
    #oa2-runtime-history-wrap {
      position: relative;
      max-height: 0;
      margin-top: 0;
      padding: 0 10px;
      overflow: hidden;
      opacity: 0;
      visibility: hidden;
      transition: max-height 180ms ease-out, opacity 180ms ease-out, margin-top 180ms ease-out;
      z-index: 1;
    }
    #oa2-runtime-history {
      max-height: 324px;
      overflow-y: auto;
      display: grid;
      gap: 8px;
      padding: 0 0 8px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.24) transparent;
    }
    #oa2-runtime-history::-webkit-scrollbar {
      width: 8px;
    }
    #oa2-runtime-history::-webkit-scrollbar-track {
      background: transparent;
    }
    #oa2-runtime-history::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.22);
    }
    .oa2-runtime-history-item {
      padding: 9px 11px;
      border-radius: 10px;
      border-left: 2px solid rgba(57, 182, 255, 0.52);
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.06));
      color: #f8fbff;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 1px 4px rgba(2, 6, 23, 0.18);
      font-size: 12px;
      line-height: 1.55;
    }
    .oa2-runtime-history-item[data-kind="success"] {
      border-left-color: rgba(34, 197, 94, 0.9);
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.22), rgba(34, 197, 94, 0.12));
    }
    .oa2-runtime-history-item[data-kind="done"] {
      border-left-width: 4px;
      border-left-color: rgba(34, 197, 94, 0.95);
      background: linear-gradient(135deg, rgba(34, 197, 94, 0.34), rgba(34, 197, 94, 0.18));
      box-shadow: 0 8px 20px rgba(34, 197, 94, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.12);
      color: #dcfce7;
      font-weight: 600;
    }
    .oa2-runtime-history-item[data-kind="error"] {
      border-left-color: rgba(239, 68, 68, 0.95);
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.28), rgba(239, 68, 68, 0.12));
      color: #fee2e2;
    }
    .oa2-runtime-history-item[data-kind="question"] {
      border-left-color: rgba(255, 159, 67, 0.9);
      background: linear-gradient(135deg, rgba(255, 159, 67, 0.28), rgba(255, 159, 67, 0.12));
    }
    .oa2-runtime-history-item[data-kind="observation"] {
      border-left-color: rgba(147, 51, 234, 0.9);
      background: linear-gradient(135deg, rgba(147, 51, 234, 0.22), rgba(147, 51, 234, 0.12));
    }
    .oa2-runtime-history-main {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .oa2-runtime-history-icon {
      flex: 0 0 auto;
      line-height: 1;
      margin-top: 1px;
    }
    .oa2-runtime-history-meta {
      margin-top: 6px;
      color: rgba(255, 255, 255, 0.72);
      font-size: 10px;
      line-height: 1.2;
    }
    #oa2-runtime-bar {
      position: relative;
      z-index: 2;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--oa2-runtime-border);
      background: var(--oa2-runtime-surface);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12) inset, 0 10px 22px rgba(2, 6, 23, 0.28);
      backdrop-filter: blur(12px);
    }
    #oa2-runtime-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      cursor: move;
    }
    #oa2-runtime-status {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    #oa2-runtime-indicator {
      width: 8px;
      height: 8px;
      margin-top: 5px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.55);
      flex: 0 0 auto;
    }
    #oa2-runtime-callout[data-mode="executing"] #oa2-runtime-indicator {
      background: var(--oa2-runtime-accent);
      animation: oa2RuntimeStatusPulse 800ms ease-in-out infinite;
    }
    #oa2-runtime-callout[data-mode="completed"] #oa2-runtime-indicator {
      background: #22c55e;
    }
    #oa2-runtime-callout[data-mode="error"] #oa2-runtime-indicator {
      background: #ef4444;
    }
    #oa2-runtime-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
    }
    .oa2-runtime-btn {
      min-width: 50px;
      height: 28px;
      padding: 0 10px;
      border: 0;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.12);
      color: #ffffff;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.01em;
    }
    .oa2-runtime-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    .oa2-runtime-btn.history {
      background: rgba(56, 189, 248, 0.18);
      color: #dbeafe;
    }
    .oa2-runtime-btn.stop {
      background: rgba(239, 68, 68, 0.2);
      color: #fecaca;
    }
    .oa2-runtime-btn.stop:hover {
      background: rgba(239, 68, 68, 0.3);
    }
    .oa2-runtime-btn.close {
      min-width: 28px;
      width: 28px;
      padding: 0;
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.84);
    }
    .oa2-runtime-btn.close:hover {
      background: rgba(255, 255, 255, 0.18);
      color: #ffffff;
    }
    #oa2-runtime-title {
      color: #ffffff;
      font: 600 12px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      margin-bottom: 3px;
    }
    #oa2-runtime-detail {
      color: var(--oa2-runtime-muted);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    #oa2-runtime-choice {
      display: none;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      gap: 8px;
    }
    #oa2-runtime-choice.active {
      display: grid;
    }
    #oa2-runtime-choice-copy {
      display: grid;
      gap: 6px;
    }
    .oa2-runtime-choice-line {
      color: rgba(255, 255, 255, 0.86);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .oa2-runtime-choice-line.is-muted {
      color: rgba(255, 255, 255, 0.68);
    }
    #oa2-runtime-choice-options {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    #oa2-runtime-choice-fields {
      display: grid;
      gap: 8px;
    }
    .oa2-runtime-choice-field {
      display: grid;
      gap: 4px;
    }
    .oa2-runtime-choice-field-label {
      color: rgba(255, 255, 255, 0.8);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.35;
    }
    .oa2-runtime-choice-field-label.required::after {
      content: " *";
      color: #fca5a5;
    }
    .oa2-runtime-choice-field-help {
      color: rgba(255, 255, 255, 0.58);
      font-size: 10px;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .oa2-runtime-choice-input {
      min-height: 34px;
      padding: 8px 10px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      font-size: 12px;
      line-height: 1.35;
      outline: none;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .oa2-runtime-choice-input:focus {
      border-color: rgba(56, 189, 248, 0.6);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.14);
    }
    .oa2-runtime-choice-input::placeholder {
      color: rgba(255, 255, 255, 0.44);
    }
    textarea.oa2-runtime-choice-input {
      min-height: 72px;
      resize: vertical;
    }
    .oa2-runtime-choice-btn {
      min-height: 32px;
      padding: 7px 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.25;
      text-align: left;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }
    .oa2-runtime-choice-btn:hover {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.22);
    }
    .oa2-runtime-choice-btn.primary {
      background: rgba(56, 189, 248, 0.2);
      border-color: rgba(56, 189, 248, 0.34);
      color: #dff6ff;
    }
    .oa2-runtime-choice-btn.warn {
      background: rgba(239, 68, 68, 0.16);
      border-color: rgba(239, 68, 68, 0.28);
      color: #fecaca;
    }
    #oa2-runtime-cursor {
      position: fixed;
      left: 0;
      top: 0;
      width: 24px;
      height: 24px;
      margin-left: -12px;
      margin-top: -12px;
      pointer-events: none;
      transform: translate(-999px, -999px);
      transition: transform 150ms ease-out;
    }
    #oa2-runtime-cursor::before,
    #oa2-runtime-cursor::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 999px;
    }
    #oa2-runtime-cursor::before {
      background: rgba(255, 255, 255, 0.92);
      border: 2px solid rgba(37, 99, 235, 0.96);
      box-shadow: 0 8px 18px rgba(37, 99, 235, 0.24);
    }
    #oa2-runtime-cursor::after {
      inset: 7px;
      background: rgba(37, 99, 235, 0.96);
    }
    #oa2-runtime-cursor.is-clicking::before {
      animation: oa2RuntimePulse 240ms ease-out;
    }
    #oa2-healing-mask {
      position: absolute;
      inset: 0;
      background: rgba(15, 23, 42, 0.14);
      backdrop-filter: blur(1px);
      pointer-events: auto;
    }
    #oa2-healing-callout {
      position: fixed;
      right: 22px;
      bottom: 84px;
      width: min(360px, calc(100vw - 24px));
      padding: 14px 14px 12px;
      border-radius: 16px;
      background: var(--oa2-bg-panel);
      border: 1px solid var(--oa2-border-strong);
      box-shadow: var(--oa2-shadow-panel);
      color: var(--oa2-text-primary);
      pointer-events: auto;
    }
    #oa2-healing-title {
      font: 700 14px/1.3 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      margin-bottom: 6px;
    }
    #oa2-healing-body {
      color: var(--oa2-text-secondary);
      font-size: 12px;
      line-height: 1.55;
      margin-bottom: 10px;
      white-space: pre-wrap;
    }
    #oa2-healing-candidates {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 10px;
    }
    #oa2-healing-candidates.is-hidden {
      display: none;
    }
    .oa2-healing-candidate {
      width: 100%;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      text-align: left;
      border: 1px solid var(--oa2-border);
      border-radius: 10px;
      background: var(--oa2-bg-surface);
      color: var(--oa2-text-primary);
      padding: 9px 10px;
      cursor: pointer;
    }
    .oa2-healing-candidate:hover {
      border-color: rgba(37, 99, 235, 0.28);
      background: rgba(37, 99, 235, 0.08);
    }
    .oa2-healing-candidate-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .oa2-healing-candidate-label {
      font-size: 12px;
      line-height: 1.45;
      color: var(--oa2-text-primary);
      word-break: break-word;
    }
    .oa2-healing-candidate-meta {
      font-size: 11px;
      color: var(--oa2-text-muted);
      word-break: break-all;
    }
    .oa2-healing-candidate-score {
      font-size: 11px;
      color: var(--oa2-blue-strong);
      white-space: nowrap;
      flex-shrink: 0;
    }
    #oa2-healing-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .oa2-healing-highlight {
      outline: 3px solid rgba(37, 99, 235, 0.82) !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 9999px rgba(37, 99, 235, 0.08) inset !important;
    }
    .oa2-value-highlight {
      background: rgba(250, 204, 21, 0.34) !important;
      color: #111827 !important;
      border-bottom: 2px solid #f59e0b !important;
      padding: 0 1px !important;
      border-radius: 2px !important;
      box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.12) !important;
    }
    .oa2-evidence-hit {
      background: rgba(56, 189, 248, 0.18) !important;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.22), inset 0 -2px 0 var(--oa2-blue);
      transition: box-shadow 150ms ease-out, background 150ms ease-out, outline 150ms ease-out, transform 150ms ease-out;
    }
    .oa2-evidence-hit-active {
      background: rgba(56, 189, 248, 0.26) !important;
      box-shadow: inset 0 -3px 0 var(--oa2-blue), 0 0 0 3px rgba(56, 189, 248, 0.28), 0 0 18px rgba(56, 189, 248, 0.18);
      outline: 2px solid rgba(14, 165, 233, 0.72);
      outline-offset: 2px;
      transform: translateY(-1px);
    }
    @media (prefers-color-scheme: dark) {
      .oa2-value-highlight {
        background: rgba(250, 204, 21, 0.46) !important;
        color: #111827 !important;
        box-shadow: 0 0 0 1px rgba(250, 204, 21, 0.18) !important;
      }
    }
    @keyframes oa2FadeIn {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes oa2GradientShift {
      0% { background-position: 0% 50%; }
      100% { background-position: 220% 50%; }
    }
    @keyframes oa2GradientSpin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes oa2LauncherPulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.82; }
    }
    @keyframes oa2RuntimePulse {
      0% { transform: scale(1); opacity: 1; }
      100% { transform: scale(1.45); opacity: 0.15; }
    }
    @keyframes oa2RuntimeStatusPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(1.25); }
    }
    #omniagent-v2-panel {
      width: 512px;
      min-width: 360px;
      max-width: min(96vw, 1480px);
      border-radius: 20px;
      background: rgba(251, 252, 254, 0.92);
      backdrop-filter: blur(22px);
      container-type: inline-size;
    }
    #omniagent-v2-panel[data-layout="compact"] {
      min-width: 360px;
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-header-top {
      align-items: center;
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-contextbar {
      grid-template-columns: 1fr;
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-quickbar {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-quickbar .oa2-btn {
      width: 100%;
      text-align: center;
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-actions-head {
      flex-direction: column;
      align-items: flex-start;
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-next-actions {
      display: grid;
      grid-template-columns: 1fr;
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-dock {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }
    #omniagent-v2-panel[data-layout="compact"] .oa2-dock-btn {
      width: 100%;
      text-align: center;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-results-shell {
      grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.95fr);
      align-items: start;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-results-detail {
      position: sticky;
      top: 0;
      align-self: start;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-teach-shell {
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(300px, 0.95fr);
      grid-template-areas:
        "intro intro"
        "bridge bridge"
        "thread status"
        "thread draft"
        "thread shortcuts"
        "thread inline"
        "thread recorder"
        "composer composer";
      align-items: start;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-teach-shell > * {
      min-width: 0;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-teach-intro {
      grid-area: intro;
    }
    #omniagent-v2-panel[data-layout="wide"] #oa2-teach-bridge {
      grid-area: bridge;
    }
    #omniagent-v2-panel[data-layout="wide"] #oa2-teach-thread {
      grid-area: thread;
      min-height: 420px;
      max-height: min(62vh, 720px);
      align-self: stretch;
    }
    #omniagent-v2-panel[data-layout="wide"] #oa2-teach-result {
      grid-area: status;
    }
    #omniagent-v2-panel[data-layout="wide"] #oa2-teach-draftbar {
      grid-area: draft;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-chat-shortcuts {
      grid-area: shortcuts;
    }
    #omniagent-v2-panel[data-layout="wide"] #oa2-teach-recorder-inline {
      grid-area: inline;
    }
    #omniagent-v2-panel[data-layout="wide"] #oa2-teach-recorder-card {
      grid-area: recorder;
      margin: 0 !important;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-chat-composer {
      grid-area: composer;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-memory-view.is-active {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.95fr);
      align-items: start;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-review-shell {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-review-hero {
      grid-column: 1 / -1;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-memory-view > .oa2-memory-card:first-child {
      min-height: 0;
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-memory-stack {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    #omniagent-v2-panel[data-layout="wide"] .oa2-memory-stack > .oa2-memory-section:first-child {
      grid-column: 1 / -1;
    }
    @media (prefers-color-scheme: dark) {
      #omniagent-v2-panel {
        background: rgba(15, 23, 42, 0.84);
      }
    }
    .oa2-header {
      padding: 14px 14px 10px;
      border-bottom: 1px solid var(--oa2-border);
      background:
        linear-gradient(180deg, rgba(37, 99, 235, 0.05), rgba(37, 99, 235, 0) 72%),
        transparent;
    }
    .oa2-header-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .oa2-brand-block {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .oa2-brand-line {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .oa2-brand-title {
      color: var(--oa2-text-primary);
      font: 700 14px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0.02em;
    }
    .oa2-header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .oa2-contextbar {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 8px;
    }
    .oa2-context-item {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .oa2-context-label {
      color: var(--oa2-text-muted);
      font: 600 10px/1.1 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .oa2-chip,
    .oa2-memory-link {
      width: 100%;
      max-width: none;
      justify-content: flex-start;
    }
    .oa2-chip {
      padding: 6px 10px;
      border-radius: 12px;
      border: 1px solid var(--oa2-border);
      background: rgba(255, 255, 255, 0.68);
      color: var(--oa2-text-primary);
      font: 600 12px/1.3 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-chip-persona {
      background: rgba(37, 99, 235, 0.12);
      border-color: rgba(37, 99, 235, 0.1);
      color: var(--oa2-blue-strong);
    }
    .oa2-memory-link {
      display: inline-flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: 12px;
      background: rgba(5, 150, 105, 0.08);
      color: var(--oa2-green);
      font: 600 12px/1.3 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      text-align: left;
    }
    .oa2-health-chip {
      padding: 6px 10px;
      border-radius: 12px;
      font: 600 11px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-close {
      width: 30px;
      height: 30px;
      border-radius: 10px;
    }
    .oa2-build-tag {
      margin-left: 0;
      padding: 2px 6px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.05);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      opacity: 1;
    }
    .oa2-subtitle {
      margin-bottom: 0;
      font: 500 12px/1.45 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-scope-banner {
      padding: 0;
      color: var(--oa2-text-secondary);
      font-size: 12px;
      line-height: 1.55;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    #omniagent-v2-panel[data-view="results"] .oa2-contextbar {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 4px;
    }
    #omniagent-v2-panel[data-view="results"] .oa2-context-item {
      gap: 0;
    }
    #omniagent-v2-panel[data-view="results"] .oa2-context-label {
      display: none;
    }
    #omniagent-v2-panel[data-view="results"] .oa2-chip,
    #omniagent-v2-panel[data-view="results"] .oa2-memory-link {
      padding: 4px 8px;
      border-radius: 999px;
      font: 600 11px/1.25 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    #omniagent-v2-panel[data-view="results"] .oa2-scope-banner {
      font-size: 11px;
      line-height: 1.45;
    }
    .oa2-view {
      padding: 12px;
    }
    .oa2-view.is-active {
      gap: 12px;
    }
    .oa2-toolbar-panel {
      padding: 10px 12px;
      border: 1px solid var(--oa2-border);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.58);
    }
    .oa2-toolbar-title {
      color: var(--oa2-text-primary);
      font: 700 13px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-toolbar-head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .oa2-quickbar {
      gap: 8px;
    }
    .oa2-btn {
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 12px;
    }
    .oa2-btn.secondary {
      background: rgba(15, 23, 42, 0.04);
      border-color: var(--oa2-border);
      color: var(--oa2-text-secondary);
    }
    .oa2-results-shell,
    .oa2-results-main,
    .oa2-results-detail {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    @container (min-width: 760px) {
      .oa2-results-shell {
        grid-template-columns: minmax(0, 1.65fr) minmax(280px, 1fr);
        align-items: start;
      }
    }
    .oa2-idle-card,
    .oa2-summary-card,
    #oa2-actions-card,
    .oa2-fold-card,
    .oa2-status-log,
    .oa2-teach-intro,
    .oa2-recorder-card,
    .oa2-memory-card,
    .oa2-chat-thread,
    .oa2-chat-composer {
      border-radius: 16px;
      border: 1px solid var(--oa2-border);
      background: rgba(255, 255, 255, 0.58);
      box-shadow: var(--oa2-shadow-soft);
      overflow: hidden;
    }
    .oa2-summary-card {
      padding: 14px 15px;
      background: linear-gradient(135deg, rgba(37, 99, 235, 0.12), rgba(37, 99, 235, 0.03) 56%, rgba(255, 255, 255, 0.74));
      box-shadow: inset 3px 0 0 rgba(37, 99, 235, 0.28);
    }
    .oa2-summary-label,
    #oa2-actions-card .oa2-card-title {
      margin-bottom: 8px;
      font: 600 11px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #oa2-summary {
      font-size: 15px;
      line-height: 1.65;
      font-weight: 600;
    }
    .oa2-summary-meta {
      gap: 8px;
      margin-top: 12px;
    }
    .oa2-summary-stat {
      padding: 4px 8px;
      font-size: 10px;
    }
    #oa2-actions-card {
      padding: 12px 14px;
    }
    .oa2-action-strip {
      gap: 10px;
    }
    .oa2-action-btn {
      padding: 8px 12px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.92);
      color: var(--oa2-blue-strong);
      font-size: 12px;
    }
    .oa2-action-btn.primary {
      background: rgba(37, 99, 235, 0.12);
    }
    .oa2-fold-card,
    .oa2-status-log {
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.54);
      border: 1px solid var(--oa2-border);
    }
    .oa2-fold-card summary,
    .oa2-status-log summary {
      padding: 12px 14px;
    }
    .oa2-fold-card[open] summary,
    .oa2-status-log[open] summary {
      border-bottom: 1px solid var(--oa2-border);
    }
    .oa2-fold-body,
    .oa2-status-log-inner {
      padding: 12px 14px 14px;
    }
    .oa2-extracted-grid {
      gap: 9px 12px;
    }
    .oa2-field-key {
      font-size: 11px;
    }
    .oa2-field-value {
      font-size: 12px;
      line-height: 1.6;
    }
    .oa2-empty,
    .oa2-muted {
      font-size: 12px;
      line-height: 1.6;
    }
    .oa2-item,
    .oa2-evidence-item,
    .oa2-memory-pop-item {
      padding: 9px 10px;
      border-radius: 12px;
      font-size: 12px;
      line-height: 1.55;
    }
    .oa2-evidence-title {
      font-size: 12px;
    }
    .oa2-evidence-quote {
      font-size: 12px;
      line-height: 1.6;
    }
    .oa2-evidence-reason {
      font-size: 11px;
      line-height: 1.5;
    }
    .oa2-locate-btn {
      padding: 5px 9px;
      font: 600 11px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-teach-shell {
      gap: 6px;
      height: 100%;
      min-height: 0;
    }
    .oa2-teach-view.is-active {
      overflow: auto;
      overscroll-behavior: contain;
    }
    .oa2-teach-intro,
    .oa2-recorder-card,
    .oa2-memory-card {
      padding: 10px 12px;
    }
    .oa2-teach-recorder-inline,
    .oa2-teach-bridge,
    .oa2-teach-draftbar {
      padding: 10px 12px;
      border-radius: 14px;
    }
    .oa2-chat-thread {
      min-height: 96px;
      max-height: min(30vh, 220px);
      padding: 10px 12px;
      gap: 10px;
      flex: 0 0 auto;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      scrollbar-gutter: stable both-edges;
      scrollbar-width: thin;
      scrollbar-color: rgba(37, 99, 235, 0.38) transparent;
    }
    .oa2-chat-thread::-webkit-scrollbar,
    .oa2-teach-result::-webkit-scrollbar,
    #oa2-teach-recorder-card[open] .oa2-recorder-fold-body::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    .oa2-chat-thread::-webkit-scrollbar-track,
    .oa2-teach-result::-webkit-scrollbar-track,
    #oa2-teach-recorder-card[open] .oa2-recorder-fold-body::-webkit-scrollbar-track {
      background: transparent;
    }
    .oa2-chat-thread::-webkit-scrollbar-thumb,
    .oa2-teach-result::-webkit-scrollbar-thumb,
    #oa2-teach-recorder-card[open] .oa2-recorder-fold-body::-webkit-scrollbar-thumb {
      border-radius: 999px;
      border: 2px solid transparent;
      background: rgba(37, 99, 235, 0.3);
      background-clip: padding-box;
    }
    .oa2-chat-msg {
      max-width: 92%;
      padding: 10px 12px;
      border-radius: 14px;
      border: 1px solid rgba(15, 23, 42, 0.05);
      background: rgba(255, 255, 255, 0.96);
      font-size: 12px;
      line-height: 1.65;
    }
    .oa2-chat-msg.user {
      background: rgba(37, 99, 235, 0.1);
    }
    .oa2-chat-role {
      margin-bottom: 4px;
      font: 600 11px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      letter-spacing: 0;
      text-transform: none;
    }
    .oa2-chat-shortcuts {
      gap: 5px;
      overflow-x: auto;
      padding-bottom: 1px;
      scrollbar-width: none;
    }
    .oa2-chat-shortcuts::-webkit-scrollbar {
      display: none;
    }
    .oa2-shortcut {
      padding: 6px 9px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.03);
      font: 600 10px/1.2 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .oa2-rule-proposal,
    .oa2-teach-result,
    .oa2-state-card {
      border-radius: 14px;
    }
    .oa2-teach-inline-row {
      align-items: flex-start;
    }
    .oa2-teach-result,
    .oa2-state-card {
      max-height: 132px;
      overflow: auto;
      scrollbar-gutter: stable both-edges;
      scrollbar-width: thin;
      scrollbar-color: rgba(37, 99, 235, 0.32) transparent;
    }
    .oa2-chat-composer {
      padding: 8px 10px;
      position: sticky;
      bottom: 0;
      z-index: 3;
      margin-top: auto;
      backdrop-filter: blur(14px);
    }
    #oa2-teach-recorder-card {
      margin: 0 0 4px !important;
    }
    #oa2-teach-recorder-card[open] .oa2-recorder-fold-body {
      max-height: 160px;
      overflow: auto;
      scrollbar-gutter: stable both-edges;
      scrollbar-width: thin;
      scrollbar-color: rgba(37, 99, 235, 0.32) transparent;
    }
    .oa2-textarea {
      min-height: 34px;
      max-height: 72px;
      padding: 8px 9px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.94);
      font: 500 12px/1.5 "Inter", "Segoe UI", "PingFang SC", sans-serif;
      overflow-y: auto;
    }
    .oa2-input {
      padding: 10px 11px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.94);
      font: 500 12px/1.45 "Inter", "Segoe UI", "PingFang SC", sans-serif;
    }
    .oa2-inline-buttons,
    .oa2-composer-actions {
      gap: 6px;
    }
    .oa2-composer-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
    }
    .oa2-composer-actions .oa2-btn {
      width: auto;
      min-width: 72px;
      justify-content: center;
      text-align: center;
      white-space: normal;
      line-height: 1.35;
    }
    .oa2-dock {
      gap: 8px;
      padding: 10px 12px 12px;
      border-top: 1px solid var(--oa2-border);
      background: rgba(15, 23, 42, 0.02);
    }
    .oa2-dock-btn {
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .oa2-dock-btn.is-active {
      background: rgba(37, 99, 235, 0.1);
      box-shadow: none;
    }
    @media (prefers-color-scheme: dark) {
      .oa2-chip,
      .oa2-toolbar-panel,
      .oa2-idle-card,
      .oa2-summary-card,
      #oa2-actions-card,
      .oa2-fold-card,
      .oa2-status-log,
      .oa2-teach-intro,
      .oa2-recorder-card,
      .oa2-memory-card,
      .oa2-chat-thread,
      .oa2-chat-composer {
        background: rgba(15, 23, 42, 0.46);
      }
      .oa2-chat-msg {
        background: rgba(15, 23, 42, 0.7);
      }
      .oa2-textarea,
      .oa2-input {
        background: rgba(15, 23, 42, 0.72);
      }
      .oa2-build-tag {
        background: rgba(148, 163, 184, 0.12);
      }
      .oa2-dock {
        background: rgba(2, 6, 23, 0.18);
      }
      .oa2-memory-usage-item {
        background: rgba(15, 23, 42, 0.42);
      }
    }
    @container (max-width: 540px) {
      .oa2-header-top {
        align-items: center;
      }
      .oa2-contextbar {
        grid-template-columns: 1fr;
      }
      .oa2-chat-thread {
        min-height: 120px;
      }
      .oa2-textarea {
        min-height: 40px;
        max-height: 88px;
      }
      .oa2-dock {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .oa2-dock-btn {
        padding-left: 8px;
        padding-right: 8px;
      }
      .oa2-memory-usage-grid {
        grid-template-columns: 1fr;
      }
    }
  `);

  const launcher = document.createElement("button");
  launcher.id = "omniagent-v2-launcher";
  launcher.innerHTML = `
    <span class="oa2-launcher-core">
      <span class="oa2-launcher-orb" aria-hidden="true"></span>
      <span class="oa2-launcher-label">OmniAgent</span>
    </span>
  `;

  const panel = document.createElement("div");
  panel.id = "omniagent-v2-panel";
  panel.dataset.layout = "medium";
  panel.dataset.view = state.activeView;
  panel.innerHTML = `
    <div class="oa2-header">
      <div class="oa2-header-top">
        <div class="oa2-brand-block">
          <div class="oa2-brand-line">
            <span class="oa2-brand-title">OmniAgent</span>
            <span class="oa2-build-tag" id="oa2-build-tag"></span>
          </div>
          <div class="oa2-subtitle"><span id="oa2-host-text">准备读取当前网页上下文。</span></div>
        </div>
        <div class="oa2-header-actions">
          <span class="oa2-health-chip" id="oa2-health-chip">未检查</span>
          <button class="oa2-close" type="button" data-action="close-panel" title="关闭">×</button>
        </div>
      </div>
      <div class="oa2-contextbar">
        <div class="oa2-context-item">
          <div class="oa2-context-label">角色</div>
          <span class="oa2-chip oa2-chip-persona" id="oa2-persona-chip">客观总结助手</span>
        </div>
        <div class="oa2-context-item">
          <div class="oa2-context-label">技能</div>
          <span class="oa2-chip" id="oa2-skill-chip">通用分析</span>
        </div>
        <div class="oa2-context-item">
          <div class="oa2-context-label">记忆</div>
          <button class="oa2-memory-link" type="button" data-action="toggle-memory-hitlist" id="oa2-memory-chip">无记忆命中</button>
        </div>
      </div>
      <div class="oa2-scope-banner" id="oa2-scope-text" title="未显式选择时，会优先使用当前文本选区；没有文本选区时回退到整页。">当前区域：整页</div>
    </div>
    <div class="oa2-body">
      <div class="oa2-memory-pop" id="oa2-memory-hits-pop"></div>
      <div class="oa2-view oa2-results-view is-active" data-view="results">
        <div class="oa2-results-shell">
          <div class="oa2-results-main">
            <div class="oa2-idle-card" id="oa2-idle-card">
              先框选再分析，其他细节按需展开。
            </div>
            <div class="oa2-state-card is-hidden" id="oa2-results-state"></div>
            <div class="oa2-summary-card" id="oa2-summary-card">
              <div class="oa2-summary-label">结论</div>
              <div id="oa2-summary">尚未分析。</div>
              <div class="oa2-summary-meta" id="oa2-summary-meta"></div>
            </div>
            <div class="oa2-toolbar-panel">
              <div class="oa2-toolbar-head">
                <div class="oa2-toolbar-title">当前页面工作台</div>
                <span class="oa2-help-tip" title="首屏只保留结论、建议下一步和推荐动作；证据、字段与执行细节按需展开。">?</span>
              </div>
              <div class="oa2-quickbar">
                <button class="oa2-btn" data-action="analyze" id="oa2-analyze-btn" title="开始分析 (Ctrl/Cmd+Shift+A)">开始分析</button>
                <button class="oa2-btn secondary" data-action="pick-scope">框选</button>
                <button class="oa2-btn secondary" data-action="clear-scope">清除</button>
                <button class="oa2-btn secondary" data-action="health">检查</button>
              </div>
            </div>
            <div class="oa2-card oa2-next-card" id="oa2-next-card">
              <div class="oa2-card-title">建议下一步</div>
              <div class="oa2-next-summary" id="oa2-next-summary">先框选范围并分析，首屏会优先告诉你下一步做什么。</div>
              <div class="oa2-next-meta" id="oa2-next-meta">结果出来后，这里会汇总优先动作、证据数量、字段数量和记忆命中。</div>
              <div class="oa2-next-actions" id="oa2-next-actions"></div>
            </div>
            <div class="oa2-card" id="oa2-actions-card">
              <div class="oa2-actions-head">
                <div class="oa2-card-title">推荐动作</div>
                <button class="oa2-card-toggle" type="button" data-action="toggle-actions" id="oa2-actions-toggle">展开全部</button>
              </div>
              <div class="oa2-action-strip" id="oa2-actions-list"></div>
            </div>
          </div>
          <div class="oa2-results-detail">
            <details class="oa2-fold-card" id="oa2-evidence-card">
              <summary>
                <span class="oa2-fold-title">证据</span>
                <span class="oa2-fold-meta" id="oa2-evidence-meta">0 条</span>
              </summary>
              <div class="oa2-fold-body">
                <div class="oa2-evidence-list" id="oa2-evidence-list">
                  <div class="oa2-empty">分析后会在这里显示可回跳的证据项。</div>
                </div>
              </div>
            </details>
            <details class="oa2-fold-card" id="oa2-fields-card">
              <summary>
                <span class="oa2-fold-title">字段</span>
                <span class="oa2-fold-meta" id="oa2-fields-meta">0 项</span>
              </summary>
              <div class="oa2-fold-body">
                <div class="oa2-card-head">
                  <div class="oa2-card-title">结构化字段</div>
                  <button class="oa2-card-toggle" type="button" data-action="toggle-fields" id="oa2-fields-toggle">展开全部</button>
                </div>
                <div class="oa2-extracted-grid" id="oa2-extracted-grid">
                  <div class="oa2-empty">尚未提取字段。</div>
                </div>
              </div>
            </details>
            <details class="oa2-status-log" id="oa2-status-wrap">
              <summary>执行细节</summary>
              <div class="oa2-status-log-inner" id="oa2-status-text">
                <div class="oa2-log-line">[sys] 等待操作。默认优先分析当前显式区域，没有区域时回退到选中文本或整页。</div>
                <div class="oa2-log-line" id="oa2-debug-text">context_key 尚未生成。</div>
              </div>
            </details>
          </div>
        </div>
      </div>
      <div class="oa2-view oa2-teach-view" data-view="teach">
        <div class="oa2-teach-shell">
          <div class="oa2-teach-intro">
            <div class="oa2-title-row">
              <div class="oa2-card-title">对话与规则</div>
              <span class="oa2-help-tip" title="先直接对话或发页面指令；只有明确要记住经验或整理流程时，才进入长期记忆草案。">?</span>
            </div>
          </div>
          <div class="oa2-teach-bridge is-hidden" id="oa2-teach-bridge"></div>
          <div class="oa2-chat-thread" id="oa2-teach-thread">
            <div class="oa2-empty">先说你想查什么、想点什么，或想让它记住什么。</div>
          </div>
          <div class="oa2-teach-result is-hidden" id="oa2-teach-result"></div>
          <div class="oa2-teach-draftbar is-hidden" id="oa2-teach-draftbar"></div>
          <div class="oa2-chat-shortcuts">
            <button class="oa2-shortcut" type="button" data-action="pick-scope">@框选区域</button>
            <button class="oa2-shortcut" type="button" data-action="view-memory">#引用记忆</button>
            <button class="oa2-shortcut" type="button" data-action="start-record">⏺ 录制流程</button>
          </div>
          <div class="oa2-teach-recorder-inline" id="oa2-teach-recorder-inline"></div>
          <details class="oa2-recorder-card oa2-recorder-fold" id="oa2-teach-recorder-card" style="margin:10px 0 12px;">
            <summary>
              <div class="oa2-title-row">
                <div class="oa2-card-title" style="margin:0;">当前流程</div>
                <span class="oa2-help-tip" title="录制结果会直接进入当前对话上下文，用来整理 workflow 草案。">?</span>
              </div>
              <div class="oa2-recorder-fold-meta" id="oa2-teach-recorder-meta">0 步 · 点击展开</div>
            </summary>
            <div class="oa2-recorder-fold-body">
              <div class="oa2-inline-buttons">
                <button class="oa2-btn" data-action="start-record">开始录制</button>
                <button class="oa2-btn secondary" data-action="stop-record">停止录制</button>
                <button class="oa2-btn secondary" data-action="record-to-teach">整理成草案</button>
                <button class="oa2-btn secondary" data-action="clear-record">清空录制</button>
              </div>
              <div class="oa2-muted" id="oa2-teach-recorder-status">尚未录制。录制步骤会自动进入 teach 上下文。</div>
              <div class="oa2-list" id="oa2-teach-recorder-list"></div>
            </div>
          </details>
          <div class="oa2-chat-composer">
            <textarea class="oa2-textarea" id="oa2-teach-input" placeholder="例如：以后遇到这种页面先提取关键信息，再给我一个可复用的操作建议或快捷动作。"></textarea>
            <div class="oa2-composer-actions">
              <button class="oa2-btn" data-action="teach">发送对话</button>
              <button class="oa2-btn secondary" data-action="operate">生成动作</button>
              <button class="oa2-btn secondary" data-action="clear">清空输入</button>
            </div>
          </div>
        </div>
      </div>
      <div class="oa2-view oa2-memory-view" data-view="memory">
        <div class="oa2-memory-card">
          <div class="oa2-title-row">
            <div class="oa2-card-title">记忆总览</div>
            <span class="oa2-help-tip" title="这里汇总最近可复用的流程、模板、文档，以及最近运行的 trace / 自愈情况。">?</span>
          </div>
          <div class="oa2-muted" id="oa2-memory-summary">尚未加载。</div>
          <div class="oa2-memory-usage-card" id="oa2-memory-usage-card">
            <div class="oa2-memory-usage-grid" id="oa2-memory-usage-grid"></div>
            <div class="oa2-memory-usage-meta" id="oa2-memory-usage-meta">调用统计加载后会显示在这里。</div>
          </div>
          <div class="oa2-list" id="oa2-memory-list"></div>
        </div>
        <details class="oa2-memory-card">
          <summary>
            <span class="oa2-fold-title">知识库摄入与检索</span>
            <span class="oa2-fold-meta">次要能力</span>
          </summary>
          <div class="oa2-fold-body">
            <div class="oa2-muted" style="margin-bottom:10px;">RAG 先降为次要工具，不再占主流程注意力；只有明确需要沉淀文档或补充检索时再展开使用。</div>
            <input class="oa2-input" id="oa2-rag-namespace" value="general" placeholder="namespace，例如 general / research / ops" />
            <input class="oa2-input" id="oa2-rag-query" placeholder="输入检索词，例如 sandbox md5 query" />
            <textarea class="oa2-textarea" id="oa2-rag-text" placeholder="可直接粘贴文本内容，或选择 CSV 文件后上传。"></textarea>
            <input class="oa2-input" id="oa2-rag-file" type="file" />
            <div class="oa2-inline-buttons">
              <button class="oa2-btn" data-action="rag-upload-text">上传文本</button>
              <button class="oa2-btn secondary" data-action="rag-upload-file">上传文件/CSV</button>
              <button class="oa2-btn secondary" data-action="rag-search">检索</button>
            </div>
            <div class="oa2-muted" id="oa2-rag-status">尚未上传或检索。上传后的文档会长期保存在本地知识库，不只在当前上下文生效。</div>
            <div class="oa2-list" id="oa2-rag-list"></div>
          </div>
        </details>
      </div>
      <div class="oa2-view oa2-review-view" data-view="review">
        <div class="oa2-review-shell">
          <div class="oa2-memory-card oa2-review-hero">
            <div class="oa2-title-row">
              <div class="oa2-card-title">知识库体检</div>
              <span class="oa2-help-tip" title="这里会检查角色库和技能库里哪些内容更值得人工看一眼，帮助普通用户更安心地使用。">?</span>
            </div>
            <div class="oa2-muted" id="oa2-review-summary">尚未开始体检。</div>
            <div class="oa2-review-stat-grid" id="oa2-review-stat-grid"></div>
            <div class="oa2-inline-buttons">
              <button class="oa2-btn" data-action="refresh-review">刷新体检</button>
              <button class="oa2-btn secondary" data-action="view-memory">查看记忆总览</button>
            </div>
          </div>
          <div class="oa2-memory-card oa2-review-section">
            <div class="oa2-title-row">
              <div class="oa2-card-title">角色库</div>
              <span class="oa2-help-tip" title="角色决定系统回答时的身份和风格。如果名称像测试数据、提示词过短，结果会更不稳定。">?</span>
            </div>
            <div class="oa2-muted" id="oa2-review-personas-meta">尚未加载。</div>
            <div class="oa2-list" id="oa2-review-personas-list"></div>
          </div>
          <div class="oa2-memory-card oa2-review-section">
            <div class="oa2-title-row">
              <div class="oa2-card-title">技能库</div>
              <span class="oa2-help-tip" title="技能决定系统在什么场景下做什么事。如果没绑定角色、没有触发条件，通常就不容易被正常调用。">?</span>
            </div>
            <div class="oa2-muted" id="oa2-review-skills-meta">尚未加载。</div>
            <div class="oa2-list" id="oa2-review-skills-list"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="oa2-dock">
      <button class="oa2-dock-btn is-active" type="button" data-action="view-results">分析</button>
      <button class="oa2-dock-btn" type="button" data-action="view-teach">对话</button>
      <button class="oa2-dock-btn" type="button" data-action="view-memory">记忆</button>
      <button class="oa2-dock-btn" type="button" data-action="view-review">体检</button>
    </div>
  `;

  const scopeOverlay = document.createElement("div");
  scopeOverlay.id = "oa2-scope-overlay";
  scopeOverlay.innerHTML = `
    <div id="oa2-scope-box"></div>
    <div id="oa2-scope-toolbar">
      <div class="oa2-scope-meta">
        <div class="oa2-scope-desc" id="oa2-scope-desc">请选择分析区域</div>
        <div class="oa2-scope-hint" id="oa2-scope-hint">移动鼠标预览，点击锁定后可调父级/子级，回车确认，Esc 取消。</div>
      </div>
      <button class="oa2-scope-btn" type="button" data-scope-action="scope-child">选子级</button>
      <button class="oa2-scope-btn" type="button" data-scope-action="scope-parent">选父级</button>
      <button class="oa2-scope-btn primary" type="button" data-scope-action="scope-confirm">确认</button>
      <button class="oa2-scope-btn warn" type="button" data-scope-action="scope-cancel">取消</button>
    </div>
  `;

  const healingOverlay = document.createElement("div");
  healingOverlay.id = "oa2-healing-overlay";
  healingOverlay.innerHTML = `
    <div id="oa2-healing-mask"></div>
    <div id="oa2-healing-callout">
      <div id="oa2-healing-title">交互式自愈</div>
      <div id="oa2-healing-body">我没找到目标元素。请你直接在页面上点一下正确的元素，我会自动修补这一步。</div>
      <div id="oa2-healing-candidates" class="is-hidden"></div>
      <div id="oa2-healing-actions">
        <button class="oa2-scope-btn warn" type="button" id="oa2-healing-cancel">取消</button>
      </div>
    </div>
  `;

  const runtimeOverlay = document.createElement("div");
  runtimeOverlay.id = "oa2-runtime-overlay";
  runtimeOverlay.innerHTML = `
    <div id="oa2-runtime-backdrop"></div>
    <div id="oa2-runtime-highlight"></div>
    <div id="oa2-runtime-target-tag"></div>
    <div id="oa2-runtime-callout" data-mode="idle">
      <div id="oa2-runtime-bar">
        <div id="oa2-runtime-header">
          <div id="oa2-runtime-status">
            <span id="oa2-runtime-indicator"></span>
            <div id="oa2-runtime-status-copy">
              <div id="oa2-runtime-title">OmniAgent 准备执行</div>
              <div id="oa2-runtime-detail">动作执行会在这里解释当前步骤。</div>
            </div>
          </div>
          <div id="oa2-runtime-controls">
            <button type="button" class="oa2-runtime-btn history" id="oa2-runtime-toggle" title="展开历史">历史</button>
            <button type="button" class="oa2-runtime-btn stop" id="oa2-runtime-stop" title="停止执行">停止</button>
            <button type="button" class="oa2-runtime-btn close" id="oa2-runtime-close" title="关闭提示">×</button>
          </div>
        </div>
        <div id="oa2-runtime-choice">
          <div id="oa2-runtime-choice-copy"></div>
          <div id="oa2-runtime-choice-fields"></div>
          <div id="oa2-runtime-choice-options"></div>
        </div>
      </div>
      <div id="oa2-runtime-history-wrap">
        <div id="oa2-runtime-history"></div>
      </div>
    </div>
    <div id="oa2-runtime-cursor"></div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(panel);
  document.body.appendChild(scopeOverlay);
  document.body.appendChild(runtimeOverlay);
  document.body.appendChild(healingOverlay);
  const buildTag = document.getElementById("oa2-build-tag");
  if (buildTag) {
    buildTag.textContent = `build ${BUILD_ID}`;
  }

  restoreLauncherPosition();
  restorePanelSize();
  syncPanelLayoutMode();
  restorePanelPosition();
  updateAnalyzeButtonLabel();
  renderPanelState("results");
  renderPanelState("teach");
  updateResultsLayout(null);
  updateRuntimeToggleLabel();
  renderRecorderList();
  scheduleScopeRestoreAttempts();
  exposeDebugBridge();

  const panelHeader = panel.querySelector(".oa2-header");
  const scopeBox = scopeOverlay.querySelector("#oa2-scope-box");
  const scopeToolbar = scopeOverlay.querySelector("#oa2-scope-toolbar");
  const scopeDesc = scopeOverlay.querySelector("#oa2-scope-desc");
  const scopeHint = scopeOverlay.querySelector("#oa2-scope-hint");
  const runtimeHighlight = runtimeOverlay.querySelector("#oa2-runtime-highlight");
  const runtimeTag = runtimeOverlay.querySelector("#oa2-runtime-target-tag");
  const runtimeCallout = runtimeOverlay.querySelector("#oa2-runtime-callout");
  const runtimeHeader = runtimeOverlay.querySelector("#oa2-runtime-header");
  const runtimeHistoryWrap = runtimeOverlay.querySelector("#oa2-runtime-history-wrap");
  const runtimeHistory = runtimeOverlay.querySelector("#oa2-runtime-history");
  const runtimeTitle = runtimeOverlay.querySelector("#oa2-runtime-title");
  const runtimeDetail = runtimeOverlay.querySelector("#oa2-runtime-detail");
  const runtimeChoice = runtimeOverlay.querySelector("#oa2-runtime-choice");
  const runtimeChoiceCopy = runtimeOverlay.querySelector("#oa2-runtime-choice-copy");
  const runtimeChoiceFields = runtimeOverlay.querySelector("#oa2-runtime-choice-fields");
  const runtimeChoiceOptions = runtimeOverlay.querySelector("#oa2-runtime-choice-options");
  const runtimeToggle = runtimeOverlay.querySelector("#oa2-runtime-toggle");
  const runtimeStop = runtimeOverlay.querySelector("#oa2-runtime-stop");
  const runtimeClose = runtimeOverlay.querySelector("#oa2-runtime-close");
  const runtimeCursor = runtimeOverlay.querySelector("#oa2-runtime-cursor");

  function getPageAgentGlobal() {
    if (typeof unsafeWindow !== "undefined" && unsafeWindow) {
      return unsafeWindow;
    }
    return window;
  }

  function exposeDebugBridge() {
    const root = getPageAgentGlobal();
    root.__oa2Debug = {
      getBuildId() {
        return BUILD_ID;
      },
      getPanelState() {
        return {
          isOpen: Boolean(state.isOpen),
          activeView: state.activeView,
          lastContextKey: state.lastContextKey,
        };
      },
      getLastAnalysis() {
        return cloneWorkflowSteps([state.lastAnalysis])[0] || null;
      },
      getQuickActions() {
        return cloneWorkflowSteps(getQuickActions(state.lastAnalysis));
      },
      getWorkflowAction(workflowId) {
        const normalizedWorkflowId = String(workflowId || "").trim();
        const action = getQuickActions(state.lastAnalysis).find((item) => String(item?.workflow_id || "").trim() === normalizedWorkflowId);
        return action ? cloneWorkflowSteps([action])[0] : null;
      },
      getRuntimeHistory() {
        return cloneWorkflowSteps(state.runtime.history);
      },
    };
    root.__omniagentRebuildBridge = {
      getBuildId() {
        return BUILD_ID;
      },
      openPanel() {
        openPanel();
      },
      closePanel() {
        closePanel();
      },
      switchView(viewName) {
        switchView(viewName);
      },
      async analyzePage() {
        openPanel();
        await analyzePage();
      },
    };
    try {
      if (typeof cloneInto === "function") {
        root.__oa2Debug = cloneInto(root.__oa2Debug, root, { cloneFunctions: true });
        root.__omniagentRebuildBridge = cloneInto(root.__omniagentRebuildBridge, root, { cloneFunctions: true });
      }
    } catch (error) {
      // ignore cloneInto failures (non-Firefox or sandbox differences)
    }
    try {
      if (root !== window) {
        window.__oa2Debug = root.__oa2Debug;
        window.__omniagentRebuildBridge = root.__omniagentRebuildBridge;
      }
    } catch (error) {
      // ignore cross-realm assignment failures
    }
    try {
      globalThis.__omniagentRebuildBridge = root.__omniagentRebuildBridge;
    } catch (error) {
      // ignore global assignment failures
    }
  }

  function waitForMs(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function describeRuntimeTarget(action) {
    if (!action || typeof action !== "object") {
      return "当前目标";
    }
    if (String(action.target_desc || "").trim()) {
      return String(action.target_desc).trim();
    }
    if (Number.isInteger(action.page_agent_index)) {
      return `元素 [${action.page_agent_index}]`;
    }
    if (String(action.selector || "").trim()) {
      return String(action.selector).trim().slice(0, 60);
    }
    if (String(action.element_id || "").trim()) {
      return String(action.element_id).trim();
    }
    return "当前目标";
  }

  function previewRuntimeValue(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 36) : "";
  }

  function getKeyboardActionMeta(rawKey) {
    const normalized = String(rawKey ?? "").trim();
    const lower = normalized.toLowerCase();
    const preset = {
      enter: { key: "Enter", code: "Enter", keyCode: 13, charCode: 13, dispatchKeyPress: true, applySubmitHint: true },
      tab: { key: "Tab", code: "Tab", keyCode: 9, charCode: 9, dispatchKeyPress: false, applySubmitHint: false },
      escape: { key: "Escape", code: "Escape", keyCode: 27, charCode: 27, dispatchKeyPress: false, applySubmitHint: false },
      esc: { key: "Escape", code: "Escape", keyCode: 27, charCode: 27, dispatchKeyPress: false, applySubmitHint: false },
      arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40, charCode: 0, dispatchKeyPress: false, applySubmitHint: false },
      arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38, charCode: 0, dispatchKeyPress: false, applySubmitHint: false },
      arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, charCode: 0, dispatchKeyPress: false, applySubmitHint: false },
      arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39, charCode: 0, dispatchKeyPress: false, applySubmitHint: false },
      space: { key: " ", code: "Space", keyCode: 32, charCode: 32, dispatchKeyPress: true, applySubmitHint: false },
      " ": { key: " ", code: "Space", keyCode: 32, charCode: 32, dispatchKeyPress: true, applySubmitHint: false },
    };
    if (preset[lower]) {
      return preset[lower];
    }
    const key = normalized || "Enter";
    const singleChar = key.length === 1;
    return {
      key,
      code: singleChar ? `Key${key.toUpperCase()}` : key,
      keyCode: singleChar ? key.toUpperCase().charCodeAt(0) : 0,
      charCode: singleChar ? key.charCodeAt(0) : 0,
      dispatchKeyPress: singleChar,
      applySubmitHint: false,
    };
  }

  function describeRuntimeAction(action) {
    const target = describeRuntimeTarget(action);
    const type = String(action?.type || "").trim().toLowerCase();
    if (type === "click") {
      return `点击 ${target}`;
    }
    if (type === "fill") {
      const valuePreview = previewRuntimeValue(action?.value);
      return `填写 ${target}${valuePreview ? ` = ${valuePreview}` : ""}`;
    }
    if (type === "select") {
      const valuePreview = previewRuntimeValue(action?.value);
      return `选择 ${target}${valuePreview ? ` = ${valuePreview}` : ""}`;
    }
    if (type === "press_key") {
      const key = previewRuntimeValue(action?.key || action?.value) || "按键";
      return `按键 ${key} -> ${target}`;
    }
    if (type === "fill_form") {
      const fields = Array.isArray(action?.fields) ? action.fields : [];
      const preview = fields
        .slice(0, 3)
        .map((field) => String(field?.target_desc || field?.field_name || "字段").trim())
        .filter(Boolean)
        .join(" / ");
      const suffix = fields.length > 3 ? ` / +${fields.length - 3}` : "";
      return `填写表单 ${target}${preview ? ` | ${preview}${suffix}` : ""}`;
    }
    if (type === "focus") {
      return `聚焦 ${target}`;
    }
    if (type === "highlight") {
      return `高亮 ${target}`;
    }
    if (type === "wait") {
      return `等待 ${Number(action.ms || action.duration_ms || 500)}ms`;
    }
    if (type === "ask_human") {
      const question = String(action?.question || "").trim();
      const message = String(action?.message || "").trim();
      const reason = String(action?.reason || "").trim();
      return question || message || reason || "等待确认";
    }
    return `${type || "执行"} ${target}`;
  }

  function buildAskHumanPrompt(action) {
    const question = String(action?.question || "").trim();
    const message = String(action?.message || "").trim();
    const reason = String(action?.reason || "").trim();
    const risk = String(action?.risk || "").trim();
    const suggestedAction = String(action?.suggested_action || "").trim();
    const confirmLabel = String(action?.confirm_label || "").trim() || "确认";
    const cancelLabel = String(action?.cancel_label || "").trim() || "取消";
    const options = Array.isArray(action?.options) ? action.options.filter((item) => item && typeof item === "object" && String(item.label || "").trim()) : [];
    const lines = [];
    if (question) {
      lines.push(question);
    } else if (message) {
      lines.push(message);
    } else {
      lines.push("是否继续执行？");
    }
    if (reason) {
      lines.push(`原因：${reason}`);
    }
    if (risk) {
      lines.push(`风险：${risk}`);
    }
    if (suggestedAction) {
      lines.push(`建议：${suggestedAction}`);
    }
    if (options.length) {
      lines.push(`可选项：${options.map((item, index) => `${index + 1}. ${String(item.label || "").trim()}`).join(" / ")}`);
    }
    lines.push(`[${confirmLabel}] / [${cancelLabel}]`);
    return lines.join("\n\n");
  }

  function getAskHumanOptions(action) {
    return Array.isArray(action?.options)
      ? action.options
        .filter((item) => item && typeof item === "object" && String(item.label || "").trim())
        .map((item, index) => ({
          id: String(item.id || `option_${index + 1}`).trim(),
          label: String(item.label || "").trim(),
          value: String(item.value || "").trim() || (index === 0 ? "continue" : ""),
          branch_steps: cloneWorkflowSteps(item.branch_steps),
          replace_remaining: Boolean(item.replace_remaining),
        }))
      : [];
  }

  function getAskHumanInputFields(action) {
    return Array.isArray(action?.input_fields)
      ? action.input_fields
        .filter((item) => item && typeof item === "object" && String(item.name || item.key || "").trim())
        .map((item, index) => ({
          name: String(item.name || item.key || `field_${index + 1}`).trim(),
          label: String(item.label || item.name || item.key || `字段 ${index + 1}`).trim(),
          type: String(item.type || "text").trim().toLowerCase(),
          placeholder: String(item.placeholder || "").trim(),
          help_text: String(item.help_text || item.description || "").trim(),
          default_value: String(item.default_value || item.value || "").trim(),
          required: item.required !== false,
          min_length: Number.isFinite(Number(item.min_length)) ? Math.max(0, Number(item.min_length)) : 0,
          pattern: String(item.pattern || "").trim(),
          validation_message: String(item.validation_message || "").trim(),
          options: Array.isArray(item.options)
            ? item.options
              .filter((option) => option && typeof option === "object" && String(option.label || option.value || "").trim())
              .map((option, optionIndex) => ({
                label: String(option.label || option.value || `选项 ${optionIndex + 1}`).trim(),
                value: String(option.value || option.label || "").trim(),
              }))
            : [],
        }))
      : [];
  }

  function renderTemplateValuesInData(node, values) {
    if (typeof node === "string") {
      return Object.entries(values || {}).reduce((text, [key, value]) => {
        return text.replaceAll(`{${key}}`, String(value ?? ""));
      }, node);
    }
    if (Array.isArray(node)) {
      return node.map((item) => renderTemplateValuesInData(item, values));
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [key, renderTemplateValuesInData(value, values)])
      );
    }
    return node;
  }

  function buildWorkflowExecutionChoiceAction(action, currentAnalysis, previewLines) {
    const workflowName = String(action?.label || action?.workflow_id || "执行流程").trim() || "执行流程";
    return {
      type: "ask_human",
      question: `是否让 AI 结合当前分析执行 workflow「${workflowName}」？`,
      reason: `当前结论：${String(currentAnalysis?.summary || "暂无结论").slice(0, 160)}`,
      suggested_action: previewLines.length
        ? `流程预览：\n${previewLines.slice(0, 4).map((line, index) => `${index + 1}. ${line}`).join("\n")}`
        : "暂无流程预览。",
      confirm_label: "继续执行",
      cancel_label: "先取消",
      options: [
        { id: "confirm", label: "继续执行", value: "continue" },
        { id: "cancel", label: "先取消", value: "cancel" },
      ],
    };
  }

  function buildWorkflowParameterChoiceAction(action) {
    const workflowName = String(action?.label || action?.workflow_id || "执行流程").trim() || "执行流程";
    const missingParams = Array.isArray(action?.missing_parameters) ? action.missing_parameters.filter(Boolean) : [];
    const explicitFields = Array.isArray(action?.missing_parameter_defs) ? action.missing_parameter_defs.filter(Boolean) : [];
    return {
      type: "ask_human",
      question: `执行 workflow「${workflowName}」前，还需要补充这些参数：${missingParams.join("、")}`,
      reason: "当前流程里存在尚未注入的占位参数，先补齐后才能更稳定地继续规划与执行。",
      suggested_action: "请补齐必要参数；确认后我会带着这些值继续复核 workflow。",
      confirm_label: "继续执行",
      cancel_label: "先取消",
      input_fields: explicitFields.length ? explicitFields : buildWorkflowParameterFields(missingParams, action?.injected_params || {}),
      options: [
        { id: "confirm", label: "继续执行", value: "continue" },
        { id: "cancel", label: "先取消", value: "cancel" },
      ],
    };
  }

  function buildWorkflowSaveChoiceAction(workflowName, workflowSummary, workflowSteps) {
    const previewLines = cloneWorkflowSteps(workflowSteps)
      .slice(0, 4)
      .map((item, index) => describeWorkflowStep(item, index));
    return {
      type: "ask_human",
      question: `这次页面操作已经完成，要保存为 workflow「${workflowName}」吗？`,
      reason: workflowSummary || "保存后，后续命中同站点同类页面时可以直接复用这次成功操作。",
      suggested_action: previewLines.length
        ? `流程预览：\n${previewLines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`
        : "暂无流程预览。",
      confirm_label: "保存流程",
      cancel_label: "暂不保存",
    };
  }

  function buildScopeSelectionChoiceAction(target, charCount, imageCount, preview) {
    const targetLabel = describeElement(target);
    const previewText = String(preview || "").trim();
    return {
      type: "ask_human",
      question: `是否将「${targetLabel}」设为当前分析区域？`,
      reason: `字符数 ${charCount}${imageCount ? `，图片数 ${imageCount}` : ""}。确认后，后续同域名页面会优先复用这个区域。`,
      suggested_action: previewText ? `内容预览：\n${previewText}${charCount > 400 ? "..." : ""}` : "当前区域没有可预览文本。",
      confirm_label: "确认区域",
      cancel_label: "取消选择",
    };
  }

  function buildSuggestedActionPreviewChoiceAction(action, previewLines, infoLines) {
    const actionLabel = String(action?.label || action?.title || action?.workflow_id || "浏览器动作").trim() || "浏览器动作";
    const typeLabel = action?.workflow_id ? "流程预览" : "动作预览";
    return {
      type: "ask_human",
      question: `${typeLabel}：${actionLabel}`,
      reason: infoLines.filter(Boolean).join(" | "),
      suggested_action: previewLines.length
        ? previewLines.map((line, index) => `${index + 1}. ${line}`).join("\n")
        : "暂无可预览步骤。",
      confirm_label: "关闭预览",
      cancel_label: "关闭预览",
      options: [{ id: "close", label: "关闭预览", value: "close" }],
    };
  }

  function looksLikeNavigationAction(action) {
    const text = [action?.target_desc, action?.selector, action?.label]
      .map((item) => String(item || ""))
      .join(" ");
    return /(下一页|上一页|next|prev|pagination|page)/i.test(text);
  }

  function getRuntimeHistoryIcon(kind) {
    if (kind === "done") {
      return "●";
    }
    if (kind === "success") {
      return "✓";
    }
    if (kind === "error") {
      return "✕";
    }
    if (kind === "question") {
      return "?";
    }
    if (kind === "observation") {
      return "◉";
    }
    return "•";
  }

  function renderRuntimeHistory() {
    if (!runtimeHistory) {
      return;
    }
    runtimeHistory.innerHTML = "";
    state.runtime.history.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "oa2-runtime-history-item";
      item.dataset.kind = entry.kind || "step";

      const main = document.createElement("div");
      main.className = "oa2-runtime-history-main";

      const icon = document.createElement("span");
      icon.className = "oa2-runtime-history-icon";
      icon.textContent = getRuntimeHistoryIcon(entry.kind || "step");

      const content = document.createElement("div");
      content.textContent = String(entry.text || "");

      main.appendChild(icon);
      main.appendChild(content);
      item.appendChild(main);

      if (entry.meta) {
        const meta = document.createElement("div");
        meta.className = "oa2-runtime-history-meta";
        meta.textContent = String(entry.meta);
        item.appendChild(meta);
      }

      runtimeHistory.appendChild(item);
    });
    runtimeHistory.scrollTop = runtimeHistory.scrollHeight;
  }

  function clearRuntimeChoice() {
    if (runtimeChoice instanceof HTMLElement) {
      runtimeChoice.classList.remove("active");
    }
    if (runtimeChoiceCopy instanceof HTMLElement) {
      runtimeChoiceCopy.innerHTML = "";
    }
    if (runtimeChoiceFields instanceof HTMLElement) {
      runtimeChoiceFields.innerHTML = "";
    }
    if (runtimeChoiceOptions instanceof HTMLElement) {
      runtimeChoiceOptions.innerHTML = "";
    }
    state.runtime.pendingChoice = null;
  }

  function resolveRuntimeChoice(selection) {
    const pending = state.runtime.pendingChoice;
    if (!pending || typeof pending.resolve !== "function") {
      clearRuntimeChoice();
      return;
    }
    const resolver = pending.resolve;
    clearRuntimeChoice();
    resolver(selection);
  }

  function waitForRuntimeChoice(action, askOptions) {
    return new Promise((resolve) => {
      clearRuntimeChoice();
      state.runtime.pendingChoice = { resolve };
      if (runtimeChoice instanceof HTMLElement) {
        runtimeChoice.classList.add("active");
      }
      const lines = [];
      const question = String(action?.question || action?.message || "请选择下一步").trim();
      const reason = String(action?.reason || "").trim();
      const risk = String(action?.risk || "").trim();
      const suggestedAction = String(action?.suggested_action || "").trim();
      const inputFields = getAskHumanInputFields(action);
      lines.push(question || "请选择下一步");
      if (reason) {
        lines.push(`原因：${reason}`);
      }
      if (risk) {
        lines.push(`风险：${risk}`);
      }
      if (suggestedAction) {
        lines.push(`建议：${suggestedAction}`);
      }
      lines.forEach((text, index) => {
        if (!(runtimeChoiceCopy instanceof HTMLElement)) {
          return;
        }
        const line = document.createElement("div");
        line.className = `oa2-runtime-choice-line${index > 0 ? " is-muted" : ""}`;
        line.textContent = text;
        runtimeChoiceCopy.appendChild(line);
      });
      const fieldNodes = new Map();
      inputFields.forEach((field) => {
        if (!(runtimeChoiceFields instanceof HTMLElement)) {
          return;
        }
        const wrap = document.createElement("label");
        wrap.className = "oa2-runtime-choice-field";
        const title = document.createElement("div");
        title.className = `oa2-runtime-choice-field-label${field.required ? " required" : ""}`;
        title.textContent = field.label;
        let input = null;
        if (field.type === "textarea") {
          input = document.createElement("textarea");
          input.className = "oa2-runtime-choice-input";
          input.value = field.default_value || "";
          input.placeholder = field.placeholder || "";
        } else if (field.type === "select") {
          input = document.createElement("select");
          input.className = "oa2-runtime-choice-input";
          const options = field.options.length
            ? field.options
            : [{ label: field.placeholder || "请选择", value: "" }];
          options.forEach((option, optionIndex) => {
            const optionNode = document.createElement("option");
            optionNode.value = option.value;
            optionNode.textContent = option.label;
            if (optionIndex === 0 && !field.default_value && !option.value) {
              optionNode.disabled = field.required;
              optionNode.selected = true;
            }
            if (field.default_value && option.value === field.default_value) {
              optionNode.selected = true;
            }
            input.appendChild(optionNode);
          });
          if (field.default_value && !field.options.some((option) => option.value === field.default_value)) {
            const fallbackOption = document.createElement("option");
            fallbackOption.value = field.default_value;
            fallbackOption.textContent = field.default_value;
            fallbackOption.selected = true;
            input.appendChild(fallbackOption);
          }
        } else {
          input = document.createElement("input");
          input.type = "text";
          input.className = "oa2-runtime-choice-input";
          input.value = field.default_value || "";
          input.placeholder = field.placeholder || "";
        }
        input.setAttribute("data-field-name", field.name);
        wrap.appendChild(title);
        wrap.appendChild(input);
        if (field.help_text) {
          const help = document.createElement("div");
          help.className = "oa2-runtime-choice-field-help";
          help.textContent = field.help_text;
          wrap.appendChild(help);
        }
        runtimeChoiceFields.appendChild(wrap);
        fieldNodes.set(field.name, { field, input });
      });
      const normalizedOptions = askOptions.length
        ? askOptions
        : [
            {
              id: "confirm",
              label: String(action?.confirm_label || "").trim() || "确认",
              value: "continue",
              branch_steps: [],
              replace_remaining: false,
            },
            {
              id: "cancel",
              label: String(action?.cancel_label || "").trim() || "取消",
              value: "cancel",
              branch_steps: [],
              replace_remaining: false,
            },
          ];
      normalizedOptions.forEach((option, index) => {
        if (!(runtimeChoiceOptions instanceof HTMLElement)) {
          return;
        }
        const button = document.createElement("button");
        button.type = "button";
        const value = String(option?.value || "").trim().toLowerCase();
        button.className = `oa2-runtime-choice-btn${index === 0 ? " primary" : value === "cancel" || value === "abort" || value === "stop" ? " warn" : ""}`;
        button.textContent = option.label;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const fieldValues = {};
          for (const [fieldName, entry] of fieldNodes.entries()) {
            const rawValue = String(entry.input?.value || "").trim();
            if (entry.field.required && !rawValue) {
              entry.input?.focus();
              entry.input?.setCustomValidity?.(entry.field.validation_message || "请先填写这个字段");
              entry.input?.reportValidity?.();
              return;
            }
            if (entry.field.min_length > 0 && rawValue && rawValue.length < entry.field.min_length) {
              entry.input?.focus();
              entry.input?.setCustomValidity?.(entry.field.validation_message || `至少输入 ${entry.field.min_length} 个字符`);
              entry.input?.reportValidity?.();
              return;
            }
            if (entry.field.pattern && rawValue) {
              try {
                const matcher = new RegExp(entry.field.pattern);
                if (!matcher.test(rawValue)) {
                  entry.input?.focus();
                  entry.input?.setCustomValidity?.(entry.field.validation_message || "输入格式不符合要求");
                  entry.input?.reportValidity?.();
                  return;
                }
              } catch (error) {
                console.warn("[OmniAgent] invalid input_fields pattern:", entry.field.pattern, error);
              }
            }
            entry.input?.setCustomValidity?.("");
            fieldValues[fieldName] = rawValue;
          }
          resolveRuntimeChoice({ ...option, field_values: fieldValues });
        });
        runtimeChoiceOptions.appendChild(button);
      });
    });
  }

  function updateRuntimeToggleLabel() {
    const toggleNode = document.getElementById("oa2-runtime-toggle");
    if (!(toggleNode instanceof HTMLElement)) {
      return;
    }
    toggleNode.textContent = state.runtime.expanded ? "收起" : "历史";
    toggleNode.title = state.runtime.expanded ? "收起历史" : "展开历史";
  }

  function applyRuntimePosition(x, y, lockPosition = state.runtime.drag.locked) {
    if (!(runtimeCallout instanceof HTMLElement)) {
      return;
    }
    const margin = 12;
    const width = runtimeCallout.offsetWidth || 392;
    const height = runtimeCallout.offsetHeight || 64;
    const nextX = clampValue(Math.round(x), margin, window.innerWidth - width - margin);
    const nextY = clampValue(Math.round(y), margin, window.innerHeight - height - margin);
    runtimeCallout.style.left = `${nextX}px`;
    runtimeCallout.style.top = `${nextY}px`;
    state.runtime.drag.locked = Boolean(lockPosition);
  }

  function syncRuntimePosition() {
    if (!(runtimeCallout instanceof HTMLElement)) {
      return;
    }
    if (state.runtime.drag.locked) {
      const rect = runtimeCallout.getBoundingClientRect();
      applyRuntimePosition(rect.left, rect.top, true);
      return;
    }
    const width = runtimeCallout.offsetWidth || 392;
    const height = runtimeCallout.offsetHeight || 64;
    applyRuntimePosition((window.innerWidth - width) / 2, window.innerHeight - height - 18, false);
  }

  function clampRuntimeIntoViewport() {
    if (!(runtimeCallout instanceof HTMLElement) || (!state.runtime.active && !state.runtime.drag.locked)) {
      return;
    }
    const rect = runtimeCallout.getBoundingClientRect();
    applyRuntimePosition(rect.left, rect.top, state.runtime.drag.locked);
  }

  function setRuntimeExpanded(expanded) {
    state.runtime.expanded = Boolean(expanded);
    if (runtimeCallout) {
      runtimeCallout.classList.toggle("expanded", state.runtime.expanded);
    }
    updateRuntimeToggleLabel();
    renderRuntimeHistory();
    if (state.runtime.drag.locked) {
      clampRuntimeIntoViewport();
    } else {
      syncRuntimePosition();
    }
  }

  function holdRuntimeOpen() {
    state.runtime.holdOpen = true;
    runtimeMask.clearHideTimer();
  }

  function isEditableElement(element) {
    return (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element?.isContentEditable
    );
  }

  function getNativeValueSetter(element) {
    if (element instanceof HTMLTextAreaElement) {
      return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set || null;
    }
    if (element instanceof HTMLInputElement) {
      return Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set || null;
    }
    return null;
  }

  function isDateLikeInput(element) {
    return element instanceof HTMLInputElement && ["date", "datetime-local", "month", "time", "week"].includes(String(element.type || "").toLowerCase());
  }

  function isSelectLikeFieldMeta(field) {
    if (!field || typeof field !== "object") {
      return false;
    }
    const tag = String(field.tag || "").trim().toLowerCase();
    const role = String(field.role || "").trim().toLowerCase();
    const inputType = String(field.input_type || "").trim().toLowerCase();
    return tag === "select"
      || tag === "option"
      || role === "combobox"
      || role === "listbox"
      || role === "option"
      || ["date", "datetime-local", "month", "time", "week"].includes(inputType)
      || Boolean(field.has_datalist);
  }

  function isComboboxLikeElement(element) {
    if (!(element instanceof Element)) {
      return false;
    }
    const role = String(element.getAttribute("role") || "").trim().toLowerCase();
    const hasListboxPopup = String(element.getAttribute("aria-haspopup") || "").trim().toLowerCase() === "listbox";
    const controls = String(element.getAttribute("aria-controls") || element.getAttribute("aria-owns") || "").trim();
    return role === "combobox" || hasListboxPopup || Boolean(controls);
  }

  function assignElementValue(element, nextValue) {
    if (element?.isContentEditable) {
      element.innerText = nextValue;
      return true;
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const setter = getNativeValueSetter(element);
      if (setter) {
        setter.call(element, nextValue);
      } else {
        element.value = nextValue;
      }
      return true;
    }
    return false;
  }

  function dispatchValueEvents(element, nextValue) {
    if (!(element instanceof Element)) {
      return;
    }
    if (element.isContentEditable) {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
    } else {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findSelectableOptions(container) {
    if (!(container instanceof Element)) {
      return [];
    }
    return Array.from(container.querySelectorAll("[role='option'], option, [data-value], [data-label]")).filter((item) => item instanceof Element && isInteractableCandidate(item));
  }

  function findMatchingSelectableOption(container, requested) {
    const normalized = String(requested || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) {
      return null;
    }
    return (
      findSelectableOptions(container).find((option) => {
        const haystack = [
          option.textContent || "",
          option.getAttribute("aria-label") || "",
          option.getAttribute("data-value") || "",
          option.getAttribute("data-label") || "",
          option.getAttribute("value") || "",
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        return haystack === normalized || haystack.includes(normalized);
      }) || null
    );
  }

  function findAssociatedListbox(element) {
    if (!(element instanceof Element)) {
      return null;
    }
    const explicitIds = [element.getAttribute("aria-controls"), element.getAttribute("aria-owns")]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    for (const idGroup of explicitIds) {
      for (const id of idGroup.split(/\s+/).filter(Boolean)) {
        const target = document.getElementById(id);
        if (target instanceof Element && (target.getAttribute("role") || "").trim().toLowerCase() === "listbox") {
          return target;
        }
      }
    }
    const parentListbox = element.closest?.("[role='listbox']");
    if (parentListbox instanceof Element) {
      return parentListbox;
    }
    const nearbyListboxes = Array.from(document.querySelectorAll("[role='listbox']")).filter((node) => node instanceof Element && !isInsideOmniAgent(node));
    return nearbyListboxes.find((node) => isInteractableCandidate(node)) || null;
  }

  function resolveSelectLikeTarget(element) {
    if (!(element instanceof Element)) {
      return null;
    }
    const directSelect = element instanceof HTMLSelectElement ? element : element.closest?.("select");
    if (directSelect instanceof HTMLSelectElement) {
      return { kind: "native_select", control: directSelect };
    }
    const role = String(element.getAttribute("role") || "").trim().toLowerCase();
    if (role === "option") {
      const listbox = element.closest?.("[role='listbox']");
      if (listbox instanceof Element) {
        return { kind: "listbox", control: listbox };
      }
    }
    if (role === "listbox") {
      return { kind: "listbox", control: element };
    }
    const listboxAncestor = element.closest?.("[role='listbox']");
    if (listboxAncestor instanceof Element) {
      return { kind: "listbox", control: listboxAncestor };
    }
    if (element instanceof HTMLInputElement && element.list instanceof HTMLDataListElement) {
      return { kind: "datalist_input", control: element };
    }
    if (isDateLikeInput(element)) {
      return { kind: "date_input", control: element };
    }
    if (isComboboxLikeElement(element)) {
      return { kind: "combobox", control: element };
    }
    const comboAncestor = element.closest?.("[role='combobox'], [aria-haspopup='listbox'], [aria-controls], [aria-owns]");
    if (comboAncestor instanceof Element) {
      return { kind: "combobox", control: comboAncestor };
    }
    return null;
  }

  function getActionSearchRoot() {
    return getScopeRoot() || pickSelectionAnchorElement() || document;
  }

  function isInteractableCandidate(element) {
    if (!(element instanceof Element) || isInsideOmniAgent(element)) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function isRectInViewport(rect) {
    if (!rect || typeof rect !== "object") {
      return false;
    }
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function scorePlannerCandidate(element) {
    if (!(element instanceof Element)) {
      return -Infinity;
    }
    const rect = element.getBoundingClientRect();
    const text = String(element.innerText || element.textContent || element.value || "").replace(/\s+/g, " ").trim();
    const label = String(element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const placeholder = String(element.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
    const nearbyText = inferNearbyText(element);
    const tag = element.tagName.toLowerCase();
    const role = String(element.getAttribute("role") || "").trim().toLowerCase();
    let score = 0;

    if (isRectInViewport(rect)) {
      score += 8;
    }
    if (rect.width >= 24 && rect.height >= 16) {
      score += 2;
    }
    if (label) {
      score += 6;
    }
    if (text) {
      score += Math.min(6, Math.ceil(text.length / 24));
    }
    if (placeholder) {
      score += 3;
    }
    if (nearbyText) {
      score += 3;
    }
    if (element.matches("button, a[href], input[type='button'], input[type='submit'], [role='button']")) {
      score += 6;
    }
    if (element.matches("input, textarea, select, [contenteditable='true']") || element.isContentEditable) {
      score += 7;
    }
    if (tag === "label") {
      score += 2;
    }
    if (role === "textbox" || role === "combobox" || role === "listbox" || role === "link") {
      score += 4;
    }
    if (element === document.activeElement) {
      score += 4;
    }
    return score;
  }

  function getInteractiveCandidates(root, limit = PAGE_AGENT_DOM_CANDIDATE_LIMIT) {
    const baseRoot = root instanceof Element || root instanceof Document ? root : document;
    const selector = [
      "button",
      "a[href]",
      "input",
      "textarea",
      "select",
      "label",
      "[role='combobox']",
      "[role='listbox']",
      "[role='option']",
      "[role='button']",
      "[data-testid]",
      "[contenteditable='true']",
      "[tabindex]",
    ].join(", ");
    const queryRoot = baseRoot instanceof Document ? baseRoot : baseRoot;
    const queried = Array.from(queryRoot.querySelectorAll(selector)).filter(isInteractableCandidate);
    if (baseRoot instanceof Element && baseRoot.matches(selector) && isInteractableCandidate(baseRoot)) {
      queried.unshift(baseRoot);
    }
    return Array.from(new Set(queried))
      .sort((left, right) => scorePlannerCandidate(right) - scorePlannerCandidate(left))
      .slice(0, Math.max(1, Number(limit) || PAGE_AGENT_DOM_CANDIDATE_LIMIT));
  }

  function buildElementCorpus(element) {
    return [
      element.innerText || "",
      element.textContent || "",
      element.getAttribute("aria-label") || "",
      element.getAttribute("placeholder") || "",
      element.getAttribute("name") || "",
      element.getAttribute("data-testid") || "",
      element.getAttribute("title") || "",
      element.getAttribute("alt") || "",
      element.id || "",
      element.className || "",
      inferNearbyText(element) || "",
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function getDomCandidateDisplayLabel(item) {
    if (!item || typeof item !== "object") {
      return "";
    }
    return String(item.label || item.text || item.placeholder || item.nearby_text || item.element_id || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function buildDomCandidateOverflowSummary(domCandidates, detailLimit = PAGE_AGENT_BROWSER_STATE_CANDIDATE_LIMIT, summaryLimit = DOM_CANDIDATE_OVERFLOW_SUMMARY_LIMIT) {
    const overflow = Array.isArray(domCandidates) ? domCandidates.slice(detailLimit) : [];
    if (!overflow.length) {
      return [];
    }
    const groups = new Map();
    overflow.forEach((item) => {
      const tag = String(item?.tag || "").trim().toLowerCase() || "unknown";
      const role = String(item?.role || "").trim().toLowerCase() || "";
      const key = `${tag}|${role}`;
      const existing = groups.get(key) || { tag, role, count: 0, sample_labels: [] };
      existing.count += 1;
      const label = getDomCandidateDisplayLabel(item);
      if (label && !existing.sample_labels.includes(label) && existing.sample_labels.length < 3) {
        existing.sample_labels.push(label.slice(0, 48));
      }
      groups.set(key, existing);
    });
    return Array.from(groups.values())
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }
        return String(left.tag || "").localeCompare(String(right.tag || ""));
      })
      .slice(0, Math.max(1, Number(summaryLimit) || DOM_CANDIDATE_OVERFLOW_SUMMARY_LIMIT));
  }

  function scoreAnchorAgainstElement(anchor, element) {
    if (!anchor || !(element instanceof Element)) {
      return 0;
    }
    let score = 0;
    const tag = String(anchor.tag || "").trim().toLowerCase();
    const role = String(anchor.role || "").trim().toLowerCase();
    const label = String(anchor.label || "").replace(/\s+/g, " ").trim().toLowerCase();
    const placeholder = String(anchor.placeholder || "").replace(/\s+/g, " ").trim().toLowerCase();
    const nearbyText = String(anchor.nearby_text || "").replace(/\s+/g, " ").trim().toLowerCase();
    const corpus = buildElementCorpus(element);
    if (tag && element.tagName.toLowerCase() === tag) {
      score += 3;
    }
    if (role && String(element.getAttribute("role") || "").trim().toLowerCase() === role) {
      score += 2;
    }
    if (label && corpus.includes(label)) {
      score += 6;
    }
    if (placeholder && corpus.includes(placeholder)) {
      score += 4;
    }
    if (nearbyText && corpus.includes(nearbyText)) {
      score += 3;
    }
    return score;
  }

  function scoreActionCandidate(action, element) {
    if (!(element instanceof Element)) {
      return -Infinity;
    }
    const corpus = buildElementCorpus(element);
    let score = 0;
    const targetDesc = String(action.target_desc || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (targetDesc) {
      if (corpus.includes(targetDesc)) {
        score += 8;
      }
      targetDesc
        .split(/[\s,/|:：;；\-]+/)
        .filter((token) => token && token.length >= 2)
        .forEach((token) => {
          if (corpus.includes(token)) {
            score += 2;
          }
        });
    }
    if (Array.isArray(action.semantic_anchors)) {
      action.semantic_anchors.forEach((anchor) => {
        score += scoreAnchorAgainstElement(anchor, element);
      });
    }
    const selectorCandidates = Array.isArray(action.selector_candidates) ? action.selector_candidates : [];
    for (const selector of [action.selector, ...selectorCandidates]) {
      if (!selector) {
        continue;
      }
      try {
        if (element.matches(selector)) {
          score += 10;
          break;
        }
      } catch (error) {
        continue;
      }
    }
    if (action.type === "click" && element.matches("button, a, [role='button'], input[type='button'], input[type='submit']")) {
      score += 2;
    }
    if (action.type === "fill" && (element.matches("input, textarea, [contenteditable='true']") || element.isContentEditable)) {
      score += 3;
    }
    if (action.type === "select") {
      const selectTarget = resolveSelectLikeTarget(element);
      if (selectTarget?.control) {
        score += 3;
        if (selectTarget.kind === "combobox") {
          score += 2;
        }
      }
    }
    return score;
  }

  function buildActionCandidateSuggestions(action, limit = 3) {
    const normalizedLimit = Math.max(1, Number(limit) || 3);
    const ranked = [];
    const seen = new Set();
    const pushCandidate = (element, score, source, nativeIndex = null) => {
      if (!(element instanceof Element) || !document.contains(element) || isInsideOmniAgent(element)) {
        return;
      }
      if (!Number.isFinite(score) || score < 3) {
        return;
      }
      const selectorCandidates = makeSelectorCandidates(element);
      const selector = selectorCandidates[0] || "";
      const dedupeKey = nativeIndex !== null ? `idx:${nativeIndex}` : selector ? `selector:${selector}` : `element:${ensureElementId(element)}`;
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);
      ranked.push({
        score,
        label: getDomCandidateDisplayLabel({
          label: inferLabel(element),
          text: element.innerText || element.value || "",
          placeholder: element.getAttribute("placeholder") || "",
          nearby_text: inferNearbyText(element),
        }),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        input_type: element instanceof HTMLInputElement ? String(element.type || "").toLowerCase() : "",
        has_datalist: element instanceof HTMLInputElement && element.list instanceof HTMLDataListElement,
        selector,
        selector_candidates: selectorCandidates.slice(0, 3),
        nearby_text: inferNearbyText(element),
        page_agent_index: Number.isInteger(nativeIndex) ? nativeIndex : null,
        source,
      });
    };

    const nativeController = state.pageAgentNativeController;
    if (nativeController?.selectorMap instanceof Map) {
      for (const [index, node] of nativeController.selectorMap.entries()) {
        const element = node?.ref;
        if (!(element instanceof Element)) {
          continue;
        }
        pushCandidate(element, scoreActionCandidate(action, element), "page_agent", Number.isInteger(index) ? index : null);
      }
    }

    const root = getActionSearchRoot();
    getInteractiveCandidates(root, PAGE_AGENT_DOM_CANDIDATE_LIMIT).forEach((element) => {
      pushCandidate(element, scoreActionCandidate(action, element), "dom_fallback");
    });

    return ranked
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.source !== right.source) {
          return left.source === "page_agent" ? -1 : 1;
        }
        return 0;
      })
      .slice(0, normalizedLimit);
  }

  function buildActionReplaySnapshot(action) {
    const replay = {
      type: String(action?.type || "").trim().toLowerCase() || "unknown",
      target_desc: String(action?.target_desc || action?.label || "").trim(),
    };
    if (Number.isInteger(action?.page_agent_index)) {
      replay.page_agent_index = action.page_agent_index;
    }
    if (String(action?.selector || "").trim()) {
      replay.selector = String(action.selector).trim();
    }
    const selectorCandidates = Array.isArray(action?.selector_candidates)
      ? action.selector_candidates.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
      : [];
    if (selectorCandidates.length) {
      replay.selector_candidates = selectorCandidates;
    }
    if (String(action?.element_id || "").trim()) {
      replay.element_id = String(action.element_id).trim();
    }
    if (action?.value !== undefined && action?.value !== null && String(action.value).trim()) {
      replay.value = String(action.value);
    }
    return replay;
  }

  function normalizeAttemptedModes(diagnostic) {
    const raw = Array.isArray(diagnostic?.attempted_modes) ? diagnostic.attempted_modes : [];
    const normalized = raw.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
    if (normalized.length) {
      return Array.from(new Set(normalized));
    }
    const strategy = String(diagnostic?.strategy || "").trim().toLowerCase();
    if (strategy === "native_then_fallback") {
      return ["native", "fallback"];
    }
    if (strategy === "native") {
      return ["native"];
    }
    if (strategy === "fallback") {
      return ["fallback"];
    }
    return [];
  }

  function inferActionFailurePhase(reason) {
    const normalized = String(reason || "").trim().toLowerCase();
    if (!normalized) {
      return "execute";
    }
    if (["page_agent_index_unresolved", "page_agent_candidate_missing", "fallback_target_missing"].includes(normalized)) {
      return "locate_target";
    }
    if (normalized.startsWith("page_agent_")) {
      return "native_execute";
    }
    if (["unsupported_select_target", "select_option_missing"].includes(normalized)) {
      return "control_interaction";
    }
    if (["empty_form_fields", "fill_form_failed"].includes(normalized)) {
      return "workflow_expand";
    }
    return "execute";
  }

  function describeActionFailurePhase(phase) {
    const normalized = String(phase || "").trim().toLowerCase();
    if (normalized === "locate_target") {
      return "目标定位失败";
    }
    if (normalized === "native_execute") {
      return "原生执行失败";
    }
    if (normalized === "control_interaction") {
      return "控件交互失败";
    }
    if (normalized === "workflow_expand") {
      return "流程展开失败";
    }
    return "动作执行失败";
  }

  function buildActionFailureRecoveryHint(diagnostic) {
    const phase = String(diagnostic?.phase || "").trim().toLowerCase();
    const actionType = String(diagnostic?.action_type || "").trim().toLowerCase();
    const candidateCount = Array.isArray(diagnostic?.top_candidates) ? diagnostic.top_candidates.length : Number(diagnostic?.candidate_count || 0);
    if (candidateCount > 0) {
      return `可先尝试候选修补；当前已有 ${candidateCount} 个候选可直接重绑。`;
    }
    if (phase === "locate_target" && Number.isInteger(diagnostic?.page_agent_index)) {
      return "原生索引可能已漂移，建议刷新页面状态后重新绑定目标元素。";
    }
    if (phase === "locate_target") {
      return "当前更像是定位失败，建议补更稳定的 selector 或直接用候选修补。";
    }
    if (phase === "native_execute" && actionType === "select") {
      return "原生 select 执行失败，可改绑到真实 combobox/listbox 节点后重试。";
    }
    if (phase === "control_interaction") {
      return "当前控件不像标准输入控件，建议确认真实交互节点后再修补 workflow。";
    }
    if (phase === "workflow_expand") {
      return "先补齐字段定义，或把这一步拆成更小的 click/fill/select 子步骤。";
    }
    return "可先查看 trace 里的失败上下文，再决定是否修补 workflow 步骤。";
  }

  function finalizeActionFailureDiagnostic(action, diagnostic) {
    const normalized = diagnostic && typeof diagnostic === "object" ? { ...diagnostic } : {};
    normalized.reason = String(normalized.reason || "unknown").trim().toLowerCase() || "unknown";
    normalized.message = String(normalized.message || `动作失败：${normalized.reason}`).trim();
    normalized.action_type = String(normalized.action_type || action?.type || "").trim().toLowerCase() || "unknown";
    normalized.target = String(normalized.target || describeRuntimeTarget(action)).trim();
    normalized.phase = String(normalized.phase || inferActionFailurePhase(normalized.reason)).trim().toLowerCase() || "execute";
    normalized.source = String(normalized.source || "browser_runtime").trim().toLowerCase() || "browser_runtime";
    normalized.strategy = String(normalized.strategy || "").trim().toLowerCase();
    normalized.page_agent_index = Number.isInteger(normalized.page_agent_index)
      ? normalized.page_agent_index
      : Number.isInteger(action?.page_agent_index)
        ? action.page_agent_index
        : null;
    normalized.selector = String(normalized.selector || action?.selector || "").trim();
    normalized.selector_candidates = Array.isArray(normalized.selector_candidates)
      ? normalized.selector_candidates.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
      : Array.isArray(action?.selector_candidates)
        ? action.selector_candidates.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
        : [];
    normalized.top_candidates = Array.isArray(normalized.top_candidates) ? normalized.top_candidates : buildActionCandidateSuggestions(action, 3);
    normalized.attempted_modes = normalizeAttemptedModes(normalized);
    normalized.candidate_count = Array.isArray(normalized.top_candidates) ? normalized.top_candidates.length : 0;
    normalized.replay = normalized.replay && typeof normalized.replay === "object" ? normalized.replay : buildActionReplaySnapshot(action);
    normalized.recovery_hint = String(normalized.recovery_hint || buildActionFailureRecoveryHint(normalized)).trim();
    if (normalized.control_kind !== undefined) {
      normalized.control_kind = String(normalized.control_kind || "").trim().toLowerCase();
    }
    if (normalized.native_reason !== undefined) {
      normalized.native_reason = String(normalized.native_reason || "").trim().toLowerCase();
    }
    return normalized;
  }

  function createActionExecutionError(action, reason, message, extra = {}) {
    const error = new Error(message || `动作失败：${reason || "unknown"}`);
    error.omniDiagnostic = finalizeActionFailureDiagnostic(action, {
      reason: String(reason || "unknown"),
      message: String(message || "").trim() || `动作失败：${reason || "unknown"}`,
      action_type: String(action?.type || "").trim().toLowerCase() || "unknown",
      target: describeRuntimeTarget(action),
      page_agent_index: Number.isInteger(action?.page_agent_index) ? action.page_agent_index : null,
      selector: String(action?.selector || "").trim(),
      selector_candidates: Array.isArray(action?.selector_candidates)
        ? action.selector_candidates.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
        : [],
      top_candidates: buildActionCandidateSuggestions(action, 3),
      ...extra,
    });
    return error;
  }

  function extractActionFailureDiagnostic(action, error) {
    if (error?.omniDiagnostic && typeof error.omniDiagnostic === "object") {
      return finalizeActionFailureDiagnostic(action, error.omniDiagnostic);
    }
    return finalizeActionFailureDiagnostic(action, {
      reason: "unknown",
      message: String(error?.message || `动作失败：${action?.type || "unknown"}`),
      action_type: String(action?.type || "").trim().toLowerCase() || "unknown",
      target: describeRuntimeTarget(action),
      page_agent_index: Number.isInteger(action?.page_agent_index) ? action.page_agent_index : null,
      selector: String(action?.selector || "").trim(),
      selector_candidates: Array.isArray(action?.selector_candidates)
        ? action.selector_candidates.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 4)
        : [],
      top_candidates: buildActionCandidateSuggestions(action, 3),
    });
  }

  function formatActionFailureDiagnostic(diagnostic) {
    if (!diagnostic || typeof diagnostic !== "object") {
      return "";
    }
    const segments = [];
    if (diagnostic.reason) {
      segments.push(`reason=${diagnostic.reason}`);
    }
    if (diagnostic.phase) {
      segments.push(`phase=${diagnostic.phase}`);
    }
    if (Number.isInteger(diagnostic.page_agent_index)) {
      segments.push(`idx=${diagnostic.page_agent_index}`);
    }
    if (diagnostic.strategy) {
      segments.push(`strategy=${diagnostic.strategy}`);
    }
    const topCandidates = Array.isArray(diagnostic.top_candidates) ? diagnostic.top_candidates : [];
    if (topCandidates.length) {
      const preview = topCandidates
        .slice(0, 2)
        .map((item) => {
          const prefix = Number.isInteger(item.page_agent_index) ? `[${item.page_agent_index}]` : "";
          return `${prefix}${String(item.label || item.selector || item.tag || "候选").trim()}`.trim();
        })
        .filter(Boolean)
        .join(" / ");
      if (preview) {
        segments.push(`candidates=${preview}`);
      }
    }
    if (diagnostic.recovery_hint) {
      segments.push(`next=${String(diagnostic.recovery_hint).slice(0, 48)}`);
    }
    return segments.join(" | ");
  }

  class OmniRuntimeMask {
    constructor() {
      this.active = false;
      this.currentTarget = null;
      this.hideTimer = null;
      this.handleViewportChange = this.handleViewportChange.bind(this);
      window.addEventListener("scroll", this.handleViewportChange, true);
      window.addEventListener("resize", this.handleViewportChange, true);
    }

    clearHideTimer() {
      if (this.hideTimer) {
        window.clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
    }

    scheduleHide(delayMs = 1800) {
      this.clearHideTimer();
      this.hideTimer = window.setTimeout(() => {
        if (state.runtime.holdOpen || state.runtime.active) {
          return;
        }
        this.hide();
      }, Math.max(0, Number(delayMs || 0)));
    }

    show(title, detail, mode = "executing") {
      this.clearHideTimer();
      this.active = true;
      state.runtime.active = true;
      runtimeOverlay.classList.add("active");
      this.setStatus(mode, title, detail);
      updateRuntimeToggleLabel();
      if (state.runtime.drag.locked) {
        clampRuntimeIntoViewport();
      } else {
        syncRuntimePosition();
      }
    }

    setStatus(mode, title, detail) {
      this.clearHideTimer();
      const nextMode = String(mode || "executing");
      state.runtime.mode = nextMode;
      if (runtimeCallout) {
        runtimeCallout.dataset.mode = nextMode;
      }
      runtimeTitle.textContent = title || "OmniAgent 正在操作网页";
      runtimeDetail.textContent = detail || "执行中...";
      if (runtimeStop) {
        const finished = nextMode === "completed" || nextMode === "error";
        runtimeStop.textContent = finished ? "关闭" : "停止";
        runtimeStop.title = finished ? "关闭提示" : "停止执行";
      }
    }

    resetSequence(label, totalSteps) {
      this.clearHideTimer();
      state.runtime.history = [];
      state.runtime.holdOpen = false;
      state.runtime.cancelRequested = false;
      renderRuntimeHistory();
      this.show("OmniAgent 正在操作网页", `${label || "页面动作"} · 共 ${Math.max(0, Number(totalSteps || 0))} 步`, "executing");
      setRuntimeExpanded(false);
    }

    pushHistory(kind, text, meta = "") {
      state.runtime.history = [...state.runtime.history, { kind, text, meta }].slice(-24);
      renderRuntimeHistory();
    }

    finish(success, detail) {
      const mode = success ? "completed" : "error";
      const title = success ? "执行完成" : "执行失败";
      this.active = false;
      state.runtime.active = false;
      state.runtime.cancelRequested = false;
      this.currentTarget = null;
      runtimeHighlight.style.display = "none";
      runtimeTag.style.display = "none";
      runtimeCursor.style.transform = "translate(-999px, -999px)";
      runtimeCursor.classList.remove("is-clicking");
      clearRuntimeChoice();
      this.setStatus(mode, title, detail);
      this.pushHistory(success ? "done" : "error", detail, success ? "执行结束" : "执行失败");
      setRuntimeExpanded(false);
      if (success && !state.runtime.holdOpen) {
        this.scheduleHide(3000);
      }
    }

    hide() {
      this.clearHideTimer();
      this.active = false;
      state.runtime.active = false;
      state.runtime.mode = "idle";
      state.runtime.holdOpen = false;
      state.runtime.cancelRequested = false;
      this.currentTarget = null;
      runtimeOverlay.classList.remove("active");
      if (runtimeCallout) {
        runtimeCallout.dataset.mode = "idle";
      }
      runtimeHighlight.style.display = "none";
      runtimeTag.style.display = "none";
      runtimeCursor.style.transform = "translate(-999px, -999px)";
      runtimeCursor.classList.remove("is-clicking");
      clearRuntimeChoice();
    }

    handleViewportChange() {
      if (!this.active || !this.currentTarget?.element || !document.contains(this.currentTarget.element)) {
        return;
      }
      this.highlight(this.currentTarget.element, this.currentTarget.label, false);
    }

    highlight(element, label, updateMessage = true) {
      if (!(element instanceof Element)) {
        runtimeHighlight.style.display = "none";
        runtimeTag.style.display = "none";
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      this.currentTarget = { element, label: label || describeElement(element) };
      runtimeHighlight.style.display = "block";
      runtimeHighlight.style.left = `${Math.round(rect.left)}px`;
      runtimeHighlight.style.top = `${Math.round(rect.top)}px`;
      runtimeHighlight.style.width = `${Math.round(rect.width)}px`;
      runtimeHighlight.style.height = `${Math.round(rect.height)}px`;
      runtimeTag.style.display = "block";
      runtimeTag.textContent = this.currentTarget.label;
      runtimeTag.style.left = `${Math.round(Math.max(12, rect.left))}px`;
      runtimeTag.style.top = `${Math.round(Math.max(12, rect.top - 34))}px`;
      if (updateMessage) {
        runtimeDetail.textContent = `当前目标：${this.currentTarget.label}`;
      }
    }

    async movePointerToElement(element, label) {
      if (!(element instanceof Element)) {
        return;
      }
      this.highlight(element, label, false);
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      runtimeCursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      await waitForMs(120);
    }

    pulseClick() {
      runtimeCursor.classList.remove("is-clicking");
      void runtimeCursor.offsetWidth;
      runtimeCursor.classList.add("is-clicking");
    }
  }

  class OmniPageController {
    constructor(mask) {
      this.mask = mask;
    }

    resolveActionElement(action) {
      if (action.element_id && state.elementRegistry.has(action.element_id)) {
        const direct = state.elementRegistry.get(action.element_id);
        if (direct instanceof Element && document.contains(direct)) {
          return direct;
        }
      }
      const roots = Array.from(new Set([getActionSearchRoot(), document])).filter(Boolean);
      const selectorCandidates = Array.isArray(action.selector_candidates) ? action.selector_candidates : [];
      for (const root of roots) {
        for (const selector of [action.selector, ...selectorCandidates]) {
          if (!selector) {
            continue;
          }
          try {
            const found = root.querySelector(selector);
            if (found instanceof Element && isInteractableCandidate(found)) {
              return found;
            }
          } catch (error) {
            continue;
          }
        }
      }
      const candidates = roots.flatMap((root) => getInteractiveCandidates(root));
      let best = null;
      let bestScore = -Infinity;
      candidates.forEach((candidate) => {
        const score = scoreActionCandidate(action, candidate);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      });
      return bestScore >= 5 ? best : null;
    }

    async prepare(action, element, title) {
      const label = action.target_desc || inferLabel(element) || describeElement(element);
      this.mask.show(title, label);
      element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      await waitForMs(180);
      await this.mask.movePointerToElement(element, label);
      return label;
    }

    async perform(action, element) {
      if (!(element instanceof Element)) {
        throw createActionExecutionError(action, "fallback_target_missing", `找不到目标元素 (${action.type})`);
      }
      const target =
        action.type === "highlight" || action.type === "focus" || action.type === "press_key"
          ? element
          : resolveRecordableElement(action.type, element) || element;
      const label = action.target_desc || inferLabel(target) || describeElement(target);
      if (action.type === "highlight") {
        this.mask.show("高亮目标元素", label);
        this.mask.highlight(target, label);
        target.classList.add("oa2-highlight");
        await waitForMs(900);
        target.classList.remove("oa2-highlight");
        return;
      }
      if (action.type === "focus") {
        await this.prepare(action, target, "聚焦目标元素");
        target.focus({ preventScroll: true });
        await waitForMs(120);
        return;
      }
      if (action.type === "click") {
        await this.performClick(action, target, label);
        return;
      }
      if (action.type === "fill") {
        await this.performFill(action, target, label);
        return;
      }
      if (action.type === "select") {
        await this.performSelect(action, target, label);
        return;
      }
      if (action.type === "press_key") {
        await this.performPressKey(action, target, label);
        return;
      }
      throw createActionExecutionError(action, "unsupported_action_type", `暂不支持的动作类型: ${action.type}`);
    }

    async performClick(action, element, label) {
      await this.prepare(action, element, "点击页面元素");
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const pointerOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: "mouse" };
      const mouseOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
      element.dispatchEvent(new PointerEvent("pointerover", pointerOpts));
      element.dispatchEvent(new PointerEvent("pointerenter", { ...pointerOpts, bubbles: false }));
      element.dispatchEvent(new MouseEvent("mouseover", mouseOpts));
      element.dispatchEvent(new MouseEvent("mouseenter", { ...mouseOpts, bubbles: false }));
      element.dispatchEvent(new PointerEvent("pointerdown", pointerOpts));
      element.dispatchEvent(new MouseEvent("mousedown", mouseOpts));
      element.focus?.({ preventScroll: true });
      this.mask.pulseClick();
      element.dispatchEvent(new PointerEvent("pointerup", pointerOpts));
      element.dispatchEvent(new MouseEvent("mouseup", mouseOpts));
      if (typeof element.click === "function") {
        element.click();
      } else {
        element.dispatchEvent(new MouseEvent("click", mouseOpts));
      }
      await waitForMs(220);
    }

    async performFill(action, element, label) {
      await this.prepare(action, element, "填写页面字段");
      const nextValue = String(action.value ?? "");
      if (element.isContentEditable) {
        element.focus({ preventScroll: true });
        element.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: nextValue,
          })
        );
        element.innerText = nextValue;
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        await waitForMs(120);
        return;
      }
      if (!isEditableElement(element)) {
        throw createActionExecutionError(action, "unsupported_fill_target", `目标元素不可填写: ${label}`);
      }
      element.focus({ preventScroll: true });
      const setter = getNativeValueSetter(element);
      if (setter) {
        setter.call(element, nextValue);
      } else {
        element.value = nextValue;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForMs(120);
    }

    async performSelect(action, element, label) {
      const resolved = resolveSelectLikeTarget(element);
      if (!resolved?.control) {
        throw createActionExecutionError(action, "unsupported_select_target", `目标元素不是下拉框: ${label}`);
      }
      const control = resolved.control;
      await this.prepare(action, control, "选择页面选项");
      const requested = String(action.value ?? "").trim();
      if (resolved.kind === "native_select") {
        const selectElement = control;
        const matchedOption =
          Array.from(selectElement.options).find((option) => option.value === requested) ||
          Array.from(selectElement.options).find((option) => String(option.textContent || "").trim() === requested) ||
          null;
        if (!matchedOption) {
          throw createActionExecutionError(action, "select_option_missing", `下拉框中不存在选项: ${requested}`);
        }
        selectElement.value = matchedOption.value;
        selectElement.dispatchEvent(new Event("input", { bubbles: true }));
        selectElement.dispatchEvent(new Event("change", { bubbles: true }));
        await waitForMs(120);
        return;
      }
      if (resolved.kind === "date_input" || resolved.kind === "datalist_input") {
        control.focus?.({ preventScroll: true });
        if (!assignElementValue(control, requested)) {
          throw createActionExecutionError(action, "unsupported_select_target", `目标元素不可直接选择: ${label}`);
        }
        dispatchValueEvents(control, requested);
        await waitForMs(120);
        return;
      }
      if (resolved.kind === "listbox") {
        const matchedOption = findMatchingSelectableOption(control, requested);
        if (!(matchedOption instanceof Element)) {
          throw createActionExecutionError(action, "select_option_missing", `列表中不存在选项: ${requested}`);
        }
        matchedOption.scrollIntoView({ block: "nearest", inline: "nearest" });
        matchedOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        matchedOption.click?.();
        matchedOption.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        await waitForMs(120);
        return;
      }
      if (resolved.kind === "combobox") {
        control.focus?.({ preventScroll: true });
        control.click?.();
        await waitForMs(80);
        if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control.isContentEditable) && assignElementValue(control, requested)) {
          dispatchValueEvents(control, requested);
          await waitForMs(80);
        }
        const listbox = findAssociatedListbox(control);
        const matchedOption = findMatchingSelectableOption(listbox, requested);
        if (matchedOption instanceof Element) {
          matchedOption.scrollIntoView({ block: "nearest", inline: "nearest" });
          matchedOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          matchedOption.click?.();
          matchedOption.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          await waitForMs(120);
          return;
        }
        const currentValue = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement ? String(control.value || "").trim() : "";
        if (currentValue === requested) {
          control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          control.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          await waitForMs(120);
          return;
        }
        throw createActionExecutionError(action, "select_option_missing", `组合框中不存在选项: ${requested}`);
      }
      throw createActionExecutionError(action, "unsupported_select_target", `目标元素不是下拉框: ${label}`);
    }

    async performPressKey(action, element, label) {
      await this.prepare(action, element, "发送键盘动作");
      const requestedKey = String(action.key ?? action.value ?? "").trim();
      if (!requestedKey) {
        throw createActionExecutionError(action, "missing_key_value", `未提供要发送的按键: ${label}`);
      }
      const keyMeta = getKeyboardActionMeta(requestedKey);
      const target = element instanceof Element ? element : document.activeElement;
      if (!(target instanceof Element)) {
        throw createActionExecutionError(action, "press_key_target_missing", `当前没有可发送按键的目标: ${label}`);
      }
      target.focus?.({ preventScroll: true });
      const eventInit = {
        key: keyMeta.key,
        code: keyMeta.code,
        keyCode: keyMeta.keyCode,
        which: keyMeta.keyCode,
        charCode: keyMeta.charCode,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      if (keyMeta.dispatchKeyPress) {
        target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
      }
      if (keyMeta.applySubmitHint) {
        const submitTarget = target.closest?.("form");
        if (submitTarget instanceof HTMLFormElement) {
          if (typeof submitTarget.requestSubmit === "function") {
            submitTarget.requestSubmit();
          } else {
            submitTarget.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          }
        }
      }
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      await waitForMs(120);
    }

    async afterAction() {
      return null;
    }
  }

  function resolvePageAgentElementByIndex(controller, index) {
    if (!controller || !(controller.selectorMap instanceof Map) || !Number.isInteger(index)) {
      return null;
    }
    const node = controller.selectorMap.get(index);
    const ref = node?.ref;
    return ref instanceof Element && document.contains(ref) ? ref : null;
  }

  function findPageAgentIndexForElement(element) {
    const controller = state.pageAgentNativeController;
    if (!(element instanceof Element) || !controller || !(controller.selectorMap instanceof Map)) {
      return null;
    }
    for (const [index, node] of controller.selectorMap.entries()) {
      if (node?.ref === element) {
        return index;
      }
    }
    const anchors = buildSemanticAnchorsFromElement(element);
    let bestIndex = null;
    let bestScore = -Infinity;
    for (const [index, node] of controller.selectorMap.entries()) {
      const ref = node?.ref;
      if (!(ref instanceof Element) || !document.contains(ref) || isInsideOmniAgent(ref)) {
        continue;
      }
      let score = 0;
      if (ref.contains(element) || element.contains(ref)) {
        score += 10;
      }
      anchors.forEach((anchor) => {
        score += scoreAnchorAgainstElement(anchor, ref);
      });
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestScore >= 8 ? bestIndex : null;
  }

  async function ensurePageAgentVendorLoaded() {
    const pageAgentGlobal = getPageAgentGlobal();
    if (
      state.pageAgentVendorReady &&
      (typeof pageAgentGlobal.PageController === "function" || typeof window.PageController === "function")
    ) {
      return true;
    }
    if (state.pageAgentVendorLoading) {
      return state.pageAgentVendorLoading;
    }
    state.pageAgentVendorLoading = (async () => {
      const source = await fetchTextResource(`/frontend/page-agent.vendor.js?v=${encodeURIComponent(BUILD_ID)}`, API_REQUEST_TIMEOUTS.standard);
      const exportBridge = `
;try {
  var __oaPageAgentGlobal = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
  if (__oaPageAgentGlobal) {
    if (typeof PageAgent === "function" && typeof __oaPageAgentGlobal.PageAgent !== "function") __oaPageAgentGlobal.PageAgent = PageAgent;
    if (typeof PageAgentCore === "function" && typeof __oaPageAgentGlobal.PageAgentCore !== "function") __oaPageAgentGlobal.PageAgentCore = PageAgentCore;
    if (typeof PageController === "function" && typeof __oaPageAgentGlobal.PageController !== "function") __oaPageAgentGlobal.PageController = PageController;
    if (typeof Panel === "function" && typeof __oaPageAgentGlobal.PageAgentPanel !== "function") __oaPageAgentGlobal.PageAgentPanel = Panel;
    __oaPageAgentGlobal.__OmniPageAgentVendor__ = __oaPageAgentGlobal.__OmniPageAgentVendor__ || { version: "1.7.1", loaded: true, bridged: true };
  }
} catch (__oaPageAgentExportError) {
  console.warn("[OmniAgent] page-agent export bridge failed:", __oaPageAgentExportError);
}
`;
      const instrumentedSource = /\}\)\(\);\s*$/.test(source)
        ? source.replace(/\}\)\(\);\s*$/, `${exportBridge}\n})();`)
        : `${source}\n${exportBridge}`;
      (0, eval)(`${instrumentedSource}\n//# sourceURL=omniagent-page-agent.vendor.js`);
      const sandboxController = window.PageController;
      const bridgedController = pageAgentGlobal.PageController;
      if (typeof sandboxController === "function" && typeof bridgedController !== "function") {
        pageAgentGlobal.PageController = sandboxController;
      }
      if (typeof bridgedController === "function" && typeof window.PageController !== "function") {
        window.PageController = bridgedController;
      }
      if (typeof pageAgentGlobal.PageController !== "function" && typeof window.PageController !== "function") {
        throw new Error("page-agent vendor 已加载，但未暴露 PageController");
      }
      state.pageAgentVendorReady = true;
      return true;
    })()
      .catch((error) => {
        state.pageAgentVendorReady = false;
        throw error;
      })
      .finally(() => {
        state.pageAgentVendorLoading = null;
      });
    return state.pageAgentVendorLoading;
  }

  async function ensurePageAgentNativeController() {
    if (state.pageAgentNativeController) {
      return state.pageAgentNativeController;
    }
    await ensurePageAgentVendorLoaded();
    const pageAgentGlobal = getPageAgentGlobal();
    const Controller = pageAgentGlobal.PageController || window.PageController;
    if (typeof Controller !== "function") {
      throw new Error("当前页面未获得 page-agent PageController");
    }
    state.pageAgentNativeController = new Controller({
      enableMask: true,
      viewportExpansion: -1,
      highlightOpacity: 0.0,
      highlightLabelOpacity: 0.0,
      interactiveBlacklist: [
        () => panel,
        () => launcher,
        () => scopeToolbar,
        () => healingOverlay,
      ],
    });
    return state.pageAgentNativeController;
  }

  function buildDomCandidatesFromPageAgent(controller) {
    if (!controller || !(controller.selectorMap instanceof Map)) {
      return [];
    }
    state.elementRegistry.clear();
    const entries = Array.from(controller.selectorMap.entries());
    return entries
      .map(([index, node]) => {
        const element = node?.ref;
        if (!(element instanceof Element) || isInsideOmniAgent(element) || !document.contains(element) || !isInteractableCandidate(element)) {
          return null;
        }
        const elementId = ensureElementId(element);
        const rect = element.getBoundingClientRect();
        const plannerScore = scorePlannerCandidate(element);
        state.elementRegistry.set(elementId, element);
        return {
          element_id: elementId,
          page_agent_index: index,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || "",
          input_type: element instanceof HTMLInputElement ? String(element.type || "").toLowerCase() : "",
          has_datalist: element instanceof HTMLInputElement && element.list instanceof HTMLDataListElement,
          label: element.getAttribute("aria-label") || "",
          text: (controller.elementTextMap?.get(index) || element.innerText || element.value || "").trim().slice(0, 160),
          placeholder: element.getAttribute("placeholder") || "",
          nearby_text: inferNearbyText(element),
          selector_candidates: makeSelectorCandidates(element),
          semantic_anchors: buildSemanticAnchorsFromElement(element),
          is_visible: isRectInViewport(rect),
          planner_score: plannerScore,
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const leftScore = Number(left?.planner_score || 0);
        const rightScore = Number(right?.planner_score || 0);
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        if (Boolean(right?.is_visible) !== Boolean(left?.is_visible)) {
          return right?.is_visible ? 1 : -1;
        }
        return Number(left?.page_agent_index || 0) - Number(right?.page_agent_index || 0);
      })
      .slice(0, PAGE_AGENT_DOM_CANDIDATE_LIMIT);
  }

  async function captureActionablePageState(text) {
    try {
      const controller = await ensurePageAgentNativeController();
      const nativeState = await controller.getBrowserState();
      await hidePageAgentMaskIfPossible();
      const domCandidates = buildDomCandidatesFromPageAgent(controller);
      const overflowSummary = buildDomCandidateOverflowSummary(domCandidates);
      const scopeRoot = getScopeRoot() || pickSelectionAnchorElement() || document.body;
      const scopeSignature = scopeRoot instanceof Element ? describeElement(scopeRoot) : "page";
      const interactiveSummary = domCandidates
        .slice(0, PAGE_AGENT_INTERACTIVE_SUMMARY_LIMIT)
        .map((item, index) => `${index + 1}.[${item.page_agent_index}]${item.tag}${item.label ? `:${String(item.label).slice(0, 32)}` : item.text ? `:${String(item.text).slice(0, 32)}` : ""}`)
        .join(" | ");
      const browserState = {
        page_kind: classifyPageKind(scopeRoot, text),
        scope_signature: scopeSignature,
        interactive_count: domCandidates.length,
        viewport_summary: nativeState.header || `${window.innerWidth}x${window.innerHeight}`,
        interactive_summary: interactiveSummary,
        dom_candidates: domCandidates.slice(0, PAGE_AGENT_BROWSER_STATE_CANDIDATE_LIMIT),
        dom_candidate_total: domCandidates.length,
        dom_candidate_overflow_count: Math.max(0, domCandidates.length - PAGE_AGENT_BROWSER_STATE_CANDIDATE_LIMIT),
        dom_candidate_overflow_summary: overflowSummary,
        page_agent_header: nativeState.header || "",
        page_agent_content: nativeState.content || "",
        page_agent_footer: nativeState.footer || "",
        page_agent_url: nativeState.url || location.href,
        page_agent_title: nativeState.title || document.title,
        controller: "page-agent",
      };
      state.pageAgentSnapshot = {
        browser_state: { ...browserState },
        dom_candidates: domCandidates.slice(),
        captured_at: Date.now(),
      };
      return {
        browser_state: browserState,
        dom_candidates: domCandidates,
      };
    } catch (error) {
      await hidePageAgentMaskIfPossible();
      console.warn("[OmniAgent] page-agent state fallback:", error);
      const domCandidates = collectDomCandidates();
      const browserState = collectBrowserState(domCandidates, text);
      return { browser_state: browserState, dom_candidates: domCandidates };
    }
  }

  class OmniPageAgentBridgeController {
    constructor(mask, fallback) {
      this.mask = mask;
      this.fallback = fallback;
      this.nativeTreeDirty = true;
      this.lastKnownUrl = location.href;
    }

    async refreshNativeTree(force = false) {
      const controller = await ensurePageAgentNativeController();
      const lastUpdatedAt = typeof controller.getLastUpdateTime === "function" ? Number(await controller.getLastUpdateTime()) || 0 : 0;
      const shouldRefresh =
        force ||
        this.nativeTreeDirty ||
        !lastUpdatedAt ||
        location.href !== this.lastKnownUrl ||
        Date.now() - lastUpdatedAt > 1800;
      if (shouldRefresh) {
        await controller.updateTree();
        this.nativeTreeDirty = false;
        this.lastKnownUrl = location.href;
      }
      return controller;
    }

    async beforeSequence() {
      try {
        const controller = await this.refreshNativeTree(true);
        await controller.showMask();
      } catch (error) {
        return false;
      }
      return true;
    }

    async afterSequence() {
      try {
        if (state.pageAgentNativeController) {
          await state.pageAgentNativeController.hideMask();
        }
      } catch (error) {
        console.warn("[OmniAgent] page-agent hideMask failed:", error);
      }
      this.nativeTreeDirty = true;
      this.lastKnownUrl = location.href;
    }

    async afterAction(action, executionMeta = null) {
      const actionType = String(action?.type || "").trim().toLowerCase();
      if (!["click", "fill", "select", "press_key"].includes(actionType)) {
        return null;
      }
      if (executionMeta?.mode === "native") {
        await waitForMs(actionType === "click" || actionType === "select" ? 80 : 40);
        try {
          await this.refreshNativeTree(true);
        } catch (error) {
          console.warn("[OmniAgent] page-agent refresh after action failed:", error);
        }
      } else {
        this.nativeTreeDirty = true;
      }
      return null;
    }

    resolveActionElement(action) {
      if (Number.isInteger(action?.page_agent_index) && state.pageAgentNativeController) {
        const nativeElement = resolvePageAgentElementByIndex(state.pageAgentNativeController, Number(action.page_agent_index));
        if (nativeElement) {
          return nativeElement;
        }
      }
      return this.fallback.resolveActionElement(action);
    }

    resolveNativeIndex(action, preferredElement) {
      const controller = state.pageAgentNativeController;
      if (!controller || !(controller.selectorMap instanceof Map)) {
        return null;
      }
      if (Number.isInteger(action?.page_agent_index)) {
        const direct = resolvePageAgentElementByIndex(controller, Number(action.page_agent_index));
        if (direct) {
          return Number(action.page_agent_index);
        }
      }
      let bestIndex = null;
      let bestScore = -Infinity;
      for (const [index, node] of controller.selectorMap.entries()) {
        const element = node?.ref;
        if (!(element instanceof Element) || !document.contains(element) || isInsideOmniAgent(element)) {
          continue;
        }
        let score = scoreActionCandidate(action, element);
        if (preferredElement && element === preferredElement) {
          score += 20;
        }
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      return bestScore >= 5 ? bestIndex : null;
    }

    async perform(action, element) {
      const actionType = String(action?.type || "").trim().toLowerCase();
      const nativePreferredTypes = new Set(["click", "fill", "select"]);
      let nativeError = null;
      let nativeControllerReady = false;
      try {
        const controller = await this.refreshNativeTree(!Number.isInteger(action?.page_agent_index));
        nativeControllerReady = true;
        const nativeIndex = this.resolveNativeIndex(action, element);
        if (nativeIndex !== null) {
          action.page_agent_index = nativeIndex;
          if (actionType === "click") {
            const result = await controller.clickElement(nativeIndex);
            if (!result?.success) {
              throw createActionExecutionError(action, "page_agent_click_failed", result?.message || "click failed", {
                strategy: "native",
                phase: "native_execute",
                source: "page_agent_bridge",
                attempted_modes: ["native"],
              });
            }
            this.nativeTreeDirty = true;
            return { mode: "native", nativeIndex };
          }
          if (actionType === "fill") {
            const result = await controller.inputText(nativeIndex, String(action.value ?? ""));
            if (!result?.success) {
              throw createActionExecutionError(action, "page_agent_fill_failed", result?.message || "fill failed", {
                strategy: "native",
                phase: "native_execute",
                source: "page_agent_bridge",
                attempted_modes: ["native"],
              });
            }
            return { mode: "native", nativeIndex };
          }
          if (actionType === "select") {
            const result = await controller.selectOption(nativeIndex, String(action.value ?? ""));
            if (!result?.success) {
              throw createActionExecutionError(action, "page_agent_select_failed", result?.message || "select failed", {
                strategy: "native",
                phase: "native_execute",
                source: "page_agent_bridge",
                attempted_modes: ["native"],
              });
            }
            this.nativeTreeDirty = true;
            return { mode: "native", nativeIndex };
          }
          if (actionType === "highlight" || actionType === "focus") {
            const nativeElement = resolvePageAgentElementByIndex(controller, nativeIndex);
            return this.fallback.perform(action, nativeElement || element);
          }
        }
        if (nativePreferredTypes.has(actionType)) {
          throw createActionExecutionError(
            action,
            Number.isInteger(action?.page_agent_index) ? "page_agent_index_unresolved" : "page_agent_candidate_missing",
            `page-agent 未能稳定定位目标元素 (${action.target_desc || action.selector || action.element_id || actionType})`,
            {
              strategy: "native",
              phase: "locate_target",
              source: "page_agent_bridge",
              attempted_modes: ["native"],
            }
          );
        }
      } catch (error) {
        nativeError = error;
        console.warn("[OmniAgent] page-agent perform fallback:", error);
      }
      const allowFallbackAfterNativeFailure = actionType === "select";
      if (nativeControllerReady && nativePreferredTypes.has(actionType) && !allowFallbackAfterNativeFailure) {
        throw nativeError || createActionExecutionError(action, "page_agent_execute_failed", `page-agent 执行失败 (${actionType})`, { strategy: "native" });
      }
      const fallbackElement = element instanceof Element ? element : this.fallback.resolveActionElement(action);
      if (!(fallbackElement instanceof Element)) {
        if (nativeError) {
          throw nativeError;
        }
        throw createActionExecutionError(action, "fallback_target_missing", `找不到目标元素 (${action?.type || "unknown"})`, {
          strategy: "fallback",
          phase: "locate_target",
          source: "legacy_runtime",
          attempted_modes: ["fallback"],
        });
      }
      try {
        await this.fallback.perform(action, fallbackElement);
      } catch (error) {
        const fallbackDiagnostic = extractActionFailureDiagnostic(action, error);
        const nativeDiagnostic = nativeError ? extractActionFailureDiagnostic(action, nativeError) : null;
        throw createActionExecutionError(
          action,
          fallbackDiagnostic.reason || "fallback_execute_failed",
          fallbackDiagnostic.message || `fallback 执行失败 (${actionType})`,
          {
            ...fallbackDiagnostic,
            strategy: nativeDiagnostic ? "native_then_fallback" : fallbackDiagnostic.strategy || "fallback",
            phase: fallbackDiagnostic.phase || "execute",
            source: "page_agent_bridge",
            attempted_modes: nativeDiagnostic ? ["native", "fallback"] : ["fallback"],
            native_reason: nativeDiagnostic?.reason || "",
            recovery_hint: fallbackDiagnostic.recovery_hint || nativeDiagnostic?.recovery_hint || "",
          }
        );
      }
      if (action?.type === "click" || action?.type === "select" || action?.type === "press_key") {
        this.nativeTreeDirty = true;
      }
      return { mode: "legacy" };
    }
  }

  const runtimeMask = new OmniRuntimeMask();
  const legacyPageController = new OmniPageController(runtimeMask);
  const pageController = new OmniPageAgentBridgeController(runtimeMask, legacyPageController);
  state.pageController = pageController;

  launcher.addEventListener("click", () => {
    if (state.drag.moved) {
      return;
    }
    if (state.isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  launcher.addEventListener("pointerdown", onLauncherPointerDown);
  panelHeader.addEventListener("pointerdown", onPanelPointerDown);
  runtimeHeader?.addEventListener("pointerdown", onRuntimePointerDown);
  runtimeHeader?.addEventListener("click", (event) => {
    if (state.runtime.drag.moved) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    setRuntimeExpanded(!state.runtime.expanded);
  });
  runtimeToggle?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    holdRuntimeOpen();
    setRuntimeExpanded(!state.runtime.expanded);
  });
  runtimeHistoryWrap?.addEventListener("click", () => {
    holdRuntimeOpen();
  });
  runtimeClose?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    runtimeMask.hide();
  });
  runtimeStop?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.runtime.pendingChoice) {
      resolveRuntimeChoice(null);
      runtimeMask.setStatus("error", "已取消选择", "当前协同分支已取消。");
      runtimeMask.pushHistory("observation", "已取消当前协同选择。", "等待选择");
      return;
    }
    if (!state.runtime.active) {
      runtimeMask.hide();
      return;
    }
    if (state.runtime.mode === "completed" || state.runtime.mode === "error") {
      runtimeMask.hide();
      return;
    }
    state.runtime.cancelRequested = true;
    runtimeMask.setStatus("error", "正在停止", "当前步骤完成后会停止后续动作。");
    runtimeMask.pushHistory("observation", "已请求停止执行。", "等待当前步骤收尾");
  });
  runtimeOverlay.querySelector("#oa2-runtime-backdrop")?.addEventListener("click", () => {
    if (!state.runtime.active) {
      runtimeMask.hide();
    }
  });
  window.addEventListener("keydown", async (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || String(event.key || "").toLowerCase() !== "a") {
      return;
    }
    if (event.defaultPrevented || event.altKey || state.scope.picking || state.runtime.active || isEditableTarget(event.target)) {
      return;
    }
    event.preventDefault();
    if (!state.isOpen) {
      openPanel();
    }
    await analyzePage();
  }, true);
  window.addEventListener("pointermove", onLauncherPointerMove, true);
  window.addEventListener("pointerup", onLauncherPointerUp, true);
  window.addEventListener("pointermove", onPanelPointerMove, true);
  window.addEventListener("pointerup", onPanelPointerUp, true);
  window.addEventListener("pointermove", onRuntimePointerMove, true);
  window.addEventListener("pointerup", onRuntimePointerUp, true);
  window.addEventListener("resize", () => {
    clampLauncherIntoViewport();
    const savedSize = readPanelSize();
    if (savedSize) {
      applyPanelSize(savedSize.width, savedSize.height, false);
    } else {
      const rect = panel.getBoundingClientRect();
      applyPanelSize(rect.width, rect.height, false);
    }
    clampPanelIntoViewport();
    if (!state.panelDrag.locked) {
      syncPanelPosition();
    }
    if (state.runtime.drag.locked) {
      clampRuntimeIntoViewport();
    } else if (state.runtime.active) {
      syncRuntimePosition();
    }
  });
  if (typeof ResizeObserver !== "undefined") {
    let resizeObserverFrame = 0;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const width = Math.round(entry.contentRect?.width || panel.offsetWidth || 0);
      const height = Math.round(entry.contentRect?.height || panel.offsetHeight || 0);
      if (!width || !height || resizeObserverFrame) {
        return;
      }
      resizeObserverFrame = window.requestAnimationFrame(() => {
        resizeObserverFrame = 0;
        syncPanelLayoutMode(width);
        writePanelSize(width, height);
        clampPanelIntoViewport();
      });
    });
    observer.observe(panel);
  }

  panel.addEventListener("click", async (event) => {
    const actionTarget = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!(actionTarget instanceof Element) || !panel.contains(actionTarget)) {
      return;
    }
    const action = actionTarget.getAttribute("data-action");
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action === "view-results") {
      switchView("results");
    }
    if (action === "view-teach") {
      switchView("teach");
    }
    if (action === "view-memory") {
      switchView("memory");
      await loadMemory();
    }
    if (action === "view-review") {
      switchView("review");
      await loadLibraryReview();
    }
    if (action === "refresh-review") {
      await loadLibraryReview();
    }
    if (action === "toggle-memory-hitlist") {
      toggleMemoryPopover();
    }
    if (action === "toggle-fields") {
      state.extractedExpanded = !state.extractedExpanded;
      updateFieldToggle();
      if (state.lastAnalysis) {
        renderAnalysis(state.lastAnalysis, { silentRefresh: true });
      }
    }
    if (action === "toggle-actions") {
      state.actionsExpanded = !state.actionsExpanded;
      updateActionToggle();
      if (state.lastAnalysis) {
        renderAnalysis(state.lastAnalysis, { silentRefresh: true });
      }
    }
    if (action === "health") {
      await checkHealth();
    }
    if (action === "analyze") {
      await analyzePage();
    }
    if (action === "pick-scope") {
      startScopePicking();
    }
    if (action === "clear-scope") {
      clearSelectedScope();
    }
    if (action === "teach") {
      await teachCurrent();
    }
    if (action === "operate") {
      await operateCurrent();
    }
    if (action === "teach-confirm") {
      await confirmTeachDraft();
    }
    if (action === "teach-reject") {
      await rejectTeachDraft();
    }
    if (action === "execute") {
      await executeLastActions();
    }
    if (action === "load-memory") {
      await loadMemory();
    }
    if (action === "rag-upload-text") {
      await uploadRagText();
    }
    if (action === "rag-upload-file") {
      await uploadRagFile();
    }
    if (action === "rag-search") {
      await searchRag();
    }
    if (action === "start-record") {
      await startWorkflowRecording();
    }
    if (action === "stop-record") {
      await stopWorkflowRecording(false);
    }
    if (action === "record-to-teach") {
      await draftRecordedWorkflow();
    }
    if (action === "toggle-teach-recorder") {
      toggleTeachRecorderCard();
    }
    if (action === "clear-record") {
      clearWorkflowRecording();
    }
    if (action === "close-panel") {
      closePanel();
    }
    if (action === "locate-evidence") {
      const evidenceIndex = Number(actionTarget.getAttribute("data-evidence-index") || -1);
      focusEvidenceItem(evidenceIndex);
    }
    if (action === "clear") {
      document.getElementById("oa2-teach-input").value = "";
      setTeachResult("输入已清空。");
    }
  });

  scopeToolbar.addEventListener("click", (event) => {
    const actionTarget = event.target instanceof Element ? event.target.closest("[data-scope-action]") : null;
    if (!(actionTarget instanceof Element) || !scopeToolbar.contains(actionTarget)) {
      return;
    }
    const action = actionTarget.getAttribute("data-scope-action");
    if (!action) {
      return;
    }
    event.preventDefault();
    if (action === "scope-parent") {
      nudgeScopeSelection(1);
    }
    if (action === "scope-child") {
      nudgeScopeSelection(-1);
    }
    if (action === "scope-confirm") {
      confirmScopeSelection();
    }
    if (action === "scope-cancel") {
      cancelScopePicking();
    }
  });

  function renderStatusHistory() {
    const node = document.getElementById("oa2-status-text");
    if (!node) {
      return;
    }
    node.innerHTML = "";
    const lines = state.statusHistory.length
      ? state.statusHistory
      : ["[sys] 等待操作。默认优先分析当前显式区域，没有区域时回退到选中文本或整页。"];
    lines.forEach((line) => {
      const item = document.createElement("div");
      item.className = "oa2-log-line";
      item.textContent = line;
      node.appendChild(item);
    });
  }

  function setStatus(text) {
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    state.statusHistory = [`[${stamp}] ${text}`, ...state.statusHistory].slice(0, 16);
    renderStatusHistory();
    const wrap = document.getElementById("oa2-status-wrap");
    if (wrap && /失败|error|取消|找不到/i.test(String(text))) {
      wrap.open = true;
    }
  }

  function pruneStatusHistory(pattern) {
    state.statusHistory = state.statusHistory.filter((line) => !pattern.test(String(line)));
    renderStatusHistory();
  }

  function setHealthState(status, message) {
    state.health.status = status;
    state.health.message = message;
    const node = document.getElementById("oa2-health-chip");
    if (!node) {
      return;
    }
    node.classList.remove("ok", "pending", "error");
    if (status === "ok") {
      node.classList.add("ok");
    } else if (status === "pending") {
      node.classList.add("pending");
    } else if (status === "error") {
      node.classList.add("error");
    }
    node.textContent = message;
    node.title = message;
  }

  function setDebug(text) {
    const node = document.getElementById("oa2-debug-text");
    if (node) {
      node.textContent = text;
    }
  }

  window.addEventListener("error", (event) => {
    const message = event?.error?.message || event?.message || "unknown error";
    if (RESIZE_OBSERVER_WARNINGS.has(message)) {
      event.preventDefault?.();
      return;
    }
    setStatus(`前端运行时错误：${message}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const message = reason?.message || reason?.error?.message || String(reason || "unknown rejection");
    if (RESIZE_OBSERVER_WARNINGS.has(message)) {
      event.preventDefault?.();
      return;
    }
    setStatus(`前端异步异常：${message}`);
  });

  function setTeachResult(text) {
    const next = String(text || "").trim();
    if (!next) {
      setPanelState("teach", "idle", "", "");
      updateTeachChrome();
      return;
    }
    const mode = /失败|error|未完成|未执行|没有可|先录制|先输入/i.test(next) ? "error" : "success";
    const title = mode === "error" ? "处理失败" : "当前进展";
    setPanelState("teach", mode, title, next);
    updateTeachChrome();
  }

  function setPanelState(viewName, mode = "idle", title = "", detail = "", actions = []) {
    if (!state.panelState[viewName]) {
      return;
    }
    state.panelState[viewName] = {
      mode: String(mode || "idle").trim() || "idle",
      title: String(title || "").trim(),
      detail: String(detail || "").trim(),
      actions: Array.isArray(actions)
        ? actions.filter((item) => item && typeof item.onClick === "function" && String(item.label || "").trim())
        : [],
    };
    renderPanelState(viewName);
    if (viewName === "teach") {
      updateTeachChrome();
    } else if (viewName === "results") {
      updateResultsLayout(state.lastAnalysis);
    }
  }

  function renderPanelState(viewName) {
    const node = document.getElementById(viewName === "results" ? "oa2-results-state" : "oa2-teach-result");
    if (!node) {
      return;
    }
    const payload = state.panelState[viewName] || { mode: "idle", title: "", detail: "", actions: [] };
    const mode = String(payload.mode || "idle").trim() || "idle";
    node.innerHTML = "";
    node.dataset.mode = mode;
    const shouldHide = mode === "idle" || (!payload.title && !payload.detail);
    node.classList.toggle("is-hidden", shouldHide);
    if (shouldHide) {
      return;
    }
    const title = document.createElement("div");
    title.className = "oa2-state-title";
    title.textContent = payload.title || (mode === "loading" ? "处理中" : mode === "error" ? "处理失败" : "已完成");
    const detail = document.createElement("div");
    detail.className = "oa2-state-detail";
    detail.textContent = payload.detail || "";
    node.appendChild(title);
    if (payload.detail) {
      node.appendChild(detail);
    }
    const actions = Array.isArray(payload.actions) ? payload.actions.filter(Boolean) : [];
    if (actions.length) {
      const actionRow = document.createElement("div");
      actionRow.className = "oa2-composer-actions";
      actions.forEach((action, index) => {
        const button = document.createElement("button");
        button.type = "button";
        const tone = String(action.tone || "").trim().toLowerCase();
        button.className = `oa2-btn${tone === "secondary" || (!tone && index > 0) ? " secondary" : tone === "warn" ? " warn" : ""}`;
        button.textContent = String(action.label || "").trim();
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          action.onClick();
        });
        actionRow.appendChild(button);
      });
      node.appendChild(actionRow);
    }
  }

  function setRecorderStatus(text) {
    ["oa2-recorder-status", "oa2-teach-recorder-status"].forEach((id) => {
      const node = document.getElementById(id);
      if (node) {
        node.textContent = text;
      }
    });
    const meta = document.getElementById("oa2-teach-recorder-meta");
    if (meta) {
      const stepCount = state.recorder.steps.length;
      const foldState = state.recorder.active ? "录制中" : stepCount ? "点击展开" : "暂无步骤";
      meta.textContent = `${stepCount} 步 · ${foldState}`;
    }
    updateTeachChrome();
  }

  function toggleTeachRecorderCard(forceOpen = null) {
    const card = document.getElementById("oa2-teach-recorder-card");
    if (!(card instanceof HTMLDetailsElement)) {
      return;
    }
    const hasRecorderActivity = Boolean(state.recorder.active || state.recorder.steps.length);
    if (!hasRecorderActivity && typeof forceOpen !== "boolean") {
      return;
    }
    if (typeof forceOpen === "boolean") {
      state.recorder.inspecting = forceOpen;
      card.open = forceOpen;
      return;
    }
    state.recorder.inspecting = !card.open;
    card.open = !card.open;
    updateTeachChrome();
  }

  function setRagStatus(text) {
    const node = document.getElementById("oa2-rag-status");
    if (node) {
      node.textContent = text;
    }
  }

  function setScopeText(text) {
    const node = document.getElementById("oa2-scope-text");
    if (node) {
      node.textContent = text;
    }
    updateAnalyzeButtonLabel();
  }

  async function hidePageAgentMaskIfPossible() {
    try {
      const controller = state.pageAgentNativeController;
      if (controller && typeof controller.hideMask === "function") {
        await controller.hideMask();
      }
    } catch (error) {
      console.warn("[OmniAgent] page-agent hideMask cleanup failed:", error);
    }
  }

  function updateAnalyzeButtonLabel() {
    const button = document.getElementById("oa2-analyze-btn");
    const hostText = document.getElementById("oa2-host-text");
    const hasScope = Boolean(getScopeRoot());
    if (button) {
      button.textContent = hasScope ? "开始分析区域" : "开始分析";
      button.title = `${hasScope ? "开始分析区域" : "开始分析"} (Ctrl/Cmd+Shift+A)`;
    }
    if (hostText) {
      hostText.textContent = `${location.host || "当前网页"} · ${hasScope ? "区域模式" : "整页模式"}`;
    }
    updateExecuteButtonState();
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      return true;
    }
    return target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") instanceof Element;
  }

  function getPrimaryExecuteActionState() {
    const directActions = Array.isArray(state.lastAnalysis?.browser_actions) ? state.lastAnalysis.browser_actions : [];
    if (directActions.length) {
      return { label: "执行当前动作", disabled: false };
    }
    const quickActions = getQuickActions(state.lastAnalysis);
    const runnableWorkflow = quickActions.find((item) => isWorkflowQuickAction(item) && Array.isArray(item.browser_actions) && item.browser_actions.length && !(Array.isArray(item.missing_parameters) && item.missing_parameters.length));
    if (runnableWorkflow) {
      return { label: "执行首选流程", disabled: false };
    }
    const runnableBrowserAction = quickActions.find((item) => item?.action_type === "execute_browser_actions" && Array.isArray(item.browser_actions) && item.browser_actions.length);
    if (runnableBrowserAction) {
      return { label: "执行首选动作", disabled: false };
    }
    const blockedWorkflow = quickActions.find((item) => isWorkflowQuickAction(item) && Array.isArray(item.missing_parameters) && item.missing_parameters.length);
    if (blockedWorkflow) {
      return { label: "补参数并执行", disabled: false };
    }
    return { label: "暂无可执行动作", disabled: true };
  }

  function updateExecuteButtonState() {
    const button = document.getElementById("oa2-execute-btn");
    if (!button) {
      return;
    }
    const next = getPrimaryExecuteActionState();
    button.textContent = next.label;
    button.disabled = Boolean(next.disabled);
  }

  function updateFieldToggle(total = 0) {
    const toggle = document.getElementById("oa2-fields-toggle");
    if (!toggle) {
      return;
    }
    if (total <= 3) {
      toggle.style.display = "none";
      return;
    }
    toggle.style.display = "inline";
    toggle.textContent = state.extractedExpanded ? "收起" : `展开全部 (${total})`;
  }

  function updateActionToggle(total = 0) {
    const toggle = document.getElementById("oa2-actions-toggle");
    if (!toggle) {
      return;
    }
    if (total <= 2) {
      toggle.style.display = "none";
      return;
    }
    toggle.style.display = "inline";
    toggle.textContent = state.actionsExpanded ? "收起" : `展开全部 (${total})`;
  }

  function switchView(viewName) {
    state.activeView = viewName;
    panel.dataset.view = viewName;
    panel.querySelectorAll(".oa2-view").forEach((node) => {
      node.classList.toggle("is-active", node.getAttribute("data-view") === viewName);
    });
    panel.querySelectorAll(".oa2-dock-btn").forEach((node) => {
      const action = node.getAttribute("data-action") || "";
      node.classList.toggle("is-active", action === `view-${viewName}`);
    });
    if (viewName !== "results") {
      closeMemoryPopover();
    }
    if (viewName === "teach") {
      renderTeachConversation();
    }
  }

  function setContextBar(result) {
    const contextBar = result?.context_bar || {};
    const personaChip = document.getElementById("oa2-persona-chip");
    const skillChip = document.getElementById("oa2-skill-chip");
    const memoryChip = document.getElementById("oa2-memory-chip");
    const hostText = document.getElementById("oa2-host-text");
    if (personaChip) {
      personaChip.textContent = contextBar.persona_label || result?.matched_persona || "客观总结助手";
      personaChip.title = contextBar.persona_id || "";
    }
    if (skillChip) {
      const firstMatchedSkill = (result?.matched_skills || [])[0];
      const fallbackLabel = (result?.matched_skills || []).length
        ? (typeof firstMatchedSkill === "string" ? firstMatchedSkill : firstMatchedSkill?.title || "通用分析")
        : "通用分析";
      const contextLabel = String(contextBar.skill_label || "").trim();
      const matchedDomain = String(result?.matched_domain || "").trim();
      const shouldPreferMatched =
        (!contextLabel || contextLabel === "未加载技能" || contextLabel === "通用分析") &&
        ((matchedDomain && matchedDomain !== "未加载技能") || (result?.matched_skills || []).length);
      const label = shouldPreferMatched ? (matchedDomain && matchedDomain !== "未加载技能" ? matchedDomain : fallbackLabel) : (contextLabel || matchedDomain || fallbackLabel);
      skillChip.textContent = label;
      const titles = Array.isArray(contextBar.skill_titles) ? contextBar.skill_titles.filter(Boolean) : [];
      skillChip.title = titles.length ? titles.join(" / ") : contextBar.skill_id || label;
    }
    if (memoryChip) {
      memoryChip.textContent = contextBar.memory_label || `记忆 ${(result?.memory_hits || []).length}`;
      memoryChip.style.visibility = result?.memory_hits?.length ? "visible" : "visible";
    }
    if (hostText) {
      const host = contextBar.host || location.host;
      const scopeLabel = getScopeRoot() ? "区域模式" : "整页模式";
      hostText.textContent = `${host || "当前网页"} · ${scopeLabel}`;
    }
    renderMemoryPopover(result?.memory_hits || []);
  }

  function logAnalyzeDecisionTrace(result) {
    const debugMeta = result?.debug_meta || {};
    const routeTrace = result?.route_trace || {};
    const gatewayPersonas = Array.isArray(debugMeta.gateway_personas) ? debugMeta.gateway_personas : [];
    const candidateSkills = Array.isArray(debugMeta.candidate_skills)
      ? debugMeta.candidate_skills
      : Array.isArray(routeTrace.candidate_skills)
        ? routeTrace.candidate_skills
        : [];
    const matchedSkills = Array.isArray(result?.matched_skills) ? result.matched_skills : [];
    const gatewaySummary = gatewayPersonas.length
      ? gatewayPersonas.map((item) => item.name || item.persona_id || "unknown").join(" / ")
      : "无";
    setStatus(`网关候选角色：${gatewaySummary}`);
    if (candidateSkills.length) {
      const skillSummary = candidateSkills
        .slice(0, 3)
        .map((item) => {
          const hits = []
            .concat(Array.isArray(item.strong_hits) ? item.strong_hits.slice(0, 2) : [])
            .concat(Array.isArray(item.weak_hits) ? item.weak_hits.slice(0, 1) : []);
          return `${item.title || item.skill_id}(score=${item.score ?? "?"}${hits.length ? `; hits=${hits.join(",")}` : ""})`;
        })
        .join(" | ");
      setStatus(`本地召回技能：${skillSummary}`);
    } else {
      setStatus("本地召回技能：无");
    }
    const roleRouterReason = String(routeTrace.role_router_reason || "").trim();
    const sopRouterReason = String(routeTrace.sop_router_reason || "").trim();
    if (roleRouterReason) {
      setStatus(`角色裁决理由：${roleRouterReason}`);
    }
    if (sopRouterReason) {
      setStatus(`SOP 裁决理由：${sopRouterReason}`);
    }
    if ((debugMeta.router_reason || routeTrace.router_reason) && !roleRouterReason && !sopRouterReason) {
      setStatus(`路由理由：${debugMeta.router_reason || routeTrace.router_reason}`);
    }
    const workflowSelectionSource = String(debugMeta.workflow_selection_source || "").trim();
    const selectedWorkflowIds = Array.isArray(debugMeta.selected_workflow_ids) ? debugMeta.selected_workflow_ids.filter(Boolean) : [];
    const workflowSelectionReason = String(debugMeta.workflow_selection_reason || "").trim();
    if (workflowSelectionSource || selectedWorkflowIds.length) {
      const sourceLabel =
        workflowSelectionSource === "analyzer"
          ? "analyzer"
          : workflowSelectionSource === "router"
            ? "workflow-router"
            : workflowSelectionSource === "code_ranker"
              ? "code-ranker"
              : workflowSelectionSource || "unknown";
      setStatus(`Workflow 选择：source=${sourceLabel}${selectedWorkflowIds.length ? ` | ids=${selectedWorkflowIds.join(",")}` : ""}`);
      if (workflowSelectionReason) {
        setStatus(`Workflow 选择理由：${workflowSelectionReason}`);
      }
    }
    if (debugMeta.vision_requested && debugMeta.vision_model_available === false) {
      setStatus("视觉状态：当前启用模型链不支持视觉解析，本次只能保留文本/结构上下文。");
    }
    const matchedSummary = matchedSkills.length
      ? matchedSkills.map((item) => (typeof item === "string" ? item : item.title || item.skill_id || "unknown")).join(" / ")
      : "未加载技能";
    setStatus(`最终命中：角色=${result?.matched_persona || "客观总结助手"} | 技能=${matchedSummary}`);
  }

  function renderMemoryPopover(hits) {
    const node = document.getElementById("oa2-memory-hits-pop");
    if (!node) {
      return;
    }
    node.innerHTML = "";
    if (!hits.length) {
      node.classList.remove("open");
      state.memoryPopoverOpen = false;
      return;
    }
    const title = document.createElement("div");
    title.className = "oa2-card-title";
    title.textContent = "本次命中的长期记忆";
    node.appendChild(title);
    const list = document.createElement("div");
    list.className = "oa2-memory-pop-list";
    hits.forEach((item) => {
      const child = document.createElement("div");
      child.className = "oa2-memory-pop-item";
      const kindLabel =
        item.kind === "structured"
          ? "流程"
          : item.kind === "query_template"
            ? "查询模板"
            : item.kind === "document"
              ? "文档"
              : "记忆";
      child.textContent = `${kindLabel} · ${item.name}${item.summary ? ` | ${item.summary}` : ""}`;
      list.appendChild(child);
    });
    node.appendChild(list);
    node.classList.toggle("open", state.memoryPopoverOpen);
  }

  function updateResultsLayout(result) {
    const idleCard = document.getElementById("oa2-idle-card");
    const resultsStateCard = document.getElementById("oa2-results-state");
    const summaryCard = document.getElementById("oa2-summary-card");
    const nextCard = document.getElementById("oa2-next-card");
    const actionsCard = document.getElementById("oa2-actions-card");
    const evidenceCard = document.getElementById("oa2-evidence-card");
    const fieldsCard = document.getElementById("oa2-fields-card");
    const evidenceMeta = document.getElementById("oa2-evidence-meta");
    const fieldsMeta = document.getElementById("oa2-fields-meta");
    const hasResult = Boolean(result && (result.summary || result.matched_domain || (result.evidence_items || []).length));
    const hasActions = Boolean(
      result &&
        (
          (result.quick_actions || result.suggested_actions || []).length ||
          (result.action_links || []).length ||
          (result.query_recommendations || []).length ||
          (result.browser_actions || []).length
        )
    );
    const hasEvidence = Boolean(result && (result.evidence_items || []).length);
    const extracted = result?.extracted_fields || {};
    const visibleFieldCount = Object.keys(extracted).filter((key) => !["page_url", "page_title", "page_host"].includes(key) && extracted[key]).length;
    const resultsStateMode = String(state.panelState?.results?.mode || "idle").trim();
    const hasResultsState = resultsStateMode !== "idle";
    if (evidenceMeta) {
      evidenceMeta.textContent = `${(result?.evidence_items || []).length} 条`;
    }
    if (fieldsMeta) {
      fieldsMeta.textContent = `${visibleFieldCount} 项`;
    }
    if (idleCard) {
      idleCard.classList.toggle("is-hidden", hasResult || hasResultsState);
    }
    if (resultsStateCard) {
      resultsStateCard.classList.toggle("is-hidden", !hasResultsState);
    }
    if (summaryCard) {
      summaryCard.classList.toggle("is-hidden", !hasResult);
    }
    if (nextCard) {
      nextCard.classList.toggle("is-hidden", !hasResult && !hasActions);
    }
    if (actionsCard) {
      actionsCard.classList.toggle("is-hidden", !hasActions);
    }
    if (evidenceCard) {
      evidenceCard.classList.toggle("is-hidden", !hasEvidence);
      if (!hasEvidence) {
        evidenceCard.open = false;
      }
    }
    if (fieldsCard) {
      fieldsCard.classList.toggle("is-hidden", !visibleFieldCount);
      if (!visibleFieldCount) {
        fieldsCard.open = false;
      }
    }
    updateExecuteButtonState();
  }

  function toggleMemoryPopover() {
    if (!(state.lastAnalysis?.memory_hits || []).length) {
      setStatus("当前分析没有命中长期记忆。");
      return;
    }
    state.memoryPopoverOpen = !state.memoryPopoverOpen;
    document.getElementById("oa2-memory-hits-pop").classList.toggle("open", state.memoryPopoverOpen);
  }

  function closeMemoryPopover() {
    state.memoryPopoverOpen = false;
    const node = document.getElementById("oa2-memory-hits-pop");
    if (node) {
      node.classList.remove("open");
    }
  }

  function getQuickActions(result) {
    if (Array.isArray(result?.quick_actions)) {
      return result.quick_actions;
    }
    if (Array.isArray(result?.suggested_actions)) {
      return result.suggested_actions;
    }
    return [];
  }

  function isWorkflowQuickAction(action) {
    const actionType = String(action?.action_type || "").trim();
    return actionType === "execute_workflow" || actionType === "execute_sop";
  }

  function getTeachContextKey() {
    const currentKey = buildContextKey(pickText());
    return currentKey || state.lastContextKey;
  }

  function getAnalysisForContext(contextKey = getTeachContextKey()) {
    if (!contextKey) {
      return null;
    }
    const contextual = state.sessionByContext.get(contextKey);
    if (contextual) {
      return contextual;
    }
    if (state.lastAnalysis?.context_key === contextKey) {
      return state.lastAnalysis;
    }
    return null;
  }

  async function buildCurrentVisualContext(contextKey = getTeachContextKey()) {
    const media = contextKey ? state.analysisContextMediaByContext.get(contextKey) : null;
    if (media) {
      return {
        images: Array.isArray(media.images) ? media.images.slice() : [],
        image_meta: media.image_meta ? { ...media.image_meta } : {},
        browser_state: media.browser_state ? { ...media.browser_state } : {},
        dom_candidates: Array.isArray(media.dom_candidates) ? media.dom_candidates.slice() : [],
      };
    }
    try {
      const text = pickText();
      const pageState = await captureActionablePageState(text);
      const domCandidates = pageState.dom_candidates;
      const browserState = pageState.browser_state;
      const captured = await captureContextImage(text);
      const images = captured?.image ? [captured.image] : [];
      const image_meta = {
        source: captured?.source || "none",
        image_count: Number(captured?.image_count || 0),
        embedded_image_count: Number(captured?.embedded_image_count || 0),
        inlined_image_count: Number(captured?.inlined_image_count || 0),
        snapshot_kind: String(captured?.snapshot_kind || "none"),
        visual_grounded: Boolean(captured?.visual_grounded),
        visual_partial: Boolean(captured?.visual_partial),
        selection_desc: String(captured?.selection_desc || ""),
      };
      if (contextKey) {
        state.analysisContextMediaByContext.set(contextKey, {
          context_key: contextKey,
          images: images.slice(),
          image_meta: { ...image_meta },
          browser_state: { ...browserState },
          dom_candidates: domCandidates.slice(),
        });
      }
      return { images, image_meta, browser_state: browserState, dom_candidates: domCandidates };
    } catch (error) {
      return { images: [], image_meta: {}, browser_state: collectBrowserState([], pickText()), dom_candidates: [] };
    }
  }

  function getTeachMessages(contextKey = getTeachContextKey()) {
    return state.teachMessagesByContext.get(contextKey) || [];
  }

  function setTeachMessages(messages, contextKey = getTeachContextKey()) {
    state.teachMessagesByContext.set(contextKey, Array.isArray(messages) ? messages.slice(-20) : []);
    updateTeachChrome(contextKey);
  }

  function cloneWorkflowSteps(steps) {
    return JSON.parse(JSON.stringify(Array.isArray(steps) ? steps : []));
  }

  function collectWorkflowPlaceholders(node, found = []) {
    const pattern = /(?<!\{)\{([A-Za-z0-9_]+)\}(?!\})/g;
    if (typeof node === "string") {
      for (const match of node.matchAll(pattern)) {
        const name = String(match?.[1] || "").trim();
        if (name && !found.includes(name)) {
          found.push(name);
        }
      }
      return found;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => collectWorkflowPlaceholders(item, found));
      return found;
    }
    if (node && typeof node === "object") {
      Object.values(node).forEach((value) => collectWorkflowPlaceholders(value, found));
    }
    return found;
  }

  function humanizeWorkflowParameterLabel(name) {
    const normalized = String(name || "").trim();
    if (!normalized) {
      return "参数";
    }
    const explicitLabels = {
      url: "接口路径",
      page_url: "页面路径",
      file_md5: "文件 MD5",
      md5: "MD5",
      sha256: "SHA256",
      file_path: "文件路径",
      process_name: "进程名",
      payload: "Payload",
      impact: "影响说明",
      status: "状态",
      priority: "优先级",
      severity: "风险等级",
      level: "等级",
      start_time: "开始时间",
      assignee: "负责人",
      owner: "处理人",
      reviewer: "复核人",
      keyword: "关键词",
      kind: "类型",
      type: "类型",
      triage_verdict: "初判结论",
      review_decision: "复核结论",
      note: "备注",
      comment: "备注",
      reason: "说明",
      description: "说明",
      triage_note: "补充说明",
      pending_items: "待补信息",
    };
    if (explicitLabels[normalized]) {
      return explicitLabels[normalized];
    }
    const parts = normalized.split(/[_\-\s]+/).filter(Boolean);
    if (!parts.length) {
      return normalized;
    }
    return parts
      .map((part) => (/^[A-Z0-9]+$/.test(part) ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
      .join(" ");
  }

  function workflowParameterNameTokens(name) {
    return new Set(
      String(name || "")
        .trim()
        .toLowerCase()
        .split(/[_\-\s]+/)
        .map((part) => part.trim())
        .filter(Boolean)
    );
  }

  function normalizeWorkflowParameterOptions(options) {
    const normalized = [];
    const seen = new Set();
    (Array.isArray(options) ? options : []).forEach((item) => {
      const label = String(item?.label || item?.text || item?.value || item || "").replace(/\s+/g, " ").trim();
      const value = String(item?.value || item?.label || item?.text || item || "").replace(/\s+/g, " ").trim();
      const normalizedLabel = label.toLowerCase();
      const normalizedValue = value.toLowerCase();
      if (
        !label
        || !value
        || seen.has(normalizedValue)
        || label.length > 80
        || value.length > 120
        || /^[\W_]+$/.test(label)
        || /^[\W_]+$/.test(value)
        || ["null", "undefined", "n/a", "na", "none"].includes(normalizedLabel)
        || ["null", "undefined", "n/a", "na", "none"].includes(normalizedValue)
        || /^(请选择|请先选择|请选择\.\.\.|请输入|输入或选择|点击选择|搜索|搜索\.\.\.|select|choose)(.*)$/i.test(label)
        || /^(请选择|请先选择|请选择\.\.\.|请输入|输入或选择|点击选择|搜索|搜索\.\.\.|select|choose)(.*)$/i.test(value)
      ) {
        return;
      }
      seen.add(normalizedValue);
      normalized.push({ label, value });
    });
    return normalized;
  }

  function workflowParameterOptionSignature(semanticKey, option) {
    if (!semanticKey || !option || typeof option !== "object") {
      return "";
    }
    const label = String(option.label || "").trim().toLowerCase();
    const value = String(option.value || "").trim().toLowerCase();
    const sample = `${label} ${value}`.trim();
    if (!sample) {
      return "";
    }
    const signatureAliases = {
      status: {
        pending: ["pending", "待处理", "待办", "open", "todo"],
        in_progress: ["in_progress", "processing", "处理中", "进行中"],
        blocked: ["blocked", "已阻塞", "阻塞", "挂起", "暂停"],
        done: ["done", "completed", "已完成", "完成", "closed", "关闭"],
      },
      priority: {
        low: ["low", "低"],
        medium: ["medium", "中", "normal", "普通"],
        high: ["high", "高"],
        critical: ["critical", "紧急", "urgent", "最高", "严重"],
      },
      triage_verdict: {
        "真实风险": ["真实风险", "更像真实风险", "confirmed", "real_risk"],
        "待补查": ["待补查", "仍需补查", "needs_followup", "follow_up"],
        "疑似误报": ["疑似误报", "更像疑似误报", "false_positive"],
      },
      review_decision: {
        "可复现待确认影响": ["可复现待确认影响", "可复现，需继续确认影响"],
        "信息不足待补充": ["信息不足待补充", "信息不足，需补充说明"],
        "低风险或误报": ["低风险或误报", "更像低风险或误报"],
      },
    };
    const aliases = signatureAliases[semanticKey] || {};
    for (const [canonical, values] of Object.entries(aliases)) {
      if (values.some((alias) => sample.includes(String(alias).toLowerCase()))) {
        return canonical;
      }
    }
    return "";
  }

  function mergeWorkflowParameterOptions(semanticKey, ...optionGroups) {
    const merged = [];
    const signatureIndex = new Map();
    const exactValues = new Set();
    optionGroups.forEach((group) => {
      normalizeWorkflowParameterOptions(group).forEach((item) => {
        const valueKey = String(item?.value || "").trim().toLowerCase();
        if (!valueKey) {
          return;
        }
        const signature = workflowParameterOptionSignature(semanticKey, item);
        if (signature && signatureIndex.has(signature)) {
          merged[signatureIndex.get(signature)] = item;
          exactValues.add(valueKey);
          return;
        }
        if (exactValues.has(valueKey)) {
          return;
        }
        exactValues.add(valueKey);
        merged.push(item);
        if (signature) {
          signatureIndex.set(signature, merged.length - 1);
        }
      });
    });
    return merged;
  }

  function workflowParameterContextBlob(contexts = []) {
    return contexts
      .map((item) => [item.target_desc, item.field_name, item.selector, item.input_type, item.role].filter(Boolean).join(" "))
      .join(" ")
      .toLowerCase();
  }

  function workflowParameterSemanticKey(name, contexts = []) {
    const normalized = String(name || "").trim().toLowerCase();
    const tokens = workflowParameterNameTokens(normalized);
    const contextBlob = workflowParameterContextBlob(contexts);
    if (["file_md5", "md5"].includes(normalized) || tokens.has("md5") || /md5|hash/.test(contextBlob) || tokens.has("hash")) {
      return "md5";
    }
    if (normalized === "sha256" || tokens.has("sha256") || contextBlob.includes("sha256")) {
      return "sha256";
    }
    if (["url", "page_url"].includes(normalized) || tokens.has("url") || /接口|链接/.test(contextBlob)) {
      return "url";
    }
    if ((tokens.has("file") && tokens.has("path")) || contextBlob.includes("文件路径")) {
      return "file_path";
    }
    if (tokens.has("process") || contextBlob.includes("进程")) {
      return "process_name";
    }
    if (tokens.has("date") || contextBlob.includes("日期")) {
      return "date";
    }
    if (tokens.has("time") || contextBlob.includes("时间")) {
      return "time";
    }
    if (tokens.has("status") || contextBlob.includes("状态")) {
      return "status";
    }
    if (["priority", "severity", "level"].some((token) => tokens.has(token)) || /优先级|风险等级/.test(contextBlob) || contextBlob.endsWith("等级")) {
      return "priority";
    }
    if (normalized === "triage_verdict" || (tokens.has("triage") && tokens.has("verdict")) || contextBlob.includes("初判结论")) {
      return "triage_verdict";
    }
    if (normalized === "review_decision" || (tokens.has("review") && tokens.has("decision")) || contextBlob.includes("复核结论")) {
      return "review_decision";
    }
    if (["kind", "type"].includes(normalized) || contextBlob.includes("类型")) {
      return "kind";
    }
    if (["assignee", "owner", "reviewer"].includes(normalized)) {
      return normalized;
    }
    if (contextBlob.includes("负责人")) {
      return "assignee";
    }
    if (contextBlob.includes("处理人")) {
      return "owner";
    }
    if (contextBlob.includes("复核人")) {
      return "reviewer";
    }
    if (["note", "comment", "reason", "description", "payload", "impact", "pending", "remark"].some((token) => normalized.includes(token))) {
      return "note";
    }
    if (/(备注|说明|描述|payload|影响)/.test(contextBlob)) {
      return "note";
    }
    return "";
  }

  function workflowParameterDefaultOptions(semanticKey) {
    if (semanticKey === "priority") {
      return [
        { label: "低", value: "low" },
        { label: "中", value: "medium" },
        { label: "高", value: "high" },
        { label: "紧急", value: "critical" },
      ];
    }
    if (semanticKey === "status") {
      return [
        { label: "待处理", value: "pending" },
        { label: "处理中", value: "in_progress" },
        { label: "已阻塞", value: "blocked" },
        { label: "已完成", value: "done" },
      ];
    }
    if (semanticKey === "triage_verdict") {
      return [
        { label: "更像真实风险", value: "真实风险" },
        { label: "仍需补查", value: "待补查" },
        { label: "更像疑似误报", value: "疑似误报" },
      ];
    }
    if (semanticKey === "review_decision") {
      return [
        { label: "可复现，需继续确认影响", value: "可复现待确认影响" },
        { label: "信息不足，需补充说明", value: "信息不足待补充" },
        { label: "更像低风险或误报", value: "低风险或误报" },
      ];
    }
    return [];
  }

  function lookupWorkflowParameterDefault(name, extractedFields = {}, contexts = []) {
    const normalized = String(name || "").trim();
    if (!normalized || !extractedFields || typeof extractedFields !== "object") {
      return "";
    }
    const exactValue = extractedFields[normalized];
    if (exactValue !== undefined && exactValue !== null && String(exactValue).trim()) {
      return String(exactValue);
    }
    const semanticKey = workflowParameterSemanticKey(normalized, contexts);
    if (!semanticKey) {
      return "";
    }
    const normalizedTokens = workflowParameterNameTokens(normalized);
    let bestValue = "";
    let bestScore = -1;
    Object.entries(extractedFields).forEach(([rawKey, rawValue]) => {
      if (rawValue === undefined || rawValue === null || !String(rawValue).trim()) {
        return;
      }
      const candidateKey = String(rawKey || "").trim();
      if (!candidateKey || workflowParameterSemanticKey(candidateKey) !== semanticKey) {
        return;
      }
      const candidateTokens = workflowParameterNameTokens(candidateKey);
      let score = 10 + Array.from(normalizedTokens).filter((token) => candidateTokens.has(token)).length * 4;
      if (candidateKey.toLowerCase() === normalized.toLowerCase()) {
        score += 100;
      }
      if (candidateTokens.size === normalizedTokens.size && Array.from(candidateTokens).every((token) => normalizedTokens.has(token))) {
        score += 30;
      }
      if (candidateTokens.has(semanticKey)) {
        score += 6;
      }
      if (score > bestScore) {
        bestScore = score;
        bestValue = String(rawValue);
      }
    });
    return bestValue;
  }

  function buildWorkflowParameterField(name, extractedFields = {}) {
    const normalized = String(name || "").trim();
    const label = humanizeWorkflowParameterLabel(normalized);
    const lowered = normalized.toLowerCase();
    const tokens = workflowParameterNameTokens(normalized);
    const semanticKey = workflowParameterSemanticKey(normalized, []);
    const entry = {
      name: normalized,
      label,
      placeholder: `请输入${label}`,
      required: true,
      type: "text",
    };
    const isPriorityLike = ["priority", "severity", "level"].some((token) => tokens.has(token));
    const isStatusLike = tokens.has("status");
    const isTriageVerdictLike = lowered === "triage_verdict" || (tokens.has("triage") && tokens.has("verdict"));
    const isReviewDecisionLike = lowered === "review_decision" || (tokens.has("review") && tokens.has("decision"));
    if (isPriorityLike) {
      entry.type = "select";
      entry.options = workflowParameterDefaultOptions("priority");
      entry.help_text = "请选择更接近当前流程的等级。";
    } else if (isStatusLike) {
      entry.type = "select";
      entry.options = workflowParameterDefaultOptions("status");
      entry.help_text = "可用于工单、任务或复核流程状态。";
    } else if (isTriageVerdictLike) {
      entry.type = "select";
      entry.options = workflowParameterDefaultOptions("triage_verdict");
      entry.help_text = "用于区分真实风险、待补查和疑似误报。";
    } else if (isReviewDecisionLike) {
      entry.type = "select";
      entry.options = workflowParameterDefaultOptions("review_decision");
      entry.help_text = "用于沉淀当前复核结论，便于继续核验。";
    } else if (["kind", "type"].includes(lowered)) {
      entry.type = "select";
    }
    if (["note", "comment", "reason", "description", "payload", "impact", "pending", "remark"].some((token) => lowered.includes(token))) {
      entry.type = "textarea";
      entry.min_length = lowered.includes("impact") ? 2 : 4;
    }
    if (["file_md5", "md5"].includes(lowered)) {
      entry.pattern = "^[A-Fa-f0-9]{32}$";
      entry.validation_message = "请输入 32 位 MD5。";
      entry.help_text = "示例：44d88612fea8a8f36de82e1278abb02f";
    } else if (lowered === "sha256") {
      entry.pattern = "^[A-Fa-f0-9]{64}$";
      entry.validation_message = "请输入 64 位 SHA256。";
    } else if (["url", "page_url"].includes(lowered)) {
      entry.min_length = 2;
      entry.help_text = "可填写 /login 或完整 URL。";
    } else if (tokens.has("date")) {
      entry.pattern = "^\\d{4}-\\d{2}-\\d{2}$";
      entry.validation_message = "请输入 YYYY-MM-DD 格式的日期。";
      entry.help_text = "示例：2026-04-25";
    } else if (tokens.has("time")) {
      entry.pattern = "^(?:[01]\\d|2[0-3]):[0-5]\\d$";
      entry.validation_message = "请输入 24 小时制 HH:MM 格式的时间。";
      entry.help_text = "示例：09:30";
    } else if (lowered === "file_path") {
      entry.min_length = 3;
      entry.help_text = "示例：C:/temp/sample.exe";
    } else if (lowered === "process_name") {
      entry.min_length = 2;
      entry.help_text = "示例：powershell.exe";
    }
    const defaultValue = lookupWorkflowParameterDefault(normalized, extractedFields, []);
    if (defaultValue !== undefined && defaultValue !== null && String(defaultValue).trim()) {
      entry.default_value = String(defaultValue);
    }
    if (entry.type === "select" && entry.default_value) {
      const defaultSignature = workflowParameterOptionSignature(semanticKey, {
        label: String(entry.default_value),
        value: String(entry.default_value),
      });
      const matchedOption = defaultSignature
        ? (entry.options || []).find((item) => workflowParameterOptionSignature(semanticKey, item) === defaultSignature)
        : null;
      if (matchedOption?.value) {
        entry.default_value = String(matchedOption.value);
      } else {
        entry.options = mergeWorkflowParameterOptions(
          semanticKey,
          entry.options || [],
          [{ label: String(entry.default_value), value: String(entry.default_value) }]
        );
      }
    }
    return entry;
  }

  function collectWorkflowPlaceholderContexts(node, contexts = {}, inherited = {}) {
    if (Array.isArray(node)) {
      node.forEach((item) => collectWorkflowPlaceholderContexts(item, contexts, inherited));
      return contexts;
    }
    if (!node || typeof node !== "object") {
      return contexts;
    }
    const local = {
      step_type: String(node.source_action_type || getWorkflowStepType(node) || inherited.step_type || "").trim().toLowerCase(),
      target_desc: String(node.target_desc || node.label || node.field_name || inherited.target_desc || "").trim(),
      field_name: String(node.field_name || inherited.field_name || "").trim(),
      selector: String(node.selector || inherited.selector || "").trim(),
      input_type: String(node.input_type || inherited.input_type || "").trim().toLowerCase(),
      role: String(node.role || inherited.role || "").trim().toLowerCase(),
      option_candidates: Array.isArray(node.option_candidates) ? node.option_candidates.slice() : (Array.isArray(inherited.option_candidates) ? inherited.option_candidates.slice() : []),
    };
    Object.values(node).forEach((value) => {
      if (typeof value === "string") {
        collectWorkflowPlaceholders(value, []).forEach((placeholder) => {
          contexts[placeholder] = contexts[placeholder] || [];
          contexts[placeholder].push({ ...local });
        });
      }
    });
    Object.values(node).forEach((value) => {
      if (value && typeof value === "object") {
        collectWorkflowPlaceholderContexts(value, contexts, local);
      }
    });
    return contexts;
  }

  function buildWorkflowParameterFieldFromContext(name, extractedFields = {}, contexts = []) {
    const entry = buildWorkflowParameterField(name, extractedFields);
    const technicalLabelsPreferred = new Set(["file_md5", "md5", "sha256", "file_path", "process_name", "url", "page_url", "payload", "impact"]);
    const contextBlob = workflowParameterContextBlob(contexts);
    const semanticKey = workflowParameterSemanticKey(name, contexts);
    const contextOptionCandidates = normalizeWorkflowParameterOptions(contexts.flatMap((item) => (Array.isArray(item.option_candidates) ? item.option_candidates : [])));
    const preferredLabel = contexts
      .map((item) => String(item.target_desc || item.field_name || "").trim().replace(/(输入框|下拉框|文本框|选择框|组合框|搜索框|按钮|字段)$/g, "").trim())
      .find(Boolean);
    if (preferredLabel && !technicalLabelsPreferred.has(String(name || "").trim())) {
      entry.label = preferredLabel;
      entry.placeholder = `请输入${preferredLabel}`;
    }
    if (contexts.some((item) => item.step_type === "select" || ["combobox", "listbox", "option"].includes(item.role)) || /(下拉|选择|状态|类型|优先级|负责人|处理人|复核人|结论)/.test(contextBlob)) {
      entry.type = "select";
    }
    if (/(备注|说明|描述|payload|影响)/.test(contextBlob)) {
      entry.type = "textarea";
      entry.min_length = Math.max(Number(entry.min_length || 0), /影响/.test(contextBlob) ? 2 : 4);
    }
    const tokens = workflowParameterNameTokens(name);
    if ((tokens.has("date") || /日期/.test(contextBlob)) && !entry.pattern) {
      entry.pattern = "^\\d{4}-\\d{2}-\\d{2}$";
      entry.validation_message = "请输入 YYYY-MM-DD 格式的日期。";
      entry.help_text = entry.help_text || "示例：2026-04-25";
    }
    if ((tokens.has("time") || /时间/.test(contextBlob)) && !entry.pattern) {
      entry.pattern = "^(?:[01]\\d|2[0-3]):[0-5]\\d$";
      entry.validation_message = "请输入 24 小时制 HH:MM 格式的时间。";
      entry.help_text = entry.help_text || "示例：09:30";
    }
    if (contextOptionCandidates.length) {
      entry.options = mergeWorkflowParameterOptions(semanticKey, entry.options || [], contextOptionCandidates);
    }
    const defaultValue = lookupWorkflowParameterDefault(name, extractedFields, contexts);
    if (defaultValue) {
      entry.default_value = defaultValue;
      if (entry.type === "select") {
        const defaultSignature = workflowParameterOptionSignature(semanticKey, {
          label: defaultValue,
          value: defaultValue,
        });
        const matchedOption = defaultSignature
          ? (entry.options || []).find((item) => workflowParameterOptionSignature(semanticKey, item) === defaultSignature)
          : null;
        if (matchedOption?.value) {
          entry.default_value = String(matchedOption.value);
        } else {
          entry.options = mergeWorkflowParameterOptions(
            semanticKey,
            entry.options || [],
            [{ label: defaultValue, value: defaultValue }]
          );
        }
      }
    }
    return entry;
  }

  function extractSelectOptionCandidates(element, limit = 8) {
    const resolved = resolveSelectLikeTarget(element instanceof Element ? element : null);
    if (!resolved?.control) {
      return [];
    }
    let rawOptions = [];
    if (resolved.kind === "native_select" && resolved.control instanceof HTMLSelectElement) {
      rawOptions = Array.from(resolved.control.options || []).map((option) => ({
        label: String(option.textContent || option.label || option.value || "").trim(),
        value: String(option.value || option.textContent || "").trim(),
      }));
    } else if (resolved.kind === "datalist_input" && resolved.control instanceof HTMLInputElement && resolved.control.list instanceof HTMLDataListElement) {
      rawOptions = Array.from(resolved.control.list.options || []).map((option) => ({
        label: String(option.label || option.value || option.textContent || "").trim(),
        value: String(option.value || option.label || option.textContent || "").trim(),
      }));
    } else {
      const listbox = resolved.kind === "listbox" ? resolved.control : findAssociatedListbox(resolved.control);
      if (listbox instanceof Element) {
        rawOptions = Array.from(listbox.querySelectorAll("[role='option'], option")).map((option) => ({
          label: String(option.textContent || option.getAttribute("aria-label") || option.getAttribute("data-label") || option.getAttribute("value") || "").trim(),
          value: String(option.getAttribute("value") || option.getAttribute("data-value") || option.textContent || option.getAttribute("aria-label") || "").trim(),
        }));
      }
    }
    return normalizeWorkflowParameterOptions(rawOptions).slice(0, Math.max(1, Number(limit) || 8));
  }

  function inferWorkflowStepOptionCandidates(step) {
    if (getWorkflowStepType(step) !== "select" || (Array.isArray(step?.option_candidates) && step.option_candidates.length)) {
      return Array.isArray(step?.option_candidates) ? normalizeWorkflowParameterOptions(step.option_candidates) : [];
    }
    const resolvedElement = resolveActionElement(step) || resolveElementByDescription(step);
    return extractSelectOptionCandidates(resolvedElement);
  }

  function buildWorkflowParameterFields(names, extractedFields = {}, steps = []) {
    const contexts = collectWorkflowPlaceholderContexts(steps, {});
    return Array.from(new Set((Array.isArray(names) ? names : []).map((item) => String(item || "").trim()).filter(Boolean)))
      .map((name) => buildWorkflowParameterFieldFromContext(name, extractedFields, contexts[name] || []));
  }

  function buildParameterizedWorkflowDraftSteps(steps, extractedFields = {}) {
    const normalizedSteps = pickPreferredWorkflowSteps(steps, []);
    if (!normalizedSteps.length) {
      return normalizedSteps;
    }
    const firstStepType = getWorkflowStepType(normalizedSteps[0]);
    if (firstStepType === "ask_human" && Array.isArray(normalizedSteps[0]?.input_fields) && normalizedSteps[0].input_fields.length) {
      return normalizedSteps;
    }
    const placeholders = collectWorkflowPlaceholders(normalizedSteps, []);
    if (!placeholders.length) {
      return normalizedSteps;
    }
    return [
      {
        type: "ask_human",
        question: `执行流程前，请先确认这 ${placeholders.length} 个可变参数。`,
        reason: "这条流程来自录制步骤，里面包含可复用占位参数；先确认参数，再继续执行会更稳定。",
        suggested_action: "可直接沿用默认值，也可以按当前页面改成新的参数。",
        confirm_label: "继续执行",
        cancel_label: "先取消",
        input_fields: buildWorkflowParameterFields(placeholders, extractedFields, normalizedSteps),
        options: [
          {
            id: "continue",
            label: "继续执行",
            value: "continue",
            branch_steps: normalizedSteps,
            replace_remaining: true,
          },
          {
            id: "cancel",
            label: "先取消",
            value: "cancel",
            replace_remaining: true,
          },
        ],
      },
    ];
  }

  function getWorkflowStepType(step) {
    return String(step?.type || step?.action || "").trim().toLowerCase();
  }

  function getWorkflowStepTargetLabel(step) {
    if (!step || typeof step !== "object") {
      return "目标";
    }
    if (getWorkflowStepType(step) === PAGE_AGENT_TASK_STEP_TYPE) {
      const instruction = String(step.instruction || step.message || "").trim();
      if (instruction) {
        return instruction;
      }
    }
    if (typeof step.target === "string" && step.target.trim()) {
      return step.target.trim();
    }
    if (step.target && typeof step.target === "object") {
      const targetDesc = String(step.target.description || step.target.selector || step.target.text_anchor || "").trim();
      if (targetDesc) {
        return targetDesc;
      }
    }
    return step.target_desc || step.label || step.selector || step.element_id || "目标";
  }

  function isExecutableWorkflowStep(step) {
    if (!step || typeof step !== "object") {
      return false;
    }
    const type = getWorkflowStepType(step);
    if (!type) {
      return false;
    }
    if (type === PAGE_AGENT_TASK_STEP_TYPE) {
      return Boolean(String(step.instruction || "").trim());
    }
    if (type === "wait") {
      return true;
    }
    if (type === "ask_human") {
      return Boolean(
        String(step.message || "").trim()
        || String(step.question || "").trim()
        || String(step.reason || "").trim()
      );
    }
    if (type === "fill_form") {
      const fields = Array.isArray(step.fields) ? step.fields : [];
      return fields.length > 0 && fields.every((field) => isExecutableWorkflowStep({
        ...field,
        type: String(field?.type || (isSelectLikeFieldMeta(field) ? "select" : "fill")).trim().toLowerCase(),
      }));
    }
    if (type === "press_key") {
      if (!String(step.key || step.value || "").trim()) {
        return false;
      }
    } else if (!["click", "fill", "select", "focus", "highlight"].includes(type)) {
      return false;
    }
    if (Number.isInteger(step.page_agent_index)) {
      return true;
    }
    if (String(step.selector || "").trim()) {
      return true;
    }
    if (Array.isArray(step.selector_candidates) && step.selector_candidates.some((item) => String(item || "").trim())) {
      return true;
    }
    if (String(step.element_id || "").trim()) {
      return true;
    }
    if (String(step.target_desc || "").trim()) {
      return true;
    }
    return Array.isArray(step.semantic_anchors) && step.semantic_anchors.length > 0;
  }

  function workflowStepsLookExecutable(steps) {
    return Array.isArray(steps) && steps.length > 0 && steps.every((step) => isExecutableWorkflowStep(step));
  }

  function pickPreferredWorkflowSteps(preferredSteps, fallbackSteps) {
    const normalizedPreferred = cloneWorkflowSteps(preferredSteps);
    const normalizedFallback = cloneWorkflowSteps(fallbackSteps);
    if (workflowStepsLookExecutable(normalizedPreferred)) {
      return normalizedPreferred;
    }
    if (workflowStepsLookExecutable(normalizedFallback)) {
      return normalizedFallback;
    }
    if (normalizedPreferred.length) {
      return normalizedPreferred;
    }
    return normalizedFallback;
  }

  function getRecordedStepsSnapshot() {
    return cloneWorkflowSteps(state.recorder.steps);
  }

  function describeWorkflowStep(step, index = null) {
    if (!step || typeof step !== "object") {
      return index === null ? "未知步骤" : `${index + 1}. 未知步骤`;
    }
    if (getWorkflowStepType(step) === PAGE_AGENT_TASK_STEP_TYPE) {
      const instruction = String(step.instruction || "").trim() || "未命名 page-agent 任务";
      const successCriteria = String(step.success_criteria || "").trim();
      const prefix = index === null ? "" : `${index + 1}. `;
      return `${prefix}${PAGE_AGENT_TASK_STEP_TYPE} | ${instruction}${successCriteria ? ` | expect=${successCriteria.slice(0, 60)}` : ""}`;
    }
    if (getWorkflowStepType(step) === "fill_form") {
      const fields = Array.isArray(step.fields) ? step.fields : [];
      const labels = fields
        .slice(0, 3)
        .map((field) => String(field?.target_desc || field?.field_name || "字段").trim())
        .filter(Boolean)
        .join(" / ");
      const more = fields.length > 3 ? ` / +${fields.length - 3}` : "";
      const prefix = index === null ? "" : `${index + 1}. `;
      return `${prefix}fill_form | ${String(step.target_desc || step.label || "表单").trim() || "表单"}${labels ? ` | ${labels}${more}` : ""}`;
    }
    if (getWorkflowStepType(step) === "press_key") {
      const key = String(step.key || step.value || "").trim() || "按键";
      const label = getWorkflowStepTargetLabel(step) || "当前焦点";
      const pageAgent = Number.isInteger(step.page_agent_index) ? ` | idx=${step.page_agent_index}` : "";
      return `${index === null ? "" : `${index + 1}. `}press_key | ${key} @ ${label}${pageAgent}`;
    }
    if (getWorkflowStepType(step) === "ask_human") {
      const question = String(step.question || "").trim();
      const message = String(step.message || "").trim();
      const reason = String(step.reason || "").trim();
      const options = Array.isArray(step.options) ? step.options.filter((item) => item && String(item.label || "").trim()) : [];
      const summary = question || message || reason || "等待确认";
      const optionSuffix = options.length ? ` | 选项=${options.length}` : "";
      return `${index === null ? "" : `${index + 1}. `}ask_human | ${summary}${optionSuffix}`;
    }
    const label = getWorkflowStepTargetLabel(step);
    const pageAgent = Number.isInteger(step.page_agent_index) ? ` | idx=${step.page_agent_index}` : "";
    const value = step.value ? ` | value=${String(step.value).slice(0, 60)}` : "";
    const prefix = index === null ? "" : `${index + 1}. `;
    return `${prefix}${getWorkflowStepType(step) || "step"} | ${label}${pageAgent}${value}`;
  }

  function summarizeWorkflowSteps(steps, limit = 6) {
    return cloneWorkflowSteps(steps)
      .slice(0, limit)
      .map((step, index) => describeWorkflowStep(step, index));
  }

  function getWorkflowDraftSteps(draftResult) {
    const steps = draftResult?.draft?.data?.steps;
    if (Array.isArray(steps) && steps.length) {
      return cloneWorkflowSteps(steps);
    }
    return [];
  }

  function normalizeWorkflowDraftWithRecorder(result, recorderSteps, currentAnalysisSeed = {}) {
    if (!result || result.teach_decision !== "create_workflow") {
      return result;
    }
    const draft = result.draft && typeof result.draft === "object" ? { ...result.draft } : { type: "workflow", data: {} };
    const draftData = draft.data && typeof draft.data === "object" ? { ...draft.data } : {};
    const normalizedSteps = buildParameterizedWorkflowDraftSteps(
      pickPreferredWorkflowSteps(draftData.steps, cloneWorkflowSteps(recorderSteps)),
      currentAnalysisSeed?.extracted_fields || {}
    );
    draftData.steps = normalizedSteps;
    draft.type = "workflow";
    draftData.step_count = Array.isArray(draftData.steps) ? draftData.steps.length : 0;
    if (!String(draftData.name || draftData.title || "").trim()) {
      const matchedDomain = String(currentAnalysisSeed?.matched_domain || "").trim();
      draftData.name = matchedDomain || `${location.host || "当前页面"}流程`;
    }
    if (!String(draftData.summary || draftData.instruction || "").trim() && draftData.step_count) {
      draftData.summary = `由录制步骤整理得到，共 ${draftData.step_count} 步`;
    }
    if ((!Array.isArray(draftData.site_scope) || !draftData.site_scope.length) && location.host) {
      draftData.site_scope = [location.host];
    }
    if (!draftData.bind_skill_id && currentAnalysisSeed?.primary_skill_id) {
      draftData.bind_skill_id = currentAnalysisSeed.primary_skill_id;
    }
    draftData.step_preview = summarizeWorkflowSteps(draftData.steps, 8);
    draft.data = draftData;
    result.draft = draft;
    return result;
  }

  function siteScopeMatchesCurrentHost(siteScope, host = location.host) {
    const normalizedHost = String(host || "").trim().toLowerCase();
    const rules = (Array.isArray(siteScope) && siteScope.length ? siteScope : ["*"])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean);
    if (!rules.length) {
      return true;
    }
    return rules.some((rule) => {
      if (rule === "*" || rule === "all") {
        return true;
      }
      if (!normalizedHost) {
        return false;
      }
      if (rule.startsWith("*.")) {
        const suffix = rule.slice(1);
        return normalizedHost === rule.slice(2) || normalizedHost.endsWith(suffix);
      }
      return normalizedHost === rule || normalizedHost.endsWith(`.${rule}`);
    });
  }

  function workflowNameLooksGeneric(name) {
    const normalized = String(name || "").replace(/\s+/g, "").trim().toLowerCase();
    if (!normalized) {
      return true;
    }
    return /(测试|test|demo|sample|example|录制流程|workflow|tmp|temp)/i.test(normalized);
  }

  function workflowDisplayPriority(workflow) {
    const steps = Array.isArray(workflow?.steps_json)
      ? workflow.steps_json
      : Array.isArray(workflow?.steps)
        ? workflow.steps
        : [];
    return [
      workflowNameLooksGeneric(workflow?.name) ? 1 : 0,
      String(workflow?.bind_skill_id || "").trim() ? 0 : 1,
      steps.length < 2 ? 1 : 0,
    ];
  }

  function pickWorkflowActionsForDisplay(workflows, limit = MAX_FALLBACK_WORKFLOW_ACTIONS) {
    return (Array.isArray(workflows) ? workflows : [])
      .map((workflow, index) => ({ workflow, index, priority: workflowDisplayPriority(workflow) }))
      .sort((left, right) => {
        for (let index = 0; index < left.priority.length; index += 1) {
          if (left.priority[index] !== right.priority[index]) {
            return left.priority[index] - right.priority[index];
          }
        }
        return left.index - right.index;
      })
      .slice(0, Math.max(0, limit))
      .map((item) => item.workflow);
  }

  function buildLocalWorkflowActions(workflows, result) {
    const extractedFields = result?.extracted_fields || {};
    return pickWorkflowActionsForDisplay(
      (Array.isArray(workflows) ? workflows : []).filter((workflow) => siteScopeMatchesCurrentHost(workflow.site_scope_json || workflow.site_scope || ["*"])),
      MAX_FALLBACK_WORKFLOW_ACTIONS
    )
      .map((workflow) => {
        const rawSteps = pickPreferredWorkflowSteps(workflow.steps_json, []);
        if (!workflowStepsLookExecutable(rawSteps)) {
          return null;
        }
        const workflowId = String(workflow.workflow_id || "").trim();
        const workflowName = String(workflow.name || "执行流程").trim() || "执行流程";
        const browserActions = rawSteps.map((step, stepIndex) => ({
          ...cloneWorkflowSteps([step])[0],
          workflow_id: workflowId,
          workflow_step_index: stepIndex,
          workflow_name: workflowName,
        }));
        const previewSteps = rawSteps.slice(0, 4).map((step, index) => describeWorkflowStep(step, index));
        const actionList = workflow.require_human_confirm
          ? [
              {
                type: "ask_human",
                message: `确认执行流程「${workflowName}」？`,
                question: `是否执行流程「${workflowName}」？`,
                reason: "该流程包含真实页面操作，执行前需要用户确认。",
                suggested_action: "确认后按既定步骤继续执行。",
                confirm_label: "确认执行",
                cancel_label: "暂不执行",
                options: [
                  { id: "confirm", label: "确认执行", value: "continue" },
                  { id: "cancel", label: "暂不执行", value: "cancel", replace_remaining: true },
                ],
                workflow_id: workflowId,
                workflow_step_index: -1,
                workflow_name: workflowName,
              },
              ...browserActions,
            ]
          : browserActions;
        return {
          action_type: "execute_workflow",
          label: workflowName,
          workflow_id: workflowId,
          browser_actions: actionList,
          preview_steps: previewSteps,
          injected_params: extractedFields,
          missing_parameters: [],
          require_confirmation: Boolean(workflow.require_human_confirm),
          from_local_fallback: true,
        };
      })
      .filter(Boolean);
  }

  function buildSuggestedActionPreviewLines(action) {
    if (Array.isArray(action?.preview_steps) && action.preview_steps.length) {
      return action.preview_steps.slice();
    }
    const actions = Array.isArray(action?.browser_actions) ? action.browser_actions : [];
    return actions
      .filter((item) => item && item.type !== "ask_human")
      .slice(0, 8)
      .map((item, index) => describeWorkflowStep(item, index));
  }

  function buildWorkflowAiInstruction(action, currentAnalysis) {
    const workflowName = String(action?.label || action?.workflow_id || "当前流程").trim();
    const summary = String(currentAnalysis?.summary || "").trim() || "暂无明确结论";
    const matchedDomain = String(currentAnalysis?.matched_domain || "").trim() || "通用分析";
    const previewLines = buildSuggestedActionPreviewLines(action);
    const params = action?.injected_params && typeof action.injected_params === "object" ? action.injected_params : {};
    const paramLines = Object.entries(params)
      .filter(([key, value]) => String(key || "").trim() && String(value ?? "").trim())
      .slice(0, 12)
      .map(([key, value]) => `${key}=${String(value).slice(0, 120)}`);
    const missingParams = Array.isArray(action?.missing_parameters) ? action.missing_parameters : [];
    return [
      `当前分析结论：${summary}`,
      `当前命中技能：${matchedDomain}`,
      `准备执行已保存 workflow：「${workflowName}」`,
      previewLines.length ? `参考流程步骤：\n${previewLines.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : "参考流程步骤：暂无",
      paramLines.length ? `本次可用参数：\n${paramLines.join("\n")}` : "本次可用参数：暂无",
      missingParams.length ? `当前缺少参数：${missingParams.join("、")}` : "",
      "请先判断当前页面是否适合执行这条 workflow。",
      "如果适合：基于当前页面真实状态，把这条 workflow 转成本次可执行的 browser_actions，并把本次分析得到的参数补进需要填写的位置。",
      "如果 workflow 的原始步骤和当前页面略有偏差，请输出等价但更稳妥的动作，不要死搬硬套旧 selector。",
      "如果不适合或信息不足：返回空数组，并在 reply 里明确说明原因。",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function executeSuggestedWorkflow(action, options = {}) {
    const workflowName = String(action?.label || action?.workflow_id || "执行流程").trim() || "执行流程";
    const currentAnalysis = getAnalysisForContext() || state.lastAnalysis || {};
    const enrichedAction = { ...(action || {}) };
    const previewLines = buildSuggestedActionPreviewLines(enrichedAction);
    const missingParams = Array.isArray(enrichedAction.missing_parameters) ? enrichedAction.missing_parameters.filter(Boolean) : [];
    if (missingParams.length) {
      runtimeMask.resetSequence(workflowName, previewLines.length || 1);
      runtimeMask.pushHistory("question", `workflow 缺少参数：${missingParams.join("、")}`, "workflow 参数补充");
      const paramChoice = await waitForRuntimeChoice(buildWorkflowParameterChoiceAction(enrichedAction), []);
      if (!paramChoice || String(paramChoice.value || "").trim().toLowerCase() === "cancel") {
        runtimeMask.finish(false, "已取消本次 workflow 参数补充。");
        setStatus("已取消本次 workflow 参数补充。");
        return { success: false, executedCount: 0, message: "用户取消补充 workflow 参数。" };
      }
      const fieldValues = paramChoice.field_values && typeof paramChoice.field_values === "object" ? paramChoice.field_values : {};
      enrichedAction.injected_params = {
        ...(enrichedAction.injected_params && typeof enrichedAction.injected_params === "object" ? enrichedAction.injected_params : {}),
        ...fieldValues,
      };
      enrichedAction.missing_parameters = [];
      runtimeMask.pushHistory(
        "success",
        `已补充 workflow 参数：${Object.keys(fieldValues).map((key) => `${key}=${String(fieldValues[key]).slice(0, 40)}`).join("；") || "无"}`,
        "workflow 参数补充"
      );
      runtimeMask.hide();
    }
    if (!options.skipConfirm) {
      runtimeMask.resetSequence(workflowName, previewLines.length || 1);
      runtimeMask.pushHistory("question", `准备执行 workflow：${workflowName}`, "workflow 入口确认");
      const workflowChoice = await waitForRuntimeChoice(
        buildWorkflowExecutionChoiceAction(enrichedAction, currentAnalysis, previewLines),
        []
      );
      if (!workflowChoice || String(workflowChoice.value || "").trim().toLowerCase() === "cancel") {
        runtimeMask.finish(false, "已取消本次 workflow 执行。");
        setStatus("已取消本次 workflow 执行。");
        return { success: false, executedCount: 0, message: "用户取消执行。" };
      }
      runtimeMask.pushHistory("success", `已确认执行 workflow：${workflowName}`, "workflow 入口确认");
      runtimeMask.hide();
    }

    const directWorkflowActions = getDirectWorkflowActions(enrichedAction, {
      stripConfirmStep: !options.skipConfirm,
    });
    if (directWorkflowActions.length) {
      setStatus(`正在直接执行 workflow「${workflowName}」...`);
      const directResult = await executeBrowserActions(directWorkflowActions, workflowName, {
        skipWorkflowSavePrompt: true,
      });
      if (directResult.success) {
        return directResult;
      }
      setStatus(`workflow「${workflowName}」直接执行失败，正在尝试结合当前页面重规划...`);
      setTeachResult(`workflow「${workflowName}」直接执行未完成：${directResult.message || "unknown error"}\n接下来会继续尝试按当前页面状态重规划。`);
    }

    setStatus(`正在让 AI 结合当前分析复核 workflow「${workflowName}」...`);
    const instruction = buildWorkflowAiInstruction(enrichedAction, currentAnalysis);
    const contextKey = getTeachContextKey() || state.lastContextKey || buildContextKey(pickText());
    const currentAnalysisSeed = await buildCurrentAnalysisSeed(contextKey);
    const pageState = await captureActionablePageState(instruction);
    const plan = await requestBrowserControlPlan(instruction, {
      contextKey,
      currentAnalysisSeed: {
        ...currentAnalysisSeed,
        workflow_action: enrichedAction,
      },
      pageState,
      messages: [{ role: "user", content: instruction }],
    });
    const plannedActions = Array.isArray(plan?.browser_actions) ? plan.browser_actions : [];
    if (!plannedActions.length) {
      const message = String(plan?.reply || "AI 认为当前不适合直接执行该 workflow。").trim();
      setStatus(`workflow 未执行：${message}`);
      setTeachResult(`workflow「${workflowName}」未执行：${message}`);
      return { success: false, executedCount: 0, message };
    }
    const workflowTaggedActions = plannedActions.map((step, index) => ({
      ...step,
      workflow_id: enrichedAction?.workflow_id || step?.workflow_id,
      workflow_name: workflowName,
      workflow_step_index: Number.isInteger(step?.workflow_step_index) ? step.workflow_step_index : index,
    }));
    rememberPlannedBrowserActions(workflowTaggedActions, plan.reply || `AI 已整理 workflow「${workflowName}」的执行计划。`, contextKey);
    setTeachResult(`AI 已根据当前工单整理出 ${workflowTaggedActions.length} 步 workflow 执行计划，准备交给 PageAgent。`);
    return executeBrowserActions(workflowTaggedActions, workflowName, { skipWorkflowSavePrompt: true });
  }

  function stripWorkflowRuntimeMeta(step) {
    const cloned = cloneWorkflowSteps([step])[0] || {};
    delete cloned.workflow_id;
    delete cloned.workflow_step_index;
    delete cloned.workflow_name;
    return cloned;
  }

  function replaceStepValueWithPlaceholder(value, extractedFields) {
    const raw = String(value ?? "").trim();
    if (!raw) {
      return value;
    }
    const entries = Object.entries(extractedFields && typeof extractedFields === "object" ? extractedFields : {});
    for (const [fieldName, fieldValue] of entries) {
      const normalizedFieldValue = String(fieldValue ?? "").trim();
      if (!fieldName || !normalizedFieldValue) {
        continue;
      }
      if (normalizedFieldValue === raw) {
        return `{${fieldName}}`;
      }
    }
    return value;
  }

  function buildReusableWorkflowSteps(actions, extractedFields) {
    return cloneWorkflowSteps(actions)
      .filter((step) => step && getWorkflowStepType(step) !== "ask_human")
      .map((step) => {
        const cleaned = stripWorkflowRuntimeMeta(step);
        const optionCandidates = inferWorkflowStepOptionCandidates(cleaned);
        if (optionCandidates.length) {
          cleaned.option_candidates = optionCandidates;
        }
        if (typeof cleaned.value === "string") {
          cleaned.value = replaceStepValueWithPlaceholder(cleaned.value, extractedFields);
        }
        if (typeof cleaned.source_value === "string") {
          cleaned.source_value = replaceStepValueWithPlaceholder(cleaned.source_value, extractedFields);
        }
        return cleaned;
      })
      .filter((step) => isExecutableWorkflowStep(step));
  }

  function buildReusableWorkflowName(label, currentAnalysis) {
    const matchedDomain = String(currentAnalysis?.matched_domain || "").trim();
    const title = String(document.title || "").trim();
    const labelText = String(label || "").trim();
    const base = matchedDomain && matchedDomain !== "通用分析" ? matchedDomain : title || location.host || "当前页面";
    if (labelText && !/(页面操作|浏览器动作|执行流程|workflow)/i.test(labelText)) {
      return `${base} - ${labelText}`.slice(0, 80);
    }
    return `${base}流程`.slice(0, 80);
  }

  async function maybeOfferWorkflowSaveAfterSuccess(actions, label = "页面操作") {
    const normalizedActions = Array.isArray(actions) ? actions.filter(Boolean) : [];
    if (!normalizedActions.length) {
      return null;
    }
    if (normalizedActions.some((step) => String(step?.workflow_id || "").trim())) {
      return null;
    }
    const workflowSteps = buildReusableWorkflowSteps(normalizedActions, getAnalysisForContext()?.extracted_fields || state.lastAnalysis?.extracted_fields || {});
    if (!workflowSteps.length || !workflowStepsLookExecutable(workflowSteps)) {
      return null;
    }
    const hasReusableInteraction = workflowSteps.some((step) => {
      const type = getWorkflowStepType(step);
      return type === PAGE_AGENT_TASK_STEP_TYPE || ["click", "fill", "select"].includes(type);
    });
    if (!hasReusableInteraction) {
      return null;
    }
    const currentAnalysis = getAnalysisForContext() || state.lastAnalysis || {};
    const workflowName = buildReusableWorkflowName(label, currentAnalysis);
    const workflowSummary = `复用当前页面操作，共 ${workflowSteps.length} 步。`;
    runtimeMask.setStatus("completed", "页面操作已完成", "可选择是否把本次成功动作保存成可复用 workflow。");
    runtimeMask.pushHistory("question", `是否保存 workflow：${workflowName}`, "workflow 保存");
    const saveChoice = await waitForRuntimeChoice(buildWorkflowSaveChoiceAction(workflowName, workflowSummary, workflowSteps), []);
    if (!saveChoice || String(saveChoice.value || "").trim().toLowerCase() === "cancel") {
      const detail = "本次页面操作已完成，暂未保存为 workflow。";
      runtimeMask.pushHistory("observation", "已跳过 workflow 保存。", "workflow 保存");
      runtimeMask.setStatus("completed", "页面操作已完成", detail);
      setStatus("本次未保存 workflow。");
      setPanelState("teach", "success", "页面操作已完成", detail);
      return null;
    }
    runtimeMask.pushHistory("success", `已确认保存 workflow：${workflowName}`, "workflow 保存");
    runtimeMask.setStatus("executing", "正在保存 workflow", `正在整理并写入 ${workflowSteps.length} 步可复用流程。`);
    setPanelState("teach", "loading", "正在保存流程", `正在把这 ${workflowSteps.length} 步成功动作整理成可复用 workflow。`);
    const payload = {
      name: workflowName,
      summary: workflowSummary,
      site_scope: [location.host || "*"],
      steps: workflowSteps,
      extracted_fields: currentAnalysis?.extracted_fields || {},
      require_human_confirm: true,
      bind_skill_id: String(currentAnalysis?.debug_meta?.primary_skill_id || currentAnalysis?.primary_skill_id || "").trim() || undefined,
    };
    const result = await apiRequest("POST", "/api/workflows/record", payload);
    const detail = `已保存 workflow：${workflowName}。后续同站点同场景可直接调用，不用再重新试动作。`;
    runtimeMask.pushHistory("done", `已保存 workflow：${workflowName}`, "workflow 保存");
    runtimeMask.setStatus("completed", "流程已保存", `已记录 ${workflowSteps.length} 步，可在后续同类页面直接复用。`);
    setRuntimeExpanded(true);
    setStatus(`已保存可复用流程：${workflowName}。下次同类页面可直接复用。`);
    setPanelState("teach", "success", "流程已保存", detail);
    return { ...result, workflow_name: workflowName, workflow_steps: workflowSteps };
  }

  async function enrichAnalysisWithWorkflowFallback(result) {
    if (!result || !location.host) {
      return result;
    }
    const quickActions = getQuickActions(result);
    const alreadyHasExecutableAction = quickActions.some((item) => {
      const actionType = String(item?.action_type || "").trim();
      return (isWorkflowQuickAction(item) || actionType === "execute_browser_actions") && Array.isArray(item.browser_actions) && item.browser_actions.length;
    });
    if (alreadyHasExecutableAction) {
      return result;
    }
    try {
      const workflows = await apiRequest("GET", "/api/workflows");
      const fallbackActions = buildLocalWorkflowActions(workflows, result);
      if (fallbackActions.length) {
        result.quick_actions = [...quickActions, ...fallbackActions];
        result.suggested_actions = result.quick_actions;
        setStatus(`分析结果未返回动作，已从本地 workflow 回填 ${fallbackActions.length} 个可执行流程。`);
      }
    } catch (error) {
      console.warn("[OmniAgent] workflow fallback unavailable:", error);
    }
    return result;
  }

  function updateTeachChrome(contextKey = getTeachContextKey()) {
    const intro = document.querySelector(".oa2-teach-intro");
    const result = document.getElementById("oa2-teach-result");
    const messages = getTeachMessages(contextKey);
    const hasDraft = Boolean(state.lastTeachDraft && state.lastTeachDraft.teach_decision && state.lastTeachDraft.teach_decision !== "chat_only");
    const hasResult = Boolean(result && !result.classList.contains("is-hidden"));
    const hasBridge = Boolean(getTeachBridgeDescriptor(contextKey));
    const shouldHideIntro = messages.length > 0 || hasDraft || hasResult || hasBridge;
    const teachRecorderCard = document.getElementById("oa2-teach-recorder-card");
    const hasRecorderActivity = Boolean(state.recorder.active || state.recorder.steps.length);
    if (intro) {
      intro.classList.toggle("is-hidden", shouldHideIntro);
    }
    if (teachRecorderCard instanceof HTMLDetailsElement) {
      const shouldShowRecorderCard = Boolean(state.recorder.active || (hasRecorderActivity && state.recorder.inspecting));
      teachRecorderCard.classList.toggle("is-hidden", !shouldShowRecorderCard);
      if (state.recorder.active) {
        teachRecorderCard.open = true;
        state.recorder.inspecting = true;
      } else if (!shouldShowRecorderCard) {
        teachRecorderCard.open = false;
      } else {
        teachRecorderCard.open = Boolean(state.recorder.inspecting);
      }
    }
    renderTeachBridge(contextKey);
    renderTeachRecorderInline();
    renderTeachDraftBar();
  }

  function getTeachBridgeDescriptor(contextKey = getTeachContextKey()) {
    const messages = getTeachMessages(contextKey);
    if (messages.length || (state.lastTeachDraft && state.lastTeachDraft.teach_decision && state.lastTeachDraft.teach_decision !== "chat_only")) {
      return null;
    }
    const analysis = getAnalysisForContext(contextKey) || state.lastAnalysis || null;
    if (!analysis || (!analysis.summary && !analysis.matched_domain && !getQuickActions(analysis).length)) {
      return null;
    }
    const summary = String(analysis.summary || "").trim() || "当前还没有明确结论。";
    const domain = String(analysis.matched_domain || analysis?.context_bar?.skill_label || "").trim() || "当前页面";
    const evidenceCount = Array.isArray(analysis.evidence_items) ? analysis.evidence_items.length : 0;
    const quickActions = getQuickActions(analysis);
    const primaryAction = quickActions[0] || null;
    const detailParts = [domain];
    if (evidenceCount) {
      detailParts.push(`证据 ${evidenceCount} 条`);
    }
    if (quickActions.length) {
      detailParts.push(`动作 ${quickActions.length} 个`);
    }
    return {
      summary,
      detail: detailParts.join(" · "),
      primaryAction,
      result: analysis,
    };
  }

  function renderTeachBridge(contextKey = getTeachContextKey()) {
    const node = document.getElementById("oa2-teach-bridge");
    if (!node) {
      return;
    }
    node.innerHTML = "";
    const descriptor = getTeachBridgeDescriptor(contextKey);
    node.classList.toggle("is-hidden", !descriptor);
    if (!descriptor) {
      return;
    }
    const title = document.createElement("div");
    title.className = "oa2-card-title";
    title.textContent = "已承接上一轮分析";
    const body = document.createElement("div");
    body.className = "oa2-rule-proposal-body";
    body.textContent = descriptor.summary;
    const meta = document.createElement("div");
    meta.className = "oa2-rule-proposal-meta";
    meta.textContent = descriptor.detail;
    const actions = document.createElement("div");
    actions.className = "oa2-composer-actions";

    const followBtn = document.createElement("button");
    followBtn.className = "oa2-btn";
    followBtn.type = "button";
    followBtn.textContent = "带去对话";
    followBtn.addEventListener("click", () => {
      focusTeachComposerWithText(buildResultFollowupPrompt(descriptor.result), "已把分析结论带到对话区，可继续推进下一步。");
    });
    actions.appendChild(followBtn);

    const draftBtn = document.createElement("button");
    draftBtn.className = "oa2-btn secondary";
    draftBtn.type = "button";
    draftBtn.textContent = "整理草案";
    draftBtn.addEventListener("click", () => {
      focusTeachComposerWithText(buildResultTeachPrompt(descriptor.result), "已把分析结论带到输入框，可继续整理规则或 workflow 草案。");
    });
    actions.appendChild(draftBtn);

    if (descriptor.primaryAction) {
      const actionBtn = document.createElement("button");
      actionBtn.className = "oa2-btn secondary";
      actionBtn.type = "button";
      actionBtn.textContent = isWorkflowQuickAction(descriptor.primaryAction) ? "执行首选流程" : "执行首选动作";
      actionBtn.addEventListener("click", () => {
        runQuickAction(descriptor.primaryAction).catch((error) => {
          setStatus(`执行失败：${error?.message || "unknown error"}`);
        });
      });
      actions.appendChild(actionBtn);
    }

    node.appendChild(title);
    node.appendChild(body);
    node.appendChild(meta);
    node.appendChild(actions);
  }

  function getTeachDraftDescriptor(draftResult = state.lastTeachDraft) {
    if (!draftResult || !draftResult.teach_decision || draftResult.teach_decision === "chat_only") {
      return null;
    }
    const draftData = draftResult.draft?.data || {};
    const workflowSteps = draftResult.teach_decision === "create_workflow" ? getWorkflowDraftSteps(draftResult) : [];
    if (draftResult.teach_decision === "update_skill") {
      const skillTitle = String(draftResult.target_skill_title || "").trim();
      return {
        title: "草案待确认",
        body: `准备把这次经验并入${skillTitle ? `「${skillTitle}」` : "当前技能"}。`,
        meta: "确认后写入长期规则",
        workflowSteps,
      };
    }
    if (draftResult.teach_decision === "create_workflow") {
      const workflowName = String(draftData.name || draftData.title || "").trim() || "未命名流程";
      const workflowSummary = String(draftData.summary || draftData.instruction || "").trim();
      const bindSkillId = String(draftData.bind_skill_id || draftResult.target_skill_id || "").trim();
      const metaParts = [];
      metaParts.push(`${workflowSteps.length || 0} 步`);
      if (bindSkillId) {
        metaParts.push(`bind=${bindSkillId}`);
      }
      return {
        title: "流程草案待确认",
        body: workflowSummary ? `${workflowName} | ${workflowSummary}` : workflowName,
        meta: metaParts.join(" | "),
        workflowSteps,
      };
    }
    return {
      title: "规则草案待确认",
      body: `准备新增一条长期规则：${String(draftData.instruction || draftData.activation_condition || "").trim() || "写入长期记忆"}`,
      meta: "确认后写入长期记忆",
      workflowSteps,
    };
  }

  function renderTeachRecorderInline() {
    const node = document.getElementById("oa2-teach-recorder-inline");
    if (!node) {
      return;
    }
    node.innerHTML = "";
    const stepCount = state.recorder.steps.length;
    const active = Boolean(state.recorder.active);
    const hasSteps = stepCount > 0;
    if (!active && !hasSteps) {
      node.classList.add("is-hidden");
      return;
    }
    node.classList.remove("is-hidden");
    node.classList.toggle("is-compact", !active);

    const row = document.createElement("div");
    row.className = "oa2-teach-inline-row";
    const textWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "oa2-card-title";
    title.textContent = active ? "正在录制流程" : "已有录制步骤";
    const meta = document.createElement("div");
    meta.className = "oa2-teach-inline-meta";
    meta.textContent = active
      ? `已记录 ${stepCount} 步，结束后可直接整理成 workflow 草案。`
      : `当前保留 ${stepCount} 步，可继续补录、展开检查或直接整理草案。`;
    textWrap.appendChild(title);
    textWrap.appendChild(meta);
    row.appendChild(textWrap);
    node.appendChild(row);

    const actions = document.createElement("div");
    actions.className = "oa2-composer-actions";
    if (active) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "oa2-btn";
      stopBtn.type = "button";
      stopBtn.setAttribute("data-action", "stop-record");
      stopBtn.textContent = "停止录制";
      actions.appendChild(stopBtn);
    } else {
      const startBtn = document.createElement("button");
      startBtn.className = "oa2-btn secondary";
      startBtn.type = "button";
      startBtn.setAttribute("data-action", "start-record");
      startBtn.textContent = hasSteps ? "继续录制" : "开始录制";
      actions.appendChild(startBtn);
    }
    if (hasSteps) {
      const draftBtn = document.createElement("button");
      draftBtn.className = "oa2-btn secondary";
      draftBtn.type = "button";
      draftBtn.setAttribute("data-action", "record-to-teach");
      draftBtn.textContent = "整理草案";
      actions.appendChild(draftBtn);

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "oa2-btn secondary";
      toggleBtn.type = "button";
      toggleBtn.setAttribute("data-action", "toggle-teach-recorder");
      const recorderCard = document.getElementById("oa2-teach-recorder-card");
      toggleBtn.textContent = recorderCard instanceof HTMLDetailsElement && recorderCard.open ? "收起步骤" : "查看步骤";
      actions.appendChild(toggleBtn);
    }
    node.appendChild(actions);
  }

  function renderTeachDraftBar() {
    const node = document.getElementById("oa2-teach-draftbar");
    if (!node) {
      return;
    }
    node.innerHTML = "";
    const descriptor = getTeachDraftDescriptor();
    node.classList.toggle("is-hidden", !descriptor);
    if (!descriptor) {
      return;
    }
    const title = document.createElement("div");
    title.className = "oa2-card-title";
    title.textContent = descriptor.title;
    const body = document.createElement("div");
    body.className = "oa2-rule-proposal-body";
    body.textContent = descriptor.body;
    const meta = document.createElement("div");
    meta.className = "oa2-rule-proposal-meta";
    meta.textContent = descriptor.meta;
    const actions = document.createElement("div");
    actions.className = "oa2-composer-actions";
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "oa2-btn";
    confirmBtn.type = "button";
    confirmBtn.setAttribute("data-action", "teach-confirm");
    confirmBtn.textContent = "确认并保存";
    const rejectBtn = document.createElement("button");
    rejectBtn.className = "oa2-btn secondary";
    rejectBtn.type = "button";
    rejectBtn.setAttribute("data-action", "teach-reject");
    rejectBtn.textContent = "放弃";
    actions.appendChild(confirmBtn);
    actions.appendChild(rejectBtn);
    node.appendChild(title);
    node.appendChild(body);
    node.appendChild(meta);
    node.appendChild(actions);
  }

  function renderTeachConversation(contextKey = getTeachContextKey()) {
    const node = document.getElementById("oa2-teach-thread");
    if (!node) {
      return;
    }
    const messages = getTeachMessages(contextKey);
    node.innerHTML = "";
    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-empty";
      empty.textContent = "先直接对话、发页面操作，或让它整理这次经验。";
      node.appendChild(empty);
      updateTeachChrome(contextKey);
      return;
    }
    messages.forEach((message) => {
      const item = document.createElement("div");
      item.className = `oa2-chat-msg ${message.role === "assistant" ? "assistant" : "user"}`;
      const role = document.createElement("span");
      role.className = "oa2-chat-role";
      role.textContent = message.role === "assistant" ? "OmniAgent" : "你";
      const content = document.createElement("div");
      content.textContent = String(message.content || "");
      item.appendChild(role);
      item.appendChild(content);
      node.appendChild(item);
    });
    if (state.lastTeachDraft && state.lastTeachDraft.teach_decision && state.lastTeachDraft.teach_decision !== "chat_only") {
      const descriptor = getTeachDraftDescriptor(state.lastTeachDraft);
      const proposal = document.createElement("div");
      proposal.className = "oa2-rule-proposal";
      const title = document.createElement("div");
      title.className = "oa2-card-title";
      title.textContent = descriptor?.title || "草案待确认";
      const body = document.createElement("div");
      body.className = "oa2-rule-proposal-body";
      const workflowSteps = descriptor?.workflowSteps || [];
      body.textContent = descriptor?.body || "";
      const meta = document.createElement("div");
      meta.className = "oa2-rule-proposal-meta";
      meta.textContent = descriptor?.meta || "确认后写入长期记忆";
      let stepList = null;
      if (state.lastTeachDraft.teach_decision === "create_workflow") {
        stepList = document.createElement("div");
        stepList.className = "oa2-list";
        if (workflowSteps.length) {
          workflowSteps.slice(0, 8).forEach((step, index) => {
            const item = document.createElement("div");
            item.className = "oa2-item";
            item.textContent = describeWorkflowStep(step, index);
            stepList.appendChild(item);
          });
          if (workflowSteps.length > 8) {
            const more = document.createElement("div");
            more.className = "oa2-item";
            more.textContent = `还有 ${workflowSteps.length - 8} 步未展开。`;
            stepList.appendChild(more);
          }
        } else {
          const empty = document.createElement("div");
          empty.className = "oa2-item";
          empty.textContent = "当前 workflow 草案没有附带录制步骤，确认时会失败。";
          stepList.appendChild(empty);
        }
      }
      const actions = document.createElement("div");
      actions.className = "oa2-composer-actions";
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "oa2-btn";
      confirmBtn.type = "button";
      confirmBtn.setAttribute("data-action", "teach-confirm");
      confirmBtn.textContent = "确认并保存";
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "oa2-btn secondary";
      rejectBtn.type = "button";
      rejectBtn.setAttribute("data-action", "teach-reject");
      rejectBtn.textContent = "放弃";
      actions.appendChild(confirmBtn);
      actions.appendChild(rejectBtn);
      proposal.appendChild(title);
      proposal.appendChild(body);
      proposal.appendChild(meta);
      if (stepList) {
        proposal.appendChild(stepList);
      }
      proposal.appendChild(actions);
      node.appendChild(proposal);
    }
    node.scrollTop = node.scrollHeight;
    updateTeachChrome(contextKey);
  }

  function shouldUseTeachFlow(text) {
    return /(记住|以后|下次|规则|固化|更新规则|保存成技能|写入长期记忆|流程|录制|演示一遍|自动填写|自动点击|一键结单)/.test(
      String(text || "").trim()
    );
  }

  function readLauncherPosition() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LAUNCHER_POSITION_KEY) || "{}");
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        return parsed;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function writeLauncherPosition(x, y) {
    localStorage.setItem(LAUNCHER_POSITION_KEY, JSON.stringify({ x, y }));
  }

  function readPanelPosition() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) || "{}");
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        return parsed;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function writePanelPosition(x, y) {
    localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ x, y }));
  }

  function readPanelSize() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || "{}");
      if (typeof parsed.widthRatio === "number" && typeof parsed.heightRatio === "number") {
        return {
          width: Math.round(window.innerWidth * parsed.widthRatio),
          height: Math.round(window.innerHeight * parsed.heightRatio),
          widthRatio: parsed.widthRatio,
          heightRatio: parsed.heightRatio,
        };
      }
      if (typeof parsed.width === "number" && typeof parsed.height === "number") {
        return parsed;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function writePanelSize(width, height) {
    const widthRatio = window.innerWidth ? Math.max(0, Math.min(1, width / window.innerWidth)) : 0;
    const heightRatio = window.innerHeight ? Math.max(0, Math.min(1, height / window.innerHeight)) : 0;
    localStorage.setItem(
      PANEL_SIZE_KEY,
      JSON.stringify({
        width,
        height,
        widthRatio: Number(widthRatio.toFixed(4)),
        heightRatio: Number(heightRatio.toFixed(4)),
      })
    );
  }

  function readScopeMemory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SCOPE_MEMORY_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function writeScopeMemory(data) {
    localStorage.setItem(SCOPE_MEMORY_KEY, JSON.stringify(data));
  }

  function clampValue(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function rectArea(rect) {
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function describeElement(element) {
    if (!(element instanceof Element)) {
      return "unknown";
    }
    const parts = [element.tagName.toLowerCase()];
    if (element.id) {
      parts.push(`#${element.id}`);
    } else if (element.classList && element.classList.length) {
      parts.push(`.${Array.from(element.classList).slice(0, 2).join(".")}`);
    }
    const text = (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim();
    if (text) {
      parts.push(`"${text.slice(0, 28)}"`);
    }
    return parts.join("");
  }

  function getStableClassNames(element) {
    if (!(element instanceof Element) || !element.classList || !element.classList.length) {
      return [];
    }
    return Array.from(element.classList).filter((item) => item && !item.startsWith("oa2-"));
  }

  function normalizeStoredSelector(selector) {
    return String(selector || "")
      .replace(/\.oa2-[A-Za-z0-9_-]+/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s*>\s*/g, " > ")
      .trim();
  }

  function buildStableSelectorForElement(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 6) {
      let segment = current.tagName.toLowerCase();
      if (current.getAttribute("name")) {
        segment += `[name="${CSS.escape(current.getAttribute("name"))}"]`;
        parts.unshift(segment);
        break;
      }
      const classNames = getStableClassNames(current);
      if (classNames.length) {
        segment += `.${classNames.slice(0, 2).map((item) => CSS.escape(item)).join(".")}`;
      }
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName)
        : [];
      if (siblings.length > 1) {
        segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(segment);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function saveScopeForCurrentSite(element) {
    if (!(element instanceof Element)) {
      return;
    }
    const selectorCandidates = makeSelectorCandidates(element);
    const selector = selectorCandidates[0] || "";
    if (!selector) {
      return;
    }
    const memory = readScopeMemory();
    memory[location.host] = {
      selector,
      selector_candidates: selectorCandidates,
      signature: describeElement(element),
      text_hint: String(element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160),
      updated_at: new Date().toISOString(),
    };
    writeScopeMemory(memory);
  }

  function removeScopeForCurrentSite() {
    const memory = readScopeMemory();
    if (memory[location.host]) {
      delete memory[location.host];
      writeScopeMemory(memory);
    }
  }

  function restoreScopeForCurrentSite() {
    if (getScopeRoot()) {
      return false;
    }
    const record = readScopeMemory()[location.host];
    if (!record || !record.selector) {
      return false;
    }
    try {
      const selectorCandidates = Array.isArray(record.selector_candidates) ? record.selector_candidates : [];
      const normalizedCandidates = [record.selector, ...selectorCandidates]
        .map((item) => normalizeStoredSelector(item))
        .filter(Boolean);
      let target = null;
      for (const selector of Array.from(new Set(normalizedCandidates))) {
        const found = document.querySelector(selector);
        if (found instanceof Element) {
          target = found;
          if (selector !== record.selector || normalizedCandidates.length !== selectorCandidates.length + 1) {
            const memory = readScopeMemory();
            memory[location.host] = {
              ...record,
              selector,
              selector_candidates: Array.from(new Set([selector, ...makeSelectorCandidates(found)])),
            };
            writeScopeMemory(memory);
          }
          break;
        }
      }
      if (!(target instanceof Element) && record.text_hint) {
        const candidates = Array.from(document.querySelectorAll("article, section, main, div, li, td, dd, dt, p, img"));
        const textHint = String(record.text_hint).trim();
        target =
          candidates.find((item) => {
            if (!(item instanceof Element) || isInsideOmniAgent(item)) {
              return false;
            }
            const text = String(item.innerText || item.textContent || "")
              .replace(/\s+/g, " ")
              .trim();
            return Boolean(textHint) && Boolean(text) && text.includes(textHint);
          }) || null;
      }
      if (!(target instanceof Element)) {
        return false;
      }
      if (!normalizedCandidates.includes(record.selector)) {
        const memory = readScopeMemory();
        memory[location.host] = {
          ...record,
          selector: makeSelectorCandidates(target)[0] || buildStableSelectorForElement(target) || record.selector,
          selector_candidates: makeSelectorCandidates(target),
          signature: describeElement(target),
        };
        writeScopeMemory(memory);
      }
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      setSelectedScope(target, false);
      setStatus(`已自动恢复该站点上次选择的区域：${record.signature || describeElement(target)}`);
      return true;
    } catch (error) {
      return false;
    }
  }

  function scheduleScopeRestoreAttempts() {
    [0, 400, 1200].forEach((delay) => {
      window.setTimeout(() => {
        if (!getScopeRoot()) {
          restoreScopeForCurrentSite();
        }
      }, delay);
    });
  }

  function getScopeRoot() {
    if (state.scope.root instanceof Element && document.contains(state.scope.root)) {
      return state.scope.root;
    }
    return null;
  }

  function resetScopeCandidateState() {
    state.scope.candidateChain = [];
    state.scope.chainIndex = -1;
    state.scope.frozen = false;
  }

  function clearScopeHover() {
    if (state.scope.hover instanceof Element) {
      state.scope.hover.classList.remove("oa2-scope-hover");
    }
    state.scope.hover = null;
  }

  function removeScopePickerModal() {
    if (state.scope.modal instanceof Element && state.scope.modal.parentNode) {
      state.scope.modal.parentNode.removeChild(state.scope.modal);
    }
    state.scope.modal = null;
  }

  function clearScopeOverlay() {
    clearScopeHover();
    scopeOverlay.style.display = "none";
    scopeBox.style.display = "none";
    scopeToolbar.style.display = "none";
  }

  function showScopeOverlay() {
    scopeOverlay.style.display = "block";
    scopeBox.style.display = "block";
    scopeToolbar.style.display = "flex";
  }

  function buildCandidateChain(element) {
    const chain = [];
    let current = element instanceof Element ? element : null;
    while (current && current !== document.body && current !== document.documentElement && chain.length < 12) {
      if (!isInsideOmniAgent(current)) {
        const rect = current.getBoundingClientRect();
        const tag = current.tagName.toLowerCase();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          !["html", "body", "script", "style", "noscript", "svg", "path"].includes(tag)
        ) {
          chain.push(current);
        }
      }
      current = current.parentElement;
    }
    return Array.from(new Set(chain));
  }

  function chooseCandidateIndex(chain) {
    if (!chain.length) {
      return -1;
    }
    const direct = chain[0];
    if (direct instanceof Element) {
      const rect = direct.getBoundingClientRect();
      const directText = (direct.innerText || "").trim().length;
      if (rect.width >= 24 && rect.height >= 18 && directText <= 12000) {
        return 0;
      }
    }
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    for (let index = 0; index < chain.length; index += 1) {
      const element = chain[index];
      const rect = element.getBoundingClientRect();
      const areaRatio = rectArea(rect) / viewportArea;
      const textLength = (element.innerText || "").trim().length;
      if (rect.width >= 48 && rect.height >= 18 && areaRatio < 0.92 && textLength <= 12000) {
        return index;
      }
    }
    return 0;
  }

  function getCurrentScopeCandidate() {
    if (!state.scope.candidateChain.length || state.scope.chainIndex < 0) {
      return null;
    }
    return state.scope.candidateChain[state.scope.chainIndex] || null;
  }

  function updateScopeOverlayForCandidate() {
    const candidate = getCurrentScopeCandidate();
    if (!(candidate instanceof Element)) {
      clearScopeOverlay();
      return;
    }
    clearScopeHover();
    state.scope.hover = candidate;
    candidate.classList.add("oa2-scope-hover");
    const rect = candidate.getBoundingClientRect();
    showScopeOverlay();
    scopeBox.style.left = `${Math.round(rect.left)}px`;
    scopeBox.style.top = `${Math.round(rect.top)}px`;
    scopeBox.style.width = `${Math.round(rect.width)}px`;
    scopeBox.style.height = `${Math.round(rect.height)}px`;
    scopeDesc.textContent = `当前区域：${describeElement(candidate)}`;
    scopeHint.textContent = `text_length=${(candidate.innerText || "").trim().length} | level=${state.scope.chainIndex + 1}/${state.scope.candidateChain.length} | 当前优先选中鼠标所指元素，可切父级/子级微调，回车确认。`;
    const margin = 12;
    const toolbarWidth = scopeToolbar.offsetWidth || 520;
    const toolbarHeight = scopeToolbar.offsetHeight || 52;
    let left = rect.left;
    let top = rect.top - toolbarHeight - 10;
    if (top < margin) {
      top = rect.bottom + 10;
    }
    if (left + toolbarWidth > window.innerWidth - margin) {
      left = window.innerWidth - toolbarWidth - margin;
    }
    if (left < margin) {
      left = margin;
    }
    if (top + toolbarHeight > window.innerHeight - margin) {
      top = window.innerHeight - toolbarHeight - margin;
    }
    scopeToolbar.style.left = `${Math.round(left)}px`;
    scopeToolbar.style.top = `${Math.round(top)}px`;
  }

  function setScopeCandidateChain(chain, preferredIndex, frozen = false) {
    state.scope.candidateChain = chain;
    state.scope.chainIndex = preferredIndex;
    state.scope.frozen = frozen;
    updateScopeOverlayForCandidate();
  }

  function updateScopeText() {
    const scopeRoot = getScopeRoot();
    const node = document.getElementById("oa2-scope-text");
    if (!scopeRoot) {
      if (node) {
        node.title = "未显式选择时，会优先使用当前文本选区；没有文本选区时回退到整页。";
      }
      setScopeText("当前区域：整页");
      return;
    }
    const textLength = (scopeRoot.innerText || "").trim().length;
    const imageCount = scopeRoot.tagName?.toLowerCase() === "img" ? 1 : scopeRoot.querySelectorAll?.("img").length || 0;
    const remembered = readScopeMemory()[location.host] ? " · 已记住" : "";
    if (node) {
      node.title = `${describeElement(scopeRoot)} | text_length=${textLength}${imageCount ? ` | 含图=${imageCount}` : ""}${remembered ? " | 已记住本站默认区域" : ""}`;
    }
    setScopeText(`当前区域：${describeElement(scopeRoot)} · ${textLength} 字${imageCount ? ` · ${imageCount} 图` : ""}${remembered}`);
  }

  function applyLauncherPosition(x, y) {
    const margin = 12;
    const width = launcher.offsetWidth || 92;
    const height = launcher.offsetHeight || 40;
    const nextX = clampValue(x, margin, window.innerWidth - width - margin);
    const nextY = clampValue(y, margin, window.innerHeight - height - margin);
    launcher.style.left = `${nextX}px`;
    launcher.style.top = `${nextY}px`;
    writeLauncherPosition(nextX, nextY);
  }

  function restoreLauncherPosition() {
    const saved = readLauncherPosition();
    if (saved) {
      applyLauncherPosition(saved.x, saved.y);
      return;
    }
    const defaultX = window.innerWidth - (launcher.offsetWidth || 92) - 18;
    const defaultY = window.innerHeight - (launcher.offsetHeight || 40) - 18;
    applyLauncherPosition(defaultX, defaultY);
  }

  function clampLauncherIntoViewport() {
    const rect = launcher.getBoundingClientRect();
    applyLauncherPosition(rect.left, rect.top);
  }

  function applyPanelPosition(x, y, persist = true) {
    const margin = 12;
    const width = panel.offsetWidth || 364;
    const height = panel.offsetHeight || 420;
    const nextX = clampValue(x, margin, window.innerWidth - width - margin);
    const nextY = clampValue(y, margin, window.innerHeight - height - margin);
    panel.style.left = `${nextX}px`;
    panel.style.top = `${nextY}px`;
    if (persist) {
      writePanelPosition(nextX, nextY);
    }
  }

  function applyPanelSize(width, height, persist = true) {
    const minWidth = 360;
    const minHeight = 288;
    const maxWidth = Math.max(minWidth, Math.floor(window.innerWidth * 0.92));
    const maxHeight = Math.max(minHeight, Math.floor(window.innerHeight * 0.94));
    const nextWidth = clampValue(width, minWidth, maxWidth);
    const nextHeight = clampValue(height, minHeight, maxHeight);
    panel.style.width = `${nextWidth}px`;
    panel.style.height = `${nextHeight}px`;
    syncPanelLayoutMode(nextWidth);
    if (persist) {
      writePanelSize(nextWidth, nextHeight);
    }
  }

  function resolvePanelLayoutMode(width) {
    const effectiveWidth = Math.max(0, Math.round(width || panel.getBoundingClientRect().width || panel.offsetWidth || 0));
    if (effectiveWidth >= PANEL_LAYOUT_BREAKPOINTS.wideMin) {
      return "wide";
    }
    if (effectiveWidth <= PANEL_LAYOUT_BREAKPOINTS.compactMax) {
      return "compact";
    }
    return "medium";
  }

  function syncPanelLayoutMode(width) {
    const mode = resolvePanelLayoutMode(width);
    panel.dataset.layout = mode;
    return mode;
  }

  function clampPanelIntoViewport() {
    const rect = panel.getBoundingClientRect();
    applyPanelPosition(rect.left, rect.top);
  }

  function restorePanelPosition() {
    const saved = readPanelPosition();
    if (saved) {
      state.panelDrag.locked = true;
      applyPanelPosition(saved.x, saved.y, false);
      return;
    }
    syncPanelPosition();
  }

  function restorePanelSize() {
    const saved = readPanelSize();
    if (!saved) {
      return;
    }
    applyPanelSize(saved.width, saved.height, false);
  }

  function syncPanelPosition() {
    if (state.panelDrag.locked) {
      clampPanelIntoViewport();
      return;
    }
    const launcherRect = launcher.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 364;
    const panelHeight = panel.offsetHeight || 420;
    const gap = 10;
    const margin = 12;

    let left = launcherRect.left + launcherRect.width - panelWidth;
    let top = launcherRect.top - panelHeight - gap;

    if (top < margin) {
      top = launcherRect.bottom + gap;
    }
    if (top + panelHeight > window.innerHeight - margin) {
      top = window.innerHeight - panelHeight - margin;
    }
    if (left < margin) {
      left = margin;
    }
    if (left + panelWidth > window.innerWidth - margin) {
      left = window.innerWidth - panelWidth - margin;
    }

    applyPanelPosition(left, top);
  }

  function openPanel() {
    state.isOpen = true;
    panel.classList.add("open");
    if (!state.runtime.active && !state.recorder.active) {
      hidePageAgentMaskIfPossible();
    }
    syncPanelLayoutMode();
    if (!getScopeRoot()) {
      restoreScopeForCurrentSite();
    }
    renderStatusHistory();
    if (state.panelDrag.locked) {
      clampPanelIntoViewport();
    } else {
      syncPanelPosition();
    }
  }

  function closePanel() {
    state.isOpen = false;
    panel.classList.remove("open");
    closeMemoryPopover();
  }

  function onLauncherPointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    const rect = launcher.getBoundingClientRect();
    state.drag.active = true;
    state.drag.moved = false;
    state.drag.startX = event.clientX;
    state.drag.startY = event.clientY;
    state.drag.launcherX = rect.left;
    state.drag.launcherY = rect.top;
    state.drag.pointerId = event.pointerId;
    launcher.setPointerCapture(event.pointerId);
  }

  function onLauncherPointerMove(event) {
    if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
      return;
    }
    const deltaX = event.clientX - state.drag.startX;
    const deltaY = event.clientY - state.drag.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      state.drag.moved = true;
    }
    applyLauncherPosition(state.drag.launcherX + deltaX, state.drag.launcherY + deltaY);
    syncPanelPosition();
  }

  function onLauncherPointerUp(event) {
    if (!state.drag.active || event.pointerId !== state.drag.pointerId) {
      return;
    }
    if (launcher.hasPointerCapture(event.pointerId)) {
      launcher.releasePointerCapture(event.pointerId);
    }
    state.drag.active = false;
    window.setTimeout(() => {
      state.drag.moved = false;
    }, 0);
  }

  function onPanelPointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    if (event.target.closest("button, input, textarea, select, a, label")) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    state.panelDrag.active = true;
    state.panelDrag.moved = false;
    state.panelDrag.startX = event.clientX;
    state.panelDrag.startY = event.clientY;
    state.panelDrag.panelX = rect.left;
    state.panelDrag.panelY = rect.top;
    state.panelDrag.pointerId = event.pointerId;
    panelHeader.setPointerCapture(event.pointerId);
  }

  function onPanelPointerMove(event) {
    if (!state.panelDrag.active || event.pointerId !== state.panelDrag.pointerId) {
      return;
    }
    const deltaX = event.clientX - state.panelDrag.startX;
    const deltaY = event.clientY - state.panelDrag.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      state.panelDrag.moved = true;
      state.panelDrag.locked = true;
    }
    applyPanelPosition(state.panelDrag.panelX + deltaX, state.panelDrag.panelY + deltaY);
  }

  function onPanelPointerUp(event) {
    if (!state.panelDrag.active || event.pointerId !== state.panelDrag.pointerId) {
      return;
    }
    if (panelHeader.hasPointerCapture(event.pointerId)) {
      panelHeader.releasePointerCapture(event.pointerId);
    }
    state.panelDrag.active = false;
    window.setTimeout(() => {
      state.panelDrag.moved = false;
    }, 0);
  }

  function onRuntimePointerDown(event) {
    if (event.button !== 0 || !(runtimeCallout instanceof HTMLElement)) {
      return;
    }
    if (event.target instanceof Element && event.target.closest("button")) {
      return;
    }
    const rect = runtimeCallout.getBoundingClientRect();
    state.runtime.drag.active = true;
    state.runtime.drag.moved = false;
    state.runtime.drag.startX = event.clientX;
    state.runtime.drag.startY = event.clientY;
    state.runtime.drag.calloutX = rect.left;
    state.runtime.drag.calloutY = rect.top;
    state.runtime.drag.pointerId = event.pointerId;
    runtimeHeader?.setPointerCapture(event.pointerId);
  }

  function onRuntimePointerMove(event) {
    if (!state.runtime.drag.active || event.pointerId !== state.runtime.drag.pointerId) {
      return;
    }
    const deltaX = event.clientX - state.runtime.drag.startX;
    const deltaY = event.clientY - state.runtime.drag.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      state.runtime.drag.moved = true;
      state.runtime.drag.locked = true;
    }
    applyRuntimePosition(state.runtime.drag.calloutX + deltaX, state.runtime.drag.calloutY + deltaY, true);
  }

  function onRuntimePointerUp(event) {
    if (!state.runtime.drag.active || event.pointerId !== state.runtime.drag.pointerId) {
      return;
    }
    if (runtimeHeader?.hasPointerCapture(event.pointerId)) {
      runtimeHeader.releasePointerCapture(event.pointerId);
    }
    state.runtime.drag.active = false;
    window.setTimeout(() => {
      state.runtime.drag.moved = false;
    }, 0);
  }

  function hashString(input) {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  function extractPrimaryRegionTitle(root) {
    const target = root instanceof Element ? root : document;
    const heading =
      target.querySelector("h1, h2, [role='heading'], .ant-descriptions-title, .page-title, .modal-title, .drawer-title") ||
      document.querySelector("h1, h2, [role='heading']");
    return String(heading?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function extractBusinessToken(text) {
    const haystack = String(text || "");
    const patterns = [
      /\bCVE-\d{4}-\d{4,7}\b/i,
      /\b(?:ticket|alert|report|case|issue)[-_:/# ]?([A-Za-z0-9-]{3,})\b/i,
      /\b[A-Z]{2,8}-\d{2,8}\b/,
      /#\d{2,8}\b/,
    ];
    for (const pattern of patterns) {
      const match = haystack.match(pattern);
      if (!match) {
        continue;
      }
      return String(match[1] || match[0] || "").slice(0, 64);
    }
    return "";
  }

  function buildContextKey(text) {
    const url = new URL(location.href);
    const scopeRoot = getScopeRoot();
    const scopeSignature = state.scope.signature || (scopeRoot ? describeElement(scopeRoot) : "page");
    const regionTitle = extractPrimaryRegionTitle(scopeRoot || document);
    const businessToken = extractBusinessToken(
      [
        location.href,
        document.title,
        regionTitle,
        String(text || "").slice(0, 400),
      ].join(" | ")
    );
    const semanticFingerprint = [
      url.host,
      url.pathname,
      document.title,
      scopeSignature,
      regionTitle,
      businessToken,
    ]
      .filter(Boolean)
      .join(" | ");
    return `${url.host}${url.pathname}#${hashString(semanticFingerprint)}`;
  }

  function buildSelectionExcerpt(text = pickText()) {
    return String(text || "").trim().slice(0, 2000);
  }

  function buildScopeMeta(text = pickText()) {
    const scopeRoot = getScopeRoot() || pickSelectionAnchorElement() || null;
    const selectionDesc = scopeRoot ? describeElement(scopeRoot) : "";
    const embeddedImageCount = scopeRoot
      ? scopeRoot.tagName?.toLowerCase() === "img"
        ? 1
        : scopeRoot.querySelectorAll?.("img").length || 0
      : 0;
    const normalizedText = String(text || "").trim();
    return {
      selection_desc: selectionDesc,
      scope_signature: state.scope.signature || selectionDesc || "page",
      text_length: normalizedText.length,
      embedded_image_count: embeddedImageCount,
      has_scope_root: Boolean(getScopeRoot()),
    };
  }

  function pickText() {
    const scopeRoot = getScopeRoot();
    if (scopeRoot) {
      return String(scopeRoot.innerText || "").trim().slice(0, 3000);
    }
    const selected = String(window.getSelection() || "").trim();
    if (selected) {
      return selected.slice(0, 3000);
    }
    return String(document.body?.innerText || "").trim().slice(0, 3000);
  }

  function resolveSelectableElement(element) {
    const chain = buildCandidateChain(element);
    const index = chooseCandidateIndex(chain);
    return index >= 0 ? chain[index] : null;
  }

  function setSelectedScope(element, persist = true) {
    const previous = getScopeRoot();
    if (previous) {
      previous.classList.remove("oa2-scope-selected");
      previous.classList.remove("oa2-selected-has-image");
    }
    if (persist && element) {
      saveScopeForCurrentSite(element);
    }
    state.scope.root = element;
    state.scope.signature = element ? describeElement(element) : "";
    if (element) {
      element.classList.add("oa2-scope-selected");
      const imageCount = element.tagName?.toLowerCase() === "img" ? 1 : element.querySelectorAll?.("img").length || 0;
      element.classList.toggle("oa2-selected-has-image", imageCount > 0);
    }
    updateScopeText();
  }

  function stopScopePicking() {
    if (typeof state.scope.cleanup === "function") {
      state.scope.cleanup();
    }
    state.scope.cleanup = null;
    state.scope.picking = false;
    resetScopeCandidateState();
    removeScopePickerModal();
    clearScopeOverlay();
  }

  function updateScopeCandidateFromEventTarget(target) {
    const chain = buildCandidateChain(target);
    if (!chain.length) {
      clearScopeOverlay();
      return;
    }
    const preferredIndex = chooseCandidateIndex(chain);
    const currentCandidate = getCurrentScopeCandidate();
    if (!state.scope.frozen && currentCandidate === chain[preferredIndex]) {
      return;
    }
    if (!state.scope.frozen) {
      setScopeCandidateChain(chain, preferredIndex, false);
    }
  }

  function nudgeScopeSelection(direction) {
    if (!state.scope.candidateChain.length) {
      return;
    }
    const nextIndex = clampValue(state.scope.chainIndex + direction, 0, state.scope.candidateChain.length - 1);
    state.scope.chainIndex = nextIndex;
    state.scope.frozen = true;
    updateScopeOverlayForCandidate();
  }

  function confirmScopeSelection() {
    const candidate = getCurrentScopeCandidate();
    if (!(candidate instanceof Element)) {
      setStatus("当前没有可确认的区域。");
      return;
    }
    setSelectedScope(candidate);
    stopScopePicking();
    openPanel();
    setStatus(`区域已选中：${describeElement(candidate)}。后续进入同域名页面时会优先尝试复用这个区域。`);
  }

  function cancelScopePicking() {
    stopScopePicking();
    openPanel();
    setStatus("已取消区域选择。");
  }

  function clearSelectedScope() {
    stopScopePicking();
    const previous = getScopeRoot();
    if (previous) {
      previous.classList.remove("oa2-scope-selected");
    }
    state.scope.root = null;
    state.scope.signature = "";
    removeScopeForCurrentSite();
    updateScopeText();
    setStatus("已清除显式区域选择，并移除该站点记住的默认区域。后续分析将回退到文本选区或整页。");
  }

  function startScopePicking() {
    if (state.scope.picking) {
      setStatus("区域选择已开启，请在页面中移动鼠标预览并确认。");
      return;
    }
    stopScopePicking();
    state.scope.picking = true;
    closePanel();
    clearScopeOverlay();
    setStatus("请选择要分析的区域：移动鼠标高亮预览，直接点击目标区域即可。按 Esc 或点取消退出。");

    const modal = document.createElement("div");
    modal.id = "oa2-picker-modal";
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483645;
      pointer-events: none;
    `;
    const hint = document.createElement("div");
    hint.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(255, 255, 255, 0.96);
      border: 2px solid #2563eb;
      border-radius: 12px;
      padding: 22px 28px;
      min-width: 320px;
      max-width: 420px;
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22);
      color: #0f172a;
      font-family: "Inter", "Segoe UI", "PingFang SC", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      text-align: center;
      pointer-events: auto;
    `;
    hint.innerHTML = `
      <div style="margin-bottom:10px;font-weight:700;font-size:16px;">区域选择模式</div>
      <div id="oa2-picker-preview" style="margin-bottom:12px;color:#475569;">请直接点击要分析的区域</div>
      <div id="oa2-picker-meta" style="margin-bottom:14px;font-size:12px;color:#64748b;">按 Esc 或点击下方取消即可退出</div>
      <button type="button" id="oa2-picker-cancel" style="
        border: none;
        border-radius: 8px;
        background: #e2e8f0;
        color: #0f172a;
        padding: 8px 14px;
        font-weight: 600;
        cursor: pointer;
      ">取消</button>
    `;
    modal.appendChild(hint);
    document.body.appendChild(modal);
    state.scope.modal = modal;
    const previewNode = hint.querySelector("#oa2-picker-preview");
    const metaNode = hint.querySelector("#oa2-picker-meta");

    const getPickTarget = (rawTarget) => {
      if (!(rawTarget instanceof Element) || isInsideOmniAgent(rawTarget) || hint.contains(rawTarget)) {
        return null;
      }
      const chain = buildCandidateChain(rawTarget);
      if (!chain.length) {
        return null;
      }
      return chain[chooseCandidateIndex(chain)] || rawTarget;
    };

    const onMove = (event) => {
      const target = getPickTarget(event.target);
      clearScopeHover();
      if (!target) {
        if (previewNode) {
          previewNode.textContent = "请直接点击要分析的区域";
        }
        if (metaNode) {
          metaNode.textContent = "按 Esc 或点击下方取消即可退出";
        }
        return;
      }
      state.scope.hover = target;
      target.classList.add("oa2-scope-hover");
      const textLength = String(target.innerText || target.textContent || "").trim().length;
      const imageCount = target.tagName?.toLowerCase() === "img" ? 1 : target.querySelectorAll?.("img").length || 0;
      if (previewNode) {
        previewNode.textContent = `当前候选：${describeElement(target)}${imageCount ? ` · 含图 ${imageCount}` : ""}`;
      }
      if (metaNode) {
        metaNode.textContent = `text=${textLength}${imageCount ? ` | 含图=${imageCount}` : ""} | 点击即可选中`;
      }
    };

    const onClick = async (event) => {
      if (hint.contains(event.target)) {
        return;
      }
      const target = getPickTarget(event.target);
      if (!target) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const previewText = String(target.innerText || target.textContent || "").trim();
      const charCount = previewText.length;
      const imageCount = target.tagName?.toLowerCase() === "img" ? 1 : target.querySelectorAll?.("img").length || 0;
      const preview = previewText.slice(0, 400);
      if (charCount < 30) {
        setStatus("区域内容太短了，请点一个包含更多文本的区域。");
        return;
      }
      if (charCount > 50000) {
        setStatus("区域内容太长了，像是整页。请点更具体的区域。");
        return;
      }
      stopScopePicking();
      runtimeMask.resetSequence("区域选择确认", 1);
      runtimeMask.setStatus("executing", "确认分析区域", `候选区域：${describeElement(target)}`);
      runtimeMask.pushHistory("question", `候选区域 text=${charCount}${imageCount ? ` | 含图=${imageCount}` : ""}`, "区域选择");
      const scopeChoice = await waitForRuntimeChoice(buildScopeSelectionChoiceAction(target, charCount, imageCount, preview), []);
      runtimeMask.hide();
      if (!scopeChoice || String(scopeChoice.value || "").trim().toLowerCase() === "cancel") {
        setStatus("已取消本次区域选择。");
        openPanel();
        return;
      }
      setSelectedScope(target);
      openPanel();
      setStatus(`区域已绑定：${describeElement(target)}${imageCount ? `，包含 ${imageCount} 张图片` : ""}。后续同域名页面会优先复用这个区域。`);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelScopePicking();
      }
    };

    const cancelBtn = hint.querySelector("#oa2-picker-cancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        cancelScopePicking();
      });
    }

    document.addEventListener("mouseover", onMove, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyDown, true);
    state.scope.cleanup = () => {
      document.removeEventListener("mouseover", onMove, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }

  function pickSelectionAnchorElement() {
    const scopeRoot = getScopeRoot();
    if (scopeRoot) {
      return scopeRoot;
    }
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) {
      return null;
    }
    let node = selection.getRangeAt(0).commonAncestorContainer;
    if (node && node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }
    if (!(node instanceof Element)) {
      return null;
    }
    let current = node;
    while (current && current !== document.body) {
      const rect = current.getBoundingClientRect();
      if (rect.width >= 180 && rect.height >= 48) {
        return current;
      }
      current = current.parentElement;
    }
    return node instanceof Element ? node : null;
  }

  function pickSnapshotElement() {
    const scopeRoot = getScopeRoot();
    if (scopeRoot) {
      return scopeRoot;
    }
    const selectedRoot = pickSelectionAnchorElement();
    if (selectedRoot) {
      return selectedRoot;
    }
    return (
      document.querySelector("main, article, form, [role='main'], .main, #main, .content, #content") ||
      document.body
    );
  }

  function buildWrappedLines(ctx, text, maxWidth) {
    const safeText = String(text || "").replace(/\s+/g, " ").trim();
    if (!safeText) {
      return [];
    }
    const words = safeText.split(" ");
    const lines = [];
    let current = "";
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
        return;
      }
      if (current) {
        lines.push(current);
      }
      current = word;
    });
    if (current) {
      lines.push(current);
    }
    return lines;
  }

  function inlineCloneStyles(source, target) {
    if (!(source instanceof Element) || !(target instanceof Element)) {
      return;
    }
    const blockedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "VIDEO", "AUDIO", "CANVAS"]);
    if (blockedTags.has(source.tagName)) {
      target.remove();
      return;
    }

    const computed = window.getComputedStyle(source);
    const cssText = Array.from(computed)
      .map((name) => `${name}:${computed.getPropertyValue(name)};`)
      .join("");
    target.setAttribute("style", cssText);

    if (source instanceof HTMLInputElement || source instanceof HTMLTextAreaElement || source instanceof HTMLSelectElement) {
      target.setAttribute("value", source.value || "");
      target.textContent = source.value || "";
    }

    if (source instanceof HTMLInputElement && source.checked) {
      target.setAttribute("checked", "checked");
    }

    const sourceChildren = Array.from(source.children);
    const targetChildren = Array.from(target.children);
    sourceChildren.forEach((child, index) => {
      inlineCloneStyles(child, targetChildren[index]);
    });
  }

  function extractFilenameFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const pathname = parsed.pathname || "";
      const raw = pathname.split("/").pop() || "";
      return raw ? decodeURIComponent(raw).slice(0, 80) : "";
    } catch (error) {
      return "";
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("blob read failed"));
      reader.readAsDataURL(blob);
    });
  }

  function parseContentTypeFromHeaders(rawHeaders) {
    const match = String(rawHeaders || "").match(/content-type:\s*([^\r\n;]+)/i);
    return match ? String(match[1] || "").trim() : "";
  }

  function requestImageBlobWithGM(url, timeoutMs = 4800) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: timeoutMs,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          Referer: location.href,
        },
        onload(response) {
          if (response.status >= 400) {
            reject(new Error(response.statusText || `GM image fetch failed (${response.status})`));
            return;
          }
          const contentType = parseContentTypeFromHeaders(response.responseHeaders) || "image/jpeg";
          const raw = response.response;
          if (!raw || (raw.byteLength !== undefined && raw.byteLength <= 0)) {
            reject(new Error("GM image fetch returned empty body"));
            return;
          }
          resolve(new Blob([raw], { type: contentType }));
        },
        onerror(error) {
          reject(new Error(error?.error || error?.details || error?.message || "GM image fetch failed"));
        },
        ontimeout() {
          reject(new Error(`GM image fetch timeout (${timeoutMs}ms)`));
        },
      });
    });
  }

  async function fetchImageAsDataUrl(url) {
    let lastError = null;
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "force-cache",
        mode: "cors",
      });
      if (!response.ok) {
        throw new Error(`image fetch failed: ${response.status}`);
      }
      const blob = await response.blob();
      if (!blob || !String(blob.type || "").startsWith("image/")) {
        throw new Error("not an image blob");
      }
      return blobToDataUrl(blob);
    } catch (error) {
      lastError = error;
    }
    if (typeof GM_xmlhttpRequest === "function") {
      const blob = await requestImageBlobWithGM(url);
      if (!blob || !String(blob.type || "").startsWith("image/")) {
        throw new Error("GM fetched resource is not an image blob");
      }
      return blobToDataUrl(blob);
    }
    throw lastError || new Error("image fetch failed");
  }

  async function hydrateSnapshotImages(sourceRoot, cloneRoot) {
    const sourceImages =
      sourceRoot instanceof HTMLImageElement ? [sourceRoot] : Array.from(sourceRoot.querySelectorAll("img"));
    const cloneImages =
      cloneRoot instanceof HTMLImageElement ? [cloneRoot] : Array.from(cloneRoot.querySelectorAll("img"));
    let inlinedCount = 0;
    for (let index = 0; index < sourceImages.length; index += 1) {
      const sourceImage = sourceImages[index];
      const cloneImage = cloneImages[index];
      if (!(sourceImage instanceof HTMLImageElement) || !(cloneImage instanceof HTMLImageElement)) {
        continue;
      }
      const currentSrc = sourceImage.currentSrc || sourceImage.src || "";
      const fallbackLabel = sourceImage.alt || extractFilenameFromUrl(currentSrc) || "[image]";
      if (!currentSrc) {
        cloneImage.removeAttribute("src");
        cloneImage.setAttribute("alt", fallbackLabel);
        continue;
      }
      if (currentSrc.startsWith("data:") || currentSrc.startsWith("blob:") || currentSrc.startsWith(location.origin)) {
        cloneImage.setAttribute("src", currentSrc);
        inlinedCount += 1;
        continue;
      }
      try {
        const dataUrl = await fetchImageAsDataUrl(currentSrc);
        if (dataUrl) {
          cloneImage.setAttribute("src", dataUrl);
          inlinedCount += 1;
          continue;
        }
      } catch (error) {
        console.warn("OmniAgent image inline fallback:", currentSrc, error);
      }
      cloneImage.removeAttribute("src");
      cloneImage.setAttribute("alt", fallbackLabel);
    }
    return inlinedCount;
  }

  async function renderNodeSnapshot(element) {
    if (!(element instanceof Element)) {
      throw new Error("no snapshot element");
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 20) {
      throw new Error("snapshot target too small");
    }

    const cloned = element.cloneNode(true);
    inlineCloneStyles(element, cloned);
    const inlinedImageCount = await hydrateSnapshotImages(element, cloned);
    const targetWidth = Math.max(320, Math.ceil(rect.width));
    const targetHeight = Math.max(180, Math.ceil(rect.height));
    const scale = Math.min(1, 1280 / targetWidth, 900 / targetHeight);
    const canvasWidth = Math.max(320, Math.ceil(targetWidth * scale));
    const canvasHeight = Math.max(180, Math.ceil(targetHeight * scale));
    const serialized = new XMLSerializer().serializeToString(cloned);
    const xhtml = `
      <div xmlns="http://www.w3.org/1999/xhtml" style="width:${targetWidth}px;height:${targetHeight}px;overflow:hidden;background:#ffffff;">
        ${serialized}
      </div>
    `;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${targetWidth}" height="${targetHeight}" viewBox="0 0 ${targetWidth} ${targetHeight}">
        <foreignObject width="100%" height="100%">${xhtml}</foreignObject>
      </svg>
    `;
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("snapshot image load failed"));
      img.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas unavailable");
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      image: canvas.toDataURL("image/jpeg", 0.62),
      inlined_image_count: inlinedImageCount,
    };
  }

  function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error(`${label || "operation"} timeout`)), timeoutMs);
      }),
    ]);
  }

  async function renderTextFallbackImage(text) {
    const canvas = document.createElement("canvas");
    canvas.width = 1100;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 34px Segoe UI, PingFang SC, sans-serif";
    ctx.fillText(document.title.slice(0, 48) || "OmniAgent Context Snapshot", 48, 68);
    ctx.font = "18px Segoe UI, PingFang SC, sans-serif";
    ctx.fillStyle = "#334155";
    const urlLines = buildWrappedLines(ctx, location.href, 1000).slice(0, 2);
    urlLines.forEach((line, index) => ctx.fillText(line, 48, 108 + index * 24));

    ctx.fillStyle = "#1e293b";
    ctx.font = "bold 22px Segoe UI, PingFang SC, sans-serif";
    ctx.fillText("Visible Text Snapshot", 48, 176);
    ctx.font = "18px Segoe UI, PingFang SC, sans-serif";
    ctx.fillStyle = "#0f172a";
    buildWrappedLines(ctx, text || pickText() || "No visible text extracted.", 1000)
      .slice(0, 18)
      .forEach((line, index) => {
        ctx.fillText(line, 48, 214 + index * 26);
      });

    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 2;
    ctx.strokeRect(36, 34, canvas.width - 72, canvas.height - 68);
    return canvas.toDataURL("image/jpeg", 0.72);
  }

  async function captureContextImage(text) {
    const target = pickSnapshotElement();
    const embeddedImageCount = target
      ? target.tagName?.toLowerCase() === "img"
        ? 1
        : target.querySelectorAll?.("img").length || 0
      : 0;
    if (target) {
      try {
        const snapshot = await withTimeout(renderNodeSnapshot(target), 1800, "snapshot");
        const visualGrounded = embeddedImageCount === 0 || Number(snapshot?.inlined_image_count || 0) >= embeddedImageCount;
        return {
          image: snapshot?.image || null,
          source: target === document.body ? "page" : "selection",
          image_count: snapshot?.image ? 1 : 0,
          embedded_image_count: embeddedImageCount,
          inlined_image_count: Number(snapshot?.inlined_image_count || 0),
          snapshot_kind: "selection_snapshot",
          visual_grounded: visualGrounded,
          visual_partial: embeddedImageCount > 0 && Number(snapshot?.inlined_image_count || 0) < embeddedImageCount,
          selection_desc: describeElement(target),
        };
      } catch (error) {
        console.warn("OmniAgent snapshot fallback:", error);
        setStatus("页面截图超时，已自动回退到文本卡片分析。");
      }
    }
    const fallback = await renderTextFallbackImage(text);
    return {
      image: fallback,
      source: "text_card",
      image_count: fallback ? 1 : 0,
      embedded_image_count: embeddedImageCount,
      inlined_image_count: 0,
      snapshot_kind: "text_card",
      visual_grounded: false,
      selection_desc: target ? describeElement(target) : "",
    };
  }

  function ensureElementId(element) {
    if (!element.dataset.omniagentElementId) {
      element.dataset.omniagentElementId = `oa2_el_${Math.random().toString(36).slice(2, 10)}`;
    }
    return element.dataset.omniagentElementId;
  }

  function makeSelectorCandidates(element) {
    const target = element instanceof Element ? element : null;
    if (!target) {
      return [];
    }
    const candidates = [];
    const stableSelector = buildStableSelectorForElement(target);
    if (stableSelector) {
      candidates.push(stableSelector);
    }
    if (target.id) {
      candidates.push(`#${CSS.escape(target.id)}`);
    }
    if (target.name) {
      candidates.push(`${target.tagName.toLowerCase()}[name="${CSS.escape(target.name)}"]`);
    }
    if (target.type) {
      candidates.push(`${target.tagName.toLowerCase()}[type="${CSS.escape(target.type)}"]`);
    }
    const classNames = getStableClassNames(target);
    if (classNames.length) {
      candidates.push(
        `${target.tagName.toLowerCase()}.${classNames
          .slice(0, 2)
          .map((item) => CSS.escape(item))
          .join(".")}`
      );
    }
    return Array.from(new Set(candidates)).slice(0, 3);
  }

  function inferLabel(element) {
    return (
      element.getAttribute("aria-label") ||
      element.getAttribute("placeholder") ||
      element.innerText ||
      element.value ||
      element.name ||
      element.id ||
      element.tagName.toLowerCase()
    )
      .trim()
      .slice(0, 80);
  }

  function inferNearbyText(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    const candidates = [
      element.closest("label"),
      element.previousElementSibling,
      element.parentElement,
      element.closest("form, section, article, li, tr, td, th, div"),
    ].filter(Boolean);
    for (const node of candidates) {
      const text = String(node.innerText || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (text && text.length <= 200) {
        return text.slice(0, 200);
      }
    }
    return "";
  }

  function buildSemanticAnchorsFromElement(element) {
    if (!(element instanceof Element)) {
      return [];
    }
    const anchor = {
      tag: element.tagName.toLowerCase(),
      role: String(element.getAttribute("role") || "").trim(),
      label: String(element.getAttribute("aria-label") || element.innerText || element.value || "").replace(/\s+/g, " ").trim().slice(0, 160),
      placeholder: String(element.getAttribute("placeholder") || "").trim().slice(0, 160),
      nearby_text: inferNearbyText(element),
    };
    if (!anchor.label && !anchor.placeholder && !anchor.nearby_text && !anchor.role) {
      return [];
    }
    return [anchor];
  }

  function collectDomCandidates() {
    state.elementRegistry.clear();
    const scopeRoot = getActionSearchRoot();
    const raw = getInteractiveCandidates(scopeRoot, FALLBACK_DOM_CANDIDATE_LIMIT);

    return raw.map((element) => {
      const elementId = ensureElementId(element);
      state.elementRegistry.set(elementId, element);
      return {
        element_id: elementId,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        label: element.getAttribute("aria-label") || "",
        text: (element.innerText || element.value || "").trim().slice(0, 80),
        placeholder: element.getAttribute("placeholder") || "",
        nearby_text: inferNearbyText(element),
        selector_candidates: makeSelectorCandidates(element),
        semantic_anchors: buildSemanticAnchorsFromElement(element),
        is_visible: true,
      };
    });
  }

  function classifyPageKind(scopeRoot, text) {
    const host = String(location.host || "").toLowerCase();
    const pathname = String(location.pathname || "").toLowerCase();
    const sample = String(text || "").slice(0, 2000).toLowerCase();
    if (scopeRoot instanceof HTMLFormElement || scopeRoot?.querySelector?.("form")) {
      return "form";
    }
    if (scopeRoot?.matches?.("table") || scopeRoot?.querySelector?.("table")) {
      return "table";
    }
    if (host.includes("github.com")) {
      return "repo";
    }
    if (host.includes("reddit") || host.includes("tieba") || host.includes("forum") || pathname.includes("forum")) {
      return "forum";
    }
    if (sample.includes("poc") || sample.includes("payload") || sample.includes("漏洞")) {
      return "security_report";
    }
    if (sample.includes("abstract") || sample.includes("introduction") || sample.includes("references")) {
      return "paper";
    }
    if (scopeRoot?.matches?.("article, main") || scopeRoot?.querySelector?.("article")) {
      return "article";
    }
    return "generic_page";
  }

  function collectBrowserState(domCandidates, text) {
    const scopeRoot = getScopeRoot() || pickSelectionAnchorElement() || document.body;
    const scopeSignature = scopeRoot instanceof Element ? describeElement(scopeRoot) : "page";
    const viewportSummary = `${window.innerWidth}x${window.innerHeight} @ (${Math.round(window.scrollX)},${Math.round(window.scrollY)})`;
    const totalCount = Array.isArray(domCandidates) ? domCandidates.length : 0;
    const overflowSummary = buildDomCandidateOverflowSummary(domCandidates);
    const interactiveSummary = (domCandidates || [])
      .slice(0, PAGE_AGENT_INTERACTIVE_SUMMARY_LIMIT)
      .map((item, index) => `${index + 1}.${item.tag}${item.label ? `:${String(item.label).slice(0, 32)}` : item.text ? `:${String(item.text).slice(0, 32)}` : ""}`)
      .join(" | ");
    return {
      page_kind: classifyPageKind(scopeRoot, text),
      scope_signature: scopeSignature,
      interactive_count: totalCount,
      viewport_summary: viewportSummary,
      interactive_summary: interactiveSummary,
      dom_candidates: Array.isArray(domCandidates) ? domCandidates.slice(0, PAGE_AGENT_BROWSER_STATE_CANDIDATE_LIMIT) : [],
      dom_candidate_total: totalCount,
      dom_candidate_overflow_count: Math.max(0, totalCount - PAGE_AGENT_BROWSER_STATE_CANDIDATE_LIMIT),
      dom_candidate_overflow_summary: overflowSummary,
    };
  }

  function getApiBaseCandidates() {
    return Array.from(new Set([API_BASE, localStorage.getItem(API_BASE_STORAGE_KEY), ...API_BASE_FALLBACKS].filter(Boolean)));
  }

  async function requestTextWithFetch(url, timeoutMs) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId = 0;
    if (controller) {
      timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        throw new Error(response.statusText || `请求失败 (${response.status})`);
      }
      return await response.text();
    } catch (error) {
      const aborted = error?.name === "AbortError";
      throw new Error(aborted ? `请求超时（${timeoutMs}ms）` : error?.message || "请求失败");
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  function requestTextWithGM(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: timeoutMs,
        onload(response) {
          if (response.status >= 400) {
            reject(new Error(response.statusText || `请求失败 (${response.status})`));
            return;
          }
          resolve(response.responseText || "");
        },
        onerror(error) {
          reject(new Error(error?.error || error?.details || error?.message || "请求失败"));
        },
        ontimeout() {
          reject(new Error(`请求超时（${timeoutMs}ms）`));
        },
      });
    });
  }

  async function fetchTextResource(path, timeoutMs = API_REQUEST_TIMEOUTS.standard) {
    const candidates = getApiBaseCandidates();
    let lastError = null;
    for (const baseUrl of candidates) {
      const url = `${baseUrl}${path}`;
      try {
        const text = await requestTextWithGM(url, timeoutMs);
        if (API_BASE !== baseUrl) {
          API_BASE = baseUrl;
          localStorage.setItem(API_BASE_STORAGE_KEY, baseUrl);
        }
        return text;
      } catch (error) {
        lastError = error;
      }
      try {
        const text = await requestTextWithFetch(url, timeoutMs);
        if (API_BASE !== baseUrl) {
          API_BASE = baseUrl;
          localStorage.setItem(API_BASE_STORAGE_KEY, baseUrl);
        }
        return text;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("资源请求失败");
  }

  function getRequestTimeoutMs(method, path, payload) {
    const normalizedPath = String(path || "").split("?")[0];
    if (normalizedPath === "/api/health" || normalizedPath === "/api/capabilities") {
      return API_REQUEST_TIMEOUTS.quick;
    }
    if (
      normalizedPath === "/api/personas" ||
      normalizedPath === "/api/skills" ||
      normalizedPath === "/api/workflows" ||
      normalizedPath === "/api/query-templates" ||
      normalizedPath === "/api/documents" ||
      normalizedPath === "/api/stats" ||
      normalizedPath === "/api/traces" ||
      normalizedPath === "/api/workflow-heal-events" ||
      method === "GET"
    ) {
      return API_REQUEST_TIMEOUTS.standard;
    }
    if (normalizedPath === "/api/analyze") {
      const imageCount = Array.isArray(payload?.images) ? payload.images.filter(Boolean).length : 0;
      return imageCount > 0 ? API_REQUEST_TIMEOUTS.vision : API_REQUEST_TIMEOUTS.xlong;
    }
    if (normalizedPath === "/api/chat" || normalizedPath === "/api/teach") {
      return API_REQUEST_TIMEOUTS.xlong;
    }
    if (
      normalizedPath === "/api/teach/confirm" ||
      normalizedPath === "/api/teach/reject" ||
      normalizedPath === "/api/workflows/record" ||
      normalizedPath === "/api/workflows/heal" ||
      normalizedPath === "/api/rag/upload"
    ) {
      return API_REQUEST_TIMEOUTS.long;
    }
    return API_REQUEST_TIMEOUTS.default;
  }

  async function parseJsonResponse(response, baseUrl) {
    const rawText = await response.text();
    if (!rawText) {
      if (response.ok) {
        return {};
      }
      throw {
        type: "http",
        baseUrl,
        payload: { error: { message: response.statusText || `请求失败 (${response.status})` } },
        status: response.status,
        transport: "fetch",
      };
    }
    try {
      const parsed = JSON.parse(rawText);
      if (!response.ok) {
        throw {
          type: "http",
          baseUrl,
          payload: parsed,
          status: response.status,
          transport: "fetch",
        };
      }
      return parsed;
    } catch (error) {
      if (error?.type) {
        throw error;
      }
      throw {
        type: "parse",
        baseUrl,
        payload: { error: { message: `响应解析失败: ${error.message}` } },
        status: response.status,
        transport: "fetch",
      };
    }
  }

  async function requestWithFetch(baseUrl, method, path, payload, timeoutMs) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timeoutId = 0;
    if (controller) {
      timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    }
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: payload ? { "Content-Type": "application/json" } : {},
        body: payload ? JSON.stringify(payload) : undefined,
        credentials: "omit",
        signal: controller ? controller.signal : undefined,
      });
      state.lastTransport = "fetch";
      return await parseJsonResponse(response, baseUrl);
    } catch (error) {
      if (error?.type) {
        throw error;
      }
      const aborted = error?.name === "AbortError";
      throw {
        type: "network",
        baseUrl,
        payload: {
          error: {
            message: aborted
              ? `请求超时（${timeoutMs}ms）`
              : error?.message || "请求失败",
          },
        },
        status: 0,
        transport: "fetch",
      };
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  function requestWithGM(baseUrl, method, path, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestConfig = {
        method,
        url: `${baseUrl}${path}`,
        timeout: timeoutMs,
        onload(response) {
          try {
            const rawText = response.responseText || "";
            const parsed = rawText ? JSON.parse(rawText) : {};
            if (response.status >= 400) {
              reject({ type: "http", baseUrl, payload: parsed, status: response.status, transport: "gm" });
              return;
            }
            state.lastTransport = "gm";
            resolve(parsed);
          } catch (error) {
            reject({
              type: "parse",
              baseUrl,
              payload: { error: { message: `响应解析失败: ${error.message}` } },
              status: response.status,
              transport: "gm",
            });
          }
        },
        onerror(error) {
          reject({
            type: "network",
            baseUrl,
            payload: { error: { message: error?.error || error?.details || error?.message || "请求失败" } },
            status: 0,
            transport: "gm",
          });
        },
        ontimeout() {
          reject({
            type: "network",
            baseUrl,
            payload: { error: { message: `请求超时（${timeoutMs}ms）` } },
            status: 0,
            transport: "gm",
          });
        },
      };
      if (payload) {
        requestConfig.headers = { "Content-Type": "application/json" };
        requestConfig.data = JSON.stringify(payload);
      }
      GM_xmlhttpRequest(requestConfig);
    });
  }

  async function requestAgainstBase(baseUrl, method, path, payload) {
    const timeoutMs = getRequestTimeoutMs(method, path, payload);
    const attempts = [];
    try {
      return await requestWithGM(baseUrl, method, path, payload, timeoutMs);
    } catch (error) {
      attempts.push(error);
    }
    try {
      return await requestWithFetch(baseUrl, method, path, payload, timeoutMs);
    } catch (error) {
      attempts.push(error);
    }
    const combinedMessage = attempts
      .map((item) => `${item?.transport || item?.type || "unknown"}:${item?.payload?.error?.message || "unknown error"}`)
      .join(" | ");
    throw attempts[attempts.length - 1] || {
      type: "network",
      baseUrl,
      payload: { error: { message: combinedMessage || "请求失败" } },
      status: 0,
    };
  }

  async function apiRequest(method, path, payload) {
    const candidates = getApiBaseCandidates();
    let lastError = null;
    for (const baseUrl of candidates) {
      try {
        const result = await requestAgainstBase(baseUrl, method, path, payload);
        if (API_BASE !== baseUrl) {
          API_BASE = baseUrl;
          localStorage.setItem(API_BASE_STORAGE_KEY, baseUrl);
        }
        return result;
      } catch (error) {
        lastError = error;
        if (error?.type === "http") {
          throw error.payload || { error: { message: "请求失败" } };
        }
      }
    }
    if (lastError?.payload) {
      throw lastError.payload;
    }
    throw { error: { message: "无法连接本地 OmniAgent 服务，请确认 127.0.0.1:8765 已启动。" } };
  }

  function buildHealthDiagnosticHint(health) {
    const providers = Array.isArray(health?.providers) ? health.providers : [];
    const activeProvider = providers.find((item) => item?.configured) || providers[0] || null;
    const reasonText = Object.values(health?.task_reasons || {})
      .map((item) => String(item || ""))
      .join(" ; ");
    if (
      activeProvider &&
      String(activeProvider.provider_id || "").trim() === "ccswitch" &&
      /503 Server Error|Service Unavailable/i.test(reasonText) &&
      String(health?.ccswitch_endpoint || "").trim()
    ) {
      const modelName = String(activeProvider.model_name || "").trim() || "unknown";
      const hints = [
        `127.0.0.1:15721 这一层已经通了，但它自己对 /v1/chat/completions 返回 503，所以问题不在 OmniAgent 的 8765 端口。`,
        modelName.toLowerCase() === "auto" ? "当前 CCSWITCH_MODEL=auto；如果 CC Switch 不接受 auto，请改成实际模型名。" : "",
        "请在 CC Switch 中确认上游 provider 已登录，并启用匹配的代理应用；如果你现在走的是 OpenAI-compatible 接口，通常要打开 Codex/OpenAI-compatible 通道。",
      ].filter(Boolean);
      return hints.join(" ");
    }
    if (
      activeProvider &&
      String(activeProvider.provider_id || "").trim() === "ccswitch" &&
      String(activeProvider.provider_type || "").trim() === "anthropic" &&
      /anthropic probe failed|anthropic call failed|400 Client Error|HTTP 400/i.test(reasonText)
    ) {
      const modelName = String(activeProvider.model_name || "").trim() || "unknown";
      const sourceApp = String(activeProvider.source_app_type || "").trim();
      const sourceLabel = String(activeProvider.source_label || "").trim();
      const hints = [
        sourceApp || sourceLabel ? `当前命中的是 CC Switch 配置：${[sourceApp, sourceLabel].filter(Boolean).join("/")}` : "",
        modelName.toLowerCase() === "auto" ? "当前模型仍是 auto；这类 Anthropic 兼容公司网关通常要求明确模型名。" : `当前模型=${modelName}。`,
        /api_key=missing|x-api-key/i.test(reasonText) ? "当前请求大概率没有带上 x-api-key。" : "",
        /auth_token=missing|authorization/i.test(reasonText) ? "当前请求大概率没有带上 Authorization Bearer token。" : "",
        "如果 VSCode 里的 Claude Code 插件正常，而 OmniAgent 不正常，常见原因是插件内部配置了 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_DEFAULT_*_MODEL，但这些值不会自动传给 OmniAgent 后端进程。",
      ].filter(Boolean);
      return hints.join(" ");
    }
    return "";
  }

  async function checkHealth() {
    setHealthState("pending", "检查中");
    pruneStatusHistory(/健康检查失败|后端正常|后端降级|正在检查后端状态|诊断提示：/);
    setStatus("正在检查后端状态...");
    try {
      let health = null;
      let capabilities = null;
      let lastError = null;
      try {
        health = await apiRequest("GET", "/api/health");
      } catch (error) {
        lastError = error;
      }
      try {
        capabilities = await apiRequest("GET", "/api/capabilities");
      } catch (error) {
        lastError = error;
      }
      if (!health && !capabilities) {
        throw lastError || { error: { message: "本地服务不可达" } };
      }
      if (capabilities) {
        state.lastCapabilities = capabilities;
      }
      const reachableProviders = (health?.providers || []).filter((item) => item.ok);
      const providerList = reachableProviders
        .map((item) => item.provider_id)
        .join(", ");
      const degraded = !health || health.status !== "ok";
      const configuredProviderList = (health?.providers || [])
        .filter((item) => item.configured)
        .map((item) => item.provider_id)
        .join(", ");
      const activeProvider = (health?.providers || []).find((item) => item.configured) || (health?.providers || [])[0] || null;
      const providerBase = String(activeProvider?.base_url || "").trim();
      const providerModel = String(activeProvider?.model_name || "").trim();
      const routingMode = String(activeProvider?.routing_mode || "").trim();
      const activeProviderId = String(activeProvider?.provider_id || "").trim();
      const sourceAppType = String(activeProvider?.source_app_type || "").trim();
      const sourceLabel = String(activeProvider?.source_label || "").trim();
      const ccswitchEndpoint = String(health?.ccswitch_endpoint || "").trim();
      const showCcswitchEndpoint = Boolean(ccswitchEndpoint) && (activeProviderId === "ccswitch" || /ccswitch/i.test(routingMode));
      const systemProxy = String(health?.system_proxy || "").trim();
      const disabledProviderDetails = (health?.providers || [])
        .filter((item) => !item.configured && item.status_reason)
        .map((item) => `${item.provider_id}=${item.status_reason}`)
        .slice(0, 4)
        .join("; ");
      const failedTasks = Object.entries(health?.task_readiness || {})
        .filter(([, ok]) => !ok)
        .map(([task]) => `${task}=${health?.task_reasons?.[task] || "unavailable"}`)
        .join("; ");
      const healthLabel = health
        ? `${degraded ? "后端降级" : "后端正常"}：base=${API_BASE} | transport=${state.lastTransport} | db=${health.db?.sqlite ? "ok" : "fail"}，reachable=${providerList || "none"}，configured=${configuredProviderList || "none"}${providerBase ? ` | provider_base=${providerBase}` : ""}${providerModel ? ` | model=${providerModel}` : ""}${routingMode ? ` | routing=${routingMode}` : ""}${sourceAppType ? ` | source_app=${sourceAppType}` : ""}${sourceLabel ? ` | source_label=${sourceLabel}` : ""}${showCcswitchEndpoint ? ` | ccswitch=${ccswitchEndpoint}` : ""}${systemProxy ? ` | system_proxy=${systemProxy}` : ""}${health.status_reason ? ` | ${health.status_reason}` : ""}${failedTasks ? ` | failed=${failedTasks}` : ""}${disabledProviderDetails ? ` | disabled=${disabledProviderDetails}` : ""}`
        : `后端可达但状态未知：base=${API_BASE} | transport=${state.lastTransport} | 已读取 capabilities，health 接口本次未返回。`;
      setHealthState(degraded ? "error" : "ok", degraded ? "后端降级" : "后端正常");
      setStatus(healthLabel);
      const healthHint = buildHealthDiagnosticHint(health);
      if (healthHint) {
        setStatus(`诊断提示：${healthHint}`);
      }
      setDebug(
        `build=${BUILD_ID} | api_base=${API_BASE} | transport=${state.lastTransport} | capabilities=${JSON.stringify(capabilities || {})} | provider_status=${JSON.stringify(
          ((health && health.providers) || []).map((item) => ({ id: item.provider_id, configured: item.configured, ok: item.ok, reason: item.status_reason }))
        )}`
      );
    } catch (error) {
      setHealthState("error", "检查失败");
      setStatus(`健康检查失败：${error?.error?.message || "unknown error"}`);
    }
  }

  async function analyzePage() {
    if (!getScopeRoot()) {
      restoreScopeForCurrentSite();
    }
    switchView("results");
    closeMemoryPopover();
    const text = pickText();
    const contextKey = buildContextKey(text);
    const selectionExcerpt = buildSelectionExcerpt(text);
    const scopeMeta = buildScopeMeta(text);
    const pageState = await captureActionablePageState(text);
    const domCandidates = pageState.dom_candidates;
    const browserState = pageState.browser_state;
    state.lastContextKey = contextKey;
    setDebug(`build=${BUILD_ID} | context_key=${contextKey} | host=${location.host} | path=${location.pathname}`);
    setPanelState("results", "loading", "正在分析", getScopeRoot() ? "正在采集当前区域上下文，并准备生成结论与推荐动作。" : "正在采集整页上下文，并准备生成结论与推荐动作。");
    updateResultsLayout(state.lastAnalysis);
    setStatus(getScopeRoot() ? "正在采集当前区域上下文并分析..." : "正在采集整页上下文并分析...");

    let imagePayload = null;
    let imageSource = "none";
    let imageCount = 0;
    let embeddedImageCount = 0;
    let inlinedImageCount = 0;
    let snapshotKind = "none";
    let visualGrounded = false;
    let selectionDesc = "";
    try {
      const captured = await captureContextImage(text);
      imagePayload = captured?.image || null;
      imageSource = captured?.source || "none";
      imageCount = Number(captured?.image_count || 0);
      embeddedImageCount = Number(captured?.embedded_image_count || 0);
      inlinedImageCount = Number(captured?.inlined_image_count || 0);
      snapshotKind = String(captured?.snapshot_kind || "none");
      visualGrounded = Boolean(captured?.visual_grounded);
      selectionDesc = String(captured?.selection_desc || "");
    } catch (error) {
      imagePayload = null;
      imageSource = "none";
    }
    setStatus(
      `上下文已准备完成，正在向后端发送分析请求... | snapshot=${imageSource}/${snapshotKind}${imageCount ? ` | visual=${imageCount}` : ""}${embeddedImageCount ? ` | embedded_images=${embeddedImageCount}` : ""}${inlinedImageCount ? ` | inlined_images=${inlinedImageCount}` : ""}${imageCount ? ` | visual_grounded=${visualGrounded ? "yes" : "no"}` : ""} | timeout=${getRequestTimeoutMs("POST", "/api/analyze", {
        images: imagePayload ? [imagePayload] : [],
      })}ms`
    );

    const payload = {
      context_key: contextKey,
      text,
      image: imagePayload,
      images: imagePayload ? [imagePayload] : [],
      image_meta: {
        source: imageSource,
        image_count: imageCount,
        embedded_image_count: embeddedImageCount,
        inlined_image_count: inlinedImageCount,
        snapshot_kind: snapshotKind,
        visual_grounded: visualGrounded,
        selection_desc: selectionDesc,
      },
      page_meta: {
        url: location.href,
        title: document.title,
        host: location.host,
      },
      selection_excerpt: selectionExcerpt,
      scope_meta: scopeMeta,
      browser_state: browserState,
      dom_candidates: domCandidates,
    };
    state.analysisContextMediaByContext.set(contextKey, {
      context_key: contextKey,
      images: imagePayload ? [imagePayload] : [],
      image_meta: { ...payload.image_meta },
      selection_excerpt: selectionExcerpt,
      scope_meta: { ...scopeMeta },
      browser_state: { ...browserState },
      dom_candidates: domCandidates.slice(),
    });

    try {
      const result = await apiRequest("POST", "/api/analyze", payload);
      const enrichedResult = await enrichAnalysisWithWorkflowFallback({
        ...result,
        context_key: result.context_key || contextKey,
        selection_excerpt: result.selection_excerpt || selectionExcerpt,
        scope_meta: result.scope_meta || { ...scopeMeta },
      });
      state.actionsExpanded = false;
      state.lastAnalysis = enrichedResult;
      state.sessionByContext.set(contextKey, enrichedResult);
      renderAnalysis(enrichedResult);
      const quickActionCount = getQuickActions(enrichedResult).length;
      const evidenceCount = (enrichedResult.evidence_items || []).length;
      setPanelState(
        "results",
        "success",
        "分析完成",
        `已得到结论${quickActionCount ? `、${quickActionCount} 个推荐动作` : ""}${evidenceCount ? `，并整理出 ${evidenceCount} 条证据` : ""}。`
      );
      updateResultsLayout(enrichedResult);
      logAnalyzeDecisionTrace(enrichedResult);
      const highlightInfo = state.valueHighlights.length ? ` | highlights=${state.valueHighlights.length}` : "";
      const traceInfo = enrichedResult.trace_id ? ` | trace=${enrichedResult.trace_id}` : "";
      const visionInfo =
        imageCount > 0
          ? ` | image=${imageSource}/${snapshotKind} | visual_grounded=${visualGrounded ? "yes" : "no"}`
          : " | image=none";
      setStatus(`分析完成。上下文来源：text=${text ? "yes" : "no"}${visionInfo}${highlightInfo}${traceInfo}`);
    } catch (error) {
      setPanelState("results", "error", "分析失败", error?.error?.message || "unknown error");
      updateResultsLayout(state.lastAnalysis);
      setStatus(`分析失败：${error?.error?.message || "unknown error"}`);
    }
  }

  function focusTeachComposerWithText(text, statusMessage = "") {
    switchView("teach");
    const input = document.getElementById("oa2-teach-input");
    if (input) {
      input.value = String(text || "").trim();
      input.focus({ preventScroll: true });
      const length = input.value.length;
      if (typeof input.setSelectionRange === "function") {
        input.setSelectionRange(length, length);
      }
    }
    if (statusMessage) {
      setStatus(statusMessage);
    }
  }

  function buildResultFollowupPrompt(result) {
    const summary = String(result?.summary || "").trim() || "暂无明确结论";
    const domain = String(result?.matched_domain || result?.context_bar?.skill_label || "").trim() || "当前页面";
    const evidence = Array.isArray(result?.evidence_items) ? result.evidence_items : [];
    const firstEvidence = String(evidence[0]?.quote || evidence[0]?.title || "").trim();
    return [
      "基于刚才这次分析，继续帮我推进下一步页面处理。",
      `当前结论：${summary}`,
      `当前场景：${domain}`,
      firstEvidence ? `优先参考证据：${firstEvidence}` : "",
      "请直接告诉我下一步最稳妥的页面动作；如果可以执行，就整理成可执行动作。"
    ].filter(Boolean).join("\n");
  }

  function buildResultTeachPrompt(result) {
    const summary = String(result?.summary || "").trim() || "暂无明确结论";
    const domain = String(result?.matched_domain || result?.context_bar?.skill_label || "").trim() || "当前页面";
    return [
      "把这次页面分析整理成一条以后可复用的规则、skill 或 workflow 草案。",
      `当前结论：${summary}`,
      `当前场景：${domain}`,
      "如果更适合沉淀成 workflow，就给我 workflow 草案；如果更适合沉淀成长期规则，就给我 skill 草案。"
    ].join("\n");
  }

  function buildHealingFollowupPrompt(failureContext, patchedStep, result) {
    const workflowName = String(
      failureContext?.action?.workflow_name ||
        failureContext?.action?.label ||
        failureContext?.workflowId ||
        "当前 workflow"
    ).trim();
    const failedTarget = getWorkflowStepTargetLabel(failureContext?.action || {});
    const repairedTarget = getWorkflowStepTargetLabel(patchedStep || {});
    const version = Number.isInteger(result?.version) ? `v${result.version}` : "最新版本";
    return [
      "基于刚才这次 workflow 自愈，帮我整理后续动作或沉淀建议。",
      `当前流程：${workflowName}`,
      `修补版本：${version}`,
      `失败步骤目标：${failedTarget || "未命名步骤"}`,
      repairedTarget ? `修补后目标：${repairedTarget}` : "",
      "请先判断这次修补更适合继续观察执行效果、补充成长期规则，还是整理成更稳妥的 workflow 改进建议。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  function openMemoryViewWithStatus(statusMessage = "") {
    switchView("memory");
    loadMemory().catch((error) => {
      setStatus(`记忆读取失败：${error?.message || "unknown error"}`);
    });
    if (statusMessage) {
      setStatus(statusMessage);
    }
  }

  function buildHealEventFollowupPrompt(healEvent, workflowLabel) {
    const patchedStep = healEvent?.new_step_json && typeof healEvent.new_step_json === "object" ? healEvent.new_step_json : {};
    const oldStep = healEvent?.old_step_json && typeof healEvent.old_step_json === "object" ? healEvent.old_step_json : {};
    const traceId = String(healEvent?.trace_id || "").trim();
    const reason = String(healEvent?.reason || "").trim() || "patched";
    const stepNumber = Number.isInteger(healEvent?.step_index) ? healEvent.step_index + 1 : null;
    return [
      "基于这次 workflow 自愈记录，帮我判断是否还需要继续沉淀规则或复核流程。",
      `流程：${workflowLabel || String(healEvent?.workflow_id || "").trim() || "当前 workflow"}`,
      stepNumber ? `修补步骤：第 ${stepNumber} 步` : "",
      `修补原因：${reason}`,
      getWorkflowStepTargetLabel(oldStep) ? `旧目标：${getWorkflowStepTargetLabel(oldStep)}` : "",
      getWorkflowStepTargetLabel(patchedStep) ? `新目标：${getWorkflowStepTargetLabel(patchedStep)}` : "",
      traceId ? `关联 trace：${traceId}` : "",
      "请先判断这次修补是一次性页面漂移，还是应该继续沉淀成更稳妥的 workflow / skill 规则。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  function buildTraceFollowupPrompt(trace, workflowLabels = [], memoryLabels = []) {
    const workflowReason = String(trace?.workflow_selection_reason || "").trim();
    const memoryReason = String(trace?.memory_selection_reason || "").trim();
    const traceId = String(trace?.trace_id || "").trim() || "unknown";
    return [
      "基于这条 Trace，帮我判断当前 workflow / memory 选择是否合理，并给出下一步建议。",
      `Trace：${traceId}`,
      workflowLabels.length ? `已选 workflow：${workflowLabels.join("；")}` : "已选 workflow：无",
      memoryLabels.length ? `已选 memory：${memoryLabels.join("；")}` : "已选 memory：无",
      workflowReason ? `workflow 理由：${workflowReason}` : "",
      memoryReason ? `memory 理由：${memoryReason}` : "",
      "如果当前选择不够稳妥，请直接告诉我应该补哪类记忆、workflow 或页面动作。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  function buildTemplateFollowupPrompt(template) {
    const name = String(template?.name || template?.template_id || "查询模板").trim();
    const summary = String(template?.summary || "").trim();
    const queryTemplate = String(template?.query_template || "").trim();
    const requiredFields = Array.isArray(template?.required_fields) ? template.required_fields.filter(Boolean) : [];
    return [
      "基于这条查询模板，帮我判断当前页面要怎么继续用它推进分析或复核。",
      `模板：${name}`,
      summary ? `用途：${summary}` : "",
      queryTemplate ? `查询模板：${queryTemplate}` : "",
      requiredFields.length ? `必填字段：${requiredFields.join("、")}` : "",
      "请先判断当前页面已经有哪些字段可直接复用；如果还缺字段，就告诉我下一步该先补什么。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  function buildDocumentFollowupPrompt(documentItem) {
    const name = String(documentItem?.name || documentItem?.document_id || "知识文档").trim();
    const namespace = String(documentItem?.namespace || "").trim();
    const docType = String(documentItem?.doc_type || "").trim();
    const snippet = String(documentItem?.content_text || "").replace(/\s+/g, " ").trim();
    return [
      "基于这份知识文档，帮我把当前页面的分析或复核动作往前推进。",
      `文档：${name}`,
      namespace ? `命名空间：${namespace}` : "",
      docType ? `类型：${docType}` : "",
      snippet ? `参考摘要：${snippet.slice(0, 180)}${snippet.length > 180 ? "..." : ""}` : "",
      "请告诉我这份文档里哪几条最值得立刻用于当前页面。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  function describeQuickActionKind(action) {
    if (isWorkflowQuickAction(action)) {
      return "workflow";
    }
    const type = String(action?.action_type || "").trim().toLowerCase();
    if (type === "execute_browser_actions") {
      return "browser";
    }
    if (type === "open_link") {
      return "link";
    }
    if (type === "copy_query") {
      return "query";
    }
    return "action";
  }

  async function runQuickAction(action) {
    const actionType = String(action?.action_type || "").trim();
    if (isWorkflowQuickAction(action)) {
      return executeSuggestedWorkflow(action);
    }
    if (actionType === "open_link") {
      window.open(action.url, "_blank", "noopener");
      return { success: true, executedCount: 0, message: "已打开链接。" };
    }
    if (actionType === "copy_query") {
      const content = action.query || "";
      try {
        await navigator.clipboard.writeText(content);
        setStatus(`已复制查询：${action.label || "模板"}`);
      } catch (error) {
        setStatus("复制查询失败，请手动复制。");
      }
      if (action.url) {
        window.open(action.url, "_blank", "noopener");
      }
      return { success: true, executedCount: 0, message: "已复制查询。" };
    }
    if (actionType === "execute_browser_actions") {
      return executeBrowserActions(action.browser_actions || [], action.label || "页面动作");
    }
    if (Array.isArray(action?.browser_actions) && action.browser_actions.length) {
      return executeBrowserActions(action.browser_actions, action.label || "页面动作");
    }
    setStatus("当前动作还不能直接执行。");
    return { success: false, executedCount: 0, message: "当前动作还不能直接执行。" };
  }

  function renderAnalysis(result, options = {}) {
    const summaryNode = document.getElementById("oa2-summary");
    const summaryMetaNode = document.getElementById("oa2-summary-meta");
    const gridNode = document.getElementById("oa2-extracted-grid");
    const evidenceNode = document.getElementById("oa2-evidence-list");
    const actionNode = document.getElementById("oa2-actions-list");
    const nextSummaryNode = document.getElementById("oa2-next-summary");
    const nextMetaNode = document.getElementById("oa2-next-meta");
    const nextActionsNode = document.getElementById("oa2-next-actions");
    if (!summaryNode || !summaryMetaNode || !gridNode || !evidenceNode || !actionNode || !nextSummaryNode || !nextMetaNode || !nextActionsNode) {
      setStatus("前端界面尚未完全挂载，已跳过结果渲染。请重开面板后重试。");
      return;
    }
    summaryNode.textContent = result.summary || "无结论";
    summaryMetaNode.innerHTML = "";
    gridNode.innerHTML = "";
    evidenceNode.innerHTML = "";
    actionNode.innerHTML = "";
    nextActionsNode.innerHTML = "";
    updateResultsLayout(result);

    setContextBar(result);

    const extracted = result.extracted_fields || {};
    const fieldPriority = ["process_name", "md5", "sha256", "ip", "domain", "host", "url", "file_path", "email"];
    const hiddenFieldKeys = new Set(["page_url", "page_title", "page_host"]);
    const allFieldKeys = Object.keys(extracted).filter((key) => !hiddenFieldKeys.has(key));
    const sortedKeys = allFieldKeys.sort((left, right) => {
      const leftIndex = fieldPriority.indexOf(left);
      const rightIndex = fieldPriority.indexOf(right);
      const normalizedLeft = leftIndex === -1 ? 999 : leftIndex;
      const normalizedRight = rightIndex === -1 ? 999 : rightIndex;
      if (normalizedLeft !== normalizedRight) {
        return normalizedLeft - normalizedRight;
      }
      return left.localeCompare(right);
    });
    const visibleKeys = state.extractedExpanded ? sortedKeys : sortedKeys.slice(0, 3);
    updateFieldToggle(sortedKeys.length);
    if (!sortedKeys.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-empty";
      empty.textContent = "这次没有抽到稳定字段，仍可参考结论、证据和动作建议。";
      gridNode.appendChild(empty);
    } else {
      visibleKeys.forEach((key) => {
        const keyNode = document.createElement("div");
        keyNode.className = "oa2-field-key";
        keyNode.textContent = key;
        const valueNode = document.createElement("div");
        valueNode.className = "oa2-field-value";
        const valueText = String(extracted[key]);
        valueNode.textContent = valueText;
        if (!state.extractedExpanded && valueText.length > 100) {
          valueNode.classList.add("truncated");
          valueNode.title = valueText;
        }
        gridNode.appendChild(keyNode);
        gridNode.appendChild(valueNode);
      });
      if (!state.extractedExpanded && sortedKeys.length > visibleKeys.length) {
        const note = document.createElement("div");
        note.className = "oa2-empty";
        note.textContent = `已收起 ${sortedKeys.length - visibleKeys.length} 个次要字段。`;
        note.style.gridColumn = "1 / -1";
        gridNode.appendChild(note);
      }
    }

    const evidenceItems = (result.evidence_items || []).slice(0, 2);
    const quickActions = getQuickActions(result);
    const memoryCount = (result.memory_hits || []).length;
    [
      sortedKeys.length ? `字段 ${sortedKeys.length}` : "字段未稳定",
      (result.evidence_items || []).length ? `证据 ${(result.evidence_items || []).length}` : "暂无证据",
      quickActions.length ? `动作 ${quickActions.length}` : "暂无动作",
      memoryCount ? `记忆 ${memoryCount}` : "无记忆命中",
    ].forEach((text) => {
      const chip = document.createElement("span");
      chip.className = "oa2-summary-stat";
      chip.textContent = text;
      summaryMetaNode.appendChild(chip);
    });

    if (!evidenceItems.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-empty";
      empty.textContent = "这次没有生成可回跳的证据项。";
      evidenceNode.appendChild(empty);
    } else {
      evidenceItems.forEach((item, index) => {
        const wrap = document.createElement("div");
        wrap.className = "oa2-evidence-item";
        const head = document.createElement("div");
        head.className = "oa2-evidence-head";
        const title = document.createElement("div");
        title.className = "oa2-evidence-title";
        title.textContent = item.title || `证据 ${index + 1}`;
        const locate = document.createElement("button");
        locate.className = "oa2-locate-btn";
        locate.type = "button";
        locate.setAttribute("data-action", "locate-evidence");
        locate.setAttribute("data-evidence-index", String(index));
        locate.textContent = "定位";
        head.appendChild(title);
        head.appendChild(locate);
        const quote = document.createElement("div");
        quote.className = "oa2-evidence-quote";
        const quoteText = String(item.quote || "无引用文本");
        quote.textContent = quoteText.length > 120 ? `${quoteText.slice(0, 120)}...` : quoteText;
        const reason = document.createElement("div");
        reason.className = "oa2-evidence-reason";
        reason.textContent = item.reason || "";
        wrap.appendChild(head);
        wrap.appendChild(quote);
        if (item.reason) {
          wrap.appendChild(reason);
        }
        evidenceNode.appendChild(wrap);
      });
      if ((result.evidence_items || []).length > evidenceItems.length) {
        const note = document.createElement("div");
        note.className = "oa2-empty";
        note.textContent = `其余 ${(result.evidence_items || []).length - evidenceItems.length} 条证据已折叠。`;
        evidenceNode.appendChild(note);
      }
    }

    const buildActionMetaText = (action) => {
      const previewLines = buildSuggestedActionPreviewLines(action);
      const missingParams = Array.isArray(action.missing_parameters) ? action.missing_parameters : [];
      const injectedParams = action.injected_params && typeof action.injected_params === "object" ? action.injected_params : {};
      const actionSteps = (Array.isArray(action.browser_actions) ? action.browser_actions : []).filter((item) => item && item.type !== "ask_human");
      const stepCount = previewLines.length || actionSteps.length;
      const parts = [];
      if (stepCount) {
        parts.push(`${stepCount} 步`);
      }
      if (action.require_confirmation || (Array.isArray(action.browser_actions) && action.browser_actions.some((item) => item?.type === "ask_human"))) {
        parts.push("执行前确认");
      }
      if (missingParams.length) {
        parts.push(`缺少参数：${missingParams.join("、")}`);
      } else if (action.workflow_id && Object.keys(injectedParams).length) {
        parts.push(`已注入 ${Object.keys(injectedParams).length} 个参数`);
      }
      if (action.from_local_fallback) {
        parts.push("本地回填");
      }
      return parts.join(" · ");
    };

    const buildActionSummaryText = (action) => {
      const type = String(action?.action_type || "").trim().toLowerCase();
      if (type === "open_link") {
        return String(action.url || "打开外部链接").trim();
      }
      if (type === "copy_query") {
        return String(action.query || action.url || "复制查询模板").trim().slice(0, 140);
      }
      const previewLines = buildSuggestedActionPreviewLines(action).slice(0, 2);
      if (previewLines.length) {
        return previewLines.join(" / ");
      }
      return buildActionMetaText(action) || "当前动作已准备好，可直接继续执行。";
    };

    const previewSuggestedAction = async (action) => {
      const previewLines = buildSuggestedActionPreviewLines(action);
      const params = action.injected_params || {};
      const missingParams = Array.isArray(action.missing_parameters) ? action.missing_parameters : [];
      const infoLines = [
        action.workflow_id ? `workflow_id=${action.workflow_id}` : `steps=${Array.isArray(action.browser_actions) ? action.browser_actions.length : 0}`,
        action.require_confirmation ? "执行前会二次确认" : "可直接执行",
      ];
      if (Object.keys(params).length) {
        infoLines.push(
          `参数：${Object.entries(params)
            .map(([key, value]) => `${key}=${String(value).slice(0, 40)}`)
            .join("；")}`
        );
      }
      if (missingParams.length) {
        infoLines.push(`缺少参数：${missingParams.join("、")}`);
      }
      runtimeMask.resetSequence(action.label || action.workflow_id || "动作预览", previewLines.length || 1);
      runtimeMask.setStatus("completed", "动作预览", buildActionMetaText(action) || "查看当前推荐动作的执行预览。");
      runtimeMask.pushHistory("observation", `已打开预览：${String(action.label || action.workflow_id || "浏览器动作").trim() || "浏览器动作"}`, "动作预览");
      await waitForRuntimeChoice(buildSuggestedActionPreviewChoiceAction(action, previewLines, infoLines), []);
      runtimeMask.hide();
    };

    const appendButton = (container, label, onClick, primary = false, disabled = false) => {
      const button = document.createElement("button");
      button.className = `oa2-action-btn${primary ? " primary" : ""}`;
      button.type = "button";
      button.textContent = label;
      button.disabled = !!disabled;
      if (!disabled) {
        button.addEventListener("click", onClick);
      }
      container.appendChild(button);
    };

    const appendActionCard = (action, primary = false) => {
      const card = document.createElement("div");
      card.className = "oa2-action-item";
      const head = document.createElement("div");
      head.className = "oa2-action-head";
      const title = document.createElement("div");
      title.className = "oa2-action-title";
      title.textContent = String(action.label || action.title || action.workflow_id || "推荐动作").trim() || "推荐动作";
      const kind = document.createElement("div");
      kind.className = "oa2-action-kind";
      const kindName = describeQuickActionKind(action);
      kind.textContent =
        kindName === "workflow"
          ? "workflow"
          : kindName === "browser"
            ? "page"
            : kindName === "link"
              ? "link"
              : kindName === "query"
                ? "query"
                : "action";
      head.appendChild(title);
      head.appendChild(kind);
      const summary = document.createElement("div");
      summary.className = "oa2-action-summary";
      summary.textContent = buildActionSummaryText(action);
      card.appendChild(head);
      card.appendChild(summary);
      const metaText = buildActionMetaText(action);
      if (metaText) {
        const meta = document.createElement("div");
        meta.className = "oa2-action-meta";
        meta.textContent = metaText;
        card.appendChild(meta);
      }
      const buttons = document.createElement("div");
      buttons.className = "oa2-action-buttons";
      appendButton(buttons, "立即执行", () => {
        runQuickAction(action).catch((error) => {
          setStatus(`执行失败：${error?.message || "unknown error"}`);
        });
      }, true);
      if (kindName === "workflow" || kindName === "browser") {
        appendButton(buttons, "查看预览", () => {
          previewSuggestedAction(action).catch((error) => {
            runtimeMask.hide();
            setStatus(`动作预览失败：${error?.message || "unknown error"}`);
          });
        });
      } else if (kindName === "query") {
        appendButton(buttons, "带去对话", () => {
          focusTeachComposerWithText(buildResultFollowupPrompt(result), "已带着当前结论切到对话区，可继续细化查询或动作。");
        });
      }
      card.appendChild(buttons);
      actionNode.appendChild(card);
    };

    const evidenceCount = (result.evidence_items || []).length;
    const primaryAction =
      quickActions[0] ||
      ((result.action_links || []).length ? { action_type: "open_link", label: result.action_links[0].title, url: result.action_links[0].url } : null) ||
      ((result.query_recommendations || []).length ? { action_type: "copy_query", label: result.query_recommendations[0].title, query: result.query_recommendations[0].query, url: result.query_recommendations[0].url } : null) ||
      ((result.browser_actions || []).length ? { action_type: "execute_browser_actions", label: "执行当前页面动作", browser_actions: result.browser_actions } : null);

    if (primaryAction) {
      const kindName = describeQuickActionKind(primaryAction);
      nextSummaryNode.textContent =
        kindName === "workflow"
          ? `建议先执行「${String(primaryAction.label || primaryAction.workflow_id || "当前流程").trim()}」`
          : kindName === "browser"
            ? `建议先执行「${String(primaryAction.label || "当前页面动作").trim()}」`
            : kindName === "link"
              ? `建议先打开「${String(primaryAction.label || "目标链接").trim()}」`
              : kindName === "query"
                ? `建议先使用「${String(primaryAction.label || "当前查询").trim()}」`
                : "建议先继续处理当前页面。";
      nextMetaNode.textContent = [
        evidenceCount ? `证据 ${evidenceCount} 条` : "证据较少",
        sortedKeys.length ? `字段 ${sortedKeys.length} 项` : "字段未稳定抽取",
        memoryCount ? `记忆 ${memoryCount} 条` : "暂无记忆命中",
      ].join(" · ");
      appendButton(nextActionsNode, kindName === "link" ? "立即打开" : "立即处理", () => {
        runQuickAction(primaryAction).catch((error) => {
          setStatus(`执行失败：${error?.message || "unknown error"}`);
        });
      }, true);
    } else {
      nextSummaryNode.textContent = result.summary
        ? "当前还没有稳定的推荐动作，建议先看证据与字段，再去对话区细化。"
        : "先框选并分析，系统会在这里给出优先动作。";
      nextMetaNode.textContent = [
        evidenceCount ? `证据 ${evidenceCount} 条` : "暂无证据",
        sortedKeys.length ? `字段 ${sortedKeys.length} 项` : "暂无字段",
        memoryCount ? `记忆 ${memoryCount} 条` : "暂无记忆",
      ].join(" · ");
    }
    appendButton(nextActionsNode, "带去对话", () => {
      focusTeachComposerWithText(buildResultFollowupPrompt(result), "已带着当前结论切到对话区，可继续让它推进下一步。");
    });
    appendButton(nextActionsNode, "整理草案", () => {
      focusTeachComposerWithText(buildResultTeachPrompt(result), "已把当前结论带到对话区，可直接整理成 skill 或 workflow 草案。");
    });

    const fallbackActions = [];
    if (!quickActions.length) {
      (result.action_links || []).forEach((link, index) => {
        fallbackActions.push({ action_type: "open_link", label: link.title || "打开", url: link.url, __primary: index === 0 });
      });
      (result.query_recommendations || []).forEach((query) => {
        fallbackActions.push({ action_type: "copy_query", label: query.title || "复制", query: query.query, url: query.url });
      });
      if ((result.browser_actions || []).length) {
        fallbackActions.push({ action_type: "execute_browser_actions", label: "执行当前页面动作", browser_actions: result.browser_actions, __primary: true });
      }
    }
    const allActionCards = quickActions.length ? quickActions : fallbackActions;
    const visibleActionCards = state.actionsExpanded ? allActionCards : allActionCards.slice(0, 2);
    updateActionToggle(allActionCards.length);

    if (quickActions.length) {
      visibleActionCards.forEach((action, index) => {
        appendActionCard(action, index === 0);
      });
    } else {
      visibleActionCards.forEach((action, index) => {
        appendActionCard(action, Boolean(action.__primary) || index === 0);
      });
    }
    if (!state.actionsExpanded && allActionCards.length > visibleActionCards.length) {
      const note = document.createElement("div");
      note.className = "oa2-empty";
      note.textContent = `已先保留最值得处理的 ${visibleActionCards.length} 个动作，其余 ${allActionCards.length - visibleActionCards.length} 个可按需展开。`;
      actionNode.appendChild(note);
    }
    if (!actionNode.children.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-action-item";
      empty.innerHTML = `<div class="oa2-action-title">当前没有稳定动作</div><div class="oa2-action-meta">先看证据与字段，或者去对话区告诉它下一步想做什么。</div>`;
      actionNode.appendChild(empty);
    }

    applyEvidenceHighlights(result);
    applyValueHighlights(result, { silent: Boolean(options.silentRefresh) });
  }

  function clearValueHighlights() {
    document.querySelectorAll(".oa2-value-highlight[data-oa2-highlight='1']").forEach((node) => {
      const parent = node.parentNode;
      if (!parent) {
        return;
      }
      parent.replaceChild(document.createTextNode(node.textContent || ""), node);
      parent.normalize();
    });
    state.valueHighlights = [];
  }

  function clearEvidenceHighlights() {
    state.evidenceHighlights.forEach((entry) => {
      if (entry.element instanceof Element) {
        entry.element.classList.remove("oa2-evidence-hit", "oa2-evidence-hit-active");
        if (entry.element.dataset.oa2EvidenceBound === "1") {
          delete entry.element.dataset.oa2EvidenceBound;
          if (entry.element.getAttribute("data-oa2-added-title") === "1") {
            entry.element.removeAttribute("title");
            entry.element.removeAttribute("data-oa2-added-title");
          }
        }
      }
    });
    state.evidenceHighlights = [];
  }

  function extractSearchTermsFromString(value) {
    const text = String(value || "").trim();
    if (!text) {
      return [];
    }
    const terms = new Set();
    text
      .split(/[\s,，。；;、:："'“”‘’()（）[\]{}<>!?！？]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (item.length >= 3 && item.length <= 32) {
          terms.add(item);
        }
      });
    text.match(/\b[A-Za-z][A-Za-z0-9._-]{2,}\b/g)?.forEach((item) => terms.add(item));
    return Array.from(terms);
  }

  function collectHighlightTerms(result) {
    const terms = new Set();
    const extractedFields = result.extracted_fields || {};
    Object.entries(extractedFields).forEach(([key, value]) => {
      const raw = String(value || "").trim();
      if (!raw) {
        return;
      }
      if (key === "page_url") {
        try {
          const url = new URL(raw);
          Array.from(url.searchParams.values()).forEach((item) => {
            extractSearchTermsFromString(item).forEach((term) => terms.add(term));
          });
          return;
        } catch (error) {
          return;
        }
      }
      if (key === "page_host") {
        return;
      }
      if (raw.length <= 120) {
        terms.add(raw);
      }
      extractSearchTermsFromString(raw).forEach((term) => terms.add(term));
    });
    extractSearchTermsFromString(result.summary || "").forEach((term) => terms.add(term));
    extractSearchTermsFromString(result.matched_domain || "").forEach((term) => terms.add(term));
    extractSearchTermsFromString(result.matched_persona || "").forEach((term) => terms.add(term));
    (result.evidence_items || []).forEach((item) => {
      extractSearchTermsFromString(item.quote || "").forEach((term) => terms.add(term));
      (item.match_terms || []).forEach((term) => extractSearchTermsFromString(term).forEach((token) => terms.add(token)));
    });
    return Array.from(terms)
      .filter((term) => term.length >= 2 && term.length <= 48)
      .filter((term) => !/^https?:/i.test(term))
      .filter((term) => !["unknown", "persona", "semantic", "structured", "used", "page", "host", "title"].includes(term.toLowerCase()))
      .sort((a, b) => b.length - a.length)
      .slice(0, 16);
  }

  function shouldSkipHighlightNode(node) {
    const parent = node.parentElement;
    if (!parent) {
      return true;
    }
    if (isInsideOmniAgent(parent)) {
      return true;
    }
    if (parent.closest(".oa2-value-highlight")) {
      return true;
    }
    return ["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "BUTTON", "SELECT", "OPTION"].includes(parent.tagName);
  }

  function highlightTermInNode(node, term, remainingRef) {
    const text = node.nodeValue || "";
    const lowerText = text.toLowerCase();
    const lowerTerm = term.toLowerCase();
    let cursor = 0;
    let matchIndex = lowerText.indexOf(lowerTerm, cursor);
    if (matchIndex === -1) {
      return false;
    }
    const fragment = document.createDocumentFragment();
    while (matchIndex !== -1 && remainingRef.count > 0) {
      if (matchIndex > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
      }
      const mark = document.createElement("mark");
      mark.className = "oa2-value-highlight";
      mark.dataset.oa2Highlight = "1";
      mark.textContent = text.slice(matchIndex, matchIndex + term.length);
      fragment.appendChild(mark);
      state.valueHighlights.push(mark);
      cursor = matchIndex + term.length;
      remainingRef.count -= 1;
      matchIndex = lowerText.indexOf(lowerTerm, cursor);
    }
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(fragment, node);
    return true;
  }

  function applyValueHighlights(result, options = {}) {
    clearValueHighlights();
    const terms = collectHighlightTerms(result);
    if (!terms.length) {
      return;
    }
    const root = getScopeRoot() || document.body;
    const remainingRef = { count: 16 };
    terms.forEach((term) => {
      if (remainingRef.count <= 0) {
        return;
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          return shouldSkipHighlightNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      let current = walker.nextNode();
      while (current) {
        nodes.push(current);
        current = walker.nextNode();
      }
      nodes.some((node) => {
        if (remainingRef.count <= 0) {
          return true;
        }
        return highlightTermInNode(node, term, remainingRef) && remainingRef.count <= 0;
      });
    });
    if (state.valueHighlights.length && !options.silent) {
      setStatus(`分析完成，并已在页面中高亮 ${state.valueHighlights.length} 处关键信息。`);
    }
  }

  function normalizeForSearch(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function pickEvidenceContainer(element) {
    let current = element instanceof Element ? element : null;
    while (current && current !== document.body) {
      if (isInsideOmniAgent(current)) {
        return null;
      }
      const text = (current.innerText || "").trim();
      const tag = current.tagName;
      if (["P", "DIV", "LI", "TD", "TH", "PRE", "CODE", "BLOCKQUOTE", "ARTICLE", "SECTION", "SPAN", "A"].includes(tag)) {
        if (text.length >= 2 && text.length <= 600) {
          return current;
        }
      }
      current = current.parentElement;
    }
    return element instanceof Element ? element : null;
  }

  function findEvidenceTarget(item) {
    const root = getScopeRoot() || document.body;
    const candidates = [];
    if (item.quote) {
      candidates.push(String(item.quote));
    }
    (item.match_terms || []).forEach((term) => candidates.push(String(term)));
    const normalizedCandidates = candidates
      .map((value) => value.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .slice(0, 6);
    if (!normalizedCandidates.length) {
      return null;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return shouldSkipHighlightNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let current = walker.nextNode();
    while (current) {
      const normalized = normalizeForSearch(current.nodeValue);
      const hit = normalizedCandidates.find((candidate) => normalized.includes(normalizeForSearch(candidate)));
      if (hit) {
        return pickEvidenceContainer(current.parentElement);
      }
      current = walker.nextNode();
    }
    return null;
  }

  function applyEvidenceHighlights(result) {
    clearEvidenceHighlights();
    (result.evidence_items || []).forEach((item, index) => {
      const target = findEvidenceTarget(item);
      if (!(target instanceof Element)) {
        return;
      }
      target.classList.add("oa2-evidence-hit");
      target.dataset.oa2EvidenceBound = "1";
      if (!target.getAttribute("title") && item.reason) {
        target.setAttribute("title", item.reason);
        target.setAttribute("data-oa2-added-title", "1");
      }
      state.evidenceHighlights.push({ index, element: target, item });
    });
  }

  function focusEvidenceItem(index) {
    const target = state.evidenceHighlights.find((entry) => entry.index === index);
    if (!target || !(target.element instanceof Element)) {
      setStatus("当前证据项还没在网页里找到稳定定位点。");
      return;
    }
    target.element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    target.element.classList.remove("oa2-evidence-hit-active");
    void target.element.offsetWidth;
    target.element.classList.add("oa2-evidence-hit-active");
    window.setTimeout(() => {
      target.element?.classList.remove("oa2-evidence-hit-active");
    }, 1800);
    setStatus(`已定位证据：${target.item.title || `证据 ${index + 1}`}`);
  }

  async function teachCurrent(options = {}) {
    const input = document.getElementById("oa2-teach-input");
    const text = String(options.text ?? input.value).trim();
    if (!text) {
      setPanelState("teach", "error", "缺少输入", "先输入一条教导内容。");
      updateTeachChrome();
      return;
    }
    const contextKey = getTeachContextKey();
    const previousMessages = getTeachMessages(contextKey);
    const outgoingMessages = [...previousMessages, { role: "user", content: text }].slice(-12);
    const recorderSteps = getRecordedStepsSnapshot();
    const useTeachFlow = Boolean(options.forceTeachFlow) || shouldUseTeachFlow(text);
    const visualContext = options.skipVisualContext
      ? (() => {
          return captureActionablePageState(text).then((pageState) => ({
            images: [],
            image_meta: {
              snapshot_kind: "omitted_for_page_agent",
              visual_grounded: false,
            },
            browser_state: pageState.browser_state,
            dom_candidates: pageState.dom_candidates,
          }));
        })()
      : buildCurrentVisualContext(contextKey);
    setTeachMessages(outgoingMessages, contextKey);
    renderTeachConversation(contextKey);
    setPanelState("teach", "loading", useTeachFlow ? "正在整理教导" : "正在发送对话", useTeachFlow ? "正在结合当前上下文整理草案或规则建议。" : "正在带着当前页面上下文继续对话。");
    updateTeachChrome();
    setStatus(useTeachFlow ? "正在发送教导..." : "正在发送对话...");
    try {
      const resolvedVisualContext = await visualContext;
      const currentAnalysisSeed = await buildCurrentAnalysisSeed(contextKey);
      currentAnalysisSeed.recorder_steps = cloneWorkflowSteps(recorderSteps);
      currentAnalysisSeed.recorded_step_count = recorderSteps.length;
      currentAnalysisSeed.recorded_step_preview = summarizeWorkflowSteps(recorderSteps, 8);
      const result = useTeachFlow
        ? await apiRequest("POST", "/api/teach", {
            context_key: contextKey,
            trace_id: getAnalysisForContext(contextKey)?.trace_id || null,
            messages: outgoingMessages,
            current_analysis_seed: currentAnalysisSeed,
            recorded_steps: cloneWorkflowSteps(recorderSteps),
            recorded_step_count: recorderSteps.length,
            images: resolvedVisualContext.images,
            image_meta: resolvedVisualContext.image_meta,
            browser_state: resolvedVisualContext.browser_state,
            dom_candidates: resolvedVisualContext.dom_candidates,
            mode: "teach",
          })
        : await apiRequest("POST", "/api/chat", {
            context_key: contextKey,
            messages: outgoingMessages,
            current_analysis_seed: currentAnalysisSeed,
            recorded_steps: cloneWorkflowSteps(recorderSteps),
            recorded_step_count: recorderSteps.length,
            images: resolvedVisualContext.images,
            image_meta: resolvedVisualContext.image_meta,
            browser_state: resolvedVisualContext.browser_state,
            dom_candidates: resolvedVisualContext.dom_candidates,
            auto_apply_tool: false,
          });
      const normalizedResult = useTeachFlow ? normalizeWorkflowDraftWithRecorder(result, recorderSteps, currentAnalysisSeed) : result;
      state.lastTeachDraft = useTeachFlow && normalizedResult.teach_decision !== "chat_only" ? normalizedResult : null;
      const returnedMessages = Array.isArray(normalizedResult.messages)
        ? normalizedResult.messages
        : [...outgoingMessages, { role: "assistant", content: result.reply || "" }];
      setTeachMessages(returnedMessages, contextKey);
      renderTeachConversation(contextKey);
      input.value = "";
      if (!useTeachFlow || normalizedResult.teach_decision === "chat_only") {
        setPanelState("teach", "success", "对话完成", "已更新当前对话，可继续追问或改成页面操作。");
      } else {
        const skillTitle = normalizedResult.target_skill_title ? `“${normalizedResult.target_skill_title}”` : "当前场景";
        if (normalizedResult.teach_decision === "update_skill") {
          setPanelState("teach", "success", "草案已生成", `已生成更新草案，确认后会并入${skillTitle}对应的长期规则。`);
        } else if (normalizedResult.teach_decision === "create_workflow") {
          const workflowSteps = getWorkflowDraftSteps(normalizedResult);
          setPanelState("teach", "success", "流程草案已生成", `确认后会保存为可复用 workflow。当前附带 ${workflowSteps.length} 步录制结果。`);
        } else {
          setPanelState("teach", "success", "规则草案已生成", "确认后会写入长期记忆。");
        }
      }
      setStatus(useTeachFlow ? "教导完成。" : "对话完成。");
    } catch (error) {
      setTeachMessages(previousMessages, contextKey);
      renderTeachConversation(contextKey);
      setPanelState("teach", "error", useTeachFlow ? "教导失败" : "对话失败", error?.error?.message || "unknown error");
      setStatus(`${useTeachFlow ? "教导" : "对话"}失败。`);
    }
  }

  function rememberPlannedBrowserActions(actions, reply, contextKey = getTeachContextKey()) {
    const normalizedActions = cloneWorkflowSteps(actions);
    const baseAnalysis = getAnalysisForContext(contextKey) || state.lastAnalysis || {};
    const previewSteps = normalizedActions
      .filter((item) => item && item.type !== "ask_human")
      .slice(0, 4)
      .map((item, index) => describeWorkflowStep(item, index));
    const existingQuickActions = getQuickActions(baseAnalysis).filter((item) => item?.action_type !== "execute_browser_actions");
    const nextAnalysis = {
      ...baseAnalysis,
      context_key: baseAnalysis.context_key || contextKey,
      summary: String(reply || "").trim() || baseAnalysis.summary || "已生成页面动作。",
      browser_actions: normalizedActions,
      quick_actions: normalizedActions.length
        ? [
            {
              action_type: "execute_browser_actions",
              label: "执行页面动作",
              browser_actions: cloneWorkflowSteps(normalizedActions),
              preview_steps: previewSteps,
            },
            ...existingQuickActions,
          ]
        : existingQuickActions,
      page_meta: baseAnalysis.page_meta || {
        url: location.href,
        title: document.title,
        host: location.host,
      },
    };
    nextAnalysis.suggested_actions = nextAnalysis.quick_actions;
    state.lastAnalysis = nextAnalysis;
    if (contextKey) {
      state.sessionByContext.set(contextKey, nextAnalysis);
    }
    return nextAnalysis;
  }

  async function requestBrowserControlPlan(instruction, options = {}) {
    const trimmedInstruction = String(instruction || "").trim();
    if (!trimmedInstruction) {
      return {
        reply: "当前没有收到明确的页面操作指令。",
        browser_actions: [],
        messages: Array.isArray(options.messages) ? options.messages.slice() : [],
      };
    }
    const contextKey = String(options.contextKey || getTeachContextKey() || buildContextKey(pickText())).trim();
    const currentAnalysisSeed = options.currentAnalysisSeed || (await buildCurrentAnalysisSeed(contextKey));
    const pageState = options.pageState || (await captureActionablePageState(trimmedInstruction));
    const messages = Array.isArray(options.messages) && options.messages.length
      ? options.messages.slice()
      : [{ role: "user", content: trimmedInstruction }];
    return apiRequest("POST", "/api/chat", {
      context_key: contextKey,
      messages,
      current_analysis_seed: currentAnalysisSeed,
      browser_state: pageState.browser_state,
      dom_candidates: pageState.dom_candidates,
      page_meta: {
        url: location.href,
        title: document.title,
        host: location.host,
      },
      scope_meta: buildScopeMeta(currentAnalysisSeed.selection_excerpt || pickText()),
      action_mode: "browser_control",
    });
  }

  async function operateCurrent() {
    const input = document.getElementById("oa2-teach-input");
    const text = String(input?.value || "").trim();
    if (!text) {
      setPanelState("teach", "error", "缺少指令", "先输入一条页面操作指令。");
      updateTeachChrome();
      return;
    }
    const contextKey = getTeachContextKey();
    const previousMessages = getTeachMessages(contextKey);
    const outgoingMessages = [...previousMessages, { role: "user", content: text }].slice(-12);
    state.lastTeachDraft = null;
    setTeachMessages(outgoingMessages, contextKey);
    renderTeachConversation(contextKey);
    setPanelState("teach", "loading", "正在理解页面操作", "正在结合当前页面上下文整理可执行动作。");
    updateTeachChrome();
    setStatus("正在理解你的页面操作指令...");
    try {
      const currentAnalysisSeed = await buildCurrentAnalysisSeed(contextKey);
      const pageState = await captureActionablePageState(text);
      const result = await requestBrowserControlPlan(text, {
        contextKey,
        messages: outgoingMessages,
        currentAnalysisSeed,
        pageState,
      });
      const returnedMessages = Array.isArray(result.messages)
        ? result.messages
        : [...outgoingMessages, { role: "assistant", content: result.reply || "" }];
      const plannedActions = Array.isArray(result.browser_actions) ? result.browser_actions : [];
      setTeachMessages(returnedMessages, contextKey);
      renderTeachConversation(contextKey);
      rememberPlannedBrowserActions(plannedActions, result.reply || "", contextKey);
      input.value = "";
      if (!plannedActions.length) {
        setPanelState("teach", "error", "没有拿到可执行动作", "这次只拿到了文字说明；具体原因我已经放在上方对话里。");
        setStatus(`这次没有生成可执行动作${result.reply ? `：${String(result.reply).slice(0, 80)}` : "。"}`);
        return;
      }
      setPanelState("teach", "loading", "动作已生成", `已生成 ${plannedActions.length} 步页面动作，正在执行。`);
      setStatus(`已根据指令生成 ${plannedActions.length} 步页面动作，准备执行。`);
      const executionResult = await executeBrowserActions(plannedActions, result.reply || "页面操作");
      if (executionResult?.success) {
        setPanelState("teach", "success", "页面操作已完成", `共执行 ${executionResult.executedCount || plannedActions.length} 步。`);
      } else if (executionResult?.message) {
        setPanelState("teach", "error", "页面操作未完成", executionResult.message);
      }
    } catch (error) {
      setTeachMessages(previousMessages, contextKey);
      renderTeachConversation(contextKey);
      setPanelState("teach", "error", "页面操作失败", error?.error?.message || "unknown error");
      setStatus("页面操作失败。");
    }
  }

  async function buildCurrentAnalysisSeed(contextKey = getTeachContextKey()) {
    const currentAnalysis = getAnalysisForContext(contextKey);
    const recorderSteps = getRecordedStepsSnapshot();
    if (!currentAnalysis) {
      const pageState = await captureActionablePageState(pickText());
      return {
        context_key: contextKey || buildContextKey(pickText()),
        selection_excerpt: buildSelectionExcerpt(),
        scope_meta: buildScopeMeta(),
        recorder_steps: cloneWorkflowSteps(recorderSteps),
        recorded_step_count: recorderSteps.length,
        recorded_step_preview: summarizeWorkflowSteps(recorderSteps, 8),
        browser_state: pageState.browser_state,
        page_meta: {
          url: location.href,
          title: document.title,
          host: location.host,
        },
      };
    }
    const fallbackPageState = currentAnalysis.browser_state ? null : await captureActionablePageState(currentAnalysis.selection_excerpt || pickText());
    return {
      trace_id: currentAnalysis.trace_id,
      context_key: currentAnalysis.context_key || contextKey,
      summary: currentAnalysis.summary,
      matched_domain: currentAnalysis.matched_domain,
      matched_persona: currentAnalysis.matched_persona,
      matched_skills: currentAnalysis.matched_skills || [],
      primary_skill_id: currentAnalysis.debug_meta?.primary_skill_id,
      extracted_fields: currentAnalysis.extracted_fields || {},
      image_meta: currentAnalysis.image_meta || {},
      selection_excerpt: currentAnalysis.selection_excerpt || buildSelectionExcerpt(),
      scope_meta: currentAnalysis.scope_meta || buildScopeMeta(currentAnalysis.selection_excerpt || pickText()),
      recorder_steps: cloneWorkflowSteps(recorderSteps),
      recorded_step_count: recorderSteps.length,
      recorded_step_preview: summarizeWorkflowSteps(recorderSteps, 8),
      browser_state: currentAnalysis.browser_state || fallbackPageState?.browser_state || collectBrowserState([], currentAnalysis.selection_excerpt || pickText()),
      quick_actions: getQuickActions(currentAnalysis),
      suggested_actions: getQuickActions(currentAnalysis),
      page_meta: {
        url: location.href,
        title: document.title,
        host: location.host,
      },
    };
  }

  function guessNamespace() {
    const currentAnalysis = getAnalysisForContext();
    if (currentAnalysis?.matched_persona === "网络安全专家") {
      return "security";
    }
    if (currentAnalysis?.matched_persona === "技术阅读助手") {
      return "research";
    }
    if (currentAnalysis?.matched_persona === "生活实践助手") {
      return "life";
    }
    return document.getElementById("oa2-rag-namespace").value.trim() || "general";
  }

  async function confirmTeachDraft() {
    if (!state.lastTeachDraft) {
      setPanelState("teach", "error", "没有待确认草案", "当前没有可确认的草案。");
      updateTeachChrome();
      return;
    }
    setPanelState("teach", "loading", "正在写入长期记忆", "正在把当前草案写入技能或 workflow。");
    updateTeachChrome();
    setStatus("正在确认并写入长期记忆...");
    try {
      const currentAnalysisSeed = await buildCurrentAnalysisSeed();
      const result = await apiRequest("POST", "/api/teach/confirm", {
        context_key: state.lastContextKey || buildContextKey(pickText()),
        teach_decision: state.lastTeachDraft.teach_decision,
        target_persona_id: state.lastTeachDraft.target_persona_id,
        target_skill_id: state.lastTeachDraft.target_skill_id,
        draft: state.lastTeachDraft.draft || {},
        current_analysis_seed: currentAnalysisSeed,
        steps: state.lastTeachDraft.teach_decision === "create_workflow" ? getWorkflowDraftSteps(state.lastTeachDraft) : [],
      });
      state.lastTeachDraft = null;
      renderTeachConversation();
      setPanelState("teach", "success", "写入完成", result.message || "已确认写入。");
      setStatus("长期记忆写入完成。");
      await loadMemory();
    } catch (error) {
      setPanelState("teach", "error", "写入失败", error?.error?.message || "unknown error");
      setStatus("长期记忆写入失败。");
    }
  }

  async function rejectTeachDraft() {
    if (!state.lastTeachDraft) {
      setPanelState("teach", "error", "没有待放弃草案", "当前没有可放弃的草案。");
      updateTeachChrome();
      return;
    }
    try {
      const result = await apiRequest("POST", "/api/teach/reject", {
        context_key: state.lastContextKey || buildContextKey(pickText()),
        reason: "user_rejected",
      });
      state.lastTeachDraft = null;
      renderTeachConversation();
      setPanelState("teach", "success", "草案已放弃", result.message || "草案已放弃。");
      setStatus("草案已放弃。");
    } catch (error) {
      setPanelState("teach", "error", "放弃失败", error?.error?.message || "unknown error");
    }
  }

  function resolveActionElement(action) {
    if (state.pageController) {
      return state.pageController.resolveActionElement(action);
    }
    return null;
  }

  function resolveElementByDescription(action) {
    const targetDesc = String(action.target_desc || "").trim().toLowerCase();
    if (!targetDesc) {
      return null;
    }
    const root = getScopeRoot() || document;
    const candidates = Array.from(
      root.querySelectorAll("button, a, input, textarea, select, [role='button'], label, [data-testid]")
    ).filter((element) => !isInsideOmniAgent(element));
    let best = null;
    let bestScore = -1;
    candidates.forEach((element) => {
      const haystack = [
        element.innerText || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("placeholder") || "",
        element.getAttribute("name") || "",
        element.getAttribute("data-testid") || "",
        element.id || "",
        element.className || "",
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      targetDesc.split(/\s+/).forEach((token) => {
        if (token && haystack.includes(token)) {
          score += 2;
        }
      });
      if (haystack.includes(targetDesc)) {
        score += 4;
      }
      if (action.type === "click" && element.closest("button, a, [role='button']")) {
        score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    });
    return bestScore > 0 ? best : null;
  }

  function resolveElementBySemanticAnchors(anchors) {
    const root = getScopeRoot() || document;
    const candidates = Array.from(
      root.querySelectorAll("button, a, input, textarea, select, [role='button'], label, [data-testid], [contenteditable='true']")
    ).filter((element) => !isInsideOmniAgent(element));
    let best = null;
    let bestScore = -1;
    anchors.forEach((anchor) => {
      const tag = String(anchor.tag || "").toLowerCase();
      const role = String(anchor.role || "").toLowerCase();
      const label = String(anchor.label || "").toLowerCase();
      const placeholder = String(anchor.placeholder || "").toLowerCase();
      const nearbyText = String(anchor.nearby_text || "").toLowerCase();
      candidates.forEach((element) => {
        let score = 0;
        const elementTag = element.tagName.toLowerCase();
        const elementRole = String(element.getAttribute("role") || "").toLowerCase();
        const elementLabel = String(element.getAttribute("aria-label") || element.innerText || element.value || "").replace(/\s+/g, " ").trim().toLowerCase();
        const elementPlaceholder = String(element.getAttribute("placeholder") || "").toLowerCase();
        const elementNearby = inferNearbyText(element).toLowerCase();
        if (tag && elementTag === tag) {
          score += 3;
        }
        if (role && elementRole === role) {
          score += 2;
        }
        if (label && elementLabel.includes(label)) {
          score += 5;
        }
        if (placeholder && elementPlaceholder.includes(placeholder)) {
          score += 4;
        }
        if (nearbyText && elementNearby.includes(nearbyText)) {
          score += 3;
        }
        if (score > bestScore) {
          bestScore = score;
          best = element;
        }
      });
    });
    return bestScore >= 5 ? best : null;
  }

  function stopHealingMode() {
    if (typeof state.healing.cleanup === "function") {
      state.healing.cleanup();
    }
    state.healing.cleanup = null;
    state.healing.active = false;
    state.healing.pending = null;
    state.healing.candidateElements = [];
    healingOverlay.classList.remove("active");
    document.querySelectorAll(".oa2-healing-highlight").forEach((node) => node.classList.remove("oa2-healing-highlight"));
  }

  function startHealingMode(failureContext) {
    return new Promise((resolve) => {
      stopHealingMode();
      state.healing.active = true;
      state.healing.pending = failureContext;
      state.healing.candidateElements = [];
      healingOverlay.classList.add("active");
      const bodyNode = healingOverlay.querySelector("#oa2-healing-body");
      const candidateListNode = healingOverlay.querySelector("#oa2-healing-candidates");
      const diagnostic = failureContext?.diagnostic && typeof failureContext.diagnostic === "object" ? failureContext.diagnostic : {};
      const topCandidates = Array.isArray(diagnostic.top_candidates) ? diagnostic.top_candidates : [];
      if (bodyNode) {
        const intro = topCandidates.length
          ? `老板，“${getWorkflowStepTargetLabel(failureContext.action)}”这一步没命中。我先给你列了几个可能目标，点候选即可修补；如果都不对，再直接点页面里的正确元素。`
          : `老板，“${getWorkflowStepTargetLabel(failureContext.action)}”这一步没命中。请在页面上点一下正确元素，我会修补这一步并继续执行。`;
        const phaseText = diagnostic.phase ? describeActionFailurePhase(diagnostic.phase) : "";
        const hintText = String(diagnostic.recovery_hint || "").trim();
        const attemptText = Array.isArray(diagnostic.attempted_modes) && diagnostic.attempted_modes.length
          ? `已尝试：${diagnostic.attempted_modes.join(" -> ")}。`
          : "";
        bodyNode.textContent = `${intro}${phaseText ? ` 当前判断：${phaseText}。` : ""}${attemptText ? ` ${attemptText}` : ""}${hintText ? ` 建议：${hintText}` : ""}`;
      }

      const pickTarget = (rawTarget) => {
        if (!(rawTarget instanceof Element) || isInsideOmniAgent(rawTarget) || healingOverlay.contains(rawTarget)) {
          return null;
        }
        return rawTarget.closest("button, a, input, textarea, select, [role='button'], label, [contenteditable='true']") || rawTarget;
      };

      const highlightHealingTarget = (target) => {
        document.querySelectorAll(".oa2-healing-highlight").forEach((node) => node.classList.remove("oa2-healing-highlight"));
        if (target instanceof Element) {
          target.classList.add("oa2-healing-highlight");
        }
      };

      const resolveElementFromCandidate = (candidate) => {
        if (!candidate || typeof candidate !== "object") {
          return null;
        }
        if (Number.isInteger(candidate.page_agent_index) && state.pageAgentNativeController) {
          const nativeElement = resolvePageAgentElementByIndex(state.pageAgentNativeController, Number(candidate.page_agent_index));
          const nativeTarget = pickTarget(nativeElement);
          if (nativeTarget instanceof Element) {
            return nativeTarget;
          }
        }
        const selector = String(candidate.selector || "").trim();
        if (!selector) {
          return null;
        }
        try {
          const root = getActionSearchRoot() || document;
          const found = root.querySelector(selector) || document.querySelector(selector);
          return pickTarget(found);
        } catch (error) {
          return null;
        }
      };

      const submitHealingStep = async (target, reason) => {
        if (!(target instanceof Element)) {
          return false;
        }
        const replacementType = failureContext.action.source_action_type || failureContext.action.type;
        const replacementValue = failureContext.action.value || failureContext.action.source_value || "";
        const replacementStep = buildStepFromElement(replacementType, target, replacementValue);
        replacementStep.workflow_id = failureContext.workflowId;
        const workflowName = String(
          failureContext?.action?.workflow_name ||
            failureContext?.action?.label ||
            failureContext?.workflowId ||
            "当前 workflow"
        ).trim() || "当前 workflow";
        const stepNumber = Number.isInteger(failureContext?.stepIndex) ? failureContext.stepIndex + 1 : null;
        setPanelState(
          "teach",
          "loading",
          "正在修补流程",
          `正在更新「${workflowName}」${stepNumber ? `第 ${stepNumber} 步` : "当前步骤"}，并准备继续当前执行。`
        );
        try {
          const result = await apiRequest("POST", "/api/workflows/heal", {
            workflow_id: failureContext.workflowId,
            trace_id: failureContext.traceId,
            step_index: failureContext.stepIndex,
            replacement_step: replacementStep,
            reason,
          });
          if (failureContext.traceId) {
            await apiRequest("POST", "/api/traces/update", {
              trace_id: failureContext.traceId,
              healing_state: "patched",
              status: "running",
              healing_detail: {
                strategy: reason,
                workflow_id: failureContext.workflowId,
                step_index: failureContext.stepIndex,
                patched_step: result.patched_step || replacementStep,
                workflow_version: result.version,
                failed_target: getWorkflowStepTargetLabel(failureContext.action),
                candidate_count: Array.isArray(failureContext?.diagnostic?.top_candidates) ? failureContext.diagnostic.top_candidates.length : 0,
              },
            }).catch(() => {});
          }
          stopHealingMode();
          const detail = `已将「${workflowName}」${stepNumber ? `第 ${stepNumber} 步` : "当前步骤"}修补到 v${result.version}，当前执行会继续。`;
          const healedStep = result.patched_step || replacementStep;
          setPanelState("teach", "success", "流程已修补", detail, [
            {
              label: "带去对话",
              tone: "secondary",
              onClick: () => {
                focusTeachComposerWithText(
                  buildHealingFollowupPrompt(failureContext, healedStep, result),
                  "已把本次自愈结果带到对话区，可继续整理后续动作或沉淀建议。"
                );
              },
            },
            {
              label: "查看记忆",
              tone: "secondary",
              onClick: () => {
                openMemoryViewWithStatus("已切到记忆视图，可继续检查 workflow、自愈记录与最近 trace。");
              },
            },
          ]);
          setStatus(`已修补流程步骤并升级到 v${result.version}，继续执行。`);
          resolve(healedStep);
          return true;
        } catch (error) {
          stopHealingMode();
          setStatus(`流程自愈失败：${error?.error?.message || "unknown error"}`);
          setPanelState("teach", "error", "流程修补失败", error?.error?.message || error?.message || "unknown error");
          resolve(null);
          return false;
        }
      };

      if (candidateListNode instanceof HTMLElement) {
        candidateListNode.innerHTML = "";
        const candidateElements = topCandidates
          .map((candidate, index) => {
            const element = resolveElementFromCandidate(candidate);
            if (!(element instanceof Element)) {
              return null;
            }
            const button = document.createElement("button");
            button.type = "button";
            button.className = "oa2-healing-candidate";
            const candidateMeta = [
              String(candidate.selector || candidate.tag || "候选元素").trim(),
              candidate.source ? `source=${candidate.source}` : "",
              Number.isInteger(candidate.page_agent_index) ? `idx=${candidate.page_agent_index}` : "",
            ].filter(Boolean).join(" | ");
            button.innerHTML = `
              <div class="oa2-healing-candidate-main">
                <div class="oa2-healing-candidate-label">${escapeHtml(String(candidate.label || describeElement(element) || `候选 ${index + 1}`))}</div>
                <div class="oa2-healing-candidate-meta">${escapeHtml(candidateMeta || "候选元素")}</div>
              </div>
              <div class="oa2-healing-candidate-score">score ${Number(candidate.score || 0)}</div>
            `;
            button.addEventListener("mouseenter", () => {
              highlightHealingTarget(element);
            });
            button.addEventListener("focus", () => {
              highlightHealingTarget(element);
            });
            button.addEventListener("click", async (event) => {
              event.preventDefault();
              event.stopPropagation();
              await submitHealingStep(element, "user_selected_candidate");
            });
            candidateListNode.appendChild(button);
            return element;
          })
          .filter(Boolean);
        state.healing.candidateElements = candidateElements;
        candidateListNode.classList.toggle("is-hidden", !candidateElements.length);
      }

      const onMove = (event) => {
        const target = pickTarget(event.target);
        highlightHealingTarget(target);
      };

      const onClick = async (event) => {
        const target = pickTarget(event.target);
        if (!target) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        await submitHealingStep(target, "user_repointed_element");
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          stopHealingMode();
          setStatus("已取消这次自愈求助。");
          resolve(null);
        }
      };

      const cancelBtn = healingOverlay.querySelector("#oa2-healing-cancel");
      const onCancel = () => {
        stopHealingMode();
        setStatus("已取消这次自愈求助。");
        resolve(null);
      };
      cancelBtn?.addEventListener("click", onCancel, { once: true });
      document.addEventListener("mouseover", onMove, true);
      document.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKeyDown, true);
      state.healing.cleanup = () => {
        document.removeEventListener("mouseover", onMove, true);
        document.removeEventListener("click", onClick, true);
        window.removeEventListener("keydown", onKeyDown, true);
        cancelBtn?.removeEventListener("click", onCancel);
        if (candidateListNode instanceof HTMLElement) {
          candidateListNode.innerHTML = "";
          candidateListNode.classList.add("is-hidden");
        }
      };
    });
  }

  async function executeLastActions() {
    const directActions = Array.isArray(state.lastAnalysis?.browser_actions) ? state.lastAnalysis.browser_actions : [];
    if (directActions.length) {
      return executeBrowserActions(directActions, "浏览器动作");
    }
    const quickActions = getQuickActions(state.lastAnalysis);
    const fallbackAction =
      quickActions.find((item) => isWorkflowQuickAction(item) && Array.isArray(item.browser_actions) && item.browser_actions.length && !(Array.isArray(item.missing_parameters) && item.missing_parameters.length)) ||
      quickActions.find((item) => item?.action_type === "execute_browser_actions" && Array.isArray(item.browser_actions) && item.browser_actions.length) ||
      null;
    if (fallbackAction) {
      if (isWorkflowQuickAction(fallbackAction)) {
        return executeSuggestedWorkflow(fallbackAction, { skipConfirm: true });
      }
      return executeBrowserActions(fallbackAction.browser_actions || [], fallbackAction.label || "执行流程");
    }
    const blockedWorkflow = quickActions.find((item) => isWorkflowQuickAction(item) && Array.isArray(item.missing_parameters) && item.missing_parameters.length);
    if (blockedWorkflow) {
      return executeSuggestedWorkflow(blockedWorkflow, { skipConfirm: true });
    }
    setStatus("当前没有可直接执行的动作。可先重新分析，或展开推荐动作查看预览。");
  }

  function normalizeFormFieldAction(field) {
    const normalized = field && typeof field === "object" ? { ...field } : {};
    const inferredType = String(normalized.type || (isSelectLikeFieldMeta(normalized) ? "select" : "fill"))
      .trim()
      .toLowerCase();
    normalized.type = inferredType === "select" ? "select" : "fill";
    if (!String(normalized.target_desc || "").trim()) {
      normalized.target_desc = String(normalized.field_name || normalized.label || normalized.name || "字段").trim() || "字段";
    }
    return normalized;
  }

  function expandFormAction(action) {
    const steps = [];
    const fields = Array.isArray(action?.fields) ? action.fields : [];
    fields.forEach((field, index) => {
      const normalized = normalizeFormFieldAction(field);
      if (!normalized.type) {
        return;
      }
      steps.push({
        ...normalized,
        workflow_id: action?.workflow_id || normalized.workflow_id,
        workflow_name: action?.workflow_name || normalized.workflow_name,
        workflow_step_index: Number.isInteger(action?.workflow_step_index) ? action.workflow_step_index : normalized.workflow_step_index,
        form_index: index,
        form_label: String(action?.target_desc || action?.label || "表单").trim() || "表单",
      });
    });
    const submitAction = action?.submit_action;
    if (submitAction && typeof submitAction === "object") {
      steps.push({
        ...submitAction,
        type: String(submitAction.type || "click").trim().toLowerCase() || "click",
        workflow_id: action?.workflow_id || submitAction.workflow_id,
        workflow_name: action?.workflow_name || submitAction.workflow_name,
        workflow_step_index: Number.isInteger(action?.workflow_step_index) ? action.workflow_step_index : submitAction.workflow_step_index,
        form_submit: true,
      });
    }
    return steps;
  }

  function getDirectWorkflowActions(action, options = {}) {
    const steps = cloneWorkflowSteps(Array.isArray(action?.browser_actions) ? action.browser_actions : []);
    if (!steps.length) {
      return [];
    }
    if (options.stripConfirmStep) {
      const firstStep = steps[0];
      if (firstStep && getWorkflowStepType(firstStep) === "ask_human" && Number(firstStep.workflow_step_index) === -1) {
        return steps.slice(1);
      }
    }
    return steps;
  }

  async function executeBrowserActions(actions, label = "浏览器动作", options = {}) {
    const normalizedActions = Array.isArray(actions) ? actions.filter(Boolean) : [];
    if (!normalizedActions.length) {
      if (!options.nested) {
        setStatus("没有可执行的浏览器动作。");
      }
      return { success: false, executedCount: 0, message: "没有可执行的浏览器动作。" };
    }
    const executedSteps = [];
    const nested = Boolean(options.nested);
    const suppressTraceUpdates = Boolean(options.suppressTraceUpdates || nested);
    const traceId = options.traceId !== undefined ? options.traceId : state.lastAnalysis?.trace_id;
    const controller = state.pageController;
    const shouldRestorePanel = !nested && state.isOpen;
    const restoreView = state.activeView;
    if (!controller) {
      if (!nested) {
        setStatus("动作失败：page-controller 尚未初始化。");
      }
      return { success: false, executedCount: 0, message: "page-controller 尚未初始化。" };
    }

    const reportTrace = (status, extra = {}) => {
      if (suppressTraceUpdates || !traceId) {
        return;
      }
      apiRequest("POST", "/api/traces/update", {
        trace_id: traceId,
        executed_steps: executedSteps,
        healing_state: state.healing.active ? "in_progress" : "none",
        status,
        ...extra,
      }).catch(() => {});
    };

    const finishFailure = (message, diagnostic = null) => {
      if (!nested) {
        runtimeMask.finish(false, message);
        setStatus(message);
      }
      return { success: false, executedCount: executedSteps.length, message, diagnostic };
    };

    const maybeHealWorkflowStep = async (action, index, actionSummary, diagnostic = null) => {
      if (!action.workflow_id) {
        return null;
      }
      const stepMeta = `步骤 ${index + 1}/${normalizedActions.length}`;
      runtimeMask.pushHistory("observation", `未命中目标，准备自愈：${actionSummary}`, stepMeta);
      reportTrace("healing", {
        failed_step: diagnostic ? { ...action, failure_diagnostic: diagnostic } : action.failure_diagnostic ? { ...action, failure_diagnostic: action.failure_diagnostic } : action,
        healing_state: "in_progress",
      });
      const healedStep = await startHealingMode({
        workflowId: action.workflow_id,
        traceId,
        stepIndex: Number.isInteger(action.workflow_step_index) ? action.workflow_step_index : index,
        action,
        diagnostic: diagnostic || action.failure_diagnostic || null,
      });
      if (!healedStep) {
        reportTrace("failed", {
          failed_step: action,
          healing_state: "failed",
        });
        return null;
      }
      normalizedActions[index] = healedStep;
      runtimeMask.pushHistory("success", `已自愈并重试：${actionSummary}`, stepMeta);
      return healedStep;
    };

    try {
      if (!nested) {
        closePanel();
        runtimeMask.resetSequence(label, normalizedActions.length);
        runtimeMask.pushHistory("observation", `${label}已开始执行。`, `steps=${normalizedActions.length}`);
        if (typeof controller.beforeSequence === "function") {
          await controller.beforeSequence(label);
        }
      }
      for (let index = 0; index < normalizedActions.length; index += 1) {
        if (state.runtime.cancelRequested) {
          reportTrace("cancelled", {
            failed_step: normalizedActions[index],
          });
          if (!nested) {
            runtimeMask.finish(false, "动作执行已取消。");
            setStatus("动作执行已取消。");
          }
          return { success: false, executedCount: executedSteps.length, message: "动作执行已取消。" };
        }
        const action = normalizedActions[index];
        const actionType = getWorkflowStepType(action);
        const stepMeta = `步骤 ${index + 1}/${normalizedActions.length}`;
        const actionSummary = actionType === PAGE_AGENT_TASK_STEP_TYPE ? getWorkflowStepTargetLabel(action) : describeRuntimeAction(action);
        if (actionType === "ask_human") {
          const historySummary = String(action.question || action.message || action.reason || "是否继续执行？").trim();
          const askOptions = getAskHumanOptions(action);
          const selectedOptionFallback = askOptions[0] || {
            id: "confirm",
            label: String(action.confirm_label || "").trim() || "确认",
            value: "continue",
            branch_steps: [],
            replace_remaining: false,
          };
          const applyAskHumanBranch = (option) => {
            const branchSteps = Array.isArray(option?.branch_steps) ? option.branch_steps.filter(Boolean) : [];
            const fieldValues = option?.field_values && typeof option.field_values === "object" ? option.field_values : {};
            if (!branchSteps.length) {
              return 0;
            }
            const preparedBranchSteps = branchSteps.map((step) => {
              const cloned = renderTemplateValuesInData(cloneWorkflowSteps([step])[0] || {}, fieldValues);
              if (action.workflow_id && !cloned.workflow_id) {
                cloned.workflow_id = action.workflow_id;
              }
              if (action.workflow_name && !cloned.workflow_name) {
                cloned.workflow_name = action.workflow_name;
              }
              if (Number.isInteger(action.workflow_step_index) && !Number.isInteger(cloned.workflow_step_index)) {
                cloned.workflow_step_index = action.workflow_step_index;
              }
              return cloned;
            });
            if (option?.replace_remaining) {
              normalizedActions.splice(index + 1, normalizedActions.length - (index + 1), ...preparedBranchSteps);
            } else {
              normalizedActions.splice(index + 1, 0, ...preparedBranchSteps);
            }
            runtimeMask.pushHistory(
              "observation",
              `已根据选择插入 ${preparedBranchSteps.length} 个分支步骤。`,
              stepMeta
            );
            return preparedBranchSteps.length;
          };
          runtimeMask.setStatus("executing", `${stepMeta} · 等待确认`, historySummary || "等待确认后继续执行。");
          runtimeMask.pushHistory("question", historySummary || "是否继续执行？", stepMeta);
          const chosenOption = await waitForRuntimeChoice(action, askOptions);
          if (!chosenOption) {
            const cancelOption =
              askOptions.find((item) => {
                const value = String(item.value || "").trim().toLowerCase();
                return value === "cancel" || value === "abort" || value === "stop";
              }) || {
                id: "cancel",
                label: String(action.cancel_label || "").trim() || "取消",
                value: "cancel",
                branch_steps: [],
                replace_remaining: false,
              };
            const insertedCount = applyAskHumanBranch(cancelOption);
            executedSteps.push({
              type: "ask_human",
              question: historySummary || "是否继续执行？",
              selected_option_id: cancelOption.id,
              selected_option_label: cancelOption.label,
              selected_option_value: cancelOption.value,
              selected_option_branch_count: insertedCount,
              selected_option_replace_remaining: Boolean(cancelOption.replace_remaining),
              field_values: cancelOption.field_values || {},
              workflow_id: action.workflow_id || undefined,
            });
            if (insertedCount > 0) {
              runtimeMask.pushHistory("success", `已选择分支：${cancelOption.label}`, stepMeta);
              continue;
            }
            reportTrace("cancelled", {
              failed_step: action,
            });
            if (!nested) {
              runtimeMask.finish(false, "动作执行已取消。");
              setStatus("动作执行已取消。");
            }
            return { success: false, executedCount: executedSteps.length, message: "动作执行已取消。" };
          }
          const selectedOption = chosenOption || selectedOptionFallback;
          const insertedCount = applyAskHumanBranch(selectedOption);
          executedSteps.push({
            type: "ask_human",
            question: historySummary || "是否继续执行？",
            selected_option_id: selectedOption.id,
            selected_option_label: selectedOption.label,
            selected_option_value: selectedOption.value,
            selected_option_branch_count: insertedCount,
            selected_option_replace_remaining: Boolean(selectedOption.replace_remaining),
            field_values: selectedOption.field_values || {},
            workflow_id: action.workflow_id || undefined,
          });
          runtimeMask.pushHistory("success", `已选择：${selectedOption.label}`, stepMeta);
          continue;
        }
        if (actionType === "wait") {
          const duration = Number(action.ms || action.duration_ms || 500);
          runtimeMask.setStatus("executing", `${stepMeta} · 等待页面响应`, `${label} · 等待 ${duration}ms`);
          runtimeMask.pushHistory("observation", `等待 ${duration}ms`, stepMeta);
          await waitForMs(duration);
          continue;
        }
        if (actionType === PAGE_AGENT_TASK_STEP_TYPE) {
          const taskInstruction = String(action.instruction || "").trim();
          runtimeMask.setStatus("executing", `${stepMeta} · 规划 page-agent 任务`, taskInstruction || "正在规划页面操作");
          runtimeMask.pushHistory("observation", taskInstruction || "正在规划 page-agent 任务。", stepMeta);
          let taskPlan = null;
          try {
            const taskAnalysisSeed = await buildCurrentAnalysisSeed();
            const taskPageState = await captureActionablePageState(taskInstruction || pickText());
            taskPlan = await requestBrowserControlPlan(taskInstruction, {
              contextKey: getTeachContextKey() || state.lastContextKey || buildContextKey(pickText()),
              currentAnalysisSeed: taskAnalysisSeed,
              pageState: taskPageState,
            });
          } catch (error) {
            const failureMessage = `page-agent 任务规划失败：${error?.error?.message || error?.message || "unknown error"}`;
            const healedStep = await maybeHealWorkflowStep(action, index, actionSummary);
            if (healedStep) {
              index -= 1;
              continue;
            }
            reportTrace("failed", {
              failed_step: action,
              healing_state: "none",
            });
            return finishFailure(failureMessage);
          }
          const plannedActions = Array.isArray(taskPlan?.browser_actions) ? taskPlan.browser_actions : [];
          if (!plannedActions.length) {
            const failureMessage = `page-agent 未为这一步生成可执行动作：${String(taskPlan?.reply || taskInstruction || "当前没有找到合适动作。").slice(0, 120)}`;
            const healedStep = await maybeHealWorkflowStep(action, index, actionSummary);
            if (healedStep) {
              index -= 1;
              continue;
            }
            reportTrace("failed", {
              failed_step: action,
              healing_state: "none",
            });
            return finishFailure(failureMessage);
          }
          runtimeMask.pushHistory("observation", `已生成 ${plannedActions.length} 步页面动作。`, stepMeta);
          const taskResult = await executeBrowserActions(plannedActions, taskInstruction || label, {
            nested: true,
            suppressTraceUpdates: true,
            traceId,
          });
          if (!taskResult.success) {
            const failureMessage = taskResult.message || `page-agent 任务执行失败：${taskInstruction || "未知任务"}`;
            const healedStep = await maybeHealWorkflowStep(action, index, actionSummary);
            if (healedStep) {
              index -= 1;
              continue;
            }
            reportTrace("failed", {
              failed_step: action,
              healing_state: "none",
            });
            return finishFailure(failureMessage);
          }
          executedSteps.push({
            type: PAGE_AGENT_TASK_STEP_TYPE,
            instruction: taskInstruction,
            workflow_id: action.workflow_id || undefined,
          });
          runtimeMask.pushHistory("success", `page-agent 任务完成：${taskInstruction}`, stepMeta);
          continue;
        }
        if (actionType === "fill_form") {
          const expandedSteps = expandFormAction(action);
          if (!expandedSteps.length) {
            const diagnostic = {
              reason: "empty_form_fields",
              message: "fill_form 未提供可执行字段",
              action_type: "fill_form",
              target: describeRuntimeTarget(action),
              phase: "workflow_expand",
              source: "workflow_runner",
              attempted_modes: ["workflow"],
            };
            reportTrace("failed", {
              failed_step: { ...action, failure_diagnostic: diagnostic },
              healing_state: "none",
            });
            return finishFailure("fill_form 未提供可执行字段。", diagnostic);
          }
          runtimeMask.setStatus("executing", `${stepMeta} · 填写表单`, `${describeRuntimeTarget(action)} | fields=${expandedSteps.length}`);
          runtimeMask.pushHistory("observation", `准备填写表单，共 ${expandedSteps.length} 个子动作。`, stepMeta);
          const formResult = await executeBrowserActions(expandedSteps, action.target_desc || label, {
            nested: true,
            suppressTraceUpdates: true,
            traceId,
          });
          if (!formResult.success) {
            const diagnostic = formResult.diagnostic || {
              reason: "fill_form_failed",
              message: formResult.message || "表单执行失败",
              action_type: "fill_form",
              target: describeRuntimeTarget(action),
              phase: "workflow_expand",
              source: "workflow_runner",
              attempted_modes: ["workflow"],
            };
            reportTrace("failed", {
              failed_step: { ...action, failure_diagnostic: diagnostic },
              healing_state: "none",
            });
            return finishFailure(formResult.message || "表单执行失败。", diagnostic);
          }
          executedSteps.push({
            type: "fill_form",
            target_desc: action.target_desc || action.label || "表单",
            field_count: expandedSteps.length,
            workflow_id: action.workflow_id || undefined,
          });
          runtimeMask.pushHistory("success", `表单填写完成：${describeRuntimeTarget(action)}`, `${stepMeta} · fields=${expandedSteps.length}`);
          continue;
        }

        runtimeMask.setStatus("executing", `${stepMeta} · ${actionSummary}`, describeRuntimeTarget(action));
        const beforeUrl = location.href;
        let executionMeta = null;
        try {
          executionMeta = (await controller.perform(action, null)) || { mode: "legacy" };
        } catch (error) {
          const diagnostic = extractActionFailureDiagnostic(action, error);
          const failureSuffix = formatActionFailureDiagnostic(diagnostic);
          const failureMessage = `${String(error?.message || `动作失败：${action.type || actionType}`)}${failureSuffix ? ` | ${failureSuffix}` : ""}`;
          const healedStep = await maybeHealWorkflowStep(action, index, actionSummary, diagnostic);
          if (healedStep) {
            index -= 1;
            continue;
          }
          reportTrace("failed", {
            failed_step: { ...action, failure_diagnostic: diagnostic },
            healing_state: "none",
          });
          return finishFailure(failureMessage, diagnostic);
        }
        const afterUrl = location.href;
        const executionMode = executionMeta.mode === "native" ? "native" : "fallback";
        const nativeIndexText = Number.isInteger(executionMeta.nativeIndex) ? ` · idx=${executionMeta.nativeIndex}` : "";
        runtimeMask.pushHistory("success", actionSummary, `${stepMeta} · ${executionMode}${nativeIndexText}`);
        if (typeof controller.afterAction === "function") {
          await controller.afterAction(action, executionMeta).catch(() => {});
        }
        if (afterUrl !== beforeUrl) {
          runtimeMask.pushHistory("observation", `页面跳转到 ${afterUrl}`, stepMeta);
        }
        if (actionType === "click" || actionType === "select" || actionType === "press_key") {
          const defaultDelayMs =
            actionType === "press_key"
              ? looksLikeNavigationAction(action) || /enter/i.test(String(action.key || action.value || ""))
                ? 160
                : 120
              : executionMeta.mode === "native"
                ? (looksLikeNavigationAction(action) ? 160 : 90)
                : 220;
          await waitForMs(Number(action.post_delay_ms || defaultDelayMs));
        }
        executedSteps.push({
          type: actionType,
          target_desc: action.target_desc || action.selector || action.element_id || "",
          page_agent_index: Number.isInteger(action.page_agent_index) ? action.page_agent_index : undefined,
          workflow_id: action.workflow_id || undefined,
        });
      }
      reportTrace("executed");
      const successMessage = `${label}执行完成。`;
      if (!nested) {
        runtimeMask.finish(true, `${label}执行完成，共 ${executedSteps.length} 步。`);
        setStatus(successMessage);
        if (!options.skipWorkflowSavePrompt) {
          try {
            await maybeOfferWorkflowSaveAfterSuccess(normalizedActions, label);
          } catch (saveError) {
            setStatus(`流程保存失败：${saveError?.error?.message || saveError?.message || "unknown error"}`);
          }
        }
      }
      return { success: true, executedCount: executedSteps.length, message: successMessage };
    } catch (error) {
      const message = `动作失败：${error?.message || "unknown error"}`;
      return finishFailure(message);
    } finally {
      if (!nested && typeof controller.afterSequence === "function") {
        await controller.afterSequence().catch(() => {});
      }
      if (!nested && shouldRestorePanel) {
        openPanel();
        switchView(restoreView);
      }
    }
  }

  function isInsideOmniAgent(element) {
    return panel.contains(element) || launcher.contains(element);
  }

  function pushRecordedStep(step) {
    const last = state.recorder.steps[state.recorder.steps.length - 1];
    const fingerprint = JSON.stringify(step);
    if (last && JSON.stringify(last) === fingerprint) {
      return;
    }
    state.recorder.steps.push(step);
    renderRecorderList();
  }

  function quoteForInstruction(value) {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    return normalized ? `“${normalized.slice(0, 80)}”` : "";
  }

  function buildElementInstructionHint(element) {
    if (!(element instanceof Element)) {
      return "当前目标";
    }
    const label = inferLabel(element);
    const nearby = inferNearbyText(element);
    const descriptor = label || describeElement(element);
    if (nearby && descriptor && !String(nearby).includes(descriptor)) {
      return `${descriptor}（附近文字：${nearby.slice(0, 40)}）`;
    }
    return descriptor || "当前目标";
  }

  function buildPageAgentTaskInstruction(type, element, value) {
    const target = resolveRecordableElement(type, element);
    const hint = buildElementInstructionHint(target);
    const quotedValue = quoteForInstruction(value);
    if (type === "click") {
      return `点击${quoteForInstruction(hint) || "当前目标"}。`;
    }
    if (type === "fill") {
      return `在${quoteForInstruction(hint) || "当前输入框"}中输入${quotedValue || "指定内容"}。`;
    }
    if (type === "select") {
      return `在${quoteForInstruction(hint) || "当前下拉框"}中选择${quotedValue || "目标选项"}。`;
    }
    if (type === "focus") {
      return `聚焦${quoteForInstruction(hint) || "当前目标"}。`;
    }
    if (type === "highlight") {
      return `高亮${quoteForInstruction(hint) || "当前目标"}。`;
    }
    return `${type || "执行"}${quoteForInstruction(hint) || "当前目标"}。`;
  }

  function buildPageAgentTaskSuccessCriteria(type, element, value) {
    const target = resolveRecordableElement(type, element);
    const hint = buildElementInstructionHint(target);
    const quotedValue = quoteForInstruction(value);
    if (type === "click") {
      return `${hint || "目标元素"}已触发点击，页面出现预期变化。`;
    }
    if (type === "fill") {
      return `${hint || "目标输入框"}成功写入${quotedValue || "目标内容"}。`;
    }
    if (type === "select") {
      return `${hint || "目标下拉框"}成功切换到${quotedValue || "目标选项"}。`;
    }
    return `${hint || "目标元素"}完成预期操作。`;
  }

  function buildStepFromElement(type, element, value) {
    const target = resolveRecordableElement(type, element);
    const step = {
      type: PAGE_AGENT_TASK_STEP_TYPE,
      instruction: buildPageAgentTaskInstruction(type, target, value),
      success_criteria: buildPageAgentTaskSuccessCriteria(type, target, value),
      source_action_type: String(type || "").trim().toLowerCase() || "step",
      source_value: value || undefined,
    };
    if (String(type || "").trim().toLowerCase() === "select") {
      const optionCandidates = extractSelectOptionCandidates(target);
      if (optionCandidates.length) {
        step.option_candidates = optionCandidates;
      }
    }
    return step;
  }

  function resolveRecordableElement(type, element) {
    if (!(element instanceof Element)) {
      return element;
    }
    if (type === "click") {
      return (
        element.closest("button, a, [role='button'], input[type='button'], input[type='submit'], label") ||
        element
      );
    }
    if (type === "fill") {
      return element.closest("input, textarea, [contenteditable='true']") || element;
    }
    if (type === "select") {
      return element.closest("select") || element;
    }
    if (type === "press_key") {
      return element.closest("input, textarea, select, [contenteditable='true'], [role='textbox'], form") || element;
    }
    return element;
  }

  async function startWorkflowRecording() {
    if (state.recorder.active) {
      setRecorderStatus("当前已经在录制中了。");
      return;
    }
    state.recorder.active = true;
    state.recorder.steps = [];
    state.recorder.inspecting = true;
    updateTeachChrome();
    toggleTeachRecorderCard(true);
    try {
      const controller = await ensurePageAgentNativeController();
      await controller.updateTree();
      setRecorderStatus("已开始录制。PageAgent 页面树已就绪，后续步骤会直接整理成可复用的任务指令。");
    } catch (error) {
      setRecorderStatus("已开始录制。当前未拿到 PageAgent 页面树，但仍会记录高层任务指令。");
    }
    closePanel();
    setStatus("已进入录制模式，面板已自动收起。录完后再打开面板停止或整理草案。");

    const onClick = (event) => {
      const element = event.target;
      if (!element || isInsideOmniAgent(element)) {
        return;
      }
      pushRecordedStep(buildStepFromElement("click", element));
      setRecorderStatus(`录制中：已记录 ${state.recorder.steps.length} 步。`);
      if (state.pageAgentNativeController?.updateTree) {
        Promise.resolve(state.pageAgentNativeController.updateTree()).catch(() => {});
      }
    };

    const onChange = (event) => {
      const element = event.target;
      if (!element || isInsideOmniAgent(element)) {
        return;
      }
      if (element.tagName === "SELECT") {
        pushRecordedStep(buildStepFromElement("select", element, element.value));
      } else if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        pushRecordedStep(buildStepFromElement("fill", element, element.value));
      }
      setRecorderStatus(`录制中：已记录 ${state.recorder.steps.length} 步。`);
      if (state.pageAgentNativeController?.updateTree) {
        Promise.resolve(state.pageAgentNativeController.updateTree()).catch(() => {});
      }
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    state.recorder.cleanup = () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
    };

    renderRecorderList();
  }

  async function stopWorkflowRecording(saveToBackend) {
    if (!state.recorder.active && !state.recorder.steps.length) {
      setRecorderStatus("当前没有录制内容。");
      return;
    }
    if (state.recorder.cleanup) {
      state.recorder.cleanup();
    }
    state.recorder.active = false;
    state.recorder.cleanup = null;
    state.recorder.inspecting = false;

    if (!saveToBackend) {
      setRecorderStatus(`录制已停止，共 ${state.recorder.steps.length} 步。可在立规矩页继续整理成 workflow 草案。`);
      return;
    }
    if (!state.recorder.steps.length) {
      setRecorderStatus("录制已停止，但没有采集到动作。");
      return;
    }
    await draftRecordedWorkflow({ assumeStopped: true });
  }

  function clearWorkflowRecording() {
    if (state.recorder.cleanup) {
      state.recorder.cleanup();
    }
    state.recorder = {
      active: false,
      steps: [],
      inspecting: false,
      cleanup: null,
    };
    renderRecorderList();
    setRecorderStatus("录制内容已清空。");
  }

  async function draftRecordedWorkflow(options = {}) {
    if (state.recorder.active && !options.assumeStopped) {
      await stopWorkflowRecording(false);
    }
    const recorderSteps = getRecordedStepsSnapshot();
    if (!recorderSteps.length) {
      switchView("teach");
      setTeachResult("先录制至少一步，再整理成 workflow 草案。");
      setRecorderStatus("当前没有录制内容，无法整理草案。");
      return;
    }
    const input = document.getElementById("oa2-teach-input");
    const defaultPrompt = "把刚才录制的步骤整理成一个可复用 workflow，生成名称、摘要，并尽量绑定到当前页面场景。";
    if (input && !input.value.trim()) {
      input.value = defaultPrompt;
    }
    switchView("teach");
    setRecorderStatus(`正在把 ${recorderSteps.length} 步录制结果整理成草案...`);
    setTeachResult(`已载入 ${recorderSteps.length} 步录制结果，正在生成 workflow 草案...`);
    await teachCurrent({
      text: input?.value || defaultPrompt,
      forceTeachFlow: true,
      skipVisualContext: true,
    });
  }

  function renderRecorderListInto(node) {
    if (!node) {
      return;
    }
    node.innerHTML = "";
    if (!state.recorder.steps.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-empty";
      empty.textContent = "尚未录到步骤。点击“开始录制”后在真实网页上操作。";
      node.appendChild(empty);
      return;
    }
    state.recorder.steps.forEach((step, index) => {
      const item = document.createElement("div");
      item.className = "oa2-item";
      item.textContent = describeWorkflowStep(step, index);
      node.appendChild(item);
    });
  }

  function renderRecorderList() {
    renderRecorderListInto(document.getElementById("oa2-recorder-list"));
    renderRecorderListInto(document.getElementById("oa2-teach-recorder-list"));
    const meta = document.getElementById("oa2-teach-recorder-meta");
    if (meta) {
      const stepCount = state.recorder.steps.length;
      const foldState = state.recorder.active ? "录制中" : stepCount ? "点击展开" : "暂无步骤";
      meta.textContent = `${stepCount} 步 · ${foldState}`;
    }
    updateTeachChrome();
  }

  async function loadMemory() {
    setStatus("正在读取记忆总览...");
    try {
      const [personas, skills, workflows, templates, documents, stats, traces, healEvents] = await Promise.all([
        apiRequest("GET", "/api/personas"),
        apiRequest("GET", "/api/skills"),
        apiRequest("GET", "/api/workflows"),
        apiRequest("GET", "/api/query-templates"),
        apiRequest("GET", "/api/documents"),
        apiRequest("GET", "/api/stats?recent_limit=8"),
        apiRequest("GET", `/api/traces?limit=6${state.lastContextKey ? `&context_key=${encodeURIComponent(state.lastContextKey)}` : ""}`),
        apiRequest("GET", "/api/workflow-heal-events?limit=6"),
      ]);
      renderMemory(personas, skills, workflows, templates, documents, stats, traces, healEvents);
      setStatus("记忆总览已更新。");
    } catch (error) {
      setStatus(`记忆读取失败：${error?.error?.message || "unknown error"}`);
    }
  }

  function renderMemory(personas, skills, workflows, templates, documents, stats, traces = [], healEvents = []) {
    const summaryNode = document.getElementById("oa2-memory-summary");
    const usageGridNode = document.getElementById("oa2-memory-usage-grid");
    const usageMetaNode = document.getElementById("oa2-memory-usage-meta");
    const listNode = document.getElementById("oa2-memory-list");
    summaryNode.textContent = `当前可直接复用的资产：流程 ${workflows.length} 条、模板 ${templates.length} 条、文档 ${documents.length} 条；最近运行里有 Trace ${traces.length} 条、自愈 ${healEvents.length} 条。角色和技能仍会在分析时自动路由。`;
    if (usageGridNode instanceof HTMLElement) {
      usageGridNode.innerHTML = "";
      const usageItems = [
        { label: "调用次数", value: Number(stats.summary?.total_calls || 0) },
        { label: "总 Token", value: Number(stats.summary?.input_tokens || 0) + Number(stats.summary?.output_tokens || 0) },
        { label: "累计费用", value: `$${Number(stats.summary?.cost_usd || 0).toFixed(4)}` },
      ];
      usageItems.forEach((item) => {
        const card = document.createElement("div");
        card.className = "oa2-memory-usage-item";
        const label = document.createElement("div");
        label.className = "oa2-memory-usage-label";
        label.textContent = item.label;
        const value = document.createElement("div");
        value.className = "oa2-memory-usage-value";
        value.textContent = String(item.value);
        card.appendChild(label);
        card.appendChild(value);
        usageGridNode.appendChild(card);
      });
    }
    if (usageMetaNode instanceof HTMLElement) {
      usageMetaNode.textContent = `input=${Number(stats.summary?.input_tokens || 0)} | output=${Number(stats.summary?.output_tokens || 0)} | cache=${Number(stats.summary?.cache_tokens || 0)} | recent_limit=8`;
    }
    listNode.innerHTML = "";
    const workflowNameById = new Map(
      (Array.isArray(workflows) ? workflows : [])
        .map((item) => [String(item?.workflow_id || "").trim(), String(item?.name || "").trim()])
        .filter(([workflowId, name]) => workflowId && name)
    );
    const templateNameById = new Map(
      (Array.isArray(templates) ? templates : [])
        .map((item) => [String(item?.template_id || "").trim(), String(item?.name || "").trim()])
        .filter(([templateId, name]) => templateId && name)
    );
    const documentNameById = new Map(
      (Array.isArray(documents) ? documents : [])
        .map((item) => [String(item?.document_id || "").trim(), String(item?.name || "").trim()])
        .filter(([documentId, name]) => documentId && name)
    );
    const resolveMemoryLabel = (memoryId) => {
      const normalizedId = String(memoryId || "").trim();
      if (!normalizedId) {
        return "";
      }
      return workflowNameById.get(normalizedId) || templateNameById.get(normalizedId) || documentNameById.get(normalizedId) || normalizedId;
    };
    const formatSelectionSourceLabel = (source, kind = "workflow") => {
      const normalized = String(source || "").trim();
      if (normalized === "analyzer") {
        return "analyzer";
      }
      if (normalized === "router") {
        return kind === "workflow" ? "workflow-router" : "router";
      }
      if (normalized === "code_ranker") {
        return "code-ranker";
      }
      if (normalized === "none") {
        return "none";
      }
      return normalized || "unknown";
    };
    const summarizeReasonText = (text, limit = 72) => {
      const normalized = String(text || "").replace(/\s+/g, " ").trim();
      if (!normalized) {
        return "";
      }
      return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
    };
    const getWorkflowMatchPresentation = (item) => {
      const reason = String(item?.reason || "").trim();
      if (item?.selected_by_ai || reason === "matched") {
        return { label: "已选", detail: "selected" };
      }
      if (reason === "filtered_by_ai") {
        return { label: "AI过滤", detail: "filtered" };
      }
      if (reason === "rejected_by_ai") {
        return { label: "AI拒绝", detail: "rejected" };
      }
      if (reason === "hidden_by_limit") {
        return { label: "超出上限", detail: "hidden" };
      }
      if (reason === "invalid_steps") {
        return { label: "步骤无效", detail: "invalid" };
      }
      if (reason.startsWith("site_scope_miss")) {
        return { label: "站点不匹配", detail: "site-miss" };
      }
      if (reason.startsWith("skill_miss")) {
        return { label: "技能不匹配", detail: "skill-miss" };
      }
      return { label: reason || "未选", detail: "other" };
    };
    const clearMemoryHighlights = () => {
      listNode.querySelectorAll(".is-highlighted").forEach((node) => node.classList.remove("is-highlighted"));
    };
    const copyMemoryText = async (text, successLabel, failureLabel) => {
      try {
        await navigator.clipboard.writeText(String(text || ""));
        setStatus(successLabel);
        return true;
      } catch (error) {
        setStatus(failureLabel);
        return false;
      }
    };
    const focusWorkflowInMemory = async (workflowId) => {
      const normalizedId = String(workflowId || "").trim();
      if (!normalizedId) {
        return;
      }
      switchView("memory");
      clearMemoryHighlights();
      const target = listNode.querySelector(`[data-workflow-id="${CSS.escape(normalizedId)}"]`);
      if (!target) {
        setStatus(`未在记忆视图里找到 workflow：${normalizedId}`);
        return;
      }
      target.classList.add("is-highlighted");
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setStatus(`已定位 workflow：${workflowNameById.get(normalizedId) || normalizedId}`);
    };
    const focusTraceInMemory = async (traceId) => {
      const normalizedId = String(traceId || "").trim();
      if (!normalizedId) {
        return;
      }
      switchView("memory");
      clearMemoryHighlights();
      const target = listNode.querySelector(`[data-trace-id="${CSS.escape(normalizedId)}"]`);
      if (!target) {
        setStatus(`未在记忆视图里找到 trace：${normalizedId}`);
        return;
      }
      target.classList.add("is-highlighted");
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
      }
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setStatus(`已定位 trace：${normalizedId}`);
    };
    const appendCopyButton = (container, text, successLabel, failureLabel, buttonLabel = "复制") => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "oa2-inline-copy";
      button.textContent = buttonLabel;
      const originalLabel = buttonLabel;
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const copied = await copyMemoryText(text, successLabel, failureLabel);
        if (!copied) {
          return;
        }
        button.classList.add("is-success");
        button.textContent = "已复制";
        window.setTimeout(() => {
          button.classList.remove("is-success");
          button.textContent = originalLabel;
        }, 1200);
      });
      container.appendChild(button);
    };
    const appendWorkflowLink = (container, workflowId, fallbackLabel) => {
      const normalizedId = String(workflowId || "").trim();
      const button = document.createElement("button");
      button.type = "button";
      button.className = "oa2-inline-link";
      button.textContent = workflowNameById.get(normalizedId) || fallbackLabel || normalizedId || "未命名流程";
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await focusWorkflowInMemory(normalizedId);
      });
      container.appendChild(button);
    };
    const appendSummaryStat = (container, text) => {
      if (!(container instanceof HTMLElement)) {
        return;
      }
      const normalized = String(text || "").trim();
      if (!normalized) {
        return;
      }
      const chip = document.createElement("span");
      chip.className = "oa2-summary-stat";
      chip.textContent = normalized;
      container.appendChild(chip);
    };

    const memoryStack = document.createElement("div");
    memoryStack.className = "oa2-memory-stack";
    listNode.appendChild(memoryStack);

    const createMemorySection = (title, meta = "") => {
      const section = document.createElement("section");
      section.className = "oa2-memory-section";
      const head = document.createElement("div");
      head.className = "oa2-memory-section-head";
      const titleNode = document.createElement("div");
      titleNode.className = "oa2-memory-section-title";
      titleNode.textContent = title;
      head.appendChild(titleNode);
      if (meta) {
        const metaNode = document.createElement("div");
        metaNode.className = "oa2-memory-section-meta";
        metaNode.textContent = meta;
        head.appendChild(metaNode);
      }
      const body = document.createElement("div");
      body.className = "oa2-memory-lines";
      section.appendChild(head);
      section.appendChild(body);
      memoryStack.appendChild(section);
      return body;
    };

    const overviewBody = createMemorySection("记忆总览", "首页总览");
    const overviewStats = document.createElement("div");
    overviewStats.className = "oa2-memory-stat-row";
    appendSummaryStat(overviewStats, `流程 ${workflows.length}`);
    appendSummaryStat(overviewStats, `自愈 ${healEvents.length}`);
    appendSummaryStat(overviewStats, `Trace ${traces.length}`);
    appendSummaryStat(overviewStats, `模板 ${templates.length}`);
    appendSummaryStat(overviewStats, `文档 ${documents.length}`);
    overviewBody.appendChild(overviewStats);
    const overviewLine = document.createElement("div");
    overviewLine.className = "oa2-memory-line";
    overviewLine.textContent = `统计：calls=${stats.summary?.total_calls || 0} | tokens=${(stats.summary?.input_tokens || 0) + (stats.summary?.output_tokens || 0)} | cost=$${Number(stats.summary?.cost_usd || 0).toFixed(4)}`;
    overviewBody.appendChild(overviewLine);

    const workflowBody = createMemorySection("可复用流程", workflows.length ? `最近 ${Math.min(workflows.length, 4)} 条` : "暂无流程");
    if (!workflows.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-empty";
      empty.textContent = "暂无";
      workflowBody.appendChild(empty);
    } else {
      workflows.slice(0, 4).forEach((item) => {
        const row = document.createElement("div");
        row.className = "oa2-trace-detail";
        row.dataset.workflowId = String(item.workflow_id || "").trim();
        appendWorkflowLink(row, item.workflow_id, item.name || "未命名流程");
        appendCopyButton(
          row,
          item.name || item.workflow_id || "",
          `已复制 workflow：${item.name || item.workflow_id || "未命名流程"}`,
          "复制 workflow 失败，请手动复制。",
          "复制"
        );
        const meta = document.createElement("span");
        meta.textContent = ` (${(item.steps_json || []).length} steps)`;
        row.appendChild(meta);
        workflowBody.appendChild(row);
      });
    }

    const healBody = createMemorySection("最近自愈", healEvents.length ? `最近 ${Math.min(healEvents.length, 4)} 条` : "暂无自愈");
    if (!healEvents.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-empty";
      empty.textContent = "暂无";
      healBody.appendChild(empty);
    } else {
      healEvents.slice(0, 4).forEach((item, index) => {
        const card = document.createElement("details");
        card.className = "oa2-trace-card";
        card.open = false;
        const healWorkflowId = String(item.workflow_id || "").trim();
        const healTraceId = String(item.trace_id || "").trim();
        if (healTraceId) {
          card.dataset.traceId = healTraceId;
        }
        const workflowLabel = workflowNameById.get(healWorkflowId) || healWorkflowId || `workflow ${index + 1}`;
        const reason = String(item.reason || "").trim() || "patched";
        const stepNumber = Number.isInteger(item.step_index) ? item.step_index + 1 : null;
        const newStep = item.new_step_json && typeof item.new_step_json === "object" ? item.new_step_json : {};
        const oldStep = item.old_step_json && typeof item.old_step_json === "object" ? item.old_step_json : {};

        const summary = document.createElement("summary");
        const top = document.createElement("div");
        top.className = "oa2-trace-topline";
        const title = document.createElement("div");
        title.className = "oa2-trace-id";
        title.textContent = workflowLabel;
        const state = document.createElement("div");
        state.className = "oa2-trace-state";
        state.textContent = `[heal]${stepNumber ? `/step-${stepNumber}` : ""}`;
        top.appendChild(title);
        top.appendChild(state);
        summary.appendChild(top);

        const meta = document.createElement("div");
        meta.className = "oa2-trace-meta";
        meta.textContent = `${reason}${item.created_at ? ` | ${item.created_at}` : ""}${healTraceId ? ` | trace=${healTraceId}` : ""}`;
        summary.appendChild(meta);

        const targetNode = document.createElement("div");
        targetNode.className = "oa2-trace-reason";
        targetNode.textContent = `目标：${getWorkflowStepTargetLabel(oldStep) || "未命名旧目标"} -> ${getWorkflowStepTargetLabel(newStep) || "未命名新目标"}`;
        summary.appendChild(targetNode);
        card.appendChild(summary);

        const actionRow = document.createElement("div");
        actionRow.className = "oa2-composer-actions";

        const workflowBtn = document.createElement("button");
        workflowBtn.type = "button";
        workflowBtn.className = "oa2-btn secondary";
        workflowBtn.textContent = "查看流程";
        workflowBtn.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await focusWorkflowInMemory(healWorkflowId);
        });
        actionRow.appendChild(workflowBtn);

        if (healTraceId) {
          const traceBtn = document.createElement("button");
          traceBtn.type = "button";
          traceBtn.className = "oa2-btn secondary";
          traceBtn.textContent = "查看 Trace";
          traceBtn.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await focusTraceInMemory(healTraceId);
          });
          actionRow.appendChild(traceBtn);
        }

        const followBtn = document.createElement("button");
        followBtn.type = "button";
        followBtn.className = "oa2-btn secondary";
        followBtn.textContent = "带去对话";
        followBtn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          focusTeachComposerWithText(
            buildHealEventFollowupPrompt(item, workflowLabel),
            "已把这次自愈记录带到对话区，可继续判断是否要沉淀成更稳妥的规则或流程。"
          );
        });
        actionRow.appendChild(followBtn);
        card.appendChild(actionRow);

        healBody.appendChild(card);
      });
    }

    const traceBody = createMemorySection("最近 Trace", traces.length ? `最近 ${Math.min(traces.length, 4)} 条` : "暂无 Trace");
    if (!traces.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-empty";
      empty.textContent = "暂无";
      traceBody.appendChild(empty);
      const knowledgeBody = createMemorySection("知识资产", "模板 / 文档");
      const emptyKnowledge = document.createElement("div");
      emptyKnowledge.className = "oa2-empty";
      emptyKnowledge.textContent = "暂无";
      knowledgeBody.appendChild(emptyKnowledge);
      return;
    }
    traces.slice(0, 4).forEach((trace) => {
      const card = document.createElement("details");
      card.className = "oa2-trace-card";
      card.open = false;
      card.dataset.traceId = String(trace.trace_id || "").trim();

      const summary = document.createElement("summary");

      const top = document.createElement("div");
      top.className = "oa2-trace-topline";

      const traceId = document.createElement("div");
      traceId.className = "oa2-trace-id";
      traceId.textContent = String(trace.trace_id || "unknown");

      const traceState = document.createElement("div");
      traceState.className = "oa2-trace-state";
      traceState.textContent = `[${trace.status || "unknown"}]${trace.healing_state ? `/${trace.healing_state}` : ""}`;

      top.appendChild(traceId);
      top.appendChild(traceState);
      appendCopyButton(
        top,
        trace.trace_id || "",
        `已复制 trace：${trace.trace_id || "unknown"}`,
        "复制 trace 失败，请手动复制。",
        "复制 trace"
      );
      summary.appendChild(top);

      const source = String(trace.workflow_selection_source || "").trim();
      const selectedIds = Array.isArray(trace.selected_workflow_ids_json) ? trace.selected_workflow_ids_json.filter(Boolean) : [];
      const selectedLabels = selectedIds.map((workflowId) => workflowNameById.get(workflowId) || workflowId);
      const memorySource = String(trace.memory_selection_source || "").trim();
      const selectedMemoryIds = Array.isArray(trace.selected_memory_ids_json) ? trace.selected_memory_ids_json.filter(Boolean) : [];
      const selectedMemoryLabels = selectedMemoryIds.map((memoryId) => resolveMemoryLabel(memoryId));
      const statRow = document.createElement("div");
      statRow.className = "oa2-summary-meta";
      appendSummaryStat(statRow, `workflow ${formatSelectionSourceLabel(source, "workflow")}`);
      appendSummaryStat(statRow, selectedLabels.length ? `workflow ${selectedLabels.length}` : "workflow 0");
      appendSummaryStat(statRow, `memory ${formatSelectionSourceLabel(memorySource, "memory")}`);
      appendSummaryStat(statRow, selectedMemoryLabels.length ? `memory ${selectedMemoryLabels.length}` : "memory 0");
      if (String(trace.healing_state || "").trim() && String(trace.healing_state || "").trim() !== "none") {
        appendSummaryStat(statRow, `heal ${String(trace.healing_state || "").trim()}`);
      }
      summary.appendChild(statRow);

      if (source || selectedIds.length) {
        const meta = document.createElement("div");
        meta.className = "oa2-trace-meta";
        meta.textContent = `workflow=${formatSelectionSourceLabel(source, "workflow")}${selectedLabels.length ? ` | selected=${selectedLabels.join(", ")}` : ""}`;
        summary.appendChild(meta);
      }

      if (memorySource || selectedMemoryIds.length) {
        const memoryMeta = document.createElement("div");
        memoryMeta.className = "oa2-trace-meta";
        memoryMeta.textContent = `memory=${formatSelectionSourceLabel(memorySource, "memory")}${selectedMemoryLabels.length ? ` | selected=${selectedMemoryLabels.join(", ")}` : ""}`;
        summary.appendChild(memoryMeta);
      }

      const reason = String(trace.workflow_selection_reason || "").trim();
      if (reason) {
        const reasonNode = document.createElement("div");
        reasonNode.className = "oa2-trace-reason";
        reasonNode.textContent = `workflow 理由：${summarizeReasonText(reason, 88)}`;
        summary.appendChild(reasonNode);
      }

      const memoryReason = String(trace.memory_selection_reason || "").trim();
      if (memoryReason) {
        const memoryReasonNode = document.createElement("div");
        memoryReasonNode.className = "oa2-trace-reason";
        memoryReasonNode.textContent = `memory 理由：${summarizeReasonText(memoryReason, 88)}`;
        summary.appendChild(memoryReasonNode);
      }

      const healingDetail = trace.healing_detail_json && typeof trace.healing_detail_json === "object" ? trace.healing_detail_json : {};
      const healingStrategy = String(healingDetail.strategy || "").trim();
      if (healingStrategy) {
        const healingNode = document.createElement("div");
        healingNode.className = "oa2-trace-reason";
        const strategyLabel =
          healingStrategy === "user_selected_candidate"
            ? "自愈：用户选择候选目标"
            : healingStrategy === "user_repointed_element"
              ? "自愈：用户手动点选目标"
              : `自愈：${healingStrategy}`;
        const patchedLabel = String(
          healingDetail.failed_target ||
          healingDetail?.patched_step?.target_desc ||
          healingDetail?.patched_step?.selector ||
          ""
        ).trim();
        const versionLabel = Number.isInteger(healingDetail.workflow_version) ? ` | v${healingDetail.workflow_version}` : "";
        healingNode.textContent = `${strategyLabel}${patchedLabel ? ` | ${patchedLabel}` : ""}${versionLabel}`;
        summary.appendChild(healingNode);
      }

      const failedStep = trace.failed_step_json && typeof trace.failed_step_json === "object" ? trace.failed_step_json : {};
      const failureDiagnostic = failedStep.failure_diagnostic && typeof failedStep.failure_diagnostic === "object" ? failedStep.failure_diagnostic : {};
      if (failureDiagnostic.reason || failureDiagnostic.phase || failureDiagnostic.recovery_hint) {
        const failureNode = document.createElement("div");
        failureNode.className = "oa2-trace-reason";
        const failureTarget = String(
          failureDiagnostic.target ||
          failedStep.target_desc ||
          failedStep.selector ||
          failedStep.element_id ||
          ""
        ).trim();
        const failurePhase = describeActionFailurePhase(failureDiagnostic.phase);
        const failureModes = Array.isArray(failureDiagnostic.attempted_modes) ? failureDiagnostic.attempted_modes.filter(Boolean).join(" -> ") : "";
        const hintText = String(failureDiagnostic.recovery_hint || "").trim();
        failureNode.textContent = `失败：${failureTarget || "目标"} | ${failurePhase}${failureModes ? ` | tried=${failureModes}` : ""}${hintText ? ` | ${hintText}` : ""}`;
        summary.appendChild(failureNode);
      }

      card.appendChild(summary);

      const actionRow = document.createElement("div");
      actionRow.className = "oa2-composer-actions";
      if (selectedIds[0]) {
        const workflowBtn = document.createElement("button");
        workflowBtn.type = "button";
        workflowBtn.className = "oa2-btn secondary";
        workflowBtn.textContent = "查看首选流程";
        workflowBtn.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await focusWorkflowInMemory(selectedIds[0]);
        });
        actionRow.appendChild(workflowBtn);
      }
      const followBtn = document.createElement("button");
      followBtn.type = "button";
      followBtn.className = "oa2-btn secondary";
      followBtn.textContent = "带去对话";
      followBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        focusTeachComposerWithText(
          buildTraceFollowupPrompt(trace, selectedLabels, selectedMemoryLabels),
          "已把这条 Trace 带到对话区，可继续复核 workflow / memory 选择是否合理。"
        );
      });
      actionRow.appendChild(followBtn);
      card.appendChild(actionRow);

      const workflowMatches = Array.isArray(trace.workflow_matches_json) ? trace.workflow_matches_json : [];
      if (workflowMatches.length) {
        const rankedMatches = workflowMatches
          .map((item, index) => {
            const reason = String(item?.reason || "").trim();
            const rank = item?.selected_by_ai || reason === "matched"
              ? 0
              : reason === "filtered_by_ai"
                ? 1
                : reason === "rejected_by_ai"
                  ? 2
                  : reason === "hidden_by_limit"
                    ? 3
                    : 4;
            return { item, index, rank };
          })
          .sort((left, right) => left.rank - right.rank || left.index - right.index);
        const selectedCount = workflowMatches.filter((item) => item?.selected_by_ai || String(item?.reason || "").trim() === "matched").length;
        const filteredCount = workflowMatches.filter((item) => String(item?.reason || "").trim() === "filtered_by_ai").length;
        const rejectedCount = workflowMatches.filter((item) => String(item?.reason || "").trim() === "rejected_by_ai").length;
        const hiddenCount = workflowMatches.filter((item) => String(item?.reason || "").trim() === "hidden_by_limit").length;
        const matchSummary = document.createElement("div");
        matchSummary.className = "oa2-summary-meta";
        appendSummaryStat(matchSummary, `候选 ${workflowMatches.length}`);
        if (selectedCount) {
          appendSummaryStat(matchSummary, `已选 ${selectedCount}`);
        }
        if (filteredCount) {
          appendSummaryStat(matchSummary, `AI过滤 ${filteredCount}`);
        }
        if (rejectedCount) {
          appendSummaryStat(matchSummary, `AI拒绝 ${rejectedCount}`);
        }
        if (hiddenCount) {
          appendSummaryStat(matchSummary, `超出上限 ${hiddenCount}`);
        }
        card.appendChild(matchSummary);

        rankedMatches.slice(0, 4).forEach(({ item }, index) => {
          const detail = document.createElement("div");
          detail.className = "oa2-trace-detail";
          const workflowId = String(item.workflow_id || `wf_${index + 1}`).trim();
          const workflowLabel = workflowNameById.get(workflowId) || workflowId;
          const reasonText = summarizeReasonText(String(item.ai_reason || item.reason || "").trim(), 96);
          const statusMeta = getWorkflowMatchPresentation(item);
          detail.dataset.workflowId = workflowId;
          const statusChip = document.createElement("span");
          statusChip.className = "oa2-summary-stat";
          statusChip.textContent = statusMeta.label;
          detail.appendChild(statusChip);
          detail.appendChild(document.createTextNode(" "));
          appendWorkflowLink(detail, workflowId, workflowLabel);
          appendCopyButton(
            detail,
            workflowLabel,
            `已复制 workflow：${workflowLabel}`,
            "复制 workflow 失败，请手动复制。",
            "复制"
          );
          if (reasonText) {
            const text = document.createElement("span");
            text.textContent = ` | ${reasonText}`;
            detail.appendChild(text);
          }
          card.appendChild(detail);
        });
      }

      traceBody.appendChild(card);
    });

    const knowledgeBody = createMemorySection("知识资产", "模板 / 文档");
    const renderKnowledgeRows = (items, kind, title) => {
      const heading = document.createElement("div");
      heading.className = "oa2-memory-line";
      heading.textContent = title;
      knowledgeBody.appendChild(heading);
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "oa2-empty";
        empty.textContent = kind === "template" ? "暂无模板" : "暂无文档";
        knowledgeBody.appendChild(empty);
        return;
      }
      items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "oa2-trace-detail";
        const label = document.createElement("span");
        const name = String(item?.name || item?.template_id || item?.document_id || "未命名资产").trim();
        if (kind === "template") {
          label.textContent = `${name} [${String(item?.platform || "template").trim() || "template"}]`;
        } else {
          label.textContent = `${name} [${String(item?.doc_type || "doc").trim() || "doc"}/${String(item?.namespace || "general").trim() || "general"}]`;
        }
        row.appendChild(label);
        const actionRow = document.createElement("span");
        actionRow.className = "oa2-composer-actions";

        const followBtn = document.createElement("button");
        followBtn.type = "button";
        followBtn.className = "oa2-btn secondary";
        followBtn.textContent = "带去对话";
        followBtn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          focusTeachComposerWithText(
            kind === "template" ? buildTemplateFollowupPrompt(item) : buildDocumentFollowupPrompt(item),
            kind === "template" ? "已把查询模板带到对话区，可继续判断当前页面要怎么复用它。" : "已把知识文档带到对话区，可继续结合当前页面推进复核。"
          );
        });
        actionRow.appendChild(followBtn);

        if (kind === "template" && String(item?.query_template || "").trim()) {
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "oa2-btn secondary";
          copyBtn.textContent = "复制模板";
          copyBtn.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await copyMemoryText(
              item.query_template || "",
              `已复制模板：${name}`,
              "复制模板失败，请手动复制。"
            );
          });
          actionRow.appendChild(copyBtn);
        }
        row.appendChild(actionRow);
        knowledgeBody.appendChild(row);
      });
    };
    renderKnowledgeRows(templates.slice(0, 4), "template", "模板");
    renderKnowledgeRows(documents.slice(0, 4), "document", "文档");
  }

  function formatReviewLoadedAt(timestamp) {
    if (!timestamp) {
      return "";
    }
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (error) {
      return "";
    }
  }

  function createReviewStatCard(label, value, meta) {
    const card = document.createElement("div");
    card.className = "oa2-review-stat";
    const labelNode = document.createElement("div");
    labelNode.className = "oa2-review-stat-label";
    labelNode.textContent = label;
    const valueNode = document.createElement("div");
    valueNode.className = "oa2-review-stat-value";
    valueNode.textContent = String(value);
    const metaNode = document.createElement("div");
    metaNode.className = "oa2-review-stat-meta";
    metaNode.textContent = meta;
    card.appendChild(labelNode);
    card.appendChild(valueNode);
    card.appendChild(metaNode);
    return card;
  }

  function summarizePersonaReviewReason(flags) {
    if (flags.includes("empty_prompt")) {
      return "这个角色没有写清楚回答原则，后续输出容易跑偏。";
    }
    if (flags.includes("short_prompt")) {
      return "这个角色的说明太短，系统不太容易保持稳定风格。";
    }
    if (flags.includes("generic_name")) {
      return "这个角色名称更像测试或临时占位，普通用户不容易判断它该何时使用。";
    }
    return "这条角色配置值得人工复查一下。";
  }

  function summarizeSkillReviewReason(flags) {
    if (flags.includes("missing_role")) {
      return "这个技能没有连到有效角色，正常使用时可能不会在合适场景里出现。";
    }
    if (flags.includes("empty_activation")) {
      return "这个技能没写清楚触发条件，系统不容易知道什么时候该启用它。";
    }
    if (flags.includes("generic_name")) {
      return "这个技能名称更像测试数据，后续维护时不容易一眼看懂用途。";
    }
    return "这条技能配置值得人工复查一下。";
  }

  function renderReviewCandidates(node, items, kind) {
    if (!(node instanceof HTMLElement)) {
      return;
    }
    node.innerHTML = "";
    if (!Array.isArray(items) || !items.length) {
      const empty = document.createElement("div");
      empty.className = "oa2-review-empty";
      empty.textContent = kind === "persona"
        ? "角色库目前看起来比较整洁，没有明显需要普通用户马上处理的条目。"
        : "技能库目前看起来比较整洁，没有明显需要普通用户马上处理的条目。";
      node.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const card = document.createElement("div");
      card.className = "oa2-review-item";
      const head = document.createElement("div");
      head.className = "oa2-review-item-head";
      const title = document.createElement("div");
      title.className = "oa2-review-item-title";
      title.textContent = kind === "persona"
        ? String(item?.name || item?.persona_id || "未命名角色").trim()
        : String(item?.title || item?.skill_id || "未命名技能").trim();
      title.title = kind === "persona"
        ? String(item?.persona_id || "").trim()
        : String(item?.skill_id || "").trim();
      const badge = document.createElement("span");
      badge.className = "oa2-review-badge";
      badge.textContent = "建议复查";
      head.appendChild(title);
      head.appendChild(badge);
      card.appendChild(head);

      const reason = document.createElement("div");
      reason.className = "oa2-review-item-reason";
      reason.textContent = kind === "persona"
        ? summarizePersonaReviewReason(item?.audit_flags || [])
        : summarizeSkillReviewReason(item?.audit_flags || []);
      card.appendChild(reason);

      const meta = document.createElement("div");
      meta.className = "oa2-review-item-meta";
      if (kind === "persona") {
        meta.textContent = `关联技能 ${Number(item?.skill_count || 0)} 项 · 角色说明长度 ${Number(item?.prompt_length || 0)} 字`;
      } else {
        meta.textContent = `绑定角色 ${String(item?.role_id || "未设置").trim() || "未设置"} · 触发线索 ${Number(item?.signature_count || 0)} 项 · 提取字段 ${Number(item?.extraction_task_count || 0)} 项 · 动作 ${Number(item?.action_count || 0)} 项`;
      }
      card.appendChild(meta);
      node.appendChild(card);
    });
  }

  function renderLibraryReview(personaAudit, skillAudit) {
    const summaryNode = document.getElementById("oa2-review-summary");
    const statGridNode = document.getElementById("oa2-review-stat-grid");
    const personasMetaNode = document.getElementById("oa2-review-personas-meta");
    const skillsMetaNode = document.getElementById("oa2-review-skills-meta");
    const personasListNode = document.getElementById("oa2-review-personas-list");
    const skillsListNode = document.getElementById("oa2-review-skills-list");
    const personaSummary = personaAudit?.summary || {};
    const skillSummary = skillAudit?.summary || {};
    const personaCandidates = Array.isArray(personaAudit?.review_candidates) ? personaAudit.review_candidates : [];
    const skillCandidates = Array.isArray(skillAudit?.review_candidates) ? skillAudit.review_candidates : [];
    const totalCandidates = personaCandidates.length + skillCandidates.length;
    const loadedAtText = formatReviewLoadedAt(state.review.loadedAt);
    summaryNode.textContent = totalCandidates
      ? `体检发现 ${totalCandidates} 项值得人工看一眼的内容，主要集中在${personaCandidates.length ? `角色 ${personaCandidates.length} 项` : ""}${personaCandidates.length && skillCandidates.length ? "，" : ""}${skillCandidates.length ? `技能 ${skillCandidates.length} 项` : ""}。这些不会自动删除，只是提醒你哪里更值得复查。`
      : `当前角色库和技能库状态良好，暂时没有明显的测试残留或缺失配置。${loadedAtText ? ` 最近一次体检：${loadedAtText}。` : ""}`;
    if (statGridNode instanceof HTMLElement) {
      statGridNode.innerHTML = "";
      const cards = [
        createReviewStatCard("角色总数", Number(personaSummary.total || 0), `待复查 ${Number(personaSummary.review_candidates || 0)} 项`),
        createReviewStatCard("技能总数", Number(skillSummary.total || 0), `待复查 ${Number(skillSummary.review_candidates || 0)} 项`),
        createReviewStatCard("可直接用的角色", Number(personaSummary.product_ready || 0), `命名偏泛 ${Number(personaSummary.generic_name || 0)} 项`),
        createReviewStatCard("可直接用的技能", Number(skillSummary.product_ready || 0), `缺角色 ${Number(skillSummary.missing_role || 0)} 项`),
      ];
      cards.forEach((card) => statGridNode.appendChild(card));
    }
    personasMetaNode.textContent = `角色库共 ${Number(personaSummary.total || 0)} 项；提示词过短或名称像测试数据的，会列在下面。`;
    skillsMetaNode.textContent = `技能库共 ${Number(skillSummary.total || 0)} 项；没绑定角色或没写触发条件的，会列在下面。`;
    renderReviewCandidates(personasListNode, personaCandidates, "persona");
    renderReviewCandidates(skillsListNode, skillCandidates, "skill");
  }

  function renderLibraryReviewError(message) {
    const summaryNode = document.getElementById("oa2-review-summary");
    const statGridNode = document.getElementById("oa2-review-stat-grid");
    const personasMetaNode = document.getElementById("oa2-review-personas-meta");
    const skillsMetaNode = document.getElementById("oa2-review-skills-meta");
    const personasListNode = document.getElementById("oa2-review-personas-list");
    const skillsListNode = document.getElementById("oa2-review-skills-list");
    if (summaryNode) {
      summaryNode.textContent = `体检暂时没成功：${message || "未知错误"}。可以稍后再试一次。`;
    }
    if (statGridNode instanceof HTMLElement) {
      statGridNode.innerHTML = "";
    }
    if (personasMetaNode) {
      personasMetaNode.textContent = "未拿到角色库体检结果。";
    }
    if (skillsMetaNode) {
      skillsMetaNode.textContent = "未拿到技能库体检结果。";
    }
    renderReviewCandidates(personasListNode, [], "persona");
    renderReviewCandidates(skillsListNode, [], "skill");
  }

  async function loadLibraryReview() {
    if (state.review.loading) {
      return;
    }
    state.review.loading = true;
    const summaryNode = document.getElementById("oa2-review-summary");
    if (summaryNode) {
      summaryNode.textContent = "正在体检角色库和技能库...";
    }
    setStatus("正在执行知识库体检...");
    try {
      const [personaAudit, skillAudit] = await Promise.all([
        apiRequest("GET", "/api/personas/audit"),
        apiRequest("GET", "/api/skills/audit"),
      ]);
      state.review.loadedAt = new Date().toISOString();
      renderLibraryReview(personaAudit, skillAudit);
      setStatus("知识库体检已更新。");
    } catch (error) {
      const message = error?.error?.message || error?.message || "unknown error";
      renderLibraryReviewError(message);
      setStatus(`知识库体检失败：${message}`);
    } finally {
      state.review.loading = false;
    }
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsText(file, "utf-8");
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(file);
    });
  }

  async function uploadRagText() {
    const namespaceNode = document.getElementById("oa2-rag-namespace");
    const textNode = document.getElementById("oa2-rag-text");
    const text = textNode.value.trim();
    const namespace = namespaceNode.value.trim() || guessNamespace();
    if (!text) {
      setRagStatus("先输入要上传的文本。");
      return;
    }
    setStatus("正在上传文本到知识库...");
    try {
      const result = await apiRequest("POST", "/api/rag/upload", {
        source_type: "text",
        text,
        namespace,
        tags: ["manual", "userscript"],
        site_scope: ["*"],
      });
      setRagStatus(`文本已永久写入知识库：document_id=${result.document_id || "unknown"} | mode=${result.rag_mode || "semantic"} | chunks=${result.chunk_count || 0}`);
      await loadMemory();
    } catch (error) {
      setRagStatus(`文本上传失败：${error?.error?.message || "unknown error"}`);
    }
  }

  async function uploadRagFile() {
    const namespaceNode = document.getElementById("oa2-rag-namespace");
    const fileNode = document.getElementById("oa2-rag-file");
    const file = fileNode.files && fileNode.files[0];
    if (!file) {
      setRagStatus("先选择一个文件。");
      return;
    }
    const namespace = namespaceNode.value.trim() || guessNamespace();
    setStatus(`正在上传文件 ${file.name}...`);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const payload = {
        source_type: "file_base64",
        name: file.name,
        content_base64: dataUrl.includes(",") ? dataUrl.split(",", 2)[1] : dataUrl,
        namespace,
        tags: ["file", file.name.split(".").pop() || "unknown", "userscript"],
        site_scope: ["*"],
      };
      const result = await apiRequest("POST", "/api/rag/upload", payload);
      setRagStatus(`文件已永久写入知识库：document_id=${result.document_id || "unknown"} | mode=${result.rag_mode || "unknown"} | count=${result.chunk_count || 0}`);
      await loadMemory();
    } catch (error) {
      setRagStatus(`文件上传失败：${error?.error?.message || "unknown error"}`);
    }
  }

  function renderRagResults(result) {
    const listNode = document.getElementById("oa2-rag-list");
    listNode.innerHTML = "";
    (result.structured_results || []).forEach((item) => {
      const node = document.createElement("div");
      node.className = "oa2-item";
      node.textContent = `结构化模板：${item.name} | ${item.query_template || ""}`;
      listNode.appendChild(node);
    });
    (result.semantic_results || []).forEach((item) => {
      const node = document.createElement("div");
      node.className = "oa2-item";
      node.textContent = `语义结果：${item.name} | ${item.snippet || ""}`;
      listNode.appendChild(node);
    });
    if (!(result.structured_results || []).length && !(result.semantic_results || []).length) {
      const node = document.createElement("div");
      node.className = "oa2-item";
      node.textContent = "没有命中结果。";
      listNode.appendChild(node);
    }
  }

  async function searchRag() {
    const namespace = document.getElementById("oa2-rag-namespace").value.trim() || guessNamespace();
    const query = document.getElementById("oa2-rag-query").value.trim();
    if (!query) {
      setRagStatus("先输入检索词。");
      return;
    }
    setStatus("正在检索知识库...");
    try {
      const result = await apiRequest("GET", `/api/rag/search?q=${encodeURIComponent(query)}&namespace=${encodeURIComponent(namespace)}&mode=auto&top_k=5`);
      setRagStatus(`检索完成：structured=${(result.structured_results || []).length} | semantic=${(result.semantic_results || []).length}`);
      renderRagResults(result);
    } catch (error) {
      setRagStatus(`检索失败：${error?.error?.message || "unknown error"}`);
    }
  }

  window.addEventListener("beforeunload", () => {
    if (state.recorder.cleanup) {
      state.recorder.cleanup();
    }
  });
})();
