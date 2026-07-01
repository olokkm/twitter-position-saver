// ==UserScript==
// @name         Twitter/X Timeline Position Saver
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Remembers where you stopped scrolling on the X timeline and jumps back there on your next visit.
// @author       zaengerlein
// @license      MIT
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @noframes
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        maxAgeMinutes: 180,       // ignore a saved position older than this
        saveIntervalMs: 2000,     // how often the current position is stored
        scrollStepDelayMs: 300,   // pause between scroll steps while searching
        maxScrollAttempts: 150,   // give up searching after this many scroll steps
        autoRestore: true         // jump back automatically when the timeline loads
    };

    const DEBUG = false;

    const STORAGE_PREFIX = 'tps_';

    function gmGet(key) {
        if (typeof GM_getValue !== 'undefined') {
            return GM_getValue(key);
        }
        try {
            const value = localStorage.getItem(STORAGE_PREFIX + key);
            return value === null ? undefined : JSON.parse(value);
        } catch {
            return undefined;
        }
    }

    function gmSet(key, value) {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue(key, value);
            return;
        }
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    }

    const KEY_TWEET_ID = 'tweet_id';
    const KEY_TIMESTAMP = 'timestamp';
    const KEY_PATH = 'path';
    const KEY_TAB_INDEX = 'tab_index';
    const KEY_TAB_LABEL = 'tab_label';

    const BUTTON_ID = 'timeline-saver-button';

    function log(...args) {
        if (DEBUG) console.log('[Timeline Saver]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ============ PAGE HELPERS ============

    function currentPath() {
        return location.pathname;
    }

    function isTimelinePage() {
        const p = currentPath();
        return p === '/' ||
            p === '/home' ||
            p === '/i/bookmarks' ||
            p.startsWith('/search') ||
            /^\/i\/lists\/\d+$/.test(p) ||
            /^\/[^/]+$/.test(p) ||
            /^\/[^/]+\/(with_replies|media|likes|highlights)$/.test(p);
    }

    function extractTweetId(article) {
        const link = article.querySelector('a[href*="/status/"]');
        const match = link && link.href.match(/\/status\/(\d+)/);
        return match ? match[1] : null;
    }

    // Id of the topmost tweet sitting in the upper half of the viewport.
    function getTopTweetId() {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (const article of articles) {
            const rect = article.getBoundingClientRect();
            if (rect.top >= 0 && rect.top < window.innerHeight * 0.5) {
                const id = extractTweetId(article);
                if (id) return id;
            }
        }
        return null;
    }

    function findTweetById(id) {
        const links = document.querySelectorAll(`a[href*="/status/${id}"]`);
        for (const link of links) {
            const article = link.closest('article[data-testid="tweet"]');
            if (article) return article;
        }
        return null;
    }

    // ============ NAVIGATION TABS (For you / Following / ...) ============

    function getTabLabel(tab) {
        const span = tab.querySelector('span');
        if (span && span.textContent.trim()) return span.textContent.trim();
        const text = (tab.innerText || tab.textContent || '').trim();
        return text || tab.getAttribute('aria-label') || null;
    }

    // Several tablists exist on the page; pick the one that looks like the timeline tab bar.
    function scoreTablist(tablist) {
        const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
        const labels = tabs.map(getTabLabel).filter(Boolean);
        if (labels.length < 2) return -1;

        let score = labels.length;
        if (tabs.some(t => t.getAttribute('aria-selected') === 'true')) score += 5;

        const column = document.querySelector('[data-testid="primaryColumn"]');
        if (column) {
            if (column.contains(tablist)) {
                score += 10;
            } else {
                // On mobile the tab bar sits just above the timeline column.
                const t = tablist.getBoundingClientRect();
                const c = column.getBoundingClientRect();
                if (t.bottom <= c.top + 120 && t.top >= c.top - 160) score += 12;
            }
        }
        return score;
    }

    function getNavigationTabs() {
        let best = [];
        let bestScore = -1;
        document.querySelectorAll('[role="tablist"], [data-testid="ScrollSnap-List"]').forEach(list => {
            const score = scoreTablist(list);
            if (score > bestScore) {
                bestScore = score;
                best = Array.from(list.querySelectorAll('[role="tab"]'));
            }
        });
        return best;
    }

    function getCurrentTab() {
        const tabs = getNavigationTabs();
        for (let i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('aria-selected') === 'true') {
                return { index: i, label: getTabLabel(tabs[i]) };
            }
        }
        return null;
    }

    function switchToTab(target) {
        if (!target || (target.index == null && target.label == null)) return true;

        const tabs = getNavigationTabs();
        const current = getCurrentTab();
        if (current && (current.index === target.index || current.label === target.label)) {
            return true;
        }
        if (target.index != null && tabs[target.index]) {
            tabs[target.index].click();
            return true;
        }
        if (target.label) {
            const tab = tabs.find(t => getTabLabel(t) === target.label);
            if (tab) {
                tab.click();
                return true;
            }
        }
        return false;
    }

    // ============ SAVE / RESTORE ============

    function savePosition() {
        if (!isTimelinePage()) return;
        const id = getTopTweetId();
        if (!id) return;

        const tab = getCurrentTab();
        gmSet(KEY_TWEET_ID, id);
        gmSet(KEY_TIMESTAMP, Date.now());
        gmSet(KEY_PATH, currentPath());
        gmSet(KEY_TAB_INDEX, tab ? tab.index : null);
        gmSet(KEY_TAB_LABEL, tab ? tab.label : null);
        log('Saved', id, 'tab', tab);
    }

    function readSavedPosition() {
        const id = gmGet(KEY_TWEET_ID);
        const timestamp = gmGet(KEY_TIMESTAMP);
        if (!id || !timestamp) return null;
        return {
            tweetId: id,
            timestamp,
            path: gmGet(KEY_PATH),
            tabIndex: gmGet(KEY_TAB_INDEX),
            tabLabel: gmGet(KEY_TAB_LABEL)
        };
    }

    let currentAbort = null;

    function abortRestore() {
        if (currentAbort) currentAbort.aborted = true;
    }

    function highlight(tweet) {
        tweet.style.transition = 'box-shadow 0.3s ease';
        tweet.style.boxShadow = '0 0 0 3px #1d9bf0';
        setTimeout(() => { tweet.style.boxShadow = ''; }, 2000);
    }

    async function restore(saved, { force = false } = {}) {
        if (!saved) return;

        if (!force) {
            const ageMinutes = (Date.now() - saved.timestamp) / 60000;
            if (ageMinutes > CONFIG.maxAgeMinutes) {
                log('Saved position too old:', ageMinutes.toFixed(1), 'min');
                return;
            }
        }
        if (saved.path && saved.path !== currentPath()) {
            log('Saved position is on a different page, skipping');
            return;
        }

        abortRestore();
        const ctrl = { aborted: false };
        currentAbort = ctrl;

        if (switchToTab({ index: saved.tabIndex, label: saved.tabLabel })) {
            await sleep(700);
        }
        if (ctrl.aborted) return;

        window.scrollTo(0, 0);
        await sleep(800);
        if (ctrl.aborted) return;

        for (let attempt = 0; attempt < CONFIG.maxScrollAttempts && !ctrl.aborted; attempt++) {
            const tweet = findTweetById(saved.tweetId);
            if (tweet) {
                tweet.scrollIntoView({ behavior: 'smooth', block: 'center' });
                highlight(tweet);
                log('Restored to', saved.tweetId);
                break;
            }
            window.scrollBy(0, window.innerHeight);
            await sleep(CONFIG.scrollStepDelayMs);
        }

        if (currentAbort === ctrl) currentAbort = null;
    }

    async function waitForTimeline(maxWaitMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            if (!isTimelinePage()) return false;
            if (document.querySelector('article[data-testid="tweet"]') || getNavigationTabs().length) {
                return true;
            }
            await sleep(400);
        }
        return false;
    }

    // ============ UI: SINGLE "JUMP BACK" BUTTON ============

    // Snapshot taken at page load so the button always returns to where the
    // previous session ended, even after the interval starts overwriting it.
    let restoreTarget = null;

    function createButton() {
        if (document.getElementById(BUTTON_ID)) return true;
        if (!document.body) return false;

        const btn = document.createElement('button');
        btn.id = BUTTON_ID;
        btn.type = 'button';
        btn.textContent = '📍';
        btn.title = 'Jump back to where you left off';
        btn.style.cssText = `
            position: fixed;
            bottom: ${window.innerWidth <= 500 ? '90px' : '150px'};
            right: 20px;
            width: 46px;
            height: 46px;
            border: none;
            border-radius: 50%;
            background: #1d9bf0;
            color: #fff;
            font-size: 20px;
            cursor: pointer;
            z-index: 99999;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        btn.addEventListener('click', () => {
            restore(restoreTarget || readSavedPosition(), { force: true });
        });
        document.body.appendChild(btn);
        return true;
    }

    function ensureButton() {
        if (createButton()) return;
        const observer = new MutationObserver(() => {
            if (createButton()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 30000);
    }

    // ============ INIT ============

    let started = false;

    function setupListeners() {
        window.addEventListener('beforeunload', () => {
            abortRestore();
            savePosition();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                abortRestore();
                savePosition();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') abortRestore();
        });
    }

    async function start() {
        if (started) return;
        started = true;

        log('started on', location.href);
        ensureButton();
        setupListeners();

        restoreTarget = readSavedPosition();

        const ready = await waitForTimeline();
        if (ready && CONFIG.autoRestore) {
            await restore(restoreTarget);
        }

        setInterval(savePosition, CONFIG.saveIntervalMs);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
