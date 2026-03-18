// ==UserScript==
// @name         Universal AI Agent - 智能工作流助手
// @namespace    http://tampermonkey.net/
// @version      3.1.0
// @description  极简告警分析 + 用户教导 (只做关键事，不生造信息)
// @author       Security Team
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    console.log('[SOC] Script loaded');

    const API_BASE = 'http://127.0.0.1:5000';
    const API_TOKEN = 'your-secure-token-here'; // TODO: 改为实际 Token

    const COLORS = {
        primary: '#0066FF',
        primaryLight: '#E0EAFF',
        primaryDark: '#0052CC',
        success: '#22C55E',
        danger: '#EF4444',
        warning: '#F59E0B',
        text: '#1F2937',
        textSecondary: '#626F86',
        bg: 'rgba(255, 255, 255, 0.85)',
        border: 'rgba(0, 0, 0, 0.08)',
        hover: 'rgba(0, 102, 255, 0.05)',
        borderLight: 'rgba(255, 255, 255, 0.2)'
    };

    let state = {
        shadowHost: null,
        shadowRoot: null,
        pickerMode: false,
        currentAnalysis: null,
        currentHighlights: [],
        selectedContainer: null,
        currentTab: 'analyze',
        // ============== 多轮对话会话管理 ==============
        currentSessionHistory: [],  // 当前工单的对话历史 [{role, content}, ...]
        chatMessages: [],           // UI中展示的聊天气泡 [{role, content, timestamp}, ...]
        // ============== 请求队列管理 ==============
        requestQueue: [],           // 请求队列
        isRequestPending: false,    // 是否有请求正在进行
        MAX_CHAT_MESSAGES: 50,      // 聊天消息上限
        lastBrowserContent: null    // 浏览器最后获取的内容
    };

    // ============== 存储（含大小检查） ==============
    const MAX_STORAGE_SIZE = 4 * 1024 * 1024; // 4MB 限制

    function getStorageKey() {
        return 'soc_target_selector_' + window.location.hostname;
    }

    function getStorageSize() {
        let total = 0;
        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                total += localStorage[key].length + key.length;
            }
        }
        return total;
    }

    function checkStorageAvailable() {
        const currentSize = getStorageSize();
        if (currentSize > MAX_STORAGE_SIZE) {
            notify('⚠️ 存储空间不足，请清理后重试', 'error');
            return false;
        }
        return true;
    }

    function getSavedSelector() {
        try {
            return localStorage.getItem(getStorageKey());
        } catch (e) {
            return null;
        }
    }

    function saveSelector(selector, name = null) {
        try {
            if (!checkStorageAvailable()) return;

            // 如果有名称，保存到多选择器列表
            if (name) {
                const selectors = getSavedSelectors();
                const existing = selectors.findIndex(s => s.name === name);
                if (existing >= 0) {
                    selectors[existing].selector = selector;
                } else {
                    selectors.push({ name: name, selector: selector, created: Date.now() });
                }
                localStorage.setItem(getStorageKey() + '_list', JSON.stringify(selectors));
            }

            // 保存当前选择器
            localStorage.setItem(getStorageKey(), selector);

            // 添加到历史记录
            addSelectorToHistory(selector);
        } catch (e) {
            console.warn('Failed to save selector:', e);
            notify('⚠️ 存储失败', 'error');
        }
    }

    // ============== 多选择器管理 ==============
    function getSavedSelectors() {
        try {
            return JSON.parse(localStorage.getItem(getStorageKey() + '_list')) || [];
        } catch (e) {
            return [];
        }
    }

    function getSelectorHistory() {
        try {
            return JSON.parse(localStorage.getItem(getStorageKey() + '_history')) || [];
        } catch (e) {
            return [];
        }
    }

    function addSelectorToHistory(selector) {
        const history = getSelectorHistory();
        // 避免重复
        if (history[0] === selector) return;
        history.unshift(selector);
        // 只保留最近 10 个
        if (history.length > 10) history.pop();
        localStorage.setItem(getStorageKey() + '_history', JSON.stringify(history));
    }

    function validateSelector(selector) {
        try {
            const el = document.querySelector(selector);
            if (!el) return { valid: false, error: '页面中找不到该元素' };
            const text = el.innerText || el.textContent || '';
            if (text.trim().length < 20) return { valid: false, error: '内容太少(<20字符)' };
            if (text.trim().length > 100000) return { valid: false, error: '内容太多(>100000字符)' };
            return { valid: true, element: el, text: text.trim(), length: text.trim().length };
        } catch (e) {
            return { valid: false, error: '选择器语法错误: ' + e.message };
        }
    }

    function previewSelector(selector) {
        const result = validateSelector(selector);
        if (!result.valid) {
            return { error: result.error };
        }
        return {
            preview: result.text.substring(0, 200) + (result.text.length > 200 ? '...' : ''),
            charCount: result.length,
            hasImages: result.element.querySelectorAll('img').length
        };
    }

    // ============== 通知 ==============
    // 改进：添加 success 类型和淡出动画

    function notify(msg, type = 'info') {
        const notif = document.createElement('div');
        notif.style.cssText = `
            position: fixed; top: 20px; right: 20px;
            background: ${type === 'error' ? COLORS.danger : (type === 'success' ? COLORS.success : COLORS.text)};
            color: white;
            padding: 12px 16px; border-radius: 4px;
            font-size: 13px; z-index: 999998;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            transition: opacity 0.3s;
        `;
        notif.textContent = msg;
        document.body.appendChild(notif);
        setTimeout(() => {
            notif.style.opacity = '0';
            setTimeout(() => notif.remove(), 300);
        }, 2500);
    }

    // ============== CSS 选择器 ==============

    function getCssSelector(el) {
        if (el.nodeType !== Node.ELEMENT_NODE) return null;

        if (el.id && el.id.trim()) {
            return '#' + el.id;
        }

        const path = [];
        while (el && el.nodeType === Node.ELEMENT_NODE) {
            let selector = el.tagName.toLowerCase();

            if (el.className) {
                const classes = el.className.split(/\s+/).filter(c => c && !c.startsWith('soc-'));
                if (classes.length > 0) {
                    selector += '.' + classes.slice(0, 2).join('.');
                    path.unshift(selector);
                    if (path.length >= 2) break;
                    el = el.parentElement;
                    continue;
                }
            }

            let sibling = el;
            let nth = 1;
            while ((sibling = sibling.previousElementSibling)) {
                if (sibling.tagName.toLowerCase() === el.tagName.toLowerCase()) nth++;
            }
            if (nth > 1 || (el.nextElementSibling && el.nextElementSibling.tagName.toLowerCase() === el.tagName.toLowerCase())) {
                selector += ':nth-of-type(' + nth + ')';
            }

            path.unshift(selector);
            el = el.parentElement;
            if (path.length > 5) break;
        }

        return path.join(' > ');
    }

    // ============== 高亮 ==============

    function clearHighlights() {
        state.currentHighlights.forEach(mark => {
            try {
                if (mark && mark.parentNode) {
                    const text = mark.textContent;
                    mark.parentNode.replaceChild(document.createTextNode(text), mark);
                }
            } catch (e) {
                console.warn('[SOC] Error clearing highlight:', e);
            }
        });
        state.currentHighlights = [];
    }

    function highlightText(highlights, container) {
        console.log('[SOC] highlightText called with:', { highlightsCount: highlights?.length, container });

        if (!highlights || !highlights.length) {
            console.log('[SOC] No highlights to apply');
            return;
        }
        clearHighlights();

        if (!container) {
            console.log('[SOC] No container specified, using document.body');
            container = document.body;
        }

        const walker = document.createTreeWalker(
            container,
            NodeFilter.SHOW_TEXT,
            null
        );

        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        console.log('[SOC] Found text nodes:', textNodes.length);

        let totalMatches = 0;
        textNodes.forEach(textNode => {
            let content = textNode.nodeValue;
            if (!content || content.trim().length === 0) return;

            const matches = [];
            highlights.forEach(h => {
                // 适配新数据结构：extracted_values 中的 exact_match_text
                const text = h.exact_match_text || h.text;
                const colorMap = {
                    'red': '#ff0000',
                    'orange': '#ff6600',
                    'yellow': '#ffff00'
                };
                const color = colorMap[h.color] || colorMap['yellow'];

                const regex = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                let m;
                while ((m = regex.exec(content)) !== null) {
                    matches.push({
                        start: m.index,
                        end: m.index + text.length,
                        color: color,
                        text: text,
                        desc: h.desc
                    });
                }
            });

            if (!matches.length) return;

            totalMatches += matches.length;

            matches.sort((a, b) => a.start - b.start);
            const dedup = [];
            matches.forEach(m => {
                if (!dedup.length || dedup[dedup.length - 1].end <= m.start) {
                    dedup.push(m);
                }
            });

            const frag = document.createDocumentFragment();
            let lastIdx = 0;

            dedup.forEach(m => {
                if (m.start > lastIdx) {
                    frag.appendChild(document.createTextNode(content.substring(lastIdx, m.start)));
                }

                const mark = document.createElement('mark');
                mark.style.cssText = `
                    background-color: ${m.color};
                    color: black;
                    font-weight: bold;
                    padding: 0 2px;
                    border-radius: 2px;
                    cursor: help;
                `;
                mark.textContent = m.text;
                mark.title = m.desc;
                frag.appendChild(mark);
                state.currentHighlights.push(mark);

                lastIdx = m.end;
            });

            if (lastIdx < content.length) {
                frag.appendChild(document.createTextNode(content.substring(lastIdx)));
            }

            textNode.parentNode.replaceChild(frag, textNode);
        });

        console.log('[SOC] Highlighting complete. Total matches applied:', totalMatches);
    }

    // ============== 区域选择器 ==============

    function enterPickerMode() {
        state.pickerMode = true;

        // 创建模态层和提示框
        const modal = document.createElement('div');
        modal.id = 'soc-picker-modal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            z-index: 999999;
            pointer-events: none;
        `;
        document.body.appendChild(modal);

        const hint = document.createElement('div');
        hint.id = 'soc-picker-hint';
        hint.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: ${COLORS.bg};
            border: 2px solid ${COLORS.primary};
            border-radius: 8px;
            padding: 24px 32px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: 14px;
            color: ${COLORS.text};
            z-index: 9999999;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
            text-align: center;
            pointer-events: auto;
        `;
        hint.innerHTML = `
            <div style="margin-bottom: 12px; font-weight: 600; font-size: 16px;">📍 区域选择模式</div>
            <div style="margin-bottom: 16px; color: ${COLORS.textSecondary};">请点击要分析的区域</div>
            <div style="margin-bottom: 16px; font-size: 12px; color: ${COLORS.textSecondary};">
                按 <kbd style="background: ${COLORS.primaryLight}; padding: 2px 6px; border-radius: 3px; color: ${COLORS.primary}; font-weight: 600;">ESC</kbd> 或点击下方取消
            </div>
            <button id="soc-picker-cancel" style="
                background: ${COLORS.border};
                border: none;
                border-radius: 4px;
                padding: 8px 16px;
                font-size: 13px;
                cursor: pointer;
                color: ${COLORS.text};
                font-weight: 500;
                transition: background 0.2s;
            ">✕ 取消</button>
        `;
        modal.appendChild(hint);

        const style = document.createElement('style');
        style.id = 'soc-picker-style';
        style.textContent = `
            .soc-picker-highlight {
                outline: 3px dashed ${COLORS.primary} !important;
                background-color: rgba(102, 126, 234, 0.1) !important;
            }
        `;
        document.head.appendChild(style);

        let lastHighlighted = null;

        const mouseoverHandler = (e) => {
            if (!state.pickerMode) return;
            const el = e.target;
            // 不高亮提示框本身
            if (hint.contains(el) || modal.contains(el)) return;
            if (lastHighlighted && lastHighlighted !== el) {
                lastHighlighted.classList.remove('soc-picker-highlight');
            }
            el.classList.add('soc-picker-highlight');
            lastHighlighted = el;

            // 实时检测图片并更新提示
            const imgCount = el.querySelectorAll('img').length;
            const charCount = (el.innerText || el.textContent || '').trim().length;
            const imgBadge = imgCount > 0
                ? `<span style="margin-left: 12px; background: #4CAF50; padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: 600;">🖼️ ${imgCount} 张图片</span>`
                : '';
            const hintContent = `
                <div style="margin-bottom: 12px; font-weight: 600; font-size: 16px;">
                    📍 区域选择 ${imgBadge}
                </div>
                <div style="margin-bottom: 8px; color: ${COLORS.textSecondary}; font-size: 13px;">
                    字符数: ${charCount}
                </div>
                <div style="margin-bottom: 16px; color: ${COLORS.textSecondary};">请点击确认此区域</div>
                <div style="margin-bottom: 16px; font-size: 12px; color: ${COLORS.textSecondary};">
                    按 <kbd style="background: ${COLORS.primaryLight}; padding: 2px 6px; border-radius: 3px; color: ${COLORS.primary}; font-weight: 600;">ESC</kbd> 或点击下方取消
                </div>
                <button id="soc-picker-cancel" style="
                    background: ${COLORS.border};
                    border: none;
                    border-radius: 4px;
                    padding: 8px 16px;
                    font-size: 13px;
                    cursor: pointer;
                    color: ${COLORS.text};
                    font-weight: 500;
                    transition: background 0.2s;
                ">✕ 取消</button>
            `;
            hint.innerHTML = hintContent;
            e.stopPropagation();
        };

        const clickHandler = (e) => {
            if (!state.pickerMode) return;
            // 提示框内的点击不触发选择
            if (hint.contains(e.target)) return;

            e.preventDefault();
            e.stopPropagation();

            const selector = getCssSelector(e.target);
            if (selector) {
                const previewText = e.target.innerText || e.target.textContent || '';
                const preview = previewText.substring(0, 400);
                const charCount = previewText.trim().length;

                // 检测区域内的图片数量
                const imgCount = e.target.querySelectorAll('img').length;
                const imgInfo = imgCount > 0 ? `\n\n🖼️ 包含 ${imgCount} 张图片` : '\n\n⚠️ 未检测到图片';

                // 内容过短或太长都应该警告
                if (charCount < 50) {
                    notify('⚠️ 区域内容太短（<50字符），请选择包含更多文本的区域');
                    return;
                }
                if (charCount > 50000) {
                    notify('⚠️ 区域内容太长（>50000字符），可能包含整个页面，请选择更具体的区域');
                    return;
                }

                const msg = `确认选择此区域？\n\n字符数: ${charCount}${imgInfo}\n\n预览:\n${preview}${charCount > 400 ? '...' : ''}`;

                if (confirm(msg)) {
                    saveSelector(selector);
                    state.selectedContainer = e.target;
                    const notifyMsg = imgCount > 0
                        ? `✓ 已绑定区域 (${charCount} 字符, ${imgCount} 张图片)`
                        : `✓ 已绑定区域 (${charCount} 字符)`;
                    notify(notifyMsg);
                } else {
                    notify('已取消选择');
                }
            } else {
                notify('⚠️ 无法获取选择器，请重试');
            }

            exitPickerMode();
        };

        function exitPickerMode() {
            state.pickerMode = false;
            const styleEl = document.getElementById('soc-picker-style');
            if (styleEl) styleEl.remove();
            const modalEl = document.getElementById('soc-picker-modal');
            if (modalEl) modalEl.remove();
            if (lastHighlighted) {
                lastHighlighted.classList.remove('soc-picker-highlight');
            }
            document.removeEventListener('mouseover', mouseoverHandler, true);
            document.removeEventListener('click', clickHandler, true);
            renderPanel();
        }

        document.addEventListener('mouseover', mouseoverHandler, true);
        document.addEventListener('click', clickHandler, true);

        const escHandler = (e) => {
            if (e.key === 'Escape' && state.pickerMode) {
                notify('已取消区域选择');
                exitPickerMode();
                document.removeEventListener('keydown', escHandler);
            }
        };

        const cancelBtn = hint.querySelector('#soc-picker-cancel');
        cancelBtn.onclick = () => {
            notify('已取消区域选择');
            exitPickerMode();
        };

        document.addEventListener('keydown', escHandler);
    }

    // ============== UI 构建 ==============

    function initShadowDOM() {
        const host = document.createElement('div');
        host.id = 'soc-assistant-host';
        host.style.cssText = 'position:fixed;z-index:999999;bottom:20px;right:20px;pointer-events:none;';
        document.body.appendChild(host);

        const shadow = host.attachShadow({ mode: 'open' });
        state.shadowHost = host;
        state.shadowRoot = shadow;

        const style = document.createElement('style');
        style.textContent = `
            :host {
                --primary: ${COLORS.primary};
                --primaryDark: ${COLORS.primaryDark};
                --success: ${COLORS.success};
                --danger: ${COLORS.danger};
                --warning: ${COLORS.warning};
                --text: ${COLORS.text};
                --textSecondary: ${COLORS.textSecondary};
                --border: ${COLORS.border};
                --bg: ${COLORS.bg};
                --hover: ${COLORS.hover};
                --borderLight: ${COLORS.borderLight};
            }

            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            .soc-btn {
                padding: 10px 16px;
                background: var(--primary);
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 500;
                font-size: 13px;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 8px rgba(0, 102, 255, 0.2);
            }

            .soc-btn:hover {
                background: var(--primaryDark);
                transform: translateY(-1px);
                box-shadow: 0 4px 16px rgba(0, 102, 255, 0.3);
            }

            .soc-btn:active {
                transform: scale(0.96);
                box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
            }

            .soc-floating-btn {
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, var(--primary) 0%, var(--primaryDark) 100%);
                color: white;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 28px;
                cursor: grab;
                box-shadow: 0 4px 16px rgba(0, 102, 255, 0.3);
                transition: box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                pointer-events: auto;
                user-select: none;
                touch-action: none;
            }

            .soc-floating-btn:hover {
                box-shadow: 0 8px 24px rgba(0, 102, 255, 0.4);
            }

            .soc-floating-btn:active {
                cursor: grabbing;
                box-shadow: 0 12px 32px rgba(0, 102, 255, 0.5);
            }

            .soc-floating-btn.dragging {
                cursor: grabbing;
            }

            .soc-panel {
                position: fixed;
                bottom: 80px;
                right: 20px;
                width: 450px;
                max-height: 600px;
                background: rgba(255, 255, 255, 0.88);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.3);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
                display: none;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                color: var(--text);
                overflow: hidden;
                z-index: 999999;
                pointer-events: auto;
                border-radius: 12px;
                animation: panelIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            @keyframes panelIn {
                from {
                    opacity: 0;
                    transform: scale(0.95) translateY(10px);
                }
                to {
                    opacity: 1;
                    transform: scale(1) translateY(0);
                }
            }

            .soc-panel.dragging {
                box-shadow: 0 20px 48px rgba(0, 0, 0, 0.15);
                animation: none;
            }

            .soc-panel.active {
                display: flex;
            }

            .soc-header {
                background: transparent;
                color: var(--text);
                border-bottom: 1px solid rgba(0, 0, 0, 0.06);
                padding: 12px 16px;
                font-weight: 600;
                font-size: 14px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                cursor: grab;
                user-select: none;
            }

            .soc-header::before {
                content: '⠿';
                color: #9CA3AF;
                font-size: 12px;
                opacity: 0.5;
                transition: opacity 0.2s;
                margin-right: 4px;
            }

            .soc-header:hover::before {
                opacity: 1;
            }

            .soc-header.dragging {
                cursor: grabbing;
            }

            .soc-close-btn {
                background: transparent;
                border: none;
                color: var(--textSecondary);
                cursor: pointer;
                width: 24px;
                height: 24px;
                border-radius: 6px;
                font-size: 14px;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .soc-close-btn:hover {
                background: rgba(0, 0, 0, 0.08);
                color: var(--text);
            }

            .soc-tabs {
                display: flex;
                border-bottom: 1px solid var(--border);
                background: transparent;
                gap: 0;
            }

            .soc-tab {
                flex: 1;
                padding: 10px;
                text-align: center;
                background: none;
                border: none;
                cursor: pointer;
                color: var(--textSecondary);
                font-weight: 500;
                font-size: 12px;
                border-bottom: 2px solid transparent;
                transition: all 0.2s;
            }

            .soc-tab:hover {
                color: var(--text);
            }

            .soc-tab.active {
                color: var(--primary);
                border-bottom-color: var(--primary);
            }

            .soc-content {
                flex: 1;
                overflow-y: auto;
                padding: 12px;
                display: none;
            }

            .soc-content.active {
                display: block;
            }

            .soc-section {
                margin-bottom: 12px;
            }

            .soc-section-title {
                font-weight: bold;
                color: var(--primary);
                font-size: 11px;
                text-transform: uppercase;
                margin-bottom: 6px;
                letter-spacing: 0.5px;
            }

            .soc-summary {
                line-height: 1.6;
                color: var(--text);
                font-size: 14px;
                font-weight: bold;
                margin-bottom: 8px;
            }

            .soc-field-list {
                list-style: none;
                padding: 0;
            }

            .soc-field-item {
                padding: 6px 8px;
                background: var(--hover);
                border-radius: 3px;
                margin-bottom: 4px;
                font-size: 11px;
                line-height: 1.4;
            }

            .soc-field-text {
                font-weight: bold;
                margin-right: 4px;
            }

            .soc-field-desc {
                color: #999;
                font-size: 10px;
            }

            .soc-action-btn {
                padding: 8px 12px;
                background: var(--primary);
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
                font-size: 12px;
                width: 100%;
                margin-top: 4px;
                transition: opacity 0.2s;
            }

            .soc-action-btn:hover {
                opacity: 0.8;
            }

            .soc-textarea {
                width: 100%;
                padding: 8px;
                border: 1px solid var(--border);
                border-radius: 4px;
                font-size: 11px;
                font-family: inherit;
                resize: vertical;
                min-height: 80px;
                margin-bottom: 8px;
            }

            .soc-chat-container {
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
            }

            .soc-chat-messages {
                flex: 1;
                overflow-y: auto;
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .soc-chat-bubble {
                display: flex;
                margin-bottom: 12px;
                animation: messageSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            @keyframes messageSlideIn {
                from {
                    opacity: 0;
                    transform: translateY(8px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }

            .soc-chat-bubble.user {
                justify-content: flex-end;
            }

            .soc-chat-bubble.assistant {
                justify-content: flex-start;
            }

            .soc-bubble-content {
                max-width: 80%;
                padding: 10px 14px;
                border-radius: 12px;
                font-size: 12px;
                line-height: 1.5;
                word-wrap: break-word;
                white-space: pre-wrap;
            }

            .soc-bubble-content.user {
                background: linear-gradient(135deg, var(--primary) 0%, var(--primaryDark) 100%);
                color: white;
                border-radius: 16px 4px 16px 16px;
                box-shadow: 0 2px 8px rgba(0, 102, 255, 0.2);
            }

            .soc-bubble-content.assistant {
                background: rgba(0, 0, 0, 0.05);
                color: var(--text);
                border-radius: 4px 16px 16px 16px;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
            }

            .soc-yaml-block {
                background: rgba(0, 0, 0, 0.04);
                border-left: 3px solid var(--success);
                padding: 10px 12px;
                margin: 10px 0;
                border-radius: 6px;
                font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
                font-size: 10px;
                line-height: 1.4;
                overflow-x: auto;
                color: var(--text);
            }

            .soc-yaml-confirm-btn {
                background: var(--success);
                color: white;
                border: none;
                padding: 10px 14px;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 500;
                margin-top: 10px;
                width: 100%;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 8px rgba(34, 197, 94, 0.2);
            }

            .soc-yaml-confirm-btn:hover {
                background: #16a34a;
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(34, 197, 94, 0.3);
            }

            .soc-yaml-confirm-btn:active {
                transform: scale(0.96);
            }

            .soc-chat-input-area {
                padding: 10px;
                border-top: 1px solid var(--border);
                display: flex;
                gap: 8px;
            }

            .soc-chat-input {
                flex: 1;
                padding: 10px 12px;
                border: 1px solid var(--border);
                border-radius: 8px;
                font-size: 12px;
                font-family: inherit;
                resize: none;
                max-height: 80px;
                color: var(--text);
                background: rgba(255, 255, 255, 0.5);
                transition: all 0.2s;
            }

            .soc-chat-input:focus {
                outline: none;
                border-color: var(--primary);
                background: white;
                box-shadow: 0 0 0 3px rgba(0, 102, 255, 0.1);
            }

            .soc-chat-send-btn {
                padding: 10px 14px;
                background: var(--primary);
                color: white;
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 500;
                font-size: 12px;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 2px 8px rgba(0, 102, 255, 0.2);
                min-width: 50px;
            }

            .soc-chat-send-btn:hover {
                background: var(--primaryDark);
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(0, 102, 255, 0.3);
            }

            .soc-chat-send-btn:active {
                transform: scale(0.96);
            }

            .soc-spinner {
                display: inline-block;
                width: 12px;
                height: 12px;
                border: 2px solid rgba(0, 102, 255, 0.2);
                border-top-color: var(--primary);
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }

            .soc-empty {
                text-align: center;
                padding: 20px;
                color: #999;
                font-size: 11px;
            }
        `;

        shadow.appendChild(style);

        // 浮窗按钮 - 支持拖动
        const floatingBtn = document.createElement('div');
        floatingBtn.className = 'soc-floating-btn';
        floatingBtn.textContent = '🔍';

        // 拖动状态
        let isDragging = false;
        let isActuallyDragging = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragStartLeft = 0;
        let dragStartTop = 0;
        const DRAG_THRESHOLD = 5;  // 拖动阈值：超过5px才认为是拖动

        floatingBtn.addEventListener('mousedown', (e) => {
            isDragging = true;
            isActuallyDragging = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            dragStartLeft = parseInt(window.getComputedStyle(state.shadowHost).right);
            dragStartTop = parseInt(window.getComputedStyle(state.shadowHost).bottom);
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = e.clientX - dragStartX;
            const deltaY = e.clientY - dragStartY;
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

            // 只有移动超过阈值才认为是真正的拖动
            if (distance > DRAG_THRESHOLD) {
                isActuallyDragging = true;
                floatingBtn.classList.add('dragging');
            }

            if (!isActuallyDragging) return;

            // 更新位置（从右下角计算）
            const newRight = dragStartLeft - deltaX;
            const newBottom = dragStartTop - deltaY;

            // 限制在视窗内
            const maxRight = window.innerWidth - 60;
            const maxBottom = window.innerHeight - 60;

            state.shadowHost.style.right = Math.max(0, Math.min(newRight, maxRight)) + 'px';
            state.shadowHost.style.bottom = Math.max(0, Math.min(newBottom, maxBottom)) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                if (isActuallyDragging) {
                    // 真正的拖动
                    floatingBtn.classList.remove('dragging');
                    // 保存位置到 localStorage
                    try {
                        localStorage.setItem('soc-floating-btn-pos', JSON.stringify({
                            right: state.shadowHost.style.right,
                            bottom: state.shadowHost.style.bottom
                        }));
                    } catch (e) {
                        console.warn('Failed to save floating button position:', e);
                    }
                } else {
                    // 没有实际拖动，视为点击
                    state.panelEl.classList.toggle('active');
                }
                isDragging = false;
                isActuallyDragging = false;
            }
        });

        shadow.appendChild(floatingBtn);

        // 恢复保存的位置
        try {
            const savedPos = JSON.parse(localStorage.getItem('soc-floating-btn-pos'));
            if (savedPos && savedPos.right && savedPos.bottom) {
                // 确保位置有效（数字）
                const rightVal = parseInt(savedPos.right);
                const bottomVal = parseInt(savedPos.bottom);
                if (!isNaN(rightVal) && !isNaN(bottomVal) && rightVal >= 0 && bottomVal >= 0) {
                    state.shadowHost.style.right = rightVal + 'px';
                    state.shadowHost.style.bottom = bottomVal + 'px';
                }
            }
        } catch (e) {
            console.warn('Failed to restore floating button position:', e);
            // 重置为默认位置
            state.shadowHost.style.right = '20px';
            state.shadowHost.style.bottom = '20px';
        }

        // 面板
        const panel = document.createElement('div');
        panel.className = 'soc-panel';
        state.panelEl = panel;

        const header = document.createElement('div');
        header.className = 'soc-header';
        header.innerHTML = '<span style="flex: 1; cursor: grab; user-select: none; padding-right: 8px;">SOC 研判</span>';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'soc-close-btn';
        closeBtn.textContent = '✕';
        closeBtn.onclick = () => {
            panel.classList.remove('active');
        };
        header.appendChild(closeBtn);

        // Tab
        const tabBar = document.createElement('div');
        tabBar.className = 'soc-tabs';

        const analyzeTab = document.createElement('button');
        analyzeTab.className = 'soc-tab active';
        analyzeTab.textContent = '【分析】';
        analyzeTab.onclick = () => switchTab('analyze', analyzeTab, teachTab);

        const teachTab = document.createElement('button');
        teachTab.className = 'soc-tab';
        teachTab.textContent = '【教导】';
        teachTab.onclick = () => switchTab('teach', analyzeTab, teachTab);

        const statsTab = document.createElement('button');
        statsTab.className = 'soc-tab';
        statsTab.textContent = '【统计】';
        statsTab.onclick = () => switchTab('stats', statsTab, [analyzeTab, teachTab, browserTab, ragTab]);

        const browserTab = document.createElement('button');
        browserTab.className = 'soc-tab';
        browserTab.textContent = '【浏览器】';
        browserTab.onclick = () => switchTab('browser', browserTab, [analyzeTab, teachTab, statsTab, ragTab]);

        const ragTab = document.createElement('button');
        ragTab.className = 'soc-tab';
        ragTab.textContent = '【知识库】';
        ragTab.onclick = () => switchTab('rag', ragTab, [analyzeTab, teachTab, statsTab, browserTab]);

        tabBar.appendChild(analyzeTab);
        tabBar.appendChild(teachTab);
        tabBar.appendChild(statsTab);
        tabBar.appendChild(browserTab);
        tabBar.appendChild(ragTab);

        // 内容区
        const analyzeContent = document.createElement('div');
        analyzeContent.className = 'soc-content active';
        analyzeContent.id = 'analyze-content';

        const teachContent = document.createElement('div');
        teachContent.className = 'soc-content';
        teachContent.id = 'teach-content';

        const statsContent = document.createElement('div');
        statsContent.className = 'soc-content';
        statsContent.id = 'stats-content';

        const browserContent = document.createElement('div');
        browserContent.className = 'soc-content';
        browserContent.id = 'browser-content';

        const ragContent = document.createElement('div');
        ragContent.className = 'soc-content';
        ragContent.id = 'rag-content';

        function switchTab(tab, activeTab, inactiveTabs) {
            state.currentTab = tab;
            const tabs = [analyzeTab, teachTab, statsTab, browserTab, ragTab];
            const contents = [analyzeContent, teachContent, statsContent, browserContent, ragContent];

            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));

            if (tab === 'analyze') {
                analyzeContent.classList.add('active');
            } else if (tab === 'teach') {
                teachContent.classList.add('active');
                renderTeachContent();
            } else if (tab === 'stats') {
                statsContent.classList.add('active');
                renderStatsContent();
            } else if (tab === 'browser') {
                browserContent.classList.add('active');
                renderBrowserContent();
            } else if (tab === 'rag') {
                ragContent.classList.add('active');
                renderRagContent();
            }
        }

        panel.appendChild(header);
        panel.appendChild(tabBar);
        panel.appendChild(analyzeContent);
        panel.appendChild(teachContent);
        panel.appendChild(statsContent);
        panel.appendChild(browserContent);
        panel.appendChild(ragContent);
        shadow.appendChild(panel);

        renderPanel();

        // ============== 高级拖拽系统初始化 ==============
        initDraggablePanel(panel, header);
    }

    // ============== 可拖拽面板系统 ==============

    function initDraggablePanel(panel, header) {
        let isDragging = false;
        let dragStart = { x: 0, y: 0 };
        let panelStart = { x: 0, y: 0 };
        const grid = 15;  // 吸附网格大小

        header.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        function handleMouseDown(e) {
            // 只在标题栏拖拽（排除按钮）
            const target = e.target;

            // 检查是否点击了关闭按钮或其内部元素
            if (target.closest('.soc-close-btn')) {
                return;
            }

            // 检查是否点击了任何button元素
            if (target.tagName === 'BUTTON' || target.closest('button')) {
                return;
            }

            isDragging = true;
            dragStart = { x: e.clientX, y: e.clientY };
            panelStart = {
                x: panel.offsetLeft,
                y: panel.offsetTop
            };
            panel.classList.add('dragging');
            header.classList.add('dragging');
            e.preventDefault();
        }

        function handleMouseMove(e) {
            if (!isDragging) return;

            let x = panelStart.x + (e.clientX - dragStart.x);
            let y = panelStart.y + (e.clientY - dragStart.y);

            // 吸附网格
            x = Math.round(x / grid) * grid;
            y = Math.round(y / grid) * grid;

            // 边界检测（防止拖出屏幕）
            const maxX = window.innerWidth - panel.offsetWidth - 20;
            const maxY = window.innerHeight - panel.offsetHeight - 20;

            x = Math.max(0, Math.min(x, maxX));
            y = Math.max(0, Math.min(y, maxY));

            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }

        function handleMouseUp() {
            if (!isDragging) return;
            isDragging = false;
            panel.classList.remove('dragging');
            header.classList.remove('dragging');

            // 保存位置到 localStorage
            localStorage.setItem('soc-panel-position', JSON.stringify({
                x: panel.offsetLeft,
                y: panel.offsetTop
            }));
        }

        // 从 localStorage 恢复位置
        try {
            const saved = JSON.parse(localStorage.getItem('soc-panel-position'));
            if (saved && saved.x !== undefined && saved.y !== undefined) {
                panel.style.left = saved.x + 'px';
                panel.style.top = saved.y + 'px';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
            }
        } catch (e) {
            console.warn('[SOC] Failed to restore panel position:', e);
        }
    }

    function renderPanel() {
        const content = state.shadowRoot.getElementById('analyze-content');
        content.innerHTML = '';

        const savedSelector = getSavedSelector();

        // 按钮区
        const btnSection = document.createElement('div');
        btnSection.style.marginBottom = '12px';

        // 选择器输入区
        const selectorSection = document.createElement('div');
        selectorSection.style.marginBottom = '12px';

        const selectorInput = document.createElement('input');
        selectorInput.type = 'text';
        selectorInput.id = 'selector-input';
        selectorInput.placeholder = '输入 CSS 选择器...';
        selectorInput.value = savedSelector || '';
        selectorInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 8px; box-sizing: border-box; font-size: 12px;';

        const selectorBtns = document.createElement('div');
        selectorBtns.style.display = 'flex';
        selectorBtns.style.gap = '8px';

        const previewBtn = document.createElement('button');
        previewBtn.className = 'soc-btn';
        previewBtn.style.flex = '1';
        previewBtn.textContent = '👁️ 预览';
        previewBtn.onclick = () => {
            const sel = selectorInput.value.trim();
            if (!sel) { notify('⚠️ 请输入选择器'); return; }
            const result = previewSelector(sel);
            if (result.error) {
                notify('❌ ' + result.error, 'error');
            } else {
                const msg = `✓ 有效选择器\n字符数: ${result.charCount}\n图片: ${result.hasImages}张\n\n预览:\n${result.preview}`;
                alert(msg);
            }
        };

        const saveNameBtn = document.createElement('button');
        saveNameBtn.className = 'soc-btn';
        saveNameBtn.style.flex = '1';
        saveNameBtn.textContent = '💾 保存';
        saveNameBtn.onclick = () => {
            const sel = selectorInput.value.trim();
            if (!sel) { notify('⚠️ 请输入选择器'); return; }
            const name = prompt('输入选择器名称（如：告警列表、威胁情报）:');
            if (name) {
                saveSelector(sel, name);
                notify('✓ 已保存: ' + name);
                renderPanel();
            }
        };

        selectorBtns.appendChild(previewBtn);
        selectorBtns.appendChild(saveNameBtn);
        selectorSection.appendChild(selectorInput);
        selectorSection.appendChild(selectorBtns);

        // 选择历史/已保存列表
        const history = getSelectorHistory();
        const savedList = getSavedSelectors();

        if (history.length > 0 || savedList.length > 0) {
            const historySection = document.createElement('div');
            historySection.style.marginBottom = '12px';
            historySection.style.fontSize = '11px';

            let historyHtml = '<div style="margin-bottom: 8px; color: #626F86;"><strong>已保存:</strong></div>';

            // 已命名的选择器
            if (savedList.length > 0) {
                savedList.forEach((s, i) => {
                    const isActive = s.selector === savedSelector;
                    historyHtml += `
                        <div style="display: flex; align-items: center; gap: 4px; margin-bottom: 4px;">
                            <button class="soc-selector-btn" data-selector="${encodeURIComponent(s.selector)}"
                                style="flex: 1; padding: 4px 8px; font-size: 11px; border: 1px solid ${isActive ? COLORS.primary : '#ddd'};
                                border-radius: 4px; background: ${isActive ? COLORS.primaryLight : '#fff'}; cursor: pointer; text-align: left;">
                                ${s.name}
                            </button>
                            <button class="soc-delete-btn" data-name="${encodeURIComponent(s.name)}"
                                style="padding: 4px 8px; font-size: 10px; border: none; background: #fee2e2; color: #ef4444; border-radius: 4px; cursor: pointer;">✕</button>
                        </div>
                    `;
                });
            }

            // 最近使用
            if (history.length > 0) {
                historyHtml += '<div style="margin-top: 8px; color: #626F86;"><strong>最近:</strong></div>';
                history.slice(0, 5).forEach((s, i) => {
                    if (!savedList.find(x => x.selector === s)) {
                        historyHtml += `
                            <button class="soc-history-btn" data-selector="${encodeURIComponent(s)}"
                                style="display: block; width: 100%; padding: 4px 8px; font-size: 10px; border: 1px solid #eee;
                                border-radius: 4px; background: #fafafa; margin-bottom: 4px; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                ${s}
                            </button>
                        `;
                    }
                });
            }

            historySection.innerHTML = historyHtml;
            btnSection.appendChild(historySection);

            // 绑定历史按钮事件
            setTimeout(() => {
                content.querySelectorAll('.soc-selector-btn').forEach(btn => {
                    btn.onclick = () => {
                        selectorInput.value = decodeURIComponent(btn.dataset.selector);
                        saveSelector(selectorInput.value.trim());
                        notify('✓ 已切换选择器');
                    };
                });
                content.querySelectorAll('.soc-delete-btn').forEach(btn => {
                    btn.onclick = () => {
                        const name = decodeURIComponent(btn.dataset.name);
                        if (confirm('删除选择器: ' + name + '?')) {
                            const selectors = getSavedSelectors().filter(s => s.name !== name);
                            localStorage.setItem(getStorageKey() + '_list', JSON.stringify(selectors));
                            notify('✓ 已删除');
                            renderPanel();
                        }
                    };
                });
                content.querySelectorAll('.soc-history-btn').forEach(btn => {
                    btn.onclick = () => {
                        selectorInput.value = decodeURIComponent(btn.dataset.selector);
                        notify('✓ 已恢复历史选择器');
                    };
                });
            }, 0);
        }

        const pickerBtn = document.createElement('button');
        pickerBtn.className = 'soc-btn';
        pickerBtn.style.width = '100%';
        pickerBtn.style.marginBottom = '8px';
        pickerBtn.textContent = savedSelector ? '🎯 重新选择区域' : '📍 设定提取区域';
        pickerBtn.onclick = enterPickerMode;

        const analyzeBtn = document.createElement('button');
        analyzeBtn.className = 'soc-btn';
        analyzeBtn.id = 'analyze-btn';
        analyzeBtn.style.width = '100%';
        analyzeBtn.textContent = '🔍 分析当前页面';
        analyzeBtn.onclick = () => {
            // 先验证选择器
            const sel = selectorInput.value.trim() || savedSelector;
            if (!sel) { notify('⚠️ 请输入或选择选择器'); return; }
            const result = validateSelector(sel);
            if (!result.valid) {
                notify('❌ ' + result.error, 'error');
                return;
            }
            // 保存当前选择器
            saveSelector(sel);
            performAnalyze();
        };

        const screenshotBtn = document.createElement('button');
        screenshotBtn.className = 'soc-btn';
        screenshotBtn.style.width = '100%';
        screenshotBtn.textContent = '📸 截图并分析';
        screenshotBtn.onclick = captureScreenshotAndAnalyze;

        btnSection.appendChild(selectorSection);
        btnSection.appendChild(pickerBtn);
        btnSection.appendChild(analyzeBtn);
        btnSection.appendChild(screenshotBtn);
        content.appendChild(btnSection);

        // 分析结果
        if (state.currentAnalysis) {
            renderAnalysisResult(content);
        } else {
            const empty = document.createElement('div');
            empty.className = 'soc-empty';
            empty.textContent = '点击【分析当前页面】开始分析';
            content.appendChild(empty);
        }
    }

    // ============== 改进：renderAnalysisResult 函数 ==============
    // 新增支持 matched_domain、matched_persona 字段

    function renderAnalysisResult(container) {
        const analysis = state.currentAnalysis;

        // 1. 新增：动态路由域和人格提示（在 matched_sop 检查之外）
        if (analysis.matched_domain) {
            const matchDiv = document.createElement('div');
            matchDiv.style.cssText = 'background: rgba(34,197,94,0.1); color: #15803d; padding: 10px; border-radius: 4px; margin-bottom: 12px; font-size: 12px; border-left: 3px solid #15803d;';
            matchDiv.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 4px;">🧠 载入人格：【${analysis.matched_persona || '客观管家'}】</div>
                <div>⚡ 触发技能：【${analysis.matched_domain}】</div>
            `;
            container.appendChild(matchDiv);
        }

        // 2. 原有的 matched_sop 检查（保持向后兼容）
        if (analysis.matched_sop) {
            const matchDiv = document.createElement('div');
            matchDiv.style.cssText = 'background: rgba(34,197,94,0.1); color: #15803d; padding: 8px; border-radius: 4px; margin-top: 10px; font-size: 12px; font-weight: bold;';
            matchDiv.textContent = `✓ 触发规则：【${analysis.matched_sop.name || analysis.matched_sop}】`;
            container.appendChild(matchDiv);
        }

        // 3. 显示本次分析消耗（如果已获取）
        if (analysis.analysis_stats) {
            const statsDiv = document.createElement('div');
            statsDiv.style.cssText = 'background: #f0f9ff; border: 1px solid #bae6fd; padding: 8px; border-radius: 4px; margin-bottom: 12px; font-size: 11px; color: #0369a1;';
            statsDiv.innerHTML = `📊 本次消耗: ${analysis.analysis_stats.tokens || '?'} tokens / $${(analysis.analysis_stats.cost || 0).toFixed(4)}`;
            container.appendChild(statsDiv);
        }

        // 4. 摘要
        if (analysis.summary) {
            const sec = document.createElement('div');
            sec.style.cssText = 'margin-top: 12px;';
            sec.innerHTML = `<div class="soc-section-title">分析摘要</div><p style="font-size:13px; line-height:1.5; color: var(--text);">${analysis.summary}</p>`;
            container.appendChild(sec);
        }

        // 4. 纯文本建议
        if (analysis.text_advice && analysis.text_advice.length > 0) {
            const sec = document.createElement('div');
            sec.style.cssText = 'margin-top: 12px;';
            sec.innerHTML = `<div class="soc-section-title">排查与建议</div>`;
            analysis.text_advice.forEach(advice => {
                const advDiv = document.createElement('div');
                advDiv.style.cssText = 'background: #f8fafc; border-left: 3px solid #F59E0B; padding: 8px 12px; margin-bottom: 8px; font-size: 12px; color: #334155;';
                advDiv.textContent = `• ${advice}`;
                sec.appendChild(advDiv);
            });
            container.appendChild(sec);
        }

        // 5. 真实工具链接
        if (analysis.action_links && analysis.action_links.length > 0) {
            const sec = document.createElement('div');
            sec.style.cssText = 'margin-top: 12px;';
            sec.innerHTML = `<div class="soc-section-title">快捷工具</div>`;
            analysis.action_links.forEach(link => {
                const btn = document.createElement('button');
                btn.className = 'soc-action-btn';
                btn.textContent = `➜ ${link.title}`;
                btn.onclick = () => {
                    reportLearnedPattern(link.title);
                    window.open(link.url, '_blank');
                };
                sec.appendChild(btn);
            });
            container.appendChild(sec);
        }
    }

    function renderTeachContent() {
        const content = state.shadowRoot.getElementById('teach-content');
        content.innerHTML = '';

        // 聊天容器
        const chatContainer = document.createElement('div');
        chatContainer.className = 'soc-chat-container';

        // 消息显示区
        const messagesArea = document.createElement('div');
        messagesArea.className = 'soc-chat-messages';
        messagesArea.id = 'soc-chat-messages';

        // 初始提示
        if (state.chatMessages.length === 0) {
            const welcomeMsg = document.createElement('div');
            welcomeMsg.className = 'soc-chat-bubble assistant';
            const welcomeContent = document.createElement('div');
            welcomeContent.className = 'soc-bubble-content assistant';
            welcomeContent.textContent = '👋 分析告警后，在这里与我讨论提取规则、操作链接等。我会在讨论完后为你生成SOP规则。';
            welcomeMsg.appendChild(welcomeContent);
            messagesArea.appendChild(welcomeMsg);
        } else {
            // 显示历史消息
            state.chatMessages.forEach(msg => {
                const bubble = document.createElement('div');
                bubble.className = `soc-chat-bubble ${msg.role}`;
                const contentDiv = document.createElement('div');
                contentDiv.className = `soc-bubble-content ${msg.role}`;
                contentDiv.textContent = msg.content;
                bubble.appendChild(contentDiv);
                messagesArea.appendChild(bubble);
            });
        }

        chatContainer.appendChild(messagesArea);

        // 输入区
        const inputArea = document.createElement('div');
        inputArea.className = 'soc-chat-input-area';

        const textarea = document.createElement('textarea');
        textarea.className = 'soc-chat-input';
        textarea.placeholder = '输入你的想法...';
        textarea.id = 'soc-chat-input';

        const sendBtn = document.createElement('button');
        sendBtn.className = 'soc-chat-send-btn';
        sendBtn.textContent = '📤';
        sendBtn.title = '发送';
        sendBtn.onclick = sendChatMessage;

        inputArea.appendChild(textarea);
        inputArea.appendChild(sendBtn);
        chatContainer.appendChild(inputArea);

        content.appendChild(chatContainer);

        // 自动滚动到底部
        setTimeout(() => {
            messagesArea.scrollTop = messagesArea.scrollHeight;
        }, 100);
    }

    function sendChatMessage() {
        const textarea = state.shadowRoot.getElementById('soc-chat-input');
        const msg = textarea.value.trim();

        if (!msg) {
            notify('⚠️ 请输入内容');
            return;
        }

        // 添加用户消息到历史
        state.currentSessionHistory.push({
            role: 'user',
            content: msg
        });

        // 添加到UI
        state.chatMessages.push({
            role: 'user',
            content: msg,
            timestamp: new Date()
        });

        // 清空输入框
        textarea.value = '';

        // 重新渲染
        renderTeachContent();

        // 调用后端 /chat 接口（多轮对话）
        callChatEndpoint(state.currentSessionHistory);
    }

    // ============== 改进：callChatEndpoint 函数 ==============
    // 新增支持 result.sop_created 和 result.persona_created 字段

    function callChatEndpoint(messages) {
        const messagesArea = state.shadowRoot.getElementById('soc-chat-messages');

        // 显示加载中
        const loadingMsg = document.createElement('div');
        loadingMsg.className = 'soc-chat-bubble assistant';
        const loadingContent = document.createElement('div');
        loadingContent.className = 'soc-bubble-content assistant';
        loadingContent.innerHTML = '<div class="soc-spinner"></div> 思考中...';
        loadingMsg.appendChild(loadingContent);
        messagesArea.appendChild(loadingMsg);
        messagesArea.scrollTop = messagesArea.scrollHeight;

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_BASE}/api/chat`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ messages: messages }),
            onload: (r) => {
                try {
                    const result = JSON.parse(r.responseText);

                    if (result.error) {
                        notify(`❌ ${result.error}`, 'error');
                        loadingMsg.remove();
                        renderTeachContent();
                        return;
                    }

                    const assistantReply = result.reply;

                    // 添加助手消息到历史
                    state.currentSessionHistory.push({
                        role: 'assistant',
                        content: assistantReply
                    });

                    // 移除加载中提示
                    loadingMsg.remove();

                    // 添加消息气泡
                    state.chatMessages.push({
                        role: 'assistant',
                        content: assistantReply,
                        timestamp: new Date()
                    });

                    // 重新渲染聊天
                    const messagesDiv = state.shadowRoot.getElementById('soc-chat-messages');
                    if (messagesDiv) {
                        // 添加助手回复气泡
                        const bubble = document.createElement('div');
                        bubble.className = 'soc-chat-bubble assistant';
                        const contentDiv = document.createElement('div');
                        contentDiv.className = 'soc-bubble-content assistant';
                        contentDiv.textContent = assistantReply;
                        bubble.appendChild(contentDiv);

                        // ============== 改进：支持人格觉醒与技能创建/更新反馈 ==============
                        let cardHtml = '';

                        // 觉醒新人格
                        if (result.persona_created) {
                            cardHtml += `<div style="color:#d97706; font-weight:bold; margin-bottom:6px;">🎭 觉醒新人格：${result.persona_name}</div>`;
                        }

                        // 习得新技能或优化覆盖技能
                        if (result.sop_created) {
                            const actionText = result.is_update ? '🔄 优化并覆盖了技能' : '✨ 习得新技能';
                            cardHtml += `<div style="color:#166534; font-weight:bold; margin-bottom:6px;">${actionText}：${result.sop_domain}</div>`;
                        }

                        // 渲染反馈卡片
                        if (cardHtml) {
                            const skillCard = document.createElement('div');
                            skillCard.style.cssText = 'background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px; margin-top: 12px; font-size:12px; line-height:1.5;';
                            skillCard.innerHTML = cardHtml + `<div style="color:#15803d; margin-top:4px;">系统记忆已同步。下次遇到此类文本，将严格按最新要求执行。</div>`;
                            bubble.appendChild(skillCard);
                            notify(result.is_update ? '记忆已更新！' : '学习成功！', 'success');
                        } else if (result.sop_created && result.sop_config) {
                            // 保留原有逻辑（向后兼容）
                            const skillCard = document.createElement('div');
                            skillCard.style.cssText = 'background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px; margin-top: 10px;';
                            skillCard.innerHTML = `
                                <div style="color: #166534; font-weight: bold; font-size: 12px; margin-bottom: 6px;">
                                    ✨ 习得新技能：${result.sop_config.domain_name}
                                </div>
                                <div style="font-size: 11px; color: #15803d; line-height: 1.4;">
                                    我已将您的教导固化为长期记忆。
                                </div>
                            `;
                            bubble.appendChild(skillCard);
                            notify('🎉 AI 成功学习了新规则！', 'success');
                        }

                        messagesDiv.appendChild(bubble);
                        messagesDiv.scrollTop = messagesDiv.scrollHeight;
                    }

                } catch (e) {
                    console.error('[SOC] Chat error:', e);
                    notify(`❌ 错误: ${e.message}`, 'error');
                    loadingMsg.remove();
                    renderTeachContent();
                }
            },
            onerror: () => {
                notify('❌ 无法连接后端', 'error');
                loadingMsg.remove();
                renderTeachContent();
            }
        });
    }

    function reportLearnedPattern(actionTitle) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_BASE}/api/patterns/record`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                sop_id: state.currentAnalysis?.matched_sop?.name || 'unknown',
                action_title: actionTitle
            }),
            onload: () => console.log('[SOC] Action recorded.')
        });
    }

    // ============== 分析和教导 ==============

    // ============== 请求队列与防重复点击 ==============
    function setButtonsLoading(loading) {
        const analyzeBtn = state.shadowRoot?.querySelector('#analyze-btn');
        const chatSendBtn = state.shadowRoot?.querySelector('#chat-send-btn');
        if (analyzeBtn) {
            analyzeBtn.disabled = loading;
            analyzeBtn.textContent = loading ? '⏳ 分析中...' : '🔍 分析当前页面';
        }
        if (chatSendBtn) {
            chatSendBtn.disabled = loading;
            chatSendBtn.textContent = loading ? '⏳' : '➤';
        }
    }

    async function performAnalyze() {
        // 防重复点击
        if (state.isRequestPending) {
            notify('⚠️ 请求处理中，请稍候');
            return;
        }

        console.log('[SOC] performAnalyze called');
        const savedSelector = getSavedSelector();
        console.log('[SOC] Saved selector:', savedSelector);

        if (!savedSelector) {
            console.log('[SOC] No saved selector found');
            notify('⚠️ 请先选择分析区域');
            return;
        }

        // 标记请求开始
        state.isRequestPending = true;
        setButtonsLoading(true);

        const content = state.shadowRoot.getElementById('analyze-content');
        content.innerHTML = '<div style="text-align: center; padding: 20px;"><div class="soc-spinner"></div> 分析中...</div>';

        try {
            const el = document.querySelector(savedSelector);
            console.log('[SOC] Element found:', !!el);

            if (!el) {
                notify('⚠️ 已保存的区域无法找到，请重新选择');
                renderPanel();
                return;
            }

            const text = el.innerText || el.textContent || '';
            console.log('[SOC] Text extracted, length:', text.length);
            state.selectedContainer = el;

            // ============== 极其关键：清空历史以隔离不同工单 ==============
            state.currentSessionHistory = [];
            state.chatMessages = [];

            if (!text.trim()) {
                notify('⚠️ 选中区域文本为空');
                renderPanel();
                return;
            }

            notify(`✓ 已提取 ${text.trim().length} 字符`);

            // 自动提取区域内的图片（现在会真正等待异步完成）
            const extractedImages = await extractImagesFromContainer(savedSelector);
            console.log(`[SOC] 检测到 ${extractedImages.length} 张图片`);

            if (extractedImages.length > 0) {
                performAnalyzeWithImages(text, extractedImages);
            } else {
                performAnalyzeWithText(text);
            }

        } catch (e) {
            console.log('[SOC] performAnalyze error:', e);
            notify(`❌ 错误: ${e.message}`, 'error');
            renderPanel();
        }
    }

    // ============== 自动图片提取函数（异步版，真正等待所有图片） ==============
    async function extractImagesFromContainer(containerSelector) {
        const container = document.querySelector(containerSelector);
        if (!container) {
            console.log('[SOC] 找不到容器:', containerSelector);
            return [];
        }

        const imgElements = container.querySelectorAll('img');
        console.log(`[SOC] 发现 ${imgElements.length} 个 <img> 元素`);

        // 创建 Promise 数组，每个 Promise 对应一张图片
        const imagePromises = Array.from(imgElements).map((img, idx) => {
            return new Promise((resolve) => {
                try {
                    let src = img.src || img.dataset.src || img.getAttribute('src');

                    if (!src) {
                        console.warn(`[SOC] 图片 ${idx} 无 src 属性`);
                        resolve(null);
                        return;
                    }

                    console.log(`[SOC] 处理图片 ${idx}: ${src.substring(0, 50)}...`);

                    // Base64 数据 URI 直接使用
                    if (src.startsWith('data:')) {
                        console.log(`[SOC] 图片 ${idx} 已收集 (Base64)`);
                        resolve(src);
                    }
                    // Blob URL
                    else if (src.startsWith('blob:')) {
                        fetch(src)
                            .then(res => res.blob())
                            .then(blob => {
                                const reader = new FileReader();
                                reader.onload = () => {
                                    console.log(`[SOC] 图片 ${idx} 已收集 (Blob)`);
                                    resolve(reader.result);
                                };
                                reader.readAsDataURL(blob);
                            })
                            .catch(err => {
                                console.warn(`[SOC] Blob 转换失败 ${idx}:`, err);
                                resolve(null);
                            });
                    }
                    // 普通 URL 转 Base64
                    else {
                        const tempImg = new Image();
                        tempImg.crossOrigin = 'anonymous';

                        tempImg.onload = () => {
                            try {
                                const canvas = document.createElement('canvas');
                                canvas.width = tempImg.width;
                                canvas.height = tempImg.height;
                                const ctx = canvas.getContext('2d');
                                ctx.drawImage(tempImg, 0, 0);
                                const base64 = canvas.toDataURL('image/jpeg', 0.8);
                                console.log(`[SOC] 图片 ${idx} 已收集 (URL转Base64, ${base64.length} bytes)`);
                                resolve(base64);
                            } catch (e) {
                                console.warn(`[SOC] Canvas 绘制失败 ${idx}:`, e);
                                resolve(null);
                            }
                        };

                        tempImg.onerror = () => {
                            console.warn(`[SOC] 图片加载失败 ${idx}: ${src}`);
                            resolve(null);
                        };

                        tempImg.src = src + (src.includes('?') ? '&' : '?') + 't=' + Date.now();
                    }
                } catch (e) {
                    console.warn(`[SOC] 图片处理异常 ${idx}:`, e);
                    resolve(null);
                }
            });
        });

        // 等待所有 Promise 完成，过滤掉失败的
        const results = await Promise.all(imagePromises);
        const validImages = results.filter(img => img !== null);
        console.log(`[SOC] 最终收集 ${validImages.length} 张有效图片`);
        return validImages;
    }

    // ============== 截图功能 ==============
    async function captureScreenshotAndAnalyze() {
        console.log('[SOC] 开始截图...');
        notify('🎬 正在截图...');

        const savedSelector = getSavedSelector();
        if (!savedSelector) {
            notify('⚠️ 请先选择分析区域');
            return;
        }

        try {
            const target = document.querySelector(savedSelector);
            if (!target) {
                notify('❌ 无法找到选中的区域');
                return;
            }

            // 先尝试提取区域内已有的图片（异步等待）
            const extractedImages = await extractImagesFromContainer(savedSelector);

            // 如果有已有的图片，优先使用
            if (extractedImages.length > 0) {
                console.log(`[SOC] 发现 ${extractedImages.length} 张已有图片，准备分析`);
                performAnalyzeWithImages(target.innerText, extractedImages);
                return;
            }

            // 否则执行区域截图
            if (typeof html2canvas !== 'undefined') {
                html2canvas(target).then(canvas => {
                    const screenshotBase64 = canvas.toDataURL('image/jpeg');
                    performAnalyzeWithImages(target.innerText, [screenshotBase64]);
                }).catch(err => {
                    console.error('[SOC] 截图失败:', err);
                    notify('❌ 截图失败: ' + err.message);
                });
            } else {
                // 降级方案：如果没有 html2canvas 库，仅使用文本
                notify('⚠️ 改用文本分析');
                performAnalyzeWithText(target.innerText);
            }
        } catch (e) {
            console.log('[SOC] captureScreenshotAndAnalyze error:', e);
            notify(`❌ 错误: ${e.message}`, 'error');
        }
    }

    // 带图片的分析
    function performAnalyzeWithImages(text, imagesList) {
        console.log(`[SOC] performAnalyzeWithImages called with ${imagesList.length} images`);

        // 详细调试日志
        imagesList.forEach((img, idx) => {
            console.log(`[SOC] Image ${idx}: ${img.substring(0, 50)}... (${img.length} bytes)`);
        });

        state.currentSessionHistory = [];
        state.chatMessages = [];

        const payload = {
            text: text.substring(0, 10000),
            images: imagesList
        };

        console.log(`[SOC] Sending payload with ${payload.images.length} images to backend`);
        console.log(`[SOC] Payload size: ${JSON.stringify(payload).length} bytes`);

        const content = state.shadowRoot.getElementById('analyze-content');
        if (content) content.innerHTML = '<div class="soc-loading">🔍 分析中...</div>';

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_BASE}/api/analyze`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(payload),
            timeout: 30000,
            onload: (r) => {
                state.isRequestPending = false;
                setButtonsLoading(false);
                try {
                    const result = JSON.parse(r.responseText);
                    console.log(`[SOC] Backend response:`, result);
                    state.currentAnalysis = result;
                    notify(`✅ 分析完成（包含 ${imagesList.length} 张图片）`);
                    renderPanel();
                } catch (e) {
                    console.error('[SOC] 解析响应失败:', e);
                    notify('❌ 分析失败: ' + e.message);
                    renderPanel();
                }
            },
            onerror: () => {
                state.isRequestPending = false;
                setButtonsLoading(false);
                console.error('[SOC] Network error');
                notify('❌ 网络错误，请检查后端服务');
            },
            ontimeout: () => {
                state.isRequestPending = false;
                setButtonsLoading(false);
                console.error('[SOC] Request timeout');
                notify('⏱️ 请求超时');
            }
        });
    }

    function performAnalyzeInBackground(text) {
        // 清空历史
        state.currentSessionHistory = [];
        state.chatMessages = [];

        performAnalyzeWithText(text);
    }

    // 统一的分析逻辑
    function performAnalyzeWithText(text) {
        console.log('[SOC] performAnalyzeWithText called with text length:', text.length);
        console.log('[SOC] API_BASE:', API_BASE);
        console.log('[SOC] Sending request to:', `${API_BASE}/api/analyze`);

        // 捕获当前页面的截图（可选功能）
        const payload = {
            text: text.substring(0, 10000),
            images: [] // 预留图片数组，前端可扩展支持截图
        };

        GM_xmlhttpRequest({
            method: 'POST',
            url: `${API_BASE}/api/analyze`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(payload),
            timeout: 30000,  // 30秒超时
            onload: (r) => {
                state.isRequestPending = false;
                setButtonsLoading(false);
                console.log('[SOC] onload triggered, status:', r.status);
                console.log('[SOC] Response text:', r.responseText.substring(0, 200));

                try {
                    const result = JSON.parse(r.responseText);

                    if (result.error) {
                        notify(`❌ ${result.error}`, 'error');
                        renderPanel();
                        return;
                    }

                    state.currentAnalysis = result;

                    console.log('[SOC] Analysis result:', result);
                    console.log('[SOC] Selected container:', state.selectedContainer);
                    console.log('[SOC] Extracted values:', result.extracted_values);

                    // 高亮（适配新的 extracted_values 数据结构）
                    if (result.extracted_values && result.extracted_values.length > 0 && state.selectedContainer) {
                        console.log('[SOC] Calling highlightText...');
                        highlightText(result.extracted_values, state.selectedContainer);
                    } else {
                        console.log('[SOC] Skipping highlight - conditions not met');
                    }

                    // ============== 打底记忆注入：建立会话的第一轮对话 ==============
                    state.currentSessionHistory.push({
                        role: 'user',
                        content: `分析以下告警文本：\n${text.substring(0, 5000)}`
                    });

                    state.currentSessionHistory.push({
                        role: 'assistant',
                        content: `已生成告警摘要：${result.summary}\n\n并提取了 ${result.extracted_values?.length || 0} 个关键字段。`
                    });

                    // UI同步（限制消息数量）
                    state.chatMessages = [
                        {
                            role: 'user',
                            content: `分析告警文本（${text.trim().length}字符）`,
                            timestamp: new Date()
                        },
                        {
                            role: 'assistant',
                            content: result.summary,
                            timestamp: new Date()
                        }
                    ].slice(-state.MAX_CHAT_MESSAGES);

                    // 获取本次分析的 Token 消耗并显示
                    fetchStatsForAnalysis(result);

                    renderPanel();
                    if (state.panelEl && state.panelEl.classList) {
                        notify('✓ 分析完成');
                    }

                } catch (e) {
                    console.log('[SOC] JSON parse error:', e.message);
                    console.log('[SOC] Response text:', r.responseText);
                    notify(`❌ 错误: ${e.message}`, 'error');
                    renderPanel();
                }
            },
            ontimeout: () => {
                state.isRequestPending = false;
                setButtonsLoading(false);
                console.log('[SOC] Request timeout');
                notify('❌ 请求超时，后端未响应', 'error');
                renderPanel();
            },
            onerror: (e) => {
                state.isRequestPending = false;
                setButtonsLoading(false);
                console.log('[SOC] onerror triggered:', e);
                notify('❌ 无法连接后端', 'error');
                renderPanel();
            }
        });
    }

    // ============== 分析完成后获取本次统计 ==============
    let lastStats = null;

    function fetchStatsForAnalysis(analysisResult) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/api/stats',
            onload: (r) => {
                try {
                    const stats = JSON.parse(r.responseText);
                    lastStats = stats;
                    // 在分析结果中显示本次消耗
                    if (state.currentAnalysis) {
                        state.currentAnalysis.analysis_stats = {
                            tokens: stats.last_tokens || stats.total_tokens,
                            cost: stats.last_cost || stats.total_cost
                        };
                    }
                } catch (e) {
                    console.warn('[SOC] 获取统计失败:', e);
                }
            }
        });
    }

    // ============== 统计面板 ==============
    function renderStatsContent() {
        const content = state.shadowRoot.getElementById('stats-content');
        content.innerHTML = '<div style="padding: 12px;">加载中...</div>';

        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/api/stats',
            onload: (r) => {
                try {
                    const stats = JSON.parse(r.responseText);
                    let html = `
                        <div style="padding: 12px;">
                            <div style="font-weight: bold; margin-bottom: 12px; font-size: 14px;">📊 使用统计</div>
                            <div style="background: #f8fafc; padding: 12px; border-radius: 6px; margin-bottom: 12px;">
                                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                                    <div><span style="color: #626F86;">Token:</span> <strong>${stats.total_tokens || 0}</strong></div>
                                    <div><span style="color: #626F86;">成本:</span> <strong>$${stats.total_cost?.toFixed(4) || '0.0000'}</strong></div>
                                    <div><span style="color: #626F86;">SOP调用:</span> <strong>${stats.sop_invocations || 0}</strong></div>
                                    <div><span style="color: #626F86;">请求:</span> <strong>${stats.total_requests || 0}</strong></div>
                                </div>
                            </div>
                            <button id="stats-reset" class="soc-btn" style="width: 100%; background: #EF4444; color: white;">🗑️ 重置统计</button>
                        </div>
                    `;
                    content.innerHTML = html;
                    content.querySelector('#stats-reset').onclick = () => {
                        if (confirm('确定重置所有统计数据？')) {
                            GM_xmlhttpRequest({
                                method: 'POST',
                                url: API_BASE + '/api/stats/reset',
                                onload: () => {
                                    notify('✓ 统计已重置');
                                    renderStatsContent();
                                },
                                onerror: () => notify('❌ 重置失败', 'error')
                            });
                        }
                    };
                } catch (e) {
                    content.innerHTML = '<div style="padding: 12px; color: #EF4444;">❌ 获取统计失败</div>';
                }
            },
            onerror: () => {
                content.innerHTML = '<div style="padding: 12px; color: #EF4444;">❌ 无法连接后端</div>';
            }
        });
    }

    // ============== 浏览器控制 ==============
    let browserPages = [];

    function renderBrowserContent() {
        const content = state.shadowRoot.getElementById('browser-content');

        const html = `
            <div style="padding: 12px;">
                <div style="font-weight: bold; margin-bottom: 12px; font-size: 14px;">🌐 浏览器控制</div>

                <div style="margin-bottom: 12px;">
                    <input type="text" id="browser-url" placeholder="输入 URL..."
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                    <button id="browser-create" class="soc-btn" style="flex: 1;">➕ 创建页面</button>
                    <button id="browser-navigate" class="soc-btn" style="flex: 1;">🚀 导航</button>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                    <button id="browser-content" class="soc-btn" style="flex: 1;">📄 获取内容</button>
                    <button id="browser-to-analyze" class="soc-btn" style="flex: 1; background: #22c55e;">📤 发送到分析</button>
                </div>

                <div id="browser-pages-list" style="font-size: 12px; color: #626F86; margin-bottom: 12px;">
                    暂无打开的页面
                </div>
                <div id="browser-content-preview" style="font-size: 11px; color: #626F86; max-height: 100px; overflow-y: auto; background: #f8fafc; padding: 8px; border-radius: 4px; display: none;">
                </div>
            </div>
        `;
        content.innerHTML = html;

        content.querySelector('#browser-create').onclick = () => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_BASE + '/api/browser/create',
                onload: (r) => {
                    try {
                        const result = JSON.parse(r.responseText);
                        if (result.page_id) {
                            browserPages.push(result.page_id);
                            notify('✓ 页面已创建: ' + result.page_id.substring(0, 8));
                            updateBrowserPagesList();
                        }
                    } catch (e) {
                        notify('❌ 创建失败', 'error');
                    }
                },
                onerror: () => notify('❌ 连接失败', 'error')
            });
        };

        content.querySelector('#browser-navigate').onclick = () => {
            const url = content.querySelector('#browser-url').value;
            if (!url) {
                notify('⚠️ 请输入 URL');
                return;
            }
            if (browserPages.length === 0) {
                notify('⚠️ 请先创建页面');
                return;
            }
            const pageId = browserPages[0];
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_BASE + '/api/browser/' + pageId + '/navigate',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ url: url }),
                onload: (r) => {
                    try {
                        const result = JSON.parse(r.responseText);
                        if (result.success) {
                            notify('✓ 已导航到: ' + url);
                        }
                    } catch (e) {
                        notify('❌ 导航失败', 'error');
                    }
                },
                onerror: () => notify('❌ 连接失败', 'error')
            });
        };

        function updateBrowserPagesList() {
            const listEl = content.querySelector('#browser-pages-list');
            if (browserPages.length === 0) {
                listEl.innerHTML = '暂无打开的页面';
            } else {
                listEl.innerHTML = '<strong>打开的页面:</strong><br>' +
                    browserPages.map(p => `• ${p.substring(0, 12)}...`).join('<br>');
            }
        }

        // 获取页面内容
        content.querySelector('#browser-content').onclick = () => {
            if (browserPages.length === 0) {
                notify('⚠️ 请先创建页面');
                return;
            }
            const pageId = browserPages[0];
            GM_xmlhttpRequest({
                method: 'GET',
                url: API_BASE + '/api/browser/' + pageId + '/content',
                onload: (r) => {
                    try {
                        const result = JSON.parse(r.responseText);
                        const previewEl = content.querySelector('#browser-content-preview');
                        previewEl.style.display = 'block';
                        previewEl.textContent = result.content?.substring(0, 500) || '无内容';
                        state.lastBrowserContent = result.content;
                    } catch (e) {
                        notify('❌ 获取内容失败', 'error');
                    }
                },
                onerror: () => notify('❌ 连接失败', 'error')
            });
        };

        // 发送到分析（作为新的分析上下文）
        content.querySelector('#browser-to-analyze').onclick = () => {
            if (!state.lastBrowserContent) {
                notify('⚠️ 请先获取页面内容');
                return;
            }
            // 切换到分析标签，使用浏览器内容作为分析文本
            const browserText = state.lastBrowserContent.substring(0, 10000);
            state.currentSessionHistory = [];
            state.chatMessages = [];
            state.currentSessionHistory.push({
                role: 'user',
                content: `【浏览器页面内容】\n${browserText}`
            });

            // 切换到教导标签显示结果（因为分析需要选择器）
            switchTab('teach', state.shadowRoot.querySelector('.soc-tab:nth-child(2)'), []);
            callChatEndpoint(state.currentSessionHistory);
            notify('✓ 已发送到对话，可继续分析');
        };
    }

    // ============== RAG 知识库 ==============
    let ragDocs = [];

    function renderRagContent() {
        const content = state.shadowRoot.getElementById('rag-content');

        const html = `
            <div style="padding: 12px;">
                <div style="font-weight: bold; margin-bottom: 12px; font-size: 14px;">📚 RAG 知识库</div>

                <div style="margin-bottom: 12px;">
                    <textarea id="rag-text" placeholder="输入要添加的文本..."
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; height: 60px; box-sizing: border-box; resize: none;"></textarea>
                </div>

                <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                    <button id="rag-add" class="soc-btn" style="flex: 1;">➕ 添加文档</button>
                </div>

                <div style="margin-bottom: 12px;">
                    <input type="text" id="rag-query" placeholder="搜索知识库..."
                        style="width: 70%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                    <button id="rag-search" class="soc-btn" style="width: 28%;">🔍 搜索</button>
                </div>

                <div id="rag-results" style="font-size: 12px; color: #626F86; max-height: 200px; overflow-y: auto;">
                    点击搜索查看结果
                </div>
            </div>
        `;
        content.innerHTML = html;

        content.querySelector('#rag-add').onclick = () => {
            const text = content.querySelector('#rag-text').value;
            if (!text) {
                notify('⚠️ 请输入文本');
                return;
            }
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_BASE + '/api/rag/add',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ text: text }),
                onload: (r) => {
                    try {
                        const result = JSON.parse(r.responseText);
                        if (result.doc_id) {
                            notify('✓ 文档已添加');
                            content.querySelector('#rag-text').value = '';
                        }
                    } catch (e) {
                        notify('❌ 添加失败', 'error');
                    }
                },
                onerror: () => notify('❌ 连接失败', 'error')
            });
        };

        content.querySelector('#rag-search').onclick = () => {
            const query = content.querySelector('#rag-query').value;
            if (!query) {
                notify('⚠️ 请输入搜索关键词');
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: API_BASE + '/api/rag/search?q=' + encodeURIComponent(query),
                onload: (r) => {
                    try {
                        const results = JSON.parse(r.responseText);
                        const resultsEl = content.querySelector('#rag-results');
                        if (results.length === 0) {
                            resultsEl.innerHTML = '未找到相关结果';
                        } else {
                            let html = '<strong>搜索结果:</strong><br>';
                            results.slice(0, 5).forEach((r, i) => {
                                const text = r.text?.substring(0, 80) || '';
                                html += `
                                    <div style="background: #f8fafc; padding: 8px; border-radius: 4px; margin-bottom: 8px;">
                                        <div style="font-size: 11px; color: #626F86;">${text}...</div>
                                        <button class="rag-to-chat-btn" data-index="${i}" data-text="${encodeURIComponent(r.text || '')}"
                                            style="background: ${COLORS.primary}; color: white; border: none; border-radius: 3px; padding: 4px 8px; font-size: 11px; margin-top: 4px; cursor: pointer;">
                                            📤 发送到对话
                                        </button>
                                    </div>
                                `;
                            });
                            resultsEl.innerHTML = html;

                            // 绑定发送按钮事件
                            content.querySelectorAll('.rag-to-chat-btn').forEach(btn => {
                                btn.onclick = () => {
                                    const text = decodeURIComponent(btn.dataset.text);
                                    // 切换到教导标签并发送
                                    switchTab('teach', state.shadowRoot.querySelector('.soc-tab:nth-child(2)'), []);
                                    // 添加到对话历史
                                    state.currentSessionHistory.push({
                                        role: 'user',
                                        content: `【知识库参考】${text}`
                                    });
                                    state.chatMessages.push({
                                        role: 'user',
                                        content: `【知识库】${text.substring(0, 100)}...`,
                                        timestamp: new Date()
                                    });
                                    renderTeachContent();
                                    notify('✓ 已添加到对话上下文');
                                };
                            });
                        }
                    } catch (e) {
                        notify('❌ 搜索失败', 'error');
                    }
                },
                onerror: () => notify('❌ 连接失败', 'error')
            });
        };
    }

    // ============== 初始化 ==============

    // Ctrl+Shift+Z 快速打开并快速分析
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (!state.shadowRoot) initShadowDOM();
            state.panelEl.classList.add('active');
            setTimeout(performAnalyze, 100);
        }
    });

    // 初始化 Shadow DOM
    initShadowDOM();

    // 尝试自动恢复并分析上次保存的选择器
    setTimeout(() => {
        const savedSelector = getSavedSelector();
        if (savedSelector) {
            try {
                const el = document.querySelector(savedSelector);
                if (el && el.innerText && el.innerText.trim().length > 20) {
                    console.log('[SOC] 自动恢复选择器并分析');
                    state.selectedContainer = el;
                    // 后台分析，不打开面板
                    performAnalyzeInBackground(el.innerText);
                }
            } catch (e) {
                console.warn('[SOC] 自动恢复失败:', e);
            }
        }
    }, 500);

    console.log('SOC Assistant v3 loaded (按 Z 选择 / Ctrl+Shift+Z 快速分析)');

})();
