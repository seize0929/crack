// ==UserScript==
// @name         📑 Crack Chat List Tuner (크랙 채팅방 목록 튜너)
// @namespace    chat list tuner
// @version      1.1.2
// @description  전체·보관함 목록을 대조해 단일 채팅까지 동명 보관함에 합치는 스마트 자동 정리를 제공합니다.
// @match        *://crack.wrtn.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==


(function () {
    'use strict';

    // 크랙 앱이 API를 호출할 때 사용하는 인증 관련 헤더를 브라우저 내부에서만 재사용합니다.
    // 캡처한 값은 외부로 출력하지 않고, 같은 crack-api.wrtn.ai 검색 API 호출에만 사용합니다.
    const CRACK_AUTH_CAPTURE = {
        headers: {},
        capturedAt: 0,
        waiters: []
    };

    function isCrackApiUrl(url) {
        try {
            return new URL(String(url || ''), location.origin).origin === 'https://crack-api.wrtn.ai';
        } catch {
            return false;
        }
    }

    function isReusableAuthHeader(name) {
        const lower = String(name || '').toLowerCase();
        if (!lower) return false;
        if (lower === 'cookie' || lower === 'host' || lower === 'origin' || lower === 'referer') return false;
        if (lower.startsWith('sec-') || lower.startsWith('proxy-')) return false;

        return lower === 'authorization' ||
            lower === 'x-csrf-token' ||
            lower === 'x-xsrf-token' ||
            lower.startsWith('x-') ||
            lower.includes('auth') ||
            lower.includes('token') ||
            lower.startsWith('wrtn-') ||
            lower.startsWith('crack-');
    }

    function rememberAuthHeader(name, value) {
        if (!isReusableAuthHeader(name)) return;
        if (value == null || value === '') return;

        CRACK_AUTH_CAPTURE.headers[String(name)] = String(value);
        CRACK_AUTH_CAPTURE.capturedAt = Date.now();

        const waiters = CRACK_AUTH_CAPTURE.waiters.splice(0);
        waiters.forEach(resolve => resolve(true));
    }

    function getCapturedAuthHeaders() {
        return { ...CRACK_AUTH_CAPTURE.headers };
    }

    // 직접 API 호출 시에는 authorization 토큰 하나만 보낸다.
    // x-wrtn-id 등 캡처된 다른 헤더가 섞이면 크랙 서버가 401로 거부할 수 있다.
    function getAuthHeaderOnly() {
        const h = CRACK_AUTH_CAPTURE.headers;
        const token = h['authorization'] || h['Authorization'];
        return token ? { authorization: token } : {};
    }

    function hasCapturedAuthHeaders() {
        return Object.keys(CRACK_AUTH_CAPTURE.headers).length > 0;
    }

    function hasAuthToken() {
        return !!(CRACK_AUTH_CAPTURE.headers['authorization'] || CRACK_AUTH_CAPTURE.headers['Authorization']);
    }

    function waitForAuthToken(timeout = 6000) {
        if (hasAuthToken()) return Promise.resolve(true);

        return new Promise(resolve => {
            const startedAt = Date.now();
            const timer = setInterval(() => {
                if (hasAuthToken()) {
                    clearInterval(timer);
                    resolve(true);
                    return;
                }

                if (Date.now() - startedAt >= timeout) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, 150);
        });
    }

    function waitForAuthHeaders(timeout = 4500) {
        if (hasCapturedAuthHeaders()) return Promise.resolve(true);

        return new Promise(resolve => {
            const timer = setTimeout(() => {
                const idx = CRACK_AUTH_CAPTURE.waiters.indexOf(done);
                if (idx >= 0) CRACK_AUTH_CAPTURE.waiters.splice(idx, 1);
                resolve(false);
            }, timeout);

            function done(value) {
                clearTimeout(timer);
                resolve(value);
            }

            CRACK_AUTH_CAPTURE.waiters.push(done);
        });
    }

    function headersToEntries(headers) {
        const entries = [];
        if (!headers) return entries;

        try {
            if (headers instanceof Headers) {
                headers.forEach((value, key) => entries.push([key, value]));
                return entries;
            }
        } catch {}

        if (Array.isArray(headers)) {
            for (const pair of headers) {
                if (Array.isArray(pair) && pair.length >= 2) entries.push([pair[0], pair[1]]);
            }
            return entries;
        }

        if (typeof headers === 'object') {
            for (const [key, value] of Object.entries(headers)) entries.push([key, value]);
        }

        return entries;
    }

    function captureHeadersFromFetch(input, init) {
        const url = input instanceof Request ? input.url : String(input || '');
        if (!isCrackApiUrl(url)) return;

        try {
            if (input instanceof Request) {
                headersToEntries(input.headers).forEach(([key, value]) => rememberAuthHeader(key, value));
            }
        } catch {}

        try {
            headersToEntries(init?.headers).forEach(([key, value]) => rememberAuthHeader(key, value));
        } catch {}
    }

    function isArchiveMutationRequest(input, init = {}) {
        const url = input instanceof Request ? input.url : String(input || '');
        if (!isCrackApiUrl(url)) return false;

        const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;

        let pathname = '';
        try {
            pathname = new URL(url, location.origin).pathname.toLowerCase();
        } catch {}

        // 자동 정리 미리보기 생성은 POST지만 서버 데이터를 바꾸지 않는다.
        // 이를 변경 요청으로 취급하면 스마트 정리 도중 전체 개수 조회가 중복 실행된다.
        if (pathname.endsWith('/chat-folders/auto-organize/preview')) return false;

        // 보관함 생성/삭제/자동 정리/채팅 이동 API는 보통 chat-folders 계열을 사용한다.
        if (pathname.includes('chat-folder') || pathname.includes('chat_folder') || pathname.includes('/archive')) {
            return true;
        }

        // 채팅 수정 API 본문에 폴더 ID가 실리는 구조도 함께 잡는다.
        const body = init?.body;
        if (typeof body === 'string' && /(?:chatFolderId|folderId|folder_id)/i.test(body)) return true;

        try {
            if (body instanceof URLSearchParams || body instanceof FormData) {
                for (const key of body.keys()) {
                    if (/^(?:chatFolderId|folderId|folder_id)$/i.test(String(key))) return true;
                }
            }
        } catch {}

        return false;
    }

    function markArchiveDataChanged() {
        // 현재 숫자와 검색 인덱스를 낡은 상태로 표시하고 서버 반영 뒤 정확한 값을 다시 읽는다.
        archiveSearchState.countUpdatedAt = 0;
        archiveSearchState.refreshedThisPage = false;
        scheduleCountRefresh(true);
    }

    function installAuthHeaderCapture() {
        try {
            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function' && !originalFetch.__crackUiAuthCapture) {
                const wrappedFetch = function(input, init) {
                    captureHeadersFromFetch(input, init);
                    const refreshArchiveCount = isArchiveMutationRequest(input, init);
                    const request = originalFetch.apply(this, arguments);

                    if (refreshArchiveCount) {
                        Promise.resolve(request).then(response => {
                            if (response?.ok) markArchiveDataChanged();
                        }).catch(() => {});
                    }

                    return request;
                };
                wrappedFetch.__crackUiAuthCapture = true;
                wrappedFetch.__originalFetch = originalFetch;
                window.fetch = wrappedFetch;
            }
        } catch (error) {
            console.warn('[Crack UI] fetch 인증 헤더 캡처 설치 실패:', error);
        }

        try {
            const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
            if (proto && !proto.__crackUiAuthCapture) {
                const originalOpen = proto.open;
                const originalSetRequestHeader = proto.setRequestHeader;
                const originalSend = proto.send;

                proto.open = function(method, url) {
                    this.__crackUiRequestUrl = String(url || '');
                    this.__crackUiRequestMethod = String(method || 'GET');
                    return originalOpen.apply(this, arguments);
                };

                proto.setRequestHeader = function(name, value) {
                    if (isCrackApiUrl(this.__crackUiRequestUrl)) {
                        rememberAuthHeader(name, value);
                    }
                    return originalSetRequestHeader.apply(this, arguments);
                };

                proto.send = function(body) {
                    const refreshArchiveCount = isArchiveMutationRequest(this.__crackUiRequestUrl, {
                        method: this.__crackUiRequestMethod,
                        body
                    });

                    if (refreshArchiveCount) {
                        this.addEventListener('loadend', () => {
                            if (this.status >= 200 && this.status < 300) markArchiveDataChanged();
                        }, { once: true });
                    }

                    return originalSend.apply(this, arguments);
                };

                proto.__crackUiAuthCapture = true;
            }
        } catch (error) {
            console.warn('[Crack UI] XHR 인증 헤더 캡처 설치 실패:', error);
        }
    }

    installAuthHeaderCapture();

    function addCrackStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
        return style;
    }

    // 로컬 스토리지 키값
    const STORAGE_KEY = 'crackColor_episode_v10_';
    const ARCHIVE_HEIGHT_KEY = 'crack_archive_h';
    const ARCHIVE_HEIGHT_MIN = 50;
    const ARCHIVE_HEIGHT_DEFAULT = 284;

    // 보관함 및 채팅 목록 제목 검색 인덱스
    const ARCHIVE_SEARCH_CACHE_KEY = 'crackUnifiedTitleSearchIndex_v6_overlay';
    const ARCHIVE_SEARCH_CACHE_TTL = 30 * 60 * 1000; // 30분
    const CRACK_API_BASE = 'https://crack-api.wrtn.ai';
    const API_PAGE_LIMIT = 40;
    const API_CONCURRENCY = 4;
    const MAX_ARCHIVE_FOLDERS = 80;
    const MAX_ARCHIVE_CHATS = 3000;
    const MAX_ARCHIVE_RESULTS = 200;
    const SMART_ORGANIZE_LOAD_CONCURRENCY = 4;

    // 커스텀 팔레트 색상 정의
    const colorValues = {
        rose: '#d87791',
        gold: '#c9ab55',
        emerald: '#65b984',
        teal: '#67b9c0',
        violet: '#b188c7'
    };

    // 테마별(다크/라이트) 배경 투명도 및 발광(Glow) 효과 정의
    const themeColorSets = {
        dark: {
            accents: {
                rose: '#d87791',
                gold: '#c9ab55',
                emerald: '#65b984',
                teal: '#67b9c0',
                violet: '#b188c7'
            },
            backgrounds: {
                rose: 'rgba(74, 30, 42, 0.72)',
                gold: 'rgba(76, 64, 30, 0.70)',
                emerald: 'rgba(27, 62, 47, 0.72)',
                teal: 'rgba(25, 59, 66, 0.72)',
                violet: 'rgba(58, 42, 68, 0.72)'
            },
            borders: {
                rose: 'rgba(216, 119, 145, 0.24)',
                gold: 'rgba(201, 171, 85, 0.23)',
                emerald: 'rgba(101, 185, 132, 0.22)',
                teal: 'rgba(103, 185, 192, 0.22)',
                violet: 'rgba(177, 136, 199, 0.23)'
            },
            glows: {
                rose: 'rgba(216, 119, 145, 0.26)',
                gold: 'rgba(201, 171, 85, 0.24)',
                emerald: 'rgba(101, 185, 132, 0.23)',
                teal: 'rgba(103, 185, 192, 0.23)',
                violet: 'rgba(177, 136, 199, 0.25)'
            }
        },
        light: {
            accents: {
                rose: '#c85f7b',
                gold: '#aa852c',
                emerald: '#459b68',
                teal: '#3f929c',
                violet: '#8f67a4'
            },
            backgrounds: {
                rose: 'rgba(255, 133, 162, 0.15)',
                gold: 'rgba(214, 172, 64, 0.17)',
                emerald: 'rgba(92, 174, 122, 0.14)',
                teal: 'rgba(83, 172, 184, 0.14)',
                violet: 'rgba(177, 136, 199, 0.15)'
            },
            borders: {
                rose: 'rgba(200, 95, 123, 0.22)',
                gold: 'rgba(170, 133, 44, 0.22)',
                emerald: 'rgba(69, 155, 104, 0.20)',
                teal: 'rgba(63, 146, 156, 0.20)',
                violet: 'rgba(143, 103, 164, 0.21)'
            },
            glows: {
                rose: 'rgba(200, 95, 123, 0.18)',
                gold: 'rgba(170, 133, 44, 0.16)',
                emerald: 'rgba(69, 155, 104, 0.16)',
                teal: 'rgba(63, 146, 156, 0.16)',
                violet: 'rgba(143, 103, 164, 0.17)'
            }
        }
    };

    let lastMenuTarget = null;
    let lastMenuTime = 0;
    let updateTimer = null;
    let isUpdatingUI = false; // DOM 중복 트리거 방지 플래그

    // 보관함 DOM은 React 재렌더 때만 바뀌므로 매 Mutation마다 전체 탐색하지 않도록 캐시합니다.
    let cachedArchiveDivider = null;
    let cachedArchiveContainer = null;
    let lastArchiveScrollTarget = null;
    let lastArchiveAppliedHeight = 0;
    let archiveFastApplyRaf = 0;

    const archiveSearchState = {
        items: [],
        status: 'idle', // idle | ready | indexing | error
        inFlight: null,
        started: false,
        loadedFolders: 0,
        totalFolders: 0,
        loadedChats: 0,
        totalArchiveChats: null,
        totalRootChats: null,
        totalAllChats: null,
        countUpdatedAt: 0,
        countStatus: 'idle', // idle | loading | ready | error
        savedAt: 0,
        partial: false,
        lastError: '',
        lastFailedAt: 0,
        lastRenderKey: '',
        lastResultKey: ''
    };
    let archiveCountRefreshPending = false;

    const smartOrganizeState = {
        runId: 0,
        open: false,
        busy: false,
        phase: 'idle', // idle | loading | review | preparing | applying | done | error
        previewId: '',
        rows: [],
        status: '',
        singletonStatus: 'idle', // idle | ready | error
        singletonCount: 0,
        singletonError: '',
        result: null
    };

    // React 재렌더 중에도 검색어가 날아가지 않도록 별도 상태로 보관합니다.
    let currentSearchQueryRaw = '';
    // 검색 입력창이 React 재렌더로 "새로 만들어진 것"인지 판별하기 위한 기준.
    let lastSearchInputEl = null;
    let legacySearchCleanupDone = false;
    const chatVisualCache = new WeakMap();

    // 검색 입력 직후 즉시 무거운 DOM/API 결과 렌더를 돌리면 한글 입력 중 포커스/조합이 끊길 수 있다.
    // 입력 중 과도한 렌더링을 막기 위해 짧은 지연 후 검색을 적용합니다.
    const SEARCH_DEBOUNCE_MS = 30;
    let searchDebounceTimer = null;
    let isSearchComposing = false;
    let searchOverlayPositionTimer = null;
    let archiveSearchRenderRaf = 0;

    function getThemeColors() {
        const theme = document.body.getAttribute('data-theme') || 'dark';
        return themeColorSets[theme] || themeColorSets.dark;
    }

    // 스타일 주입
    addCrackStyle(`
        body[data-theme="dark"] {
            --crack-current-neutral-border: rgba(255, 255, 255, 0.95);
            --crack-current-neutral-bg: rgba(255, 255, 255, 0.08);

            --crack-menu-bg: rgba(24, 24, 24, 0.985);
            --crack-menu-border: rgba(255, 255, 255, 0.12);
            --crack-menu-shadow: rgba(0, 0, 0, 0.45);

            --crack-palette-bg: rgba(20, 20, 20, 0.96);
            --crack-palette-border: rgba(255, 255, 255, 0.15);
            --crack-dot-border: rgba(255, 255, 255, 0.22);

            --crack-search-bg: rgba(255, 255, 255, 0.04);
            --crack-search-border: rgba(255, 255, 255, 0.1);
            --crack-search-focus-border: rgba(255, 255, 255, 0.4);
            --crack-search-text: #fff;
            --crack-search-placeholder: #888;
            --crack-card-gap: rgba(0, 0, 0, 0.34);
        }

        body[data-theme="light"] {
            --crack-current-neutral-border: rgba(40, 40, 40, 0.62);
            --crack-current-neutral-bg: rgba(0, 0, 0, 0.045);

            --crack-menu-bg: rgba(255, 255, 255, 0.985);
            --crack-menu-border: rgba(0, 0, 0, 0.10);
            --crack-menu-shadow: rgba(0, 0, 0, 0.18);

            --crack-palette-bg: rgba(255, 255, 255, 0.96);
            --crack-palette-border: rgba(0, 0, 0, 0.10);
            --crack-dot-border: rgba(0, 0, 0, 0.18);

            --crack-search-bg: rgba(0, 0, 0, 0.02);
            --crack-search-border: rgba(0, 0, 0, 0.08);
            --crack-search-focus-border: rgba(0, 0, 0, 0.25);
            --crack-search-text: #111;
            --crack-search-placeholder: #aaa;
            --crack-card-gap: rgba(255, 255, 255, 0.88);
        }

        /* 1. 실시간 채팅 검색바 스타일 */
        .crack-search-container {
            margin: 8px 10px 12px;
            position: relative;
        }
        .crack-search-box {
            display: flex;
            align-items: center;
            background: var(--crack-search-bg);
            border: 1px solid var(--crack-search-border);
            border-radius: 8px;
            padding: 6px 10px;
            gap: 8px;
            transition: all 0.2s ease;
        }
        .crack-search-box:focus-within {
            border-color: var(--crack-search-focus-border);
            background: var(--crack-menu-bg);
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.05);
        }
        .crack-search-icon {
            color: var(--crack-search-placeholder);
            flex-shrink: 0;
            display: flex;
            align-items: center;
        }
        .crack-search-input {
            width: 100%;
            background: transparent;
            border: none;
            outline: none;
            font-size: 13px;
            color: var(--crack-search-text);
        }
        .crack-search-input::placeholder {
            color: var(--crack-search-placeholder);
        }
        .crack-search-clear {
            cursor: pointer;
            color: var(--crack-search-placeholder);
            font-size: 11px;
            background: none;
            border: none;
            display: none;
            padding: 2px;
            line-height: 1;
        }
        .crack-search-clear.visible {
            display: block;
        }
        .crack-search-clear:hover {
            color: var(--crack-search-text);
        }

        .crack-section-count {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 42px;
            height: 18px;
            padding: 0 6px;
            border: 1px solid var(--crack-search-border);
            border-radius: 999px;
            background: var(--crack-search-bg);
            color: var(--crack-search-placeholder);
            font-size: 10.5px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            line-height: 1;
            white-space: nowrap;
            box-sizing: border-box;
            flex: 0 0 auto;
        }

        .crack-section-count[data-kind="archive"] {
            margin-left: 6px;
        }

        .crack-section-count[data-kind="root"] {
            margin-left: auto;
            margin-right: 8px;
        }

        .crack-section-count[data-state="ready"] {
            color: var(--crack-search-text);
        }

        .crack-api-search-status {
            display: none;
            margin: 6px 4px 0;
            padding: 0;
            font-size: 11px;
            line-height: 1.35;
            color: var(--crack-search-placeholder);
            background: transparent;
            border: 0;
        }

        .crack-api-search-status.visible {
            display: block;
        }

        .crack-api-search-results {
            display: none;
            margin: 8px 0 0;
            padding-right: 0;
            overflow: visible;
        }

        .crack-api-search-results.visible {
            display: flex;
            flex-direction: column;
            gap: 6px;
            overflow: visible !important;
            max-height: none !important;
        }

        .crack-search-container.crack-search-active {
            position: relative;
            z-index: 20;
            flex: 0 0 auto !important;
            min-height: 0 !important;
            overflow: visible !important;
        }

        .crack-api-result-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin: 8px 2px 2px;
            padding: 0 1px;
            color: var(--crack-search-placeholder);
            font-size: 12px;
            font-weight: 700;
        }

        .crack-api-result-header:first-child {
            margin-top: 2px;
        }

        .crack-api-result-item {
            width: 100%;
            display: flex;
            gap: 7px;
            align-items: flex-start;
            border: 1px solid var(--crack-search-border);
            background: var(--crack-search-bg);
            color: var(--crack-search-text);
            border-radius: 9px;
            padding: 7px;
            text-align: left;
            cursor: pointer;
            transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
        }

        .crack-api-result-item:hover {
            background: var(--crack-menu-bg);
            border-color: var(--crack-search-focus-border);
            transform: translateY(-1px);
        }

        .crack-api-result-thumb {
            width: 30px;
            height: 30px;
            flex: 0 0 30px;
            border-radius: 8px;
            overflow: hidden;
            background: var(--crack-search-border);
            border: 1px solid var(--crack-search-border);
        }

        .crack-api-result-thumb img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
        }

        .crack-api-result-main {
            min-width: 0;
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 3px;
        }

        .crack-api-result-title {
            font-size: 12px;
            font-weight: 600;
            line-height: 1.25;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .crack-api-result-meta,
        .crack-api-result-snippet {
            font-size: 10.5px;
            line-height: 1.25;
            color: var(--crack-search-placeholder);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* 2. 기존 채팅방 및 선택방 테두리 스타일 */
        .crack-chat-item {
            position: relative !important;
            border-radius: 10px !important;
            transition:
                background-color 0.15s ease,
                box-shadow 0.15s ease,
                outline 0.15s ease !important;
        }

        [data-chat-color] {
            border-radius: 10px !important;
            box-sizing: border-box !important;
            background-clip: padding-box !important;
            border-top: 0 !important;
            border-bottom: 0 !important;
        }

        .crack-current-chat {
            outline: 2px solid var(--crack-accent, var(--crack-current-neutral-border)) !important;
            outline-offset: -2px !important;
        }

        .crack-current-chat:not([data-chat-color]) {
            background-color: var(--crack-current-neutral-bg) !important;
        }

        .crack-current-chat::before,
        .crack-current-chat::after {
            content: none !important;
            display: none !important;
        }

        /* 3. 우클릭 컨텍스트 메뉴 스타일 */
        .crack-menu-solid {
            background: var(--crack-menu-bg) !important;
            backdrop-filter: blur(12px) !important;
            border: 1px solid var(--crack-menu-border) !important;
            box-shadow: 0 10px 28px var(--crack-menu-shadow) !important;
            z-index: 999999 !important;
        }
        /* 4. 팔레트 디자인 */
        .custom-palette-container {
            display: flex;
            gap: 8px;
            padding: 8px 8px 6px;
            justify-content: flex-start;
            align-items: center;
            background: transparent;
            backdrop-filter: none;
            border-radius: 0;
            margin: 4px 0 0;
            border: 0;
            border-top: 1px solid var(--crack-menu-border);
            box-shadow: none;
        }

        .custom-palette-dot {
            width: 19px;
            height: 19px;
            border-radius: 999px;
            cursor: pointer;
            border: 2px solid var(--crack-dot-border);
            transition: transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            line-height: 1;
            user-select: none;
            flex-shrink: 0;
        }

        .custom-palette-dot:hover {
            transform: scale(1.18);
            border-color: var(--crack-current-neutral-border);
        }

        .custom-palette-dot.active {
            transform: scale(1.08);
            border-color: var(--crack-current-neutral-border);
            box-shadow: 0 0 0 2px var(--crack-palette-border);
        }


        /* 5. 텍스트 스크롤(Marquee) 애니메이션 */
        .marquee-target.can-animate:hover {
            text-overflow: clip !important;
            overflow: visible !important;
            display: inline-block !important;
            animation: moveTextDynamic 5s linear infinite;
            padding-right: 50px;
        }

        @keyframes moveTextDynamic {
            0% { transform: translateX(0); }
            45% { transform: translateX(var(--move-dist)); }
            55% { transform: translateX(var(--move-dist)); }
            100% { transform: translateX(0); }
        }

        /* 6. 리사이저 핸들 */
        .crack-resizer-handle {
            cursor: ns-resize !important;
            height: 4px !important;
            background: transparent !important;
            transition: background 0.2s ease;
        }

        .crack-resizer-handle:hover {
            background: var(--icon_primary) !important;
            opacity: 0.3;
        }

        .crack-archive-resized {
            max-height: var(--crack-archive-h, 284px) !important;
            overflow-y: auto !important;
            overflow-y: overlay !important;
            overflow-x: hidden !important;
            overscroll-behavior: contain !important;
            padding-bottom: 4px !important;
            transition: none !important;
            scrollbar-width: thin !important;
            scrollbar-color: transparent transparent !important;
        }

        .crack-archive-resized:hover {
            scrollbar-color: rgba(150, 150, 150, 0.5) transparent !important;
        }

        .crack-archive-resized::-webkit-scrollbar {
            width: 4px !important;
        }

        .crack-archive-resized::-webkit-scrollbar-track {
            background: transparent !important;
        }

        .crack-archive-resized::-webkit-scrollbar-thumb {
            background: transparent !important;
            border-radius: 4px !important;
        }

        .crack-archive-resized:hover::-webkit-scrollbar-thumb {
            background: rgba(150, 150, 150, 0.5) !important;
        }
    `);


    // 검색 결과 전용 오버레이 스타일
    addCrackStyle(`
        #crack-search-overlay {
            display: none;
            position: fixed;
            z-index: 9990;
            box-sizing: border-box;
            padding: 0 10px 88px;
            overflow-y: auto;
            overflow-x: hidden;
            overscroll-behavior: contain;
            background: var(--crack-menu-bg, rgba(255, 255, 255, 0.985));
            color: var(--crack-search-text, inherit);
        }

        body[data-theme="dark"] #crack-search-overlay {
            background: rgba(18, 18, 18, 0.995);
        }

        body[data-theme="light"] #crack-search-overlay {
            background: rgba(255, 255, 255, 0.995);
        }

        #crack-search-overlay.visible {
            display: block;
        }

        #crack-search-overlay .crack-api-search-status {
            display: block;
            visibility: hidden;
            min-height: 15px;
            margin: 0 4px 8px;
            padding: 0;
            font-size: 11px;
            line-height: 1.35;
            color: var(--crack-search-placeholder);
            background: transparent;
            border: 0;
        }

        #crack-search-overlay .crack-api-search-status.visible {
            visibility: visible;
        }

        #crack-search-overlay .crack-api-search-results {
            display: none;
            margin: 0;
            padding: 0;
            overflow: visible !important;
            max-height: none !important;
        }

        #crack-search-overlay .crack-api-search-results.visible {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        #crack-search-overlay .crack-api-result-header {
            margin: 8px 2px 2px;
        }

        #crack-search-overlay .crack-api-result-item {
            width: 100%;
            box-sizing: border-box;
        }
    `);

    // 스마트 자동 정리 메뉴 및 검토창 스타일
    addCrackStyle(`
        .crack-smart-organize-menu-item {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 32px;
            box-sizing: border-box;
            margin: 2px 4px;
            padding: 7px 8px;
            border-radius: 6px;
            color: inherit;
            font-size: 13px;
            line-height: 1.2;
            cursor: pointer;
            user-select: none;
            outline: none;
        }

        .crack-smart-organize-menu-item:hover,
        .crack-smart-organize-menu-item:focus-visible {
            background: var(--crack-search-bg);
        }

        .crack-smart-organize-menu-icon {
            width: 18px;
            flex: 0 0 18px;
            color: #9b82dc;
            text-align: center;
            font-size: 15px;
        }

        .crack-smart-organize-menu-label {
            flex: 1;
            min-width: 0;
        }

        .crack-smart-organize-menu-badge {
            padding: 2px 5px;
            border-radius: 999px;
            background: rgba(155, 130, 220, 0.16);
            color: #a990ea;
            font-size: 9.5px;
            font-weight: 700;
        }

        #crack-smart-organize-modal {
            --so-bg: #1d1d21;
            --so-panel: #25252b;
            --so-panel-2: #2c2c33;
            --so-text: #f4f4f6;
            --so-muted: #aaaab2;
            --so-border: rgba(255, 255, 255, 0.11);
            --so-accent: #a990ea;
            --so-accent-bg: rgba(169, 144, 234, 0.14);
            --so-danger: #ef8e9f;
            position: fixed;
            inset: 0;
            z-index: 2147483000;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            padding: 22px;
            background: rgba(0, 0, 0, 0.62);
            backdrop-filter: blur(8px);
            color: var(--so-text);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        body[data-theme="light"] #crack-smart-organize-modal {
            --so-bg: #ffffff;
            --so-panel: #f7f7f9;
            --so-panel-2: #efeff3;
            --so-text: #1d1d22;
            --so-muted: #6f6f78;
            --so-border: rgba(0, 0, 0, 0.11);
            --so-accent: #7d5fc5;
            --so-accent-bg: rgba(125, 95, 197, 0.11);
            --so-danger: #c7596d;
            background: rgba(20, 20, 24, 0.36);
        }

        .crack-smart-dialog {
            width: min(760px, 100%);
            max-height: min(820px, calc(100vh - 44px));
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border: 1px solid var(--so-border);
            border-radius: 16px;
            background: var(--so-bg);
            box-shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
        }

        .crack-smart-head,
        .crack-smart-foot {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 16px 18px;
        }

        .crack-smart-head {
            border-bottom: 1px solid var(--so-border);
        }

        .crack-smart-foot {
            justify-content: flex-end;
            border-top: 1px solid var(--so-border);
        }

        .crack-smart-title-wrap {
            min-width: 0;
            flex: 1;
        }

        .crack-smart-title {
            margin: 0;
            color: var(--so-text);
            font-size: 17px;
            font-weight: 750;
            line-height: 1.3;
        }

        .crack-smart-subtitle {
            margin-top: 3px;
            color: var(--so-muted);
            font-size: 11.5px;
            line-height: 1.4;
        }

        .crack-smart-close {
            width: 30px;
            height: 30px;
            padding: 0;
            border: 0;
            border-radius: 8px;
            background: transparent;
            color: var(--so-muted);
            font-size: 18px;
            cursor: pointer;
        }

        .crack-smart-close:hover {
            background: var(--so-panel);
            color: var(--so-text);
        }

        .crack-smart-body {
            min-height: 170px;
            padding: 16px 18px;
            overflow-y: auto;
            overscroll-behavior: contain;
        }

        .crack-smart-loading,
        .crack-smart-message {
            min-height: 180px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 12px;
            color: var(--so-muted);
            text-align: center;
        }

        .crack-smart-spinner {
            width: 28px;
            height: 28px;
            border: 3px solid var(--so-border);
            border-top-color: var(--so-accent);
            border-radius: 999px;
            animation: crackSmartSpin 0.75s linear infinite;
        }

        @keyframes crackSmartSpin {
            to { transform: rotate(360deg); }
        }

        .crack-smart-toolbar,
        .crack-smart-summary {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 7px;
            margin-bottom: 12px;
        }

        .crack-smart-summary {
            margin: 0;
            margin-right: auto;
            color: var(--so-muted);
            font-size: 11.5px;
        }

        .crack-smart-chip {
            padding: 4px 7px;
            border: 1px solid var(--so-border);
            border-radius: 999px;
            background: var(--so-panel);
            color: var(--so-muted);
            font-size: 10.5px;
            font-weight: 650;
        }

        .crack-smart-chip.conflict {
            border-color: rgba(169, 144, 234, 0.34);
            background: var(--so-accent-bg);
            color: var(--so-accent);
        }

        .crack-smart-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .crack-smart-row {
            display: grid;
            grid-template-columns: minmax(150px, 1fr) 160px minmax(170px, 1fr);
            align-items: center;
            gap: 9px;
            padding: 10px;
            border: 1px solid var(--so-border);
            border-radius: 11px;
            background: var(--so-panel);
        }

        .crack-smart-row[data-conflict="true"] {
            border-color: rgba(169, 144, 234, 0.34);
        }

        .crack-smart-name {
            min-width: 0;
        }

        .crack-smart-name strong {
            display: block;
            overflow: hidden;
            color: var(--so-text);
            font-size: 12.5px;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .crack-smart-name span {
            display: block;
            margin-top: 3px;
            color: var(--so-muted);
            font-size: 10.5px;
        }

        .crack-smart-select {
            width: 100%;
            min-width: 0;
            height: 34px;
            box-sizing: border-box;
            padding: 0 9px;
            border: 1px solid var(--so-border);
            border-radius: 8px;
            outline: none;
            background: var(--so-panel-2);
            color: var(--so-text);
            font-size: 11.5px;
        }

        .crack-smart-select:focus {
            border-color: var(--so-accent);
        }

        .crack-smart-button {
            min-height: 34px;
            padding: 0 12px;
            border: 1px solid var(--so-border);
            border-radius: 8px;
            background: var(--so-panel);
            color: var(--so-text);
            font-size: 11.5px;
            font-weight: 650;
            cursor: pointer;
        }

        .crack-smart-button:hover:not(:disabled) {
            border-color: var(--so-accent);
        }

        .crack-smart-button.primary {
            border-color: transparent;
            background: var(--so-accent);
            color: #fff;
        }

        .crack-smart-button:disabled {
            cursor: default;
            opacity: 0.45;
        }

        .crack-smart-error {
            color: var(--so-danger);
            font-size: 11.5px;
            white-space: pre-wrap;
        }

        .crack-smart-result-list {
            width: min(520px, 100%);
            margin: 0;
            padding-left: 18px;
            text-align: left;
        }

        @media (max-width: 700px) {
            #crack-smart-organize-modal {
                align-items: flex-end;
                padding: 0;
            }

            .crack-smart-dialog {
                width: 100%;
                max-height: 92vh;
                border-radius: 16px 16px 0 0;
            }

            .crack-smart-row {
                grid-template-columns: 1fr;
            }
        }
    `);

    // 비동기 딜레이 헬퍼
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    function readSavedArchiveHeight() {
        try {
            const raw = localStorage.getItem(ARCHIVE_HEIGHT_KEY);
            const value = Number.parseInt(raw || '', 10);
            return Number.isFinite(value) && value >= ARCHIVE_HEIGHT_MIN ? value : null;
        } catch (e) {
            return null;
        }
    }

    function setArchiveHeightValue(height) {
        if (!height) return;

        document.documentElement.style.setProperty('--crack-archive-h', `${height}px`);

        try {
            localStorage.setItem(ARCHIVE_HEIGHT_KEY, String(height));
        } catch (e) {}
    }

    // document-start 시점에 저장 높이를 CSS 변수로 먼저 올려둔다.
    // React가 사이드바를 다시 그릴 때 기본 높이가 번쩍 보이는 현상을 줄이기 위함.
    const initialArchiveHeight = readSavedArchiveHeight();
    if (initialArchiveHeight) {
        document.documentElement.style.setProperty('--crack-archive-h', `${initialArchiveHeight}px`);
    }

    function findArchiveDivider() {
        const dividers = Array.from(document.querySelectorAll('.border-t'));

        return dividers.find(el => {
            const prevText = cleanText(el.previousElementSibling?.textContent || '');
            const nextText = cleanText(el.nextElementSibling?.textContent || '');

            // 현재 DOM: [보관함 섹션] [border-t] [채팅 목록 헤더]
            // 구형 DOM: border 다음 형제에 보관함/채팅 목록 텍스트가 붙어 있던 구조
            return (
                (prevText.includes('보관함') && nextText.includes('채팅 목록')) ||
                nextText.includes('채팅 목록') ||
                nextText.includes('보관함')
            );
        }) || null;
    }

    function isLiveArchiveContainer(el) {
        if (!(el instanceof HTMLElement) || !el.isConnected) return false;
        return !!el.querySelector?.('button[aria-label="보관함 전체보기"]') ||
            el.matches?.('.crack-archive-resized');
    }

    function resetArchiveCache() {
        cachedArchiveDivider = null;
        cachedArchiveContainer = null;
    }

    function findArchiveContainerByButton(scope = document) {
        const root = scope instanceof HTMLElement || scope === document ? scope : document;
        const buttons = Array.from(root.querySelectorAll?.('button[aria-label="보관함 전체보기"]') || []);

        for (const button of buttons) {
            if (!isInActiveSidebar(button)) continue;

            // 상대 확프에서 스크롤이 살아난 핵심 타겟:
            // div.flex.flex-col:has(> div > button[aria-label="보관함 전체보기"])
            // :has 의존을 줄이려고 JS로 같은 구조를 직접 찾는다.
            const directChild = button.parentElement;
            for (let el = directChild?.parentElement, depth = 0; el && el !== document.body && depth < 8; el = el.parentElement, depth += 1) {
                if (!(el instanceof HTMLElement)) continue;
                if (!el.classList?.contains('flex') || !el.classList?.contains('flex-col')) continue;

                if (directChild && directChild.parentElement === el) return el;
                if (Array.from(el.children || []).some(child => child instanceof HTMLElement && child.contains(button))) return el;
            }
        }

        return null;
    }

    function getArchiveContainerFromDivider(divider) {
        if (!divider) return findArchiveContainerByButton(document);

        const previous = divider.previousElementSibling;
        if (!previous) return findArchiveContainerByButton(document);

        // 1순위: 보관함 전체보기 버튼을 기준으로 실제 스크롤 박스 flex-col을 잡는다.
        // 기존처럼 .overflow-hidden 내부 요소를 잡으면 max-height는 먹어도 스크롤이 막힐 수 있다.
        const buttonTarget = findArchiveContainerByButton(previous);
        if (buttonTarget) return buttonTarget;

        // 2순위: 기존 로직 유지. 단, overflow-hidden은 스크롤 컨테이너로 쓰기 전에 auto로 강제될 예정이다.
        if (previous.classList?.contains('overflow-hidden')) return previous;

        const directOverflow = Array.from(previous.children || [])
            .find(el => el.classList?.contains('overflow-hidden'));
        if (directOverflow) return directOverflow;

        return previous.querySelector(':scope > .overflow-hidden, :scope > .overflow-y-auto, :scope > .scrollbar') ||
            previous.querySelector('.overflow-y-auto, .scrollbar') ||
            findArchiveContainerByButton(document) ||
            null;
    }

    function getArchivePartsCached() {
        if (isLiveArchiveContainer(cachedArchiveContainer)) {
            if (!(cachedArchiveDivider instanceof HTMLElement) || !cachedArchiveDivider.isConnected) {
                cachedArchiveDivider = findArchiveDivider();
            }

            return {
                divider: cachedArchiveDivider,
                archiveContainer: cachedArchiveContainer
            };
        }

        const divider = findArchiveDivider();
        const archiveContainer = getArchiveContainerFromDivider(divider);

        cachedArchiveDivider = divider || null;
        cachedArchiveContainer = archiveContainer || null;

        return { divider, archiveContainer };
    }

    function applyArchiveScrollBox(archiveContainer, height) {
        if (!archiveContainer) return;

        const safeHeight = Math.max(ARCHIVE_HEIGHT_MIN, Number.parseInt(height || '', 10) || ARCHIVE_HEIGHT_DEFAULT);
        document.documentElement.style.setProperty('--crack-archive-h', `${safeHeight}px`);

        // 같은 DOM/같은 높이에 반복 적용되는 경우가 제일 많아서 여기서 바로 탈출한다.
        if (archiveContainer === lastArchiveScrollTarget && lastArchiveAppliedHeight === safeHeight && archiveContainer.classList.contains('crack-archive-resized')) {
            return;
        }

        if (archiveContainer !== lastArchiveScrollTarget) {
            cleanupWrongArchiveResizeTargets(archiveContainer);
            lastArchiveScrollTarget = archiveContainer;
        }

        lastArchiveAppliedHeight = safeHeight;
        archiveContainer.classList.add('crack-archive-resized');
        archiveContainer.style.setProperty('max-height', `${safeHeight}px`, 'important');
        archiveContainer.style.setProperty('transition', 'none', 'important');
    }

    function cleanupWrongArchiveResizeTargets(archiveContainer) {
        document.querySelectorAll('.crack-archive-resized').forEach(el => {
            if (el === archiveContainer) return;
            if (el.classList?.contains('border-t')) return;

            // v1.0.4에서 내부 overflow-hidden 버튼/자식에 max-height가 먹은 경우 제거
            el.classList.remove('crack-archive-resized');
            el.style.removeProperty('max-height');
            el.style.removeProperty('overflow-y');
            el.style.removeProperty('overflow-x');
            el.style.removeProperty('overscroll-behavior');
            el.style.removeProperty('padding-bottom');
            el.style.removeProperty('transition');
        });
    }

    function applySavedArchiveHeightFast() {
        const { archiveContainer } = getArchivePartsCached();
        if (!archiveContainer) return null;

        // 저장값이 없어도 기본 높이를 줘야 overflow-y가 실제로 스크롤 영역을 만든다.
        // 저장은 드래그 종료 시에만 하므로 기존 사용자 설정 로직은 유지된다.
        const height = readSavedArchiveHeight() || ARCHIVE_HEIGHT_DEFAULT;
        applyArchiveScrollBox(archiveContainer, height);

        return archiveContainer;
    }

    function scheduleArchiveHeightFastApply() {
        if (archiveFastApplyRaf) return;

        archiveFastApplyRaf = requestAnimationFrame(() => {
            archiveFastApplyRaf = 0;
            applySavedArchiveHeightFast();
        });
    }

    // 텍스트 정제 헬퍼
    function cleanText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    // 검색/스캔에서 제외할 사이드바 헤더 이름 필터
    function isBadHeaderName(name) {
        return /^(보관함|채팅 목록|채팅목록|전체|메뉴|에피소드|파티챗)$/.test(cleanText(name));
    }

    // 실제 사이드바 내부 요소인지 확인하는 가드
    function isInActiveSidebar(el) {
        if (!el) return false;

        // 1. 드롭다운 메뉴, 팝오버, 라디오그룹 내부 제외
        if (
            el.closest('[role="menu"]') ||
            el.closest('[role="popover"]') ||
            el.closest('[role="radiogroup"]')
        ) {
            return false;
        }

        // 2. 보관함 이동 팝업 다이얼로그 및 편집 도구창 제외 (순정 사이드바는 필터 통과)
        const dialog = el.closest('[role="dialog"]');
        if (dialog) {
            if (
                dialog.textContent.includes('보관함 이동') ||
                dialog.querySelector('h2')?.textContent?.includes('이동') ||
                dialog.querySelector('button[aria-label="편집 종료"]')
            ) {
                return false;
            }
        }

        return true;
    }

    // 엘리먼트 내부에서 채팅 이름이나 텍스트를 추출해내는 안전 함수
    function getNameText(container) {
        if (!container) return '';

        const selectors = [
            '.text-popover-foreground.whitespace-nowrap',
            '.text-popover-foreground',
            '.typo-text-sm_leading-none_medium',
            '[class*="typo-text-sm"]'
        ];

        for (const selector of selectors) {
            const el = container.querySelector(selector);
            const text = cleanText(el?.textContent);
            if (text) return text;
        }

        return '';
    }

    function isRealChatLink(el) {
        if (!(el instanceof HTMLElement)) return false;
        if (!isInActiveSidebar(el)) return false;
        if (el.tagName.toLowerCase() !== 'a') return false;
        if (el.closest('[role="tablist"]')) return false;

        const name = getNameText(el);
        if (name && isBadHeaderName(name)) return false;

        const href = el.getAttribute('href');
        if (!href) return false;

        try {
            const url = new URL(href, location.origin);
            const parts = url.pathname.split('/').filter(Boolean);

            if (parts.length <= 1) return false;

            return parts.includes('episodes') || parts.includes('stories');
        } catch {
            return false;
        }
    }
    // 채팅방 고유 ID 파싱
    // 채팅방 고유 ID는 episode ID를 우선 사용합니다.
    function getChatId(container) {
        if (!container) return null;

        const tag = container.tagName.toLowerCase();

        // 1. 일반/보관함 내부 개별 채팅방 (a 링크 구조)
        if (tag === 'a') {
            if (!isRealChatLink(container)) return null;

            const href = container.getAttribute('href');
            if (!href) return null;

            const episodeMatch = href.match(/\/episodes\/([a-f0-9]+)/i);
            if (episodeMatch && episodeMatch[1]) {
                return `episode_${episodeMatch[1]}`;
            }

            const storyMatch = href.match(/\/stories\/([a-f0-9]+)/i);
            if (storyMatch && storyMatch[1]) {
                return `story_${storyMatch[1]}`;
            }

            return `chat_${href}`;
        }

        // 2. 보관함 폴더 버튼은 채팅방 팔레트 대상이 아니지만,
        //    기존 보관함 색상 표시가 필요할 수 있어 별도 archive ID만 유지한다.
        const name = getNameText(container);
        if (name && !isBadHeaderName(name)) {
            return `archive_${cleanText(name)}`;
        }

        return null;
    }

    function getChatContainers() {
        return Array.from(document.querySelectorAll('a[href*="/episodes"], a[href*="/stories"]'))
            .filter(isRealChatLink);
    }

    function applyVisualColor(container, colorKey) {
        if (!container) return;

        container.classList.add('crack-chat-item');

        if (!colorKey || colorKey === 'none') {
            container.removeAttribute('data-chat-color');
            container.style.removeProperty('--crack-accent');
            container.style.removeProperty('--crack-glow');
            container.style.removeProperty('--crack-color-bg');
            container.style.removeProperty('--crack-color-border');
            container.style.removeProperty('--crack-current-border');
            container.style.removeProperty('background-color');
            container.style.removeProperty('box-shadow');
            container.style.removeProperty('border-top');
            container.style.removeProperty('border-bottom');
            return;
        }

        const themeColors = getThemeColors();
        const accent = themeColors.accents?.[colorKey] || colorValues[colorKey];
        const bg = themeColors.backgrounds[colorKey];
        const border = themeColors.borders?.[colorKey] || 'rgba(255, 255, 255, 0.08)';
        const glow = themeColors.glows[colorKey];

        container.setAttribute('data-chat-color', colorKey);
        container.style.setProperty('--crack-accent', accent);
        container.style.setProperty('--crack-glow', glow);
        container.style.setProperty('--crack-color-bg', bg);
        container.style.setProperty('--crack-color-border', border);
        container.style.setProperty('--crack-current-border', border);

        // 메뉴 위치 계산과 충돌하기 쉬운 ::before/z-index 레이어 대신
        // 직접 background/box-shadow만 적용한다.
        // 실제 border/margin은 레이아웃 높이를 바꿔 색칠/삭제 때 살짝 움직이므로 쓰지 않는다.
        const gapLine = `inset 0 1px 0 var(--crack-card-gap), inset 0 -1px 0 var(--crack-card-gap)`;
        const baseShadow = `inset 2px 0 0 ${accent}, inset 0 0 0 1px ${border}, ${gapLine}`;
        const selectedShadow = `inset 2px 0 0 ${accent}, inset 0 0 0 1px ${border}, ${gapLine}, 0 0 14px -7px ${glow}`;

        container.style.removeProperty('border-top');
        container.style.removeProperty('border-bottom');
        container.style.setProperty('background-color', bg, 'important');
        container.style.setProperty('box-shadow', isCurrentChat(container) ? selectedShadow : baseShadow, 'important');
    }

    function paintSameChat(id, colorKey) {
        getChatContainers().forEach(container => {
            if (getChatId(container) === id) {
                applyVisualColor(container, colorKey);
                markCurrentChat(container);
            }
        });
    }

    function saveColor(id, colorKey) {
        if (!id) return;

        try {
            if (!colorKey || colorKey === 'none') {
                localStorage.removeItem(STORAGE_KEY + id);
                paintSameChat(id, null);
                return;
            }

            localStorage.setItem(STORAGE_KEY + id, colorKey);
            paintSameChat(id, colorKey);
        } catch (e) {
            console.warn("[Crack UI] LocalStorage 저장 실패:", e);
        }
    }

    function isCurrentChat(container) {
        if (!container) return false;

        if (container.getAttribute('aria-current') === 'page') return true;
        if (container.dataset.state === 'active') return true;
        if (container.getAttribute('data-state') === 'active') return true;

        const href = container.getAttribute?.('href');
        if (!href) return false;

        try {
            const url = new URL(href, location.origin);
            const targetPath = url.pathname.replace(/\/+$/, '');
            const currentPath = location.pathname.replace(/\/+$/, '');

            if (!targetPath || targetPath === '/episodes' || targetPath === '/stories') return false;

            return currentPath === targetPath || currentPath.startsWith(targetPath + '/');
        } catch {
            return false;
        }
    }

    // 마크 및 마퀴 스크롤 세팅
    function markCurrentChat(container) {
        if (!container) return;

        container.classList.add('crack-chat-item');

        const current = isCurrentChat(container);
        if (current) {
            container.classList.add('crack-current-chat');
        } else {
            container.classList.remove('crack-current-chat');
        }

        // 색칠된 채팅방은 선택 여부에 따라 그림자만 살짝 바꾼다.
        // 이 역시 pseudo-element 없이 직접 스타일로 처리한다.
        const colorKey = container.getAttribute('data-chat-color');
        if (colorKey && colorValues[colorKey]) {
            const themeColors = getThemeColors();
            const accent = themeColors.accents?.[colorKey] || colorValues[colorKey];
            const border = themeColors.borders?.[colorKey] || 'rgba(255, 255, 255, 0.08)';
            const glow = themeColors.glows?.[colorKey] || 'rgba(255,255,255,0.18)';
            const gapLine = `inset 0 1px 0 var(--crack-card-gap), inset 0 -1px 0 var(--crack-card-gap)`;
            const baseShadow = `inset 2px 0 0 ${accent}, inset 0 0 0 1px ${border}, ${gapLine}`;
            const selectedShadow = `inset 2px 0 0 ${accent}, inset 0 0 0 1px ${border}, ${gapLine}, 0 0 14px -7px ${glow}`;
            container.style.setProperty('box-shadow', current ? selectedShadow : baseShadow, 'important');
        }
    }

    function findChatContainerFromMenuButton(trigger) {
        if (!trigger) return null;

        // 팔레트는 오직 개별 채팅방의 메뉴 버튼에서만 허용한다.
        // 보관함 메뉴/채팅 목록 상단 메뉴/기타 드롭다운은 여기서 전부 탈락한다.
        if (trigger.getAttribute('aria-label') !== '채팅방 메뉴') return null;

        const link = trigger.closest('a[href*="/episodes"], a[href*="/stories"]');
        if (link && isRealChatLink(link)) return link;

        return null;
    }

    // Radix 채팅방 메뉴가 열린 동안에는 튜너가 사이드바 DOM을 건드리지 않는다.
    // 메뉴 Content는 body 포털에 있으므로 트리거의 open 상태를 기준으로 판별한다.
    function isChatMenuOpen() {
        return !!document.querySelector(
            'button[aria-label="채팅방 메뉴"][data-state="open"], ' +
            'button[aria-label="채팅방 메뉴"][aria-expanded="true"]'
        );
    }

    function rememberMenuTarget(e) {
        const trigger = e.target.closest?.('button[aria-haspopup="menu"]');

        if (!trigger) return;

        // 다른 메뉴를 누른 순간, 직전에 잡아둔 채팅방 대상을 반드시 비운다.
        if (trigger.getAttribute('aria-label') !== '채팅방 메뉴') {
            lastMenuTarget = null;
            lastMenuTime = 0;
            return;
        }

        const container = findChatContainerFromMenuButton(trigger);
        const id = getChatId(container);

        if (container && id) {
            lastMenuTarget = {
                container,
                id,
                trigger,
                triggerId: trigger.id || '',
                menuId: trigger.getAttribute('aria-controls') || ''
            };
            lastMenuTime = Date.now();
        } else {
            lastMenuTarget = null;
            lastMenuTime = 0;
        }
    }

    document.addEventListener('pointerdown', rememberMenuTarget, true);

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            lastMenuTarget = null;
            if (smartOrganizeState.open && !smartOrganizeState.busy) {
                closeSmartOrganize();
            }
        }
    });

    function injectPalette(menuNode) {
        if (!menuNode) return;

        if (!lastMenuTarget || !lastMenuTarget.container || !lastMenuTarget.id) return;
        if (Date.now() - lastMenuTime > 3000) return;

        // 현재 열린 메뉴가 방금 누른 채팅방 메뉴와 연결된 메뉴인지 확인한다.
        // aria-controls/id는 Radix가 여는 동안 붙이는 임시값이라 있을 때만 보조 확인용으로 사용한다.
        if (lastMenuTarget.menuId && menuNode.id && lastMenuTarget.menuId !== menuNode.id) return;
        if (lastMenuTarget.triggerId && menuNode.getAttribute('aria-labelledby') && menuNode.getAttribute('aria-labelledby') !== lastMenuTarget.triggerId) return;

        // 메뉴 내용이 채팅방 메뉴 구성인지 2차 확인한다. 다른 메뉴에 팔레트가 묻어나는 것을 방지한다.
        const menuText = cleanText(menuNode.textContent);
        const looksLikeChatMenu =
            menuText.includes('이름 변경') &&
            menuText.includes('삭제') &&
            (menuText.includes('고정') || menuText.includes('고정 해제'));
        if (!looksLikeChatMenu) return;

        menuNode.classList.add('crack-menu-solid');

        // 같은 메뉴에 팔레트를 제거/재삽입하면 Radix의 포커스·선택 상태가 흔들릴 수 있다.
        // 이미 주입된 경우에는 DOM을 더 바꾸지 않는다.
        if (menuNode.querySelector(':scope > .custom-palette-container')) return;

        const wrap = document.createElement('div');
        wrap.className = 'custom-palette-container';
        let currentColor = null;
        try {
            currentColor = localStorage.getItem(STORAGE_KEY + lastMenuTarget.id);
        } catch (e) {}

        Object.keys(colorValues).forEach(key => {
            const dot = document.createElement('div');
            dot.className = `custom-palette-dot ${currentColor === key ? 'active' : ''}`;
            dot.style.backgroundColor = colorValues[key];
            dot.title = currentColor === key ? `${key} 색상 제거` : `${key} 색상 적용`;

            dot.addEventListener('pointerdown', e => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                const target = lastMenuTarget;
                if (!target || !target.id) {
                    console.warn('[Crack UI] 색상 적용 실패: 채팅방 대상을 찾지 못했습니다.');
                    return;
                }

                let saved = null;
                try {
                    saved = localStorage.getItem(STORAGE_KEY + target.id);
                } catch (err) {}

                // 이미 같은 색이면 제거, 아니면 해당 색 적용
                const nextColor = saved === key ? null : key;
                saveColor(target.id, nextColor);

                setTimeout(() => {
                    document.dispatchEvent(new KeyboardEvent('keydown', {
                        key: 'Escape',
                        code: 'Escape',
                        bubbles: true
                    }));
                }, 30);
            }, true);

            dot.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }, true);

            wrap.appendChild(dot);
        });


        menuNode.appendChild(wrap);
    }

    function closeOpenRadixMenu() {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true
        }));
    }

    function injectSmartAutoOrganizeMenu(menuNode) {
        if (!(menuNode instanceof HTMLElement)) return;
        if (menuNode.querySelector('.crack-smart-organize-menu-item')) return;

        const candidates = Array.from(menuNode.querySelectorAll('[role="menuitem"], button, [data-radix-collection-item]'));
        const nativeAutoOrganize = candidates.find(item => {
            const text = cleanText(item.textContent || '');
            return text === '자동 정리' || text.includes('자동 정리');
        });
        if (!nativeAutoOrganize) return;

        const item = document.createElement('div');
        item.className = 'crack-smart-organize-menu-item';
        item.setAttribute('role', 'menuitem');
        item.setAttribute('tabindex', '-1');

        const icon = document.createElement('span');
        icon.className = 'crack-smart-organize-menu-icon';
        icon.textContent = '✦';

        const label = document.createElement('span');
        label.className = 'crack-smart-organize-menu-label';
        label.textContent = '스마트 자동 정리';

        const badge = document.createElement('span');
        badge.className = 'crack-smart-organize-menu-badge';
        badge.textContent = '추천';

        item.append(icon, label, badge);

        item.addEventListener('pointerdown', event => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            closeOpenRadixMenu();
            setTimeout(() => openSmartOrganize(), 60);
        }, true);

        item.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }, true);

        const parent = nativeAutoOrganize.parentElement || menuNode;
        parent.insertBefore(item, nativeAutoOrganize);
        menuNode.classList.add('crack-menu-solid');
    }

    function isSmartOrganizeRunActive(runId) {
        return smartOrganizeState.open && smartOrganizeState.runId === runId;
    }

    function getSmartOrganizeRoot() {
        return document.getElementById('crack-smart-organize-modal');
    }

    function getSmartOrganizeParts() {
        const root = getSmartOrganizeRoot();
        if (!root) return {};
        return {
            root,
            title: root.querySelector('.crack-smart-title'),
            subtitle: root.querySelector('.crack-smart-subtitle'),
            close: root.querySelector('.crack-smart-close'),
            body: root.querySelector('.crack-smart-body'),
            foot: root.querySelector('.crack-smart-foot')
        };
    }

    function ensureSmartOrganizeModal() {
        let root = getSmartOrganizeRoot();
        if (root) return root;

        root = document.createElement('div');
        root.id = 'crack-smart-organize-modal';
        root.innerHTML = `
            <section class="crack-smart-dialog" role="dialog" aria-modal="true" aria-labelledby="crack-smart-title">
                <header class="crack-smart-head">
                    <div class="crack-smart-title-wrap">
                        <h2 class="crack-smart-title" id="crack-smart-title">스마트 자동 정리</h2>
                        <div class="crack-smart-subtitle">동명 보관함을 확인하고 안전하게 정리합니다.</div>
                    </div>
                    <button type="button" class="crack-smart-close" aria-label="닫기">×</button>
                </header>
                <main class="crack-smart-body"></main>
                <footer class="crack-smart-foot"></footer>
            </section>
        `;

        root.addEventListener('pointerdown', event => {
            if (event.target === root && !smartOrganizeState.busy) closeSmartOrganize();
        });

        root.querySelector('.crack-smart-close').addEventListener('click', () => closeSmartOrganize());
        document.body.appendChild(root);
        return root;
    }

    function closeSmartOrganize(force = false) {
        if (smartOrganizeState.busy && !force && ['preparing', 'applying'].includes(smartOrganizeState.phase)) return;

        smartOrganizeState.runId += 1;
        smartOrganizeState.open = false;
        smartOrganizeState.busy = false;
        smartOrganizeState.phase = 'idle';
        smartOrganizeState.previewId = '';
        smartOrganizeState.rows = [];
        smartOrganizeState.status = '';
        smartOrganizeState.singletonStatus = 'idle';
        smartOrganizeState.singletonCount = 0;
        smartOrganizeState.singletonError = '';
        smartOrganizeState.result = null;
        getSmartOrganizeRoot()?.remove();
    }

    function setSmartOrganizeHeader(title, subtitle) {
        const parts = getSmartOrganizeParts();
        if (parts.title) parts.title.textContent = title;
        if (parts.subtitle) parts.subtitle.textContent = subtitle;
    }

    function renderSmartOrganizeLoading(title, status, phase = 'loading') {
        ensureSmartOrganizeModal();
        smartOrganizeState.phase = phase;
        smartOrganizeState.status = status;
        setSmartOrganizeHeader(title, '크랙의 자동 정리 미리보기를 안전하게 처리합니다.');

        const parts = getSmartOrganizeParts();
        parts.close.disabled = ['preparing', 'applying'].includes(phase);
        parts.body.replaceChildren();

        const wrap = document.createElement('div');
        wrap.className = 'crack-smart-loading';

        const spinner = document.createElement('div');
        spinner.className = 'crack-smart-spinner';

        const text = document.createElement('div');
        text.className = 'crack-smart-progress-text';
        text.textContent = status;

        wrap.append(spinner, text);
        parts.body.appendChild(wrap);
        parts.foot.replaceChildren();

        const busyButton = document.createElement('button');
        busyButton.type = 'button';
        busyButton.className = 'crack-smart-button';
        busyButton.disabled = true;
        busyButton.textContent = '처리 중';
        parts.foot.appendChild(busyButton);
    }

    function updateSmartOrganizeProgress(status) {
        smartOrganizeState.status = status;
        const text = getSmartOrganizeRoot()?.querySelector('.crack-smart-progress-text');
        if (text) text.textContent = status;
    }

    function formatSmartFolderDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
    }

    function getSmartOrganizeSummary() {
        const rows = smartOrganizeState.rows;
        const createRows = rows.filter(row => row.action === 'create');
        const mergeRows = rows.filter(row => row.action === 'merge');
        const skipRows = rows.filter(row => row.action === 'skip');
        return {
            createGroups: createRows.length,
            mergeGroups: mergeRows.length,
            skipGroups: skipRows.length,
            selectedGroups: createRows.length + mergeRows.length,
            selectedChats: [...createRows, ...mergeRows].reduce((sum, row) => sum + Math.max(0, Number(row.chatCount || 0)), 0)
        };
    }

    function updateSmartOrganizeReviewSummary() {
        const root = getSmartOrganizeRoot();
        if (!root) return;

        const summary = getSmartOrganizeSummary();
        const text = root.querySelector('.crack-smart-summary');
        const apply = root.querySelector('[data-smart-action="apply"]');

        if (text) {
            text.textContent = `새로 생성 ${summary.createGroups}개 · 기존에 합침 ${summary.mergeGroups}개 · 건너뜀 ${summary.skipGroups}개 · 채팅 ${summary.selectedChats}개`;
        }
        if (apply) {
            apply.disabled = summary.selectedGroups === 0;
            apply.textContent = summary.selectedGroups ? `${summary.selectedGroups}개 그룹 정리` : '정리할 항목 없음';
        }
    }

    function makeSmartSelect(options, value) {
        const select = document.createElement('select');
        select.className = 'crack-smart-select';
        for (const optionInfo of options) {
            const option = document.createElement('option');
            option.value = optionInfo.value;
            option.textContent = optionInfo.label;
            select.appendChild(option);
        }
        select.value = value;
        return select;
    }

    function renderSmartOrganizeReview() {
        smartOrganizeState.phase = 'review';
        smartOrganizeState.busy = false;
        setSmartOrganizeHeader('스마트 자동 정리', '동명 보관함은 기존에 합치고, 나머지는 새로 만들 수 있어요.');

        const parts = getSmartOrganizeParts();
        parts.close.disabled = false;
        parts.body.replaceChildren();
        parts.foot.replaceChildren();

        if (!smartOrganizeState.rows.length) {
            const empty = document.createElement('div');
            empty.className = 'crack-smart-message';
            empty.textContent = smartOrganizeState.singletonStatus === 'error'
                ? '순정 자동 정리 후보가 없습니다. 단일 채팅 확인도 실패했어요.'
                : '자동 정리할 채팅이 없습니다.';
            parts.body.appendChild(empty);

            if (smartOrganizeState.singletonStatus === 'error') {
                const detail = document.createElement('div');
                detail.className = 'crack-smart-subtitle';
                detail.style.marginTop = '10px';
                detail.textContent = `단일 채팅 확인 실패: ${smartOrganizeState.singletonError || '알 수 없는 오류'}`;
                parts.body.appendChild(detail);
            }

            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'crack-smart-button primary';
            close.textContent = '닫기';
            close.addEventListener('click', () => closeSmartOrganize());
            parts.foot.appendChild(close);
            return;
        }

        const conflictCount = smartOrganizeState.rows.filter(row => row.existingMatches.length > 0).length;
        const toolbar = document.createElement('div');
        toolbar.className = 'crack-smart-toolbar';

        const totalChip = document.createElement('span');
        totalChip.className = 'crack-smart-chip';
        totalChip.textContent = `정리 후보 ${smartOrganizeState.rows.length}개`;
        toolbar.appendChild(totalChip);

        if (smartOrganizeState.singletonStatus === 'ready') {
            const singletonChip = document.createElement('span');
            singletonChip.className = 'crack-smart-chip';
            singletonChip.textContent = smartOrganizeState.singletonCount
                ? `단일 채팅 +${smartOrganizeState.singletonCount}개`
                : '단일 채팅 추가 없음';
            toolbar.appendChild(singletonChip);
        } else if (smartOrganizeState.singletonStatus === 'error') {
            const singletonChip = document.createElement('span');
            singletonChip.className = 'crack-smart-chip conflict';
            singletonChip.textContent = '단일 채팅 확인 실패';
            singletonChip.title = smartOrganizeState.singletonError || '';
            toolbar.appendChild(singletonChip);
        }

        if (conflictCount) {
            const conflictChip = document.createElement('span');
            conflictChip.className = 'crack-smart-chip conflict';
            conflictChip.textContent = `동명 충돌 ${conflictCount}개`;
            toolbar.appendChild(conflictChip);

            const mergeAll = document.createElement('button');
            mergeAll.type = 'button';
            mergeAll.className = 'crack-smart-button';
            mergeAll.textContent = '동명 모두 합치기';
            mergeAll.addEventListener('click', () => {
                smartOrganizeState.rows.forEach(row => {
                    if (row.existingMatches.length) row.action = 'merge';
                });
                renderSmartOrganizeReview();
            });

            const createAll = document.createElement('button');
            createAll.type = 'button';
            createAll.className = 'crack-smart-button';
            createAll.textContent = '동명 모두 따로 만들기';
            createAll.addEventListener('click', () => {
                smartOrganizeState.rows.forEach(row => {
                    if (row.existingMatches.length) row.action = 'create';
                });
                renderSmartOrganizeReview();
            });

            toolbar.append(mergeAll, createAll);
        }

        const list = document.createElement('div');
        list.className = 'crack-smart-list';

        smartOrganizeState.rows.forEach(row => {
            const rowEl = document.createElement('div');
            rowEl.className = 'crack-smart-row';
            rowEl.dataset.conflict = row.existingMatches.length ? 'true' : 'false';

            const name = document.createElement('div');
            name.className = 'crack-smart-name';
            const strong = document.createElement('strong');
            strong.textContent = row.name || '이름 없는 보관함';
            const meta = document.createElement('span');
            meta.textContent = row.existingMatches.length
                ? `새 채팅 ${row.chatCount}개 · 같은 이름 보관함 ${row.existingMatches.length}개`
                : `새 채팅 ${row.chatCount}개 · 새 보관함 생성 예정`;
            name.append(strong, meta);

            const actionOptions = row.existingMatches.length
                ? [
                    { value: 'merge', label: '기존 보관함에 합치기' },
                    { value: 'create', label: '새 보관함으로 따로 만들기' },
                    { value: 'skip', label: '이번에는 건너뛰기' }
                ]
                : [
                    { value: 'create', label: '새 보관함 만들기' },
                    { value: 'skip', label: '이번에는 건너뛰기' }
                ];
            const actionSelect = makeSmartSelect(actionOptions, row.action);

            const targetWrap = document.createElement('div');
            const targetOptions = row.existingMatches.map((folder, index) => {
                const date = formatSmartFolderDate(folder.createdAt);
                const pinned = folder.pinnedAt ? ' · 고정됨' : '';
                return {
                    value: folder._id,
                    label: `기존 ${index + 1} · ${Number(folder.chatCount || 0)}개${date ? ' · ' + date : ''}${pinned}`
                };
            });
            const targetSelect = targetOptions.length
                ? makeSmartSelect(targetOptions, row.targetFolderId || targetOptions[0].value)
                : null;

            function syncTargetVisibility() {
                targetWrap.replaceChildren();
                if (row.action === 'merge' && targetSelect) {
                    targetWrap.appendChild(targetSelect);
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'crack-smart-chip';
                    placeholder.textContent = row.action === 'create' ? '새 보관함' : '적용 안 함';
                    targetWrap.appendChild(placeholder);
                }
            }

            actionSelect.addEventListener('change', () => {
                row.action = actionSelect.value;
                syncTargetVisibility();
                updateSmartOrganizeReviewSummary();
            });

            targetSelect?.addEventListener('change', () => {
                row.targetFolderId = targetSelect.value;
            });

            syncTargetVisibility();
            rowEl.append(name, actionSelect, targetWrap);
            list.appendChild(rowEl);
        });

        const note = document.createElement('div');
        note.className = 'crack-smart-subtitle';
        note.style.marginTop = '12px';
        note.textContent = smartOrganizeState.singletonStatus === 'error'
            ? `같은 이름은 공백·대소문자 차이를 정리한 보관함명 기준입니다. 단일 채팅 확인은 실패하여 순정 후보만 표시합니다: ${smartOrganizeState.singletonError || '알 수 없는 오류'}`
            : '같은 이름은 공백·대소문자 차이를 정리한 보관함명 기준입니다. 전체 목록에서 보관함 채팅을 제외해 1개짜리 채팅도 확인하며, 적용 전 선택한 항목만 처리합니다.';

        parts.body.append(toolbar, list, note);

        const summaryText = document.createElement('div');
        summaryText.className = 'crack-smart-summary';

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'crack-smart-button';
        cancel.textContent = '취소';
        cancel.addEventListener('click', () => closeSmartOrganize());

        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'crack-smart-button primary';
        apply.dataset.smartAction = 'apply';
        apply.addEventListener('click', () => applySmartOrganize());

        parts.foot.append(summaryText, cancel, apply);
        updateSmartOrganizeReviewSummary();
    }

    function renderSmartOrganizeError(error, retry = true) {
        smartOrganizeState.phase = 'error';
        smartOrganizeState.busy = false;
        setSmartOrganizeHeader('스마트 자동 정리 실패', '아직 보관함 변경은 적용되지 않았습니다.');

        const parts = getSmartOrganizeParts();
        parts.close.disabled = false;
        parts.body.replaceChildren();
        parts.foot.replaceChildren();

        const message = document.createElement('div');
        message.className = 'crack-smart-message';
        const title = document.createElement('strong');
        title.textContent = '미리보기를 준비하지 못했어요.';
        const detail = document.createElement('div');
        detail.className = 'crack-smart-error';
        detail.textContent = getSmartOrganizeErrorMessage(error);
        message.append(title, detail);
        parts.body.appendChild(message);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'crack-smart-button';
        close.textContent = '닫기';
        close.addEventListener('click', () => closeSmartOrganize());
        parts.foot.appendChild(close);

        if (retry) {
            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.className = 'crack-smart-button primary';
            retryButton.textContent = '다시 시도';
            retryButton.addEventListener('click', () => {
                closeSmartOrganize(true);
                setTimeout(() => openSmartOrganize(), 50);
            });
            parts.foot.appendChild(retryButton);
        }
    }

    function renderSmartOrganizeDone(result) {
        smartOrganizeState.phase = 'done';
        smartOrganizeState.busy = false;
        smartOrganizeState.result = result;

        const failed = result.items.filter(item => !item.ok);
        setSmartOrganizeHeader(
            failed.length ? '스마트 자동 정리 일부 완료' : '스마트 자동 정리 완료',
            failed.length ? '성공한 항목은 적용됐고, 실패한 항목은 아래에 표시했어요.' : '선택한 채팅을 모두 안전하게 정리했어요.'
        );

        const parts = getSmartOrganizeParts();
        parts.close.disabled = false;
        parts.body.replaceChildren();
        parts.foot.replaceChildren();

        const message = document.createElement('div');
        message.className = 'crack-smart-message';

        const summary = document.createElement('strong');
        summary.textContent = `새 보관함 ${result.createdGroups}개 · 기존에 합침 ${result.mergedGroups}개 · 채팅 ${result.movedChats}개`;
        message.appendChild(summary);

        if (failed.length) {
            const list = document.createElement('ul');
            list.className = 'crack-smart-result-list crack-smart-error';
            failed.forEach(item => {
                const li = document.createElement('li');
                li.textContent = `${item.name}: ${item.error}`;
                list.appendChild(li);
            });
            message.appendChild(list);
        } else {
            const detail = document.createElement('div');
            detail.textContent = '보관함 및 채팅 목록 개수도 자동으로 다시 계산합니다.';
            message.appendChild(detail);
        }

        parts.body.appendChild(message);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'crack-smart-button primary';
        close.textContent = '완료';
        close.addEventListener('click', () => closeSmartOrganize());
        parts.foot.appendChild(close);
    }

    function normalizeSmartFolderName(value) {
        return cleanText(value || '')
            .normalize('NFKC')
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase();
    }

    function sortSmartExistingFolders(folders) {
        return [...folders].sort((a, b) => {
            const countDiff = Number(b?.chatCount || 0) - Number(a?.chatCount || 0);
            if (countDiff) return countDiff;
            return String(a?.createdAt || '').localeCompare(String(b?.createdAt || ''));
        });
    }

    function buildSmartOrganizeRows(groups, existingFolders) {
        const byName = new Map();
        for (const folder of existingFolders) {
            if (!folder?._id) continue;
            const key = normalizeSmartFolderName(folder.name);
            if (!key) continue;
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(folder);
        }

        return groups
            .filter(group => group?.storyId && Number(group?.chatCount || 0) > 0)
            .map(group => {
                const matches = sortSmartExistingFolders(byName.get(normalizeSmartFolderName(group.name)) || []);
                return {
                    storyId: group.storyId,
                    name: cleanText(group.name || '이름 없는 보관함'),
                    chatCount: Math.max(0, Number(group.chatCount || 0)),
                    preloadedChatIds: Array.isArray(group.preloadedChatIds)
                        ? [...new Set(group.preloadedChatIds.filter(Boolean))]
                        : null,
                    isSingletonSupplement: !!group.isSingletonSupplement,
                    existingMatches: matches,
                    action: matches.length ? 'merge' : 'create',
                    targetFolderId: matches[0]?._id || ''
                };
            });
    }

    function buildSmartSingletonGroups(rootChats, existingFolders, previewGroups) {
        const existingNames = new Set(
            existingFolders
                .filter(folder => folder?._id)
                .map(folder => normalizeSmartFolderName(folder.name))
                .filter(Boolean)
        );
        const previewStoryIds = new Set(
            previewGroups
                .map(group => String(group?.storyId || ''))
                .filter(Boolean)
        );
        const grouped = new Map();

        for (const chat of rootChats) {
            const chatId = String(chat?._id || '');
            const storyId = String(chat?.story?._id || '');
            if (!chatId || !storyId || previewStoryIds.has(storyId)) continue;

            const name = cleanText(chat?.story?.name || chat?.title || '');
            if (!name) continue;

            if (!grouped.has(storyId)) {
                grouped.set(storyId, {
                    storyId,
                    name,
                    chatIds: new Set()
                });
            }
            grouped.get(storyId).chatIds.add(chatId);
        }

        return [...grouped.values()]
            .filter(group => group.chatIds.size === 1)
            .filter(group => existingNames.has(normalizeSmartFolderName(group.name)))
            .map(group => ({
                storyId: group.storyId,
                name: group.name,
                chatCount: 1,
                preloadedChatIds: [...group.chatIds],
                isSingletonSupplement: true
            }));
    }

    function getSmartOrganizeErrorMessage(error) {
        if (error?.message === 'NO_AUTH_TOKEN') {
            return '인증 토큰을 아직 못 잡았어요. 채팅방을 아무거나 한 번 열었다 나온 뒤 다시 시도해 주세요.';
        }
        if (error?.status === 401) return '인증이 만료됐어요. 크랙을 새로고침한 뒤 다시 시도해 주세요.';
        return cleanText(error?.detail || error?.message || String(error || '알 수 없는 오류'));
    }

    async function openSmartOrganize() {
        if (smartOrganizeState.open) return;

        smartOrganizeState.runId += 1;
        const runId = smartOrganizeState.runId;
        smartOrganizeState.open = true;
        smartOrganizeState.busy = true;
        smartOrganizeState.previewId = '';
        smartOrganizeState.rows = [];
        smartOrganizeState.singletonStatus = 'idle';
        smartOrganizeState.singletonCount = 0;
        smartOrganizeState.singletonError = '';
        smartOrganizeState.result = null;

        ensureSmartOrganizeModal();
        renderSmartOrganizeLoading('스마트 자동 정리 준비', '인증 정보를 확인하는 중…', 'loading');

        try {
            if (!hasAuthToken()) await waitForAuthToken(6000);
            if (!isSmartOrganizeRunActive(runId)) return;
            if (!hasAuthToken()) throw new Error('NO_AUTH_TOKEN');

            updateSmartOrganizeProgress('크랙 자동 정리 미리보기를 만드는 중…');
            const previewJson = await requestCrackJson('/crack-gen/chat-folders/auto-organize/preview', {
                method: 'POST'
            });
            if (!isSmartOrganizeRunActive(runId)) return;

            const previewId = previewJson?.data?.previewId;
            if (!previewId) throw new Error('미리보기 ID를 받지 못했습니다.');
            smartOrganizeState.previewId = previewId;

            updateSmartOrganizeProgress('기존 보관함과 정리 후보를 비교하는 중…');
            const [existingFolders, groups] = await Promise.all([
                fetchSmartExistingFolders(),
                fetchSmartPreviewGroups(previewId)
            ]);
            if (!isSmartOrganizeRunActive(runId)) return;

            updateSmartOrganizeProgress('기존 보관함에 합칠 단일 채팅을 확인하는 중…');
            let singletonGroups = [];
            try {
                singletonGroups = await fetchSmartSingletonGroups(existingFolders, groups, (completed, total) => {
                    if (isSmartOrganizeRunActive(runId)) {
                        updateSmartOrganizeProgress(`보관함과 대조하는 중 ${completed}/${total}`);
                    }
                });
                smartOrganizeState.singletonStatus = 'ready';
                smartOrganizeState.singletonCount = singletonGroups.length;
            } catch (error) {
                // 보충 조회가 실패해도 순정 미리보기 기반 스마트 정리는 그대로 사용할 수 있게 둡니다.
                console.warn('[Crack UI] 단일 채팅 스마트 정리 후보 확인 실패:', error);
                smartOrganizeState.singletonStatus = 'error';
                smartOrganizeState.singletonCount = 0;
                smartOrganizeState.singletonError = getSmartOrganizeErrorMessage(error);
            }
            if (!isSmartOrganizeRunActive(runId)) return;

            smartOrganizeState.rows = buildSmartOrganizeRows([...groups, ...singletonGroups], existingFolders);
            renderSmartOrganizeReview();
        } catch (error) {
            if (!isSmartOrganizeRunActive(runId)) return;
            console.warn('[Crack UI] 스마트 자동 정리 준비 실패:', error);
            renderSmartOrganizeError(error, true);
        }
    }

    async function mapSmartWithConcurrency(items, limit, mapper, onProgress) {
        const results = new Array(items.length);
        let cursor = 0;
        let completed = 0;

        async function worker() {
            while (cursor < items.length) {
                const index = cursor++;
                results[index] = await mapper(items[index], index);
                completed += 1;
                onProgress?.(completed, items.length);
            }
        }

        const workers = Array.from(
            { length: Math.min(Math.max(1, limit), Math.max(1, items.length)) },
            () => worker()
        );
        await Promise.all(workers);
        return results;
    }

    async function applySmartOrganize() {
        if (smartOrganizeState.busy || smartOrganizeState.phase !== 'review') return;

        const selectedRows = smartOrganizeState.rows
            .filter(row => row.action === 'create' || row.action === 'merge')
            .map(row => ({ ...row }));
        if (!selectedRows.length) return;

        const runId = smartOrganizeState.runId;
        smartOrganizeState.busy = true;
        renderSmartOrganizeLoading('정리할 채팅 확인', `채팅 목록을 불러오는 중 0/${selectedRows.length}`, 'preparing');

        try {
            // 실제 변경 전에 모든 대상 채팅 ID를 먼저 확보한다. 중간 조회 실패로 반쯤 적용되는 일을 막는다.
            const prepared = await mapSmartWithConcurrency(
                selectedRows,
                SMART_ORGANIZE_LOAD_CONCURRENCY,
                async row => ({
                    row,
                    chatIds: row.preloadedChatIds?.length
                        ? [...row.preloadedChatIds]
                        : await fetchSmartPreviewChatIds(smartOrganizeState.previewId, row.storyId)
                }),
                (completed, total) => {
                    if (isSmartOrganizeRunActive(runId)) {
                        updateSmartOrganizeProgress(`채팅 목록을 불러오는 중 ${completed}/${total}`);
                    }
                }
            );
            if (!isSmartOrganizeRunActive(runId)) return;

            smartOrganizeState.phase = 'applying';
            const result = {
                createdGroups: 0,
                mergedGroups: 0,
                movedChats: 0,
                items: []
            };

            for (let index = 0; index < prepared.length; index += 1) {
                const { row, chatIds } = prepared[index];
                updateSmartOrganizeProgress(`보관함에 적용하는 중 ${index + 1}/${prepared.length} · ${row.name}`);

                try {
                    const uniqueChatIds = [...new Set(chatIds.filter(Boolean))];
                    if (!uniqueChatIds.length) {
                        result.items.push({ name: row.name, ok: true, action: 'skip-empty', chatCount: 0 });
                        continue;
                    }

                    if (row.action === 'merge') {
                        if (!row.targetFolderId) throw new Error('합칠 보관함을 선택하지 않았습니다.');
                        await moveSmartChatsToFolder(uniqueChatIds, row.targetFolderId);
                        result.mergedGroups += 1;
                    } else {
                        await createSmartFolderWithChats(row.name, uniqueChatIds);
                        result.createdGroups += 1;
                    }

                    result.movedChats += uniqueChatIds.length;
                    result.items.push({
                        name: row.name,
                        ok: true,
                        action: row.action,
                        chatCount: uniqueChatIds.length
                    });
                } catch (error) {
                    console.warn('[Crack UI] 스마트 자동 정리 항목 실패:', row.name, error);
                    result.items.push({
                        name: row.name,
                        ok: false,
                        action: row.action,
                        chatCount: 0,
                        error: getSmartOrganizeErrorMessage(error)
                    });
                }
            }

            archiveSearchState.refreshedThisPage = false;
            archiveSearchState.savedAt = 0;
            archiveSearchState.lastRenderKey = '';
            archiveSearchState.lastResultKey = '';
            markArchiveDataChanged();
            setTimeout(() => ensureArchiveSearchIndex(), 1200);
            renderSmartOrganizeDone(result);
        } catch (error) {
            if (!isSmartOrganizeRunActive(runId)) return;
            console.warn('[Crack UI] 스마트 자동 정리 적용 준비 실패:', error);
            renderSmartOrganizeError(error, true);
        }
    }

    function setupMarquee(container) {
        const nameSpan = container.querySelector(
            '.typo-text-sm_leading-none_medium, .text-popover-foreground.whitespace-nowrap, .text-popover-foreground'
        );

        if (!nameSpan || nameSpan.classList.contains('marquee-target')) return;

        nameSpan.classList.add('marquee-target');

        requestAnimationFrame(() => {
            const diff = nameSpan.scrollWidth - nameSpan.clientWidth;

            if (diff > 0) {
                nameSpan.classList.add('can-animate');
                nameSpan.style.setProperty('--move-dist', `${(diff + 10) * -1}px`);
            }
        });
    }

    // 보관함 상단 검색바 생성 및 삽입
    function scheduleSearchQueryApply(delay = SEARCH_DEBOUNCE_MS) {
        clearTimeout(searchDebounceTimer);

        searchDebounceTimer = setTimeout(() => {
            searchDebounceTimer = null;

            const input = document.querySelector('.crack-search-input');
            if (input && input.value !== currentSearchQueryRaw) {
                currentSearchQueryRaw = input.value || '';
            }

            filterChatsAndFolders(normalizeSearchText(currentSearchQueryRaw));
        }, delay);
    }

    function syncSearchInputFromState(input, clearBtn) {
        if (!input) return;

        const isNewInput = input !== lastSearchInputEl;
        lastSearchInputEl = input;

        if (isNewInput) {
            // React가 검색창을 새로 만든 경우에만 이전 검색어를 되살린다.
            // 조합(IME) 중에는 value를 건드리면 자모가 겹치므로 건너뛴다.
            if (!isSearchComposing && currentSearchQueryRaw && !input.value) {
                input.value = currentSearchQueryRaw;
            }
        } else if (!isSearchComposing) {
            // 살아있는 입력창에서는 입력창 값이 항상 진실이다.
            // 사용자가 직접 지웠으면 백업본도 같이 비워야 글자가 되살아나지 않는다.
            currentSearchQueryRaw = input.value || '';
        }

        if (clearBtn) {
            clearBtn.classList.toggle('visible', !!input.value.trim());
        }
    }

    function ensureSearchBarEvents(searchContainer) {
        if (!searchContainer) return;

        // 검색 결과는 fixed overlay에서만 렌더링합니다.
        searchContainer.querySelectorAll('.crack-api-result-snippet, .crack-api-search-status, .crack-api-search-results').forEach(el => el.remove());
        ensureSearchOverlay();

        const input = searchContainer.querySelector('.crack-search-input');
        const clearBtn = searchContainer.querySelector('.crack-search-clear');
        if (!input || !clearBtn) return;

        input.placeholder = '채팅방 제목 검색...';
        syncSearchInputFromState(input, clearBtn);

        if (searchContainer.dataset.crackSearchBound === 'true') return;

        input.addEventListener('compositionstart', () => {
            isSearchComposing = true;
        });

        input.addEventListener('compositionend', () => {
            isSearchComposing = false;
            currentSearchQueryRaw = input.value || '';
            const query = normalizeSearchText(currentSearchQueryRaw);
            clearBtn.classList.toggle('visible', !!query);
            scheduleSearchQueryApply(SEARCH_DEBOUNCE_MS);
        });

        // IME 조합 중에도 input.value 기준으로 검색을 갱신한다.
        input.addEventListener('input', () => {
            currentSearchQueryRaw = input.value || '';
            const query = normalizeSearchText(currentSearchQueryRaw);
            clearBtn.classList.toggle('visible', !!query);

            scheduleSearchQueryApply(SEARCH_DEBOUNCE_MS);
        });

        // 조합 중에 X를 누르면 포커스가 빠지면서 만들던 글자가 되돌아온다.
        // 클릭 전에 포커스가 빠지지 않도록 막는다.
        clearBtn.addEventListener('mousedown', e => {
            e.preventDefault();
        });

        clearBtn.addEventListener('click', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = null;
            isSearchComposing = false;

            currentSearchQueryRaw = '';
            input.value = '';
            clearBtn.classList.remove('visible');
            filterChatsAndFolders('');
            input.focus();

            // 뒤늦게 되돌아온 조합 문자를 한 번 더 정리한다.
            requestAnimationFrame(() => {
                if (currentSearchQueryRaw === '' && input.value) {
                    input.value = '';
                    clearBtn.classList.remove('visible');
                    filterChatsAndFolders('');
                }
            });
        });

        // 조합 입력/자동완성 직후에도 상태를 한 번 더 맞춘다.
        input.addEventListener('change', () => {
            currentSearchQueryRaw = input.value || '';
            clearBtn.classList.toggle('visible', !!normalizeSearchText(currentSearchQueryRaw));
            scheduleSearchQueryApply(SEARCH_DEBOUNCE_MS);
        });

        searchContainer.dataset.crackSearchBound = 'true';
    }


    function ensureSearchOverlay() {
        let overlay = document.getElementById('crack-search-overlay');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'crack-search-overlay';
        overlay.innerHTML = `
            <div class="crack-api-search-status"></div>
            <div class="crack-api-search-results"></div>
        `;
        document.body.appendChild(overlay);
        return overlay;
    }

    function getSearchOverlayParts() {
        const overlay = ensureSearchOverlay();
        return {
            overlay,
            status: overlay.querySelector('.crack-api-search-status'),
            results: overlay.querySelector('.crack-api-search-results')
        };
    }

    function getSearchSidebarRect(searchContainer) {
        const searchRect = searchContainer.getBoundingClientRect();
        let best = null;

        for (let el = searchContainer.parentElement, depth = 0; el && el instanceof HTMLElement && el !== document.body && depth < 14; el = el.parentElement, depth += 1) {
            const rect = el.getBoundingClientRect();
            if (
                rect.width >= searchRect.width - 2 &&
                rect.width <= 430 &&
                rect.height >= 220 &&
                rect.left <= searchRect.left + 12 &&
                rect.right >= searchRect.right - 12
            ) {
                best = rect;
            }
        }

        if (best) return best;

        return {
            left: Math.max(0, searchRect.left - 10),
            right: searchRect.right + 10,
            width: searchRect.width + 20,
            top: searchRect.top,
            bottom: window.innerHeight,
            height: window.innerHeight - searchRect.top
        };
    }

    function updateSearchOverlayPosition() {
        const overlay = document.getElementById('crack-search-overlay');
        const searchContainer = document.querySelector('.crack-search-container');
        if (!overlay || !searchContainer || !overlay.classList.contains('visible')) return;

        const searchRect = searchContainer.getBoundingClientRect();
        const sidebarRect = getSearchSidebarRect(searchContainer);
        const top = Math.max(0, Math.round(searchRect.bottom + 6));
        const height = Math.max(120, Math.round(window.innerHeight - top));

        overlay.style.left = `${Math.max(0, Math.round(sidebarRect.left))}px`;
        overlay.style.top = `${top}px`;
        overlay.style.width = `${Math.max(180, Math.round(sidebarRect.width))}px`;
        overlay.style.height = `${height}px`;
    }

    function scheduleSearchOverlayPositionUpdate() {
        clearTimeout(searchOverlayPositionTimer);
        searchOverlayPositionTimer = setTimeout(() => {
            searchOverlayPositionTimer = null;
            updateSearchOverlayPosition();
        }, 30);
    }

    function setSearchOverlayActive(active) {
        const overlay = ensureSearchOverlay();

        if (!active) {
            overlay.classList.remove('visible');
            return;
        }

        overlay.classList.add('visible');
        updateSearchOverlayPosition();
    }

    function isInsideSearchOverlay(node) {
        if (!node) return false;
        const el = node instanceof HTMLElement ? node : node.parentElement;
        return !!el?.closest?.('#crack-search-overlay');
    }

    function isInsideSmartOrganize(node) {
        if (!node) return false;
        const el = node instanceof HTMLElement ? node : node.parentElement;
        return !!el?.closest?.('#crack-smart-organize-modal');
    }

    // Radix 메뉴 포털의 생성·제거 및 팔레트 주입은 튜너 전체 UI 갱신 사유가 아니다.
    // 제거된 노드는 closest()가 동작하지 않을 수 있어 자기 자신/내부 role="menu"도 함께 확인한다.
    function isMenuLayerNode(node) {
        if (!(node instanceof HTMLElement)) return false;

        if (node.matches?.('[role="menu"]') || node.querySelector?.('[role="menu"]')) return true;
        if (node.closest?.('[role="menu"]')) return true;

        const popper = node.closest?.('[data-radix-popper-content-wrapper]');
        return !!popper?.querySelector?.('[role="menu"]');
    }

    function isMenuOnlyMutation(mutation) {
        if (!mutation) return false;
        if (isMenuLayerNode(mutation.target)) return true;

        const changedNodes = [
            ...Array.from(mutation.addedNodes || []),
            ...Array.from(mutation.removedNodes || [])
        ].filter(node => node instanceof HTMLElement);

        return changedNodes.length > 0 && changedNodes.every(isMenuLayerNode);
    }

    // 이전 버전에서 남긴 숨김/레이아웃 흔적을 정리합니다.
    function cleanupLegacySearchModeArtifacts(force = false) {
        // 구버전(v4.5.x 계열) 잔여 속성 정리는 대부분 최초 1회면 충분하다.
        // 검색어가 비어 있을 때마다 전역 querySelectorAll을 반복하지 않도록 막는다.
        if (!force && legacySearchCleanupDone) return;

        restoreSearchModeHiddenElements();
        restoreSearchLayoutExpansion();
        document.querySelectorAll('.crack-search-container.crack-search-active').forEach(el => {
            el.classList.remove('crack-search-active');
        });

        legacySearchCleanupDone = true;
    }

    function restoreSearchModeHiddenElements() {
        document.querySelectorAll('[data-crack-search-hidden-v457="true"]').forEach(el => {
            if (!(el instanceof HTMLElement)) return;
            const prev = el.dataset.crackPrevDisplayV457 || '';
            if (prev) {
                el.style.display = prev;
            } else {
                el.style.removeProperty('display');
            }
            delete el.dataset.crackSearchHiddenV457;
            delete el.dataset.crackPrevDisplayV457;
        });
    }

    function restoreSearchLayoutExpansion() {
        document.querySelectorAll('[data-crack-search-expanded-v458="true"]').forEach(el => {
            if (!(el instanceof HTMLElement)) return;

            const props = ['overflow', 'overflowY', 'overflowX', 'maxHeight', 'height', 'minHeight', 'flex', 'flexBasis'];
            props.forEach(prop => {
                const key = 'crackPrev' + prop.charAt(0).toUpperCase() + prop.slice(1) + '';
                const value = el.dataset[key] || '';
                if (value) {
                    el.style[prop] = value;
                } else {
                    el.style.removeProperty(prop.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
                }
                delete el.dataset[key];
            });

            delete el.dataset.crackSearchExpandedV458;
        });

        document.querySelectorAll('.crack-search-container.crack-search-active').forEach(el => {
            el.classList.remove('crack-search-active');
        });
    }

    function findSectionHeaderSpan(label) {
        return Array.from(document.querySelectorAll('span')).find(el => {
            if (cleanText(el.textContent) !== label) return false;
            if (el.closest('#crack-search-overlay')) return false;
            const dialog = el.closest('[role="dialog"]');
            if (dialog && (
                dialog.textContent.includes('보관함 이동') ||
                dialog.querySelector('h2')?.textContent?.includes('이동')
            )) return false;
            return isInActiveSidebar(el);
        }) || null;
    }

    function findArchiveHeaderSpan() {
        return findSectionHeaderSpan('보관함');
    }

    function findChatListHeaderSpan() {
        return findSectionHeaderSpan('채팅 목록');
    }

    function findSectionHeaderRow(header) {
        if (!header) return null;

        for (let el = header.parentElement, depth = 0; el && el !== document.body && depth < 6; el = el.parentElement, depth += 1) {
            if (!(el instanceof HTMLElement)) continue;
            if (!el.classList.contains('flex') || !el.classList.contains('items-center')) continue;

            const text = cleanText(el.textContent);
            if (text.includes(cleanText(header.textContent))) return el;
        }

        return header.parentElement;
    }

    function placeSectionCountBadge(header, badge, kind) {
        let row = findSectionHeaderRow(header);
        if (!row) return false;

        if (kind === 'root') {
            // 채팅 목록 제목의 가장 가까운 flex가 내부 묶음일 수 있으므로,
            // 실제 점 세 개 메뉴 버튼을 포함한 상위 헤더 행까지 올라간다.
            let menuButton = null;
            for (let el = row; el && el !== document.body; el = el.parentElement) {
                if (!(el instanceof HTMLElement)) continue;
                const candidate = Array.from(el.querySelectorAll('button[aria-haspopup="menu"]'))
                    .find(button => button instanceof HTMLElement && isInActiveSidebar(button));
                if (!candidate) continue;
                row = el;
                menuButton = candidate;
                break;
            }

            if (menuButton) {
                if (badge.parentElement !== row || badge.nextElementSibling !== menuButton) {
                    row.insertBefore(badge, menuButton);
                }
                return true;
            }
        }

        // 보관함은 제목을 소유한 버튼/요소 바로 뒤에 둔다.
        const titleOwner = header.closest('button') || header;
        if (titleOwner.parentElement === row) {
            if (badge.parentElement !== row || badge.previousElementSibling !== titleOwner) {
                titleOwner.insertAdjacentElement('afterend', badge);
            }
        } else if (badge.parentElement !== row) {
            row.appendChild(badge);
        }

        return true;
    }

    function updateSectionCountBadge(kind, header, count) {
        if (!header) return null;

        const selector = `.crack-section-count[data-kind="${kind}"]`;
        let badge = document.querySelector(selector);

        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'crack-section-count';
            badge.dataset.kind = kind;
        }

        if (!placeSectionCountBadge(header, badge, kind)) return null;

        const state = archiveSearchState.countStatus;
        const hasCount = Number.isFinite(count);
        const nextState = hasCount ? 'ready' : state;
        const nextText = hasCount
            ? `${count.toLocaleString()}개`
            : state === 'error' ? '—' : '…';
        const label = kind === 'archive' ? '보관함 채팅' : '채팅 목록';
        const nextAria = hasCount
            ? `${label} ${count}개`
            : state === 'error' ? `${label} 개수를 불러오지 못함` : `${label} 개수 불러오는 중`;

        // 같은 값이면 DOM을 다시 쓰지 않는다. MutationObserver 재렌더 깜빡임을 줄인다.
        if (badge.textContent !== nextText) badge.textContent = nextText;
        if (badge.dataset.state !== nextState) badge.dataset.state = nextState;
        if (badge.getAttribute('aria-label') !== nextAria) badge.setAttribute('aria-label', nextAria);
        badge.title = nextAria;

        return badge;
    }

    function updateChatCountBadges() {
        const archiveHeader = findArchiveHeaderSpan();
        const rootHeader = findChatListHeaderSpan();

        updateSectionCountBadge('archive', archiveHeader, archiveSearchState.totalArchiveChats);
        updateSectionCountBadge('root', rootHeader, archiveSearchState.totalRootChats);
    }

    function injectSearchBar() {
        updateChatCountBadges();
        const existing = document.querySelector('.crack-search-container');
        if (existing) {
            ensureSearchBarEvents(existing);
            return;
        }

        // 보관함 검색바 생성 시 진짜 사이드바 헤더만 정밀 타겟팅
        const archiveHeader = findArchiveHeaderSpan();
        if (!archiveHeader) return;

        const headerDiv = archiveHeader.closest('.flex.items-center');
        if (headerDiv && headerDiv.parentNode) {
            const searchContainer = document.createElement('div');
            searchContainer.className = 'crack-search-container';
            searchContainer.innerHTML = `
                <div class="crack-search-box">
                    <span class="crack-search-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" width="14" height="14">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                    </span>
                    <input type="text" class="crack-search-input" placeholder="채팅방 제목 검색...">
                    <button type="button" class="crack-search-clear">✕</button>
                </div>
            `;

            headerDiv.parentNode.insertBefore(searchContainer, headerDiv);
            ensureSearchBarEvents(searchContainer);
        }
    }
    // API 기반 보관함 내부 검색 인덱스 -----------------------------
    function normalizeSearchText(text) {
        return cleanText(text).toLowerCase();
    }

    function textMatchesQuery(text, query) {
        const normalizedText = normalizeSearchText(text);
        const terms = normalizeSearchText(query).split(' ').filter(Boolean);
        if (!terms.length) return false;
        return terms.every(term => normalizedText.includes(term));
    }

    function getBestImage(chat) {
        const profile = chat?.story?.profileImage || {};
        const portrait = chat?.story?.portraitImage || {};
        return portrait.w200 || profile.w200 || portrait.origin || profile.origin || '';
    }

    function formatArchiveDate(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';

        const diff = Date.now() - date.getTime();
        const day = 24 * 60 * 60 * 1000;

        if (diff >= 0 && diff < day) return '오늘';
        if (diff >= day && diff < 2 * day) return '어제';
        if (diff >= 2 * day && diff < 7 * day) return `${Math.floor(diff / day)}일 전`;

        return `${date.getMonth() + 1}월 ${date.getDate()}일`;
    }

    function buildChatHref(chat) {
        const storyId = chat?.story?._id;
        const chatId = chat?._id;
        if (!storyId || !chatId) return '';
        return `/stories/${storyId}/episodes/${chatId}`;
    }

    function mapArchiveChat(folder, chat, source = 'archive') {
        const href = buildChatHref(chat);
        if (!href) return null;

        const title = cleanText(chat?.title || chat?.story?.name || '제목 없음');
        const isRoot = source === 'root';

        return {
            source,
            folderId: isRoot ? '__root__' : (folder?._id || ''),
            folderName: isRoot ? '채팅 목록' : (folder?.name || '보관함'),
            chatId: chat?._id || '',
            storyId: chat?.story?._id || '',
            title,
            // 검색에는 쓰지 않는다. 결과 카드에도 표시하지 않는다.
            lastMessage: cleanText(chat?.lastMessage || ''),
            storyName: cleanText(chat?.story?.name || ''),
            updatedAt: chat?.messagedAt || chat?.updatedAt || chat?.pinnedAt || chat?.createdAt || '',
            imageUrl: getBestImage(chat),
            href
        };
    }

    function getNextCursor(data) {
        if (!data || typeof data !== 'object') return null;
        return data.nextCursor || data.cursor || data.next || data.pageInfo?.nextCursor || data.pagination?.nextCursor || null;
    }

    function makeApiUrl(path, params = {}) {
        const url = new URL(path, CRACK_API_BASE);
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, value);
            }
        });
        return url.toString();
    }

    async function fetchCrackJson(path, params = {}) {
        const url = makeApiUrl(path, params);
        const response = await fetch(url, {
            method: 'GET',
            mode: 'cors',
            credentials: 'include',
            headers: {
                'accept': 'application/json',
                ...getAuthHeaderOnly()
            }
        });

        if (!response.ok) {
            const error = new Error(`API ${response.status}: ${path}`);
            error.status = response.status;
            error.url = url;
            throw error;
        }

        return response.json();
    }

    async function requestCrackJson(path, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const url = makeApiUrl(path, options.params || {});
        const hasBody = options.body !== undefined;
        const headers = {
            'accept': 'application/json',
            ...getAuthHeaderOnly()
        };
        if (hasBody) headers['content-type'] = 'application/json';

        const response = await fetch(url, {
            method,
            mode: 'cors',
            credentials: 'include',
            headers,
            ...(hasBody ? { body: JSON.stringify(options.body) } : {})
        });

        let json = null;
        try {
            json = await response.json();
        } catch {}

        if (!response.ok) {
            const error = new Error(`API ${response.status}: ${path}`);
            error.status = response.status;
            error.url = url;
            error.detail = json?.message || json?.error || '';
            throw error;
        }

        return json || { result: 'SUCCESS' };
    }

    async function fetchSmartExistingFolders() {
        const folders = [];
        let cursor = null;
        let page = 0;

        do {
            const params = { limit: API_PAGE_LIMIT };
            if (cursor) params.cursor = cursor;

            const json = await fetchCrackJson('/crack-gen/chat-folders', params);
            const data = json?.data || {};
            const list = Array.isArray(data.folders) ? data.folders : [];
            folders.push(...list.filter(folder => folder?._id));

            cursor = getNextCursor(data);
            page += 1;
        } while (cursor && page < 50);

        if (cursor) throw new Error('보관함 목록이 너무 많아 전부 불러오지 못했습니다.');
        return folders;
    }

    async function fetchSmartPreviewGroups(previewId) {
        const groups = [];
        let cursor = null;
        let page = 0;

        do {
            const params = {
                previewId,
                limit: API_PAGE_LIMIT
            };
            if (cursor) params.cursor = cursor;

            const json = await fetchCrackJson('/crack-gen/chat-folders/auto-organize/preview', params);
            const data = json?.data || {};
            const list = Array.isArray(data.folders) ? data.folders : [];
            groups.push(...list);

            cursor = getNextCursor(data);
            page += 1;
        } while (cursor && page < 50);

        if (cursor) throw new Error('자동 정리 후보가 너무 많아 전부 불러오지 못했습니다.');
        return groups;
    }

    async function fetchSmartPreviewChatIds(previewId, storyId) {
        const chatIds = [];
        const seen = new Set();
        let cursor = null;
        let page = 0;

        do {
            const params = {
                previewId,
                storyId,
                limit: API_PAGE_LIMIT
            };
            if (cursor) params.cursor = cursor;

            const json = await fetchCrackJson('/crack-gen/chat-folders/auto-organize/preview', params);
            const data = json?.data || {};
            const chats = Array.isArray(data.chats) ? data.chats : [];

            for (const chat of chats) {
                const chatId = chat?._id;
                if (!chatId || seen.has(chatId)) continue;
                seen.add(chatId);
                chatIds.push(chatId);
            }

            cursor = getNextCursor(data);
            page += 1;
        } while (cursor && page < 80);

        if (cursor) throw new Error('정리할 채팅을 전부 불러오지 못했습니다.');
        return chatIds;
    }

    async function fetchSmartAllChats() {
        const chats = [];
        const seen = new Set();
        let cursor = null;
        let page = 0;

        do {
            const params = { limit: API_PAGE_LIMIT };
            if (cursor) params.cursor = cursor;

            const json = await fetchCrackJson('/crack-gen/v3/chats', params);
            const data = json?.data || {};
            const list = Array.isArray(data.chats) ? data.chats : [];

            for (const chat of list) {
                const chatId = chat?._id;
                if (!chatId || seen.has(chatId)) continue;
                seen.add(chatId);
                chats.push(chat);
            }

            cursor = getNextCursor(data);
            page += 1;
        } while (cursor && page < 80);

        if (cursor) throw new Error('전체 채팅을 전부 불러오지 못했습니다.');
        return chats;
    }

    async function fetchSmartFolderChatIds(folder) {
        const chatIds = [];
        const seen = new Set();
        let cursor = null;
        let page = 0;

        do {
            const params = {
                folderId: folder._id,
                limit: API_PAGE_LIMIT
            };
            if (cursor) params.cursor = cursor;

            const json = await fetchCrackJson('/crack-gen/v3/chats', params);
            const data = json?.data || {};
            const chats = Array.isArray(data.chats) ? data.chats : [];

            for (const chat of chats) {
                const chatId = chat?._id;
                if (!chatId || seen.has(chatId)) continue;
                seen.add(chatId);
                chatIds.push(chatId);
            }

            cursor = getNextCursor(data);
            page += 1;
        } while (cursor && page < 80);

        if (cursor) throw new Error(`${cleanText(folder?.name || '보관함')} 내부 채팅을 전부 불러오지 못했습니다.`);
        return chatIds;
    }

    async function fetchSmartArchivedChatIds(existingFolders, onProgress) {
        const folders = existingFolders.filter(folder => folder?._id);
        const pages = await mapSmartWithConcurrency(
            folders,
            SMART_ORGANIZE_LOAD_CONCURRENCY,
            folder => fetchSmartFolderChatIds(folder),
            onProgress
        );

        const archivedChatIds = new Set();
        pages.forEach(chatIds => chatIds.forEach(chatId => archivedChatIds.add(chatId)));
        return archivedChatIds;
    }

    async function fetchSmartRootChats(existingFolders, onProgress) {
        // folderId 없는 호출은 보관함 채팅까지 포함한 전체 목록이다.
        // 모든 실제 보관함의 chatId를 빼면 순정 자동 정리와 무관한 미보관 목록만 남는다.
        const [allChats, archivedChatIds] = await Promise.all([
            fetchSmartAllChats(),
            fetchSmartArchivedChatIds(existingFolders, onProgress)
        ]);
        return allChats.filter(chat => chat?._id && !archivedChatIds.has(chat._id));
    }

    async function fetchSmartSingletonGroups(existingFolders, previewGroups, onProgress) {
        const rootChats = await fetchSmartRootChats(existingFolders, onProgress);
        if (!rootChats.length) return [];
        return buildSmartSingletonGroups(rootChats, existingFolders, previewGroups);
    }

    async function moveSmartChatsToFolder(chatIds, targetFolderId) {
        return requestCrackJson('/crack-gen/chat-folders/chats/move', {
            method: 'PATCH',
            body: {
                chatIds,
                targetFolderId
            }
        });
    }

    async function createSmartFolderWithChats(name, chatIds) {
        return requestCrackJson('/crack-gen/chat-folders', {
            method: 'POST',
            body: {
                name,
                chatIds
            }
        });
    }

    function loadArchiveSearchCache() {
        try {
            const raw = localStorage.getItem(ARCHIVE_SEARCH_CACHE_KEY);
            if (!raw) return false;

            const cached = JSON.parse(raw);
            if (!cached || !Array.isArray(cached.items)) return false;

            archiveSearchState.items = cached.items;
            archiveSearchState.savedAt = Number(cached.savedAt || 0);
            archiveSearchState.loadedChats = archiveSearchState.items.length;
            archiveSearchState.partial = !!cached.partial;
            // v1.0.15 이전 캐시는 totalRootChats에 전체 채팅 수가 들어 있어 재사용하면 안 된다.
            if (cached.countMode === 'root-minus-archive-v1') {
                const cachedArchiveCount = Number(cached.totalArchiveChats);
                const cachedRootCount = Number(cached.totalRootChats);
                const cachedAllCount = Number(cached.totalAllChats);
                if (Number.isFinite(cachedArchiveCount) && cachedArchiveCount >= 0) archiveSearchState.totalArchiveChats = cachedArchiveCount;
                if (Number.isFinite(cachedRootCount) && cachedRootCount >= 0) archiveSearchState.totalRootChats = cachedRootCount;
                if (Number.isFinite(cachedAllCount) && cachedAllCount >= 0) archiveSearchState.totalAllChats = cachedAllCount;
                if (Number.isFinite(archiveSearchState.totalArchiveChats) && Number.isFinite(archiveSearchState.totalRootChats)) {
                    archiveSearchState.countStatus = 'ready';
                }
            }
            archiveSearchState.status = 'ready';
            updateChatCountBadges();

            return true;
        } catch (error) {
            console.warn('[Crack UI] 보관함 검색 캐시 읽기 실패:', error);
            return false;
        }
    }

    function isArchiveSearchCacheFresh() {
        return archiveSearchState.items.length > 0 &&
            archiveSearchState.savedAt > 0 &&
            Date.now() - archiveSearchState.savedAt < ARCHIVE_SEARCH_CACHE_TTL;
    }

    function saveArchiveSearchCache() {
        try {
            localStorage.setItem(ARCHIVE_SEARCH_CACHE_KEY, JSON.stringify({
                savedAt: Date.now(),
                partial: archiveSearchState.partial,
                countMode: 'root-minus-archive-v1',
                totalArchiveChats: archiveSearchState.totalArchiveChats,
                totalRootChats: archiveSearchState.totalRootChats,
                totalAllChats: archiveSearchState.totalAllChats,
                items: archiveSearchState.items
            }));
        } catch (error) {
            console.warn('[Crack UI] 보관함 검색 캐시 저장 실패:', error);
        }
    }

    let archiveFoldersInFlight = null;

    async function fetchRootChats() {
        const items = [];
        const seen = new Set();
        let cursor = null;
        let page = 0;
        let truncated = false;

        do {
            const params = { limit: API_PAGE_LIMIT };
            if (cursor) params.cursor = cursor;

            const json = await fetchCrackJson('/crack-gen/v3/chats', params);
            const data = json?.data || {};
            const chats = Array.isArray(data.chats) ? data.chats : [];

            for (const chat of chats) {
                const mapped = mapArchiveChat(null, chat, 'root');
                if (!mapped || seen.has(mapped.chatId)) continue;
                seen.add(mapped.chatId);
                items.push(mapped);
                if (items.length >= MAX_ARCHIVE_CHATS) {
                    truncated = true;
                    break;
                }
            }

            cursor = getNextCursor(data);
            page += 1;
        } while (cursor && page < 80 && !truncated);

        return {
            items,
            totalCount: items.length,
            truncated: truncated || !!cursor
        };
    }

    async function fetchAllFolders() {
        if (archiveFoldersInFlight) return archiveFoldersInFlight;

        archiveFoldersInFlight = (async () => {
            const folders = [];
            let cursor = null;
            let page = 0;
            let truncated = false;
            let totalChatCount = 0;

            do {
                const params = { limit: API_PAGE_LIMIT };
                if (cursor) params.cursor = cursor;

                const json = await fetchCrackJson('/crack-gen/chat-folders', params);
                const data = json?.data || {};
                const list = Array.isArray(data.folders) ? data.folders : [];

                // 검색 인덱스에 쓸 폴더는 기존 제한까지만 보관하되,
                // 전체 채팅 수는 모든 페이지의 chatCount를 끝까지 합산한다.
                totalChatCount += list.reduce(
                    (sum, folder) => sum + Math.max(0, Number(folder?.chatCount || 0)),
                    0
                );

                if (folders.length < MAX_ARCHIVE_FOLDERS) {
                    folders.push(...list.slice(0, MAX_ARCHIVE_FOLDERS - folders.length));
                }

                cursor = getNextCursor(data);
                page += 1;

                if (folders.length >= MAX_ARCHIVE_FOLDERS && cursor) {
                    truncated = true;
                }
            } while (cursor && page < 30);

            if (cursor) truncated = true;

            return {
                folders,
                totalChatCount,
                truncated
            };
        })();

        try {
            return await archiveFoldersInFlight;
        } finally {
            archiveFoldersInFlight = null;
        }
    }

    async function ensureArchiveCount(force = false) {
        if (archiveSearchState.countStatus === 'loading') {
            // 이동 직전 시작된 집계가 낡은 값으로 끝나더라도, 완료 직후 반드시 한 번 더 읽는다.
            if (force) archiveCountRefreshPending = true;
            return;
        }

        const fresh = archiveSearchState.countUpdatedAt && Date.now() - archiveSearchState.countUpdatedAt < 10000;
        const hasBothCounts = Number.isFinite(archiveSearchState.totalArchiveChats) && Number.isFinite(archiveSearchState.totalRootChats);
        if (!force && fresh && hasBothCounts) return;

        archiveSearchState.countStatus = 'loading';
        // 이미 확인된 숫자는 지우지 않는다. 재수집 중에도 기존 배지가 그대로 남는다.
        updateChatCountBadges();

        try {
            if (!hasAuthToken()) await waitForAuthToken(6000);
            if (!hasAuthToken()) throw new Error('NO_AUTH_TOKEN');

            const [folderResult, rootResult] = await Promise.all([
                fetchAllFolders(),
                fetchRootChats()
            ]);

            // 폴더 조건 없는 /v3/chats 응답은 보관함까지 포함한 전체 목록이다.
            // 따라서 화면의 "채팅 목록" 숫자는 전체에서 보관함 합계를 빼서 분리한다.
            const totalAllChats = Math.max(0, Number(rootResult.totalCount || 0));
            const totalArchiveChats = Math.max(0, Number(folderResult.totalChatCount || 0));
            archiveSearchState.totalArchiveChats = totalArchiveChats;
            archiveSearchState.totalRootChats = Math.max(0, totalAllChats - totalArchiveChats);
            archiveSearchState.totalAllChats = totalAllChats;
            archiveSearchState.countUpdatedAt = Date.now();
            archiveSearchState.countStatus = 'ready';
            saveArchiveSearchCache();
        } catch (error) {
            const hasCachedCount = Number.isFinite(archiveSearchState.totalArchiveChats) || Number.isFinite(archiveSearchState.totalRootChats);
            archiveSearchState.countStatus = hasCachedCount ? 'ready' : 'error';
            console.warn('[Crack UI] 채팅 영역별 개수 로딩 실패:', error);
        } finally {
            updateChatCountBadges();

            if (archiveCountRefreshPending) {
                archiveCountRefreshPending = false;
                setTimeout(() => ensureArchiveCount(true), 250);
            }
        }
    }

    async function fetchFolderChats(folder) {
        const items = [];
        let cursor = null;
        let page = 0;
        let truncated = false;

        do {
            if (archiveSearchState.loadedChats + items.length >= MAX_ARCHIVE_CHATS) {
                truncated = true;
                break;
            }

            const params = {
                folderId: folder._id,
                limit: API_PAGE_LIMIT
            };
            if (cursor) params.cursor = cursor;

            const json = await fetchCrackJson('/crack-gen/v3/chats', params);
            const data = json?.data || {};
            const chats = Array.isArray(data.chats) ? data.chats : [];

            for (const chat of chats) {
                const mapped = mapArchiveChat(folder, chat, 'archive');
                if (mapped) items.push(mapped);

                if (archiveSearchState.loadedChats + items.length >= MAX_ARCHIVE_CHATS) {
                    truncated = true;
                    break;
                }
            }

            cursor = getNextCursor(data);
            page += 1;
        } while (cursor && page < 80 && !truncated);

        return {
            items,
            truncated: truncated || !!cursor
        };
    }

    async function buildArchiveSearchIndex() {
        // 이미 화면에 쓸 수 있는 목록이 있으면, 재인덱싱 도중에는 items를 갈아끼우지 않는다.
        // 중간중간 교체하면 검색 결과 카드가 사라졌다 나타나며 깜빡인다.
        const keepExistingUntilDone = archiveSearchState.items.length > 0;

        archiveSearchState.status = 'indexing';
        archiveSearchState.started = true;
        archiveSearchState.lastError = '';
        archiveSearchState.loadedFolders = 0;
        archiveSearchState.totalFolders = 0;
        archiveSearchState.loadedChats = archiveSearchState.items.length;
        archiveSearchState.partial = false;
        archiveSearchState.lastRenderKey = '';
        scheduleArchiveSearchRender();

        if (!hasAuthToken()) await waitForAuthToken(6000);

        if (!hasAuthToken()) {
            const error = new Error('NO_AUTH_TOKEN');
            error.status = 401;
            throw error;
        }

        const allItems = [];
        let totalAllChatsFromRoot = null;

        // 폴더 조건 없는 일반 호출은 보관함까지 포함한 전체 채팅을 반환한다.
        // 검색 인덱스에는 그대로 넣되, 표시용 채팅 목록 개수는 폴더 합계를 받은 뒤 계산한다.
        try {
            const rootResult = await fetchRootChats();
            allItems.push(...rootResult.items);
            archiveSearchState.partial = archiveSearchState.partial || rootResult.truncated;
            totalAllChatsFromRoot = Math.max(0, Number(rootResult.totalCount || 0));
            archiveSearchState.loadedChats = Math.min(allItems.length, MAX_ARCHIVE_CHATS);

            if (!keepExistingUntilDone) {
                archiveSearchState.items = allItems.slice(0, MAX_ARCHIVE_CHATS);
                archiveSearchState.lastRenderKey = '';
            }
            scheduleArchiveSearchRender();
        } catch (error) {
            archiveSearchState.partial = true;
            console.warn('[Crack UI] 일반 채팅 목록 로딩 실패:', error);
        }

        // 보관함 목록 및 내부 채팅 인덱싱
        const folderResult = await fetchAllFolders();
        const folders = folderResult.folders.filter(folder => folder && folder._id && Number(folder.chatCount || 0) > 0);

        const totalArchiveChats = Math.max(0, Number(folderResult.totalChatCount || 0));
        const totalAllChats = Number.isFinite(totalAllChatsFromRoot)
            ? totalAllChatsFromRoot
            : Math.max(0, Number(archiveSearchState.totalAllChats || 0));
        archiveSearchState.totalArchiveChats = totalArchiveChats;
        archiveSearchState.totalRootChats = Math.max(0, totalAllChats - totalArchiveChats);
        archiveSearchState.totalAllChats = totalAllChats;
        archiveSearchState.countUpdatedAt = Date.now();
        archiveSearchState.countStatus = 'ready';
        updateChatCountBadges();

        archiveSearchState.totalFolders = folders.length;
        archiveSearchState.partial = archiveSearchState.partial || folderResult.truncated;
        archiveSearchState.loadedFolders = 0;
        archiveSearchState.lastRenderKey = '';
        scheduleArchiveSearchRender();

        let cursor = 0;

        async function worker() {
            while (cursor < folders.length && allItems.length < MAX_ARCHIVE_CHATS) {
                const folder = folders[cursor++];

                try {
                    const result = await fetchFolderChats(folder);
                    allItems.push(...result.items);
                    archiveSearchState.partial = archiveSearchState.partial || result.truncated;
                } catch (error) {
                    archiveSearchState.partial = true;
                    console.warn('[Crack UI] 보관함 내부 채팅 로딩 실패:', folder?.name, error);
                } finally {
                    archiveSearchState.loadedFolders += 1;
                    archiveSearchState.loadedChats = Math.min(allItems.length, MAX_ARCHIVE_CHATS);

                    if (!keepExistingUntilDone) {
                        archiveSearchState.items = allItems.slice(0, MAX_ARCHIVE_CHATS);
                        archiveSearchState.lastRenderKey = '';
                    }

                    scheduleArchiveSearchRender();
                    await delay(40);
                }
            }
        }

        const workers = Array.from({ length: Math.min(API_CONCURRENCY, Math.max(1, folders.length)) }, () => worker());
        await Promise.all(workers);

        // 같은 채팅이 여러 경로로 잡혔을 때 중복 제거.
        // 같은 chatId가 일반 목록과 보관함 내부에 모두 있으면 보관함 내부 쪽을 우선한다.
        const unique = new Map();
        for (const item of allItems) {
            const prev = unique.get(item.chatId);
            if (!prev || (prev.source === 'root' && item.source === 'archive')) {
                unique.set(item.chatId, item);
            }
        }

        archiveSearchState.items = Array.from(unique.values()).slice(0, MAX_ARCHIVE_CHATS);
        archiveSearchState.loadedChats = archiveSearchState.items.length;
        archiveSearchState.status = 'ready';
        archiveSearchState.refreshedThisPage = true;
        archiveSearchState.savedAt = Date.now();
        archiveSearchState.inFlight = null;
        archiveSearchState.lastRenderKey = '';
        saveArchiveSearchCache();
        scheduleArchiveSearchRender();

        return archiveSearchState.items;
    }

    function ensureArchiveSearchIndex() {
        // 캐시가 있어도 페이지당 한 번은 뒤에서 새로 긁어온다.
        if (isArchiveSearchCacheFresh() && archiveSearchState.refreshedThisPage) {
            return Promise.resolve(archiveSearchState.items);
        }
        if (archiveSearchState.inFlight) return archiveSearchState.inFlight;

        // 인덱싱이 실패한 직후에는 잠깐 쉬어간다.
        // 실패할 때마다 글자 하나 칠 때마다 전체 재수집이 돌면서 결과가 깜빡이는 문제를 막는다.
        if (archiveSearchState.lastFailedAt && Date.now() - archiveSearchState.lastFailedAt < 15000) {
            return Promise.resolve(archiveSearchState.items);
        }

        const hadFreshCache = isArchiveSearchCacheFresh();

        archiveSearchState.inFlight = buildArchiveSearchIndex().then(items => {
            archiveSearchState.refreshedThisPage = true;
            archiveSearchState.lastFailedAt = 0;
            return items;
        }).catch(error => {
            archiveSearchState.status = archiveSearchState.items.length ? 'ready' : 'error';
            archiveSearchState.lastFailedAt = Date.now();

            if (error?.message === 'NO_AUTH_TOKEN') {
                archiveSearchState.lastError = '인증 토큰을 아직 못 잡았어. 채팅방을 아무거나 한 번 열었다 나오면 검색이 켜져.';
            } else if (error?.status === 401) {
                archiveSearchState.lastError = '인증 토큰이 거절됐어. 새로고침 후 채팅방을 한 번 열고 다시 검색해줘.';
            } else {
                archiveSearchState.lastError = String(error?.message || error);
            }

            archiveSearchState.inFlight = null;
            archiveSearchState.lastRenderKey = '';
            console.warn('[Crack UI] 보관함 검색 인덱싱 실패:', error);
            scheduleArchiveSearchRender();
            return archiveSearchState.items;
        });

        // 신선한 캐시가 있으면 기존 결과는 바로 보여주고, 새 인덱싱은 뒤에서 갱신한다.
        if (hadFreshCache) return Promise.resolve(archiveSearchState.items);
        return archiveSearchState.inFlight;
    }

    function getCurrentSearchQuery() {
        const input = document.querySelector('.crack-search-input');

        // 여기서는 절대 input.value를 되돌려 쓰지 않는다. 복구는 syncSearchInputFromState 전담.
        if (input && !isSearchComposing && input === lastSearchInputEl) {
            currentSearchQueryRaw = input.value || '';
        }

        return normalizeSearchText(currentSearchQueryRaw);
    }

    function scheduleArchiveSearchRender() {
        if (archiveSearchRenderRaf) return;

        archiveSearchRenderRaf = requestAnimationFrame(() => {
            archiveSearchRenderRaf = 0;
            renderArchiveSearchResults(getCurrentSearchQuery());
        });
    }

    function getArchiveSearchMatches(query) {
        if (!query) return [];

        const matches = [];
        const seen = new Set();

        for (const item of archiveSearchState.items) {
            if (!item || seen.has(item.chatId)) continue;

            // 검색 기준: 채팅방 제목 + 스토리(캐릭터)명
            const haystack = `${item.title || ''} ${item.storyName || ''}`;
            if (textMatchesQuery(haystack, query)) {
                seen.add(item.chatId);
                matches.push(item);
                if (matches.length >= MAX_ARCHIVE_RESULTS) break;
            }
        }

        return matches;
    }

    // 상태 문구가 인덱싱 진행에 맞춰 0.1초마다 바뀌면 글자 길이가 계속 달라져 깜빡이는 것처럼 보인다.
    // 같은 문구는 무시하고, 갱신도 최소 간격을 둔다.
    const STATUS_UPDATE_MIN_INTERVAL = 600;
    let lastStatusText = '';
    let lastStatusAt = 0;
    let statusPendingTimer = null;

    function setStatusText(message, visible = true) {
        const { status } = getSearchOverlayParts();
        if (!status) return;

        const text = message || '';

        const apply = () => {
            statusPendingTimer = null;
            lastStatusText = text;
            lastStatusAt = Date.now();
            status.textContent = text;
            status.classList.toggle('visible', !!visible && !!text);
        };

        // 검색어를 지운 경우(빈 문구)는 즉시 반영한다.
        if (!text) {
            clearTimeout(statusPendingTimer);
            statusPendingTimer = null;
            apply();
            return;
        }

        if (text === lastStatusText) {
            status.classList.toggle('visible', !!visible);
            return;
        }

        const remain = STATUS_UPDATE_MIN_INTERVAL - (Date.now() - lastStatusAt);
        clearTimeout(statusPendingTimer);

        if (remain <= 0) {
            apply();
        } else {
            statusPendingTimer = setTimeout(apply, remain);
        }
    }

    function renderArchiveSearchResults(query) {
        const { overlay, results: resultsBox, status: statusBox } = getSearchOverlayParts();
        if (!overlay || !resultsBox || !statusBox) return;

        const normalizedQuery = normalizeSearchText(query);

        if (!normalizedQuery) {
            archiveSearchState.lastRenderKey = '';
            archiveSearchState.lastResultKey = '';
            resultsBox.classList.remove('visible');
            resultsBox.replaceChildren();
            setStatusText('', false);
            setSearchOverlayActive(false);
            cleanupLegacySearchModeArtifacts();
            return;
        }

        setSearchOverlayActive(true);

        const matches = getArchiveSearchMatches(normalizedQuery);
        const rootMatches = matches.filter(item => item.source === 'root');
        const archiveMatches = matches.filter(item => item.source !== 'root');

        // 상태 문구는 매 렌더마다 갱신하되, 결과 카드 DOM 재생성 조건과 분리한다.
        // 인덱싱 진행 숫자만 바뀔 때 카드 전체가 replaceChildren() 되며 깜빡이는 문제를 막기 위함.
        let statusText = '';
        if (archiveSearchState.status === 'indexing') {
            // 진행 숫자를 실시간으로 찍지 않는다. 문구가 고정되어야 깜빡임이 없다.
            statusText = archiveSearchState.items.length
                ? '검색 결과 갱신 중'
                : '검색 목록 준비 중';
        } else if (archiveSearchState.status === 'ready') {
            const suffix = archiveSearchState.partial ? ' · 최대 수집 한도 적용' : '';
            statusText = `${archiveSearchState.loadedChats.toLocaleString()}개 채팅에서 검색${suffix}`;
        } else if (archiveSearchState.status === 'error') {
            statusText = archiveSearchState.items.length
                ? `${archiveSearchState.loadedChats.toLocaleString()}개 캐시에서 검색 · 최신화 실패`
                : `검색 준비 실패: ${archiveSearchState.lastError || '알 수 없는 오류'}`;
        } else {
            statusText = '검색 목록 준비 중';
        }

        setStatusText(statusText, true);

        // 결과 카드는 실제 매치 목록이 바뀔 때만 다시 그린다.
        // loadedFolders/loadedChats 같은 진행 상태는 resultKey에 넣지 않는다.
        const resultKey = `${normalizedQuery}|` + matches.map(item => `${item.source}:${item.chatId}`).join(',');
        if (archiveSearchState.lastResultKey === resultKey) return;
        archiveSearchState.lastResultKey = resultKey;

        resultsBox.replaceChildren();

        if (matches.length === 0) {
            resultsBox.classList.remove('visible');
            return;
        }

        function appendGroup(label, items) {
            if (!items.length) return;

            const header = document.createElement('div');
            header.className = 'crack-api-result-header';
            header.textContent = `${label} ${items.length}개`;
            resultsBox.appendChild(header);

            items.forEach(item => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'crack-api-result-item';
                btn.title = `${item.folderName} / ${item.title}`;
                btn.addEventListener('click', () => {
                    if (item.href) location.href = item.href;
                });

                const thumb = document.createElement('span');
                thumb.className = 'crack-api-result-thumb';
                if (item.imageUrl) {
                    const img = document.createElement('img');
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    img.src = item.imageUrl;
                    thumb.appendChild(img);
                }

                const main = document.createElement('span');
                main.className = 'crack-api-result-main';

                const title = document.createElement('span');
                title.className = 'crack-api-result-title';
                title.textContent = item.title || '제목 없음';

                const meta = document.createElement('span');
                meta.className = 'crack-api-result-meta';
                if (item.source === 'root') {
                    meta.textContent = `채팅 목록${item.updatedAt ? ' · ' + formatArchiveDate(item.updatedAt) : ''}`;
                } else {
                    meta.textContent = `${item.folderName || '보관함'}${item.updatedAt ? ' · ' + formatArchiveDate(item.updatedAt) : ''}`;
                }

                main.appendChild(title);
                main.appendChild(meta);

                btn.appendChild(thumb);
                btn.appendChild(main);
                resultsBox.appendChild(btn);
            });
        }

        appendGroup('보관함', archiveMatches);
        appendGroup('채팅 목록', rootMatches);

        resultsBox.classList.add('visible');
    }

    function handleArchiveSearchQuery(query) {
        const normalizedQuery = normalizeSearchText(query);
        renderArchiveSearchResults(normalizedQuery);

        if (normalizedQuery) {
            ensureArchiveSearchIndex();
        }
    }

    // 검색 중에는 기존 사이드바 DOM을 숨기거나 필터링하지 않는다.
    //          검색 결과 fixed overlay만 갱신해서 타자 끊김과 레이아웃 충돌을 줄인다.
    function filterChatsAndFolders(query) {
        const normalizedQuery = normalizeSearchText(query || '');

        if (!normalizedQuery) {
            handleArchiveSearchQuery('');
            cleanupLegacySearchModeArtifacts();
            return;
        }

        handleArchiveSearchQuery(normalizedQuery);
    }

    function refreshChatItem(container) {
        const id = getChatId(container);
        if (!id) return;

        container.classList.add('crack-chat-item');
        container.dataset.crackChatId = id;

        let saved = null;
        try {
            saved = localStorage.getItem(STORAGE_KEY + id);
        } catch (e) {
            console.warn("[Crack UI] LocalStorage 읽기 실패:", e);
        }

        const current = isCurrentChat(container);
        const theme = document.body.getAttribute('data-theme') || 'dark';
        const visualKey = `${id}|${saved || ''}|${current ? '1' : '0'}|${theme}`;

        if (chatVisualCache.get(container) !== visualKey) {
            applyVisualColor(container, saved || null);
            markCurrentChat(container);
            chatVisualCache.set(container, visualKey);
        }

        setupMarquee(container);
    }

    // 핵심 통합 UI 리프레시 엔진 (React 렌더링 동시성 제어)
    function updateUI() {
        if (isUpdatingUI) return;

        // 열린 Radix 메뉴의 포커스/선택 수명주기를 보존한다.
        // 메뉴가 닫힌 뒤 실제 목록 변화가 생기면 MutationObserver가 다시 갱신한다.
        if (isChatMenuOpen()) return;

        isUpdatingUI = true;

        try {
            // 1. 검색창 및 보관함/채팅 목록 개수 주입
            injectSearchBar();
            ensureArchiveCount();
            scheduleSearchOverlayPositionUpdate();

            // 2. 채팅방/보관함 컬러 세팅 및 커스텀 UI 적용
            getChatContainers().forEach(refreshChatItem);

            // 3. 보관함 높이 리사이저 핸들 세팅
            setupResizer();

            // 4. 검색 필터 유지 보완
            const searchInput = document.querySelector('.crack-search-input');
            if (searchInput) {
                syncSearchInputFromState(searchInput, document.querySelector('.crack-search-clear'));
                const query = getCurrentSearchQuery();

                // 검색 중 MutationObserver가 계속 updateUI를 부르며 타자를 끊지 않도록,
                // 실제 검색 적용은 입력 디바운스 타이머에 맡긴다.
                if (!query) {
                    filterChatsAndFolders('');
                } else if (!searchDebounceTimer) {
                    scheduleSearchQueryApply(SEARCH_DEBOUNCE_MS);
                }
            }
        } catch (error) {
            console.error("[Crack UI] updateUI 과정 중 오류 발생:", error);
        } finally {
            isUpdatingUI = false;
        }
    }

    function scheduleUpdate() {
        clearTimeout(updateTimer);
        updateTimer = setTimeout(updateUI, 80);
    }

    function setupResizer() {
        const { divider, archiveContainer } = getArchivePartsCached();
        if (!divider || !archiveContainer) return;

        // 매번 빠르게 재적용한다. divider가 이미 핸들 처리되어 있어도 새 컨테이너가 생길 수 있다.
        const savedHeight = readSavedArchiveHeight() || ARCHIVE_HEIGHT_DEFAULT;
        applyArchiveScrollBox(archiveContainer, savedHeight);

        if (divider.classList.contains('crack-resizer-handle')) return;

        divider.classList.add('crack-resizer-handle');

        divider.addEventListener('mousedown', e => {
            e.preventDefault();

            const liveContainer = isLiveArchiveContainer(cachedArchiveContainer)
                ? cachedArchiveContainer
                : getArchivePartsCached().archiveContainer;
            if (!liveContainer) return;

            const startY = e.clientY;
            const startH = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--crack-archive-h'), 10) ||
                liveContainer.offsetHeight ||
                ARCHIVE_HEIGHT_DEFAULT;

            const onMouseMove = ev => {
                const newH = Math.max(ARCHIVE_HEIGHT_MIN, startH + (ev.clientY - startY));
                setArchiveHeightValue(newH);
                applyArchiveScrollBox(liveContainer, newH);
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove, true);
                document.removeEventListener('mouseup', onMouseUp, true);
            };

            document.addEventListener('mousemove', onMouseMove, true);
            document.addEventListener('mouseup', onMouseUp, true);
        }, true);
    }

    let lastKnownPathname = location.pathname;
    let countRefreshTimer = null;
    let countFollowupTimer = null;

    function scheduleCountRefresh(force = true) {
        clearTimeout(countRefreshTimer);
        clearTimeout(countFollowupTimer);

        countRefreshTimer = setTimeout(() => {
            countRefreshTimer = null;
            ensureArchiveCount(force);

            // 생성/이동 직후 서버 집계 반영이 늦는 경우를 위해 한 번 더 확인한다.
            countFollowupTimer = setTimeout(() => {
                countFollowupTimer = null;
                ensureArchiveCount(true);
            }, 2200);
        }, 700);
    }

    // 실시간 페이지 변화(DOM Mutation) 감시
    const observer = new MutationObserver(mutations => {
        const onlyIgnoredMutation = mutations.every(mutation => {
            if (isInsideSearchOverlay(mutation.target)) return true;
            if (isInsideSmartOrganize(mutation.target)) return true;
            const addedNodes = Array.from(mutation.addedNodes || []);
            if (addedNodes.length && addedNodes.every(node => isInsideSearchOverlay(node))) return true;
            if (addedNodes.length && addedNodes.every(node => isInsideSmartOrganize(node))) return true;
            return isMenuOnlyMutation(mutation);
        });

        if (!onlyIgnoredMutation) {
            const pathnameChanged = location.pathname !== lastKnownPathname;
            if (pathnameChanged) {
                lastKnownPathname = location.pathname;
                scheduleCountRefresh(true);
            }

            const chatLinkChanged = mutations.some(mutation =>
                [...Array.from(mutation.addedNodes || []), ...Array.from(mutation.removedNodes || [])].some(node =>
                    node instanceof HTMLElement && (
                        node.matches?.('a[href*="/episodes"], a[href*="/stories"]') ||
                        node.querySelector?.('a[href*="/episodes"], a[href*="/stories"]')
                    )
                )
            );
            if (chatLinkChanged) scheduleCountRefresh(true);

            const touchedArchiveCache = mutations.some(mutation => {
                if (!(cachedArchiveContainer instanceof HTMLElement)) return false;
                return Array.from(mutation.removedNodes || []).some(node =>
                    node instanceof HTMLElement && (node === cachedArchiveContainer || node.contains(cachedArchiveContainer))
                );
            });
            if (touchedArchiveCache) resetArchiveCache();

            // React가 헤더를 다시 그려 배지를 지운 경우 80ms updateUI를 기다리지 않고 즉시 복구한다.
            updateChatCountBadges();

            // 채팅방 이동 등으로 사이드바가 재렌더링될 때 저장된 보관함 높이를 즉시 재적용한다.
            // 기존 80ms 지연 updateUI 전에 한 번 먹여서 깜빡임을 줄인다.
            scheduleArchiveHeightFastApply();
            scheduleUpdate();
        }

        mutations.forEach(mutation => {
            if (
                mutation.type === 'attributes' &&
                mutation.attributeName === 'data-theme' &&
                mutation.target === document.body
            ) {
                updateUI();
                return;
            }

            mutation.addedNodes.forEach(node => {
                if (!(node instanceof HTMLElement)) return;

                const menus = new Set();

                if (node.matches?.('[role="menu"]')) {
                    menus.add(node);
                }

                node.querySelectorAll?.('[role="menu"]').forEach(menu => {
                    menus.add(menu);
                });

                const closestMenu = node.closest?.('[role="menu"]');
                if (closestMenu) menus.add(closestMenu);

                menus.forEach(menu => {
                    setTimeout(() => {
                        injectPalette(menu);
                        injectSmartAutoOrganizeMenu(menu);
                    }, 0);
                });
            });
        });
    });

    // 핫픽스: DOM이 완전히 빌드되기 전 observer가 실행되어 스크립트 전체가 사망하는 구조적 결함 원천 해결
    function init() {
        if (!document.body) {
            setTimeout(init, 50);
            return;
        }

        loadArchiveSearchCache();
        cleanupLegacySearchModeArtifacts(true);
        applySavedArchiveHeightFast();
        window.addEventListener('resize', scheduleSearchOverlayPositionUpdate, { passive: true });
        window.addEventListener('scroll', scheduleSearchOverlayPositionUpdate, true);

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-theme']
        });

        setTimeout(updateUI, 300);
        setTimeout(updateUI, 1000);
        setInterval(() => ensureArchiveCount(false), 30000);
    }

    init();
})();