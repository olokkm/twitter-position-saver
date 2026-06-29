// ==UserScript==
// @name         Twitter/X Timeline Position Saver
// @namespace    http://tampermonkey.net/
// @version      2.7
// @description  A Tampermonkey script that saves your timeline position and returns to it on demand
// @author       zaengerlein
// @license      MIT
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @updateURL    https://raw.githubusercontent.com/zaengerlein/twitter-position-saver/main/twitter-position-saver.user.js
// @downloadURL  https://raw.githubusercontent.com/zaengerlein/twitter-position-saver/main/twitter-position-saver.user.js
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ============ KONFIGURATION ============
    const CONFIG = {
        // Zeitspanne in Minuten, innerhalb derer die Position wiederhergestellt wird
        maxAgeMinutes: 60,

        // Wie oft die aktuelle Position gespeichert wird (in ms)
        saveIntervalMs: 2000,

        // Pause zwischen Scroll-Schritten beim Suchen (in ms)
        // Muss lang genug sein damit Twitter neue Tweets laden kann
        scrollStepDelayMs: 300,

        // Scroll-Schrittweite in Pixeln (nicht mehr verwendet, scrollt jetzt zum Seitenende)
        scrollStepPx: 800,

        // Maximale Scroll-Versuche bevor aufgegeben wird
        maxScrollAttempts: 150,

        // Benachrichtigung anzeigen?
        showNotifications: true,

        // Debug-Modus (mehr Console-Ausgaben)
        debug: true
    };

    // ============ STORAGE KEYS ============
    // Automatische Position
    const STORAGE_KEY_TWEET_ID = 'twitter_last_tweet_id';
    const STORAGE_KEY_TIMESTAMP = 'twitter_last_timestamp';
    const STORAGE_KEY_PATH = 'twitter_last_path';

    // Manuelle Position (Lesezeichen)
    const STORAGE_KEY_MANUAL_TWEET_ID = 'twitter_manual_tweet_id';
    const STORAGE_KEY_MANUAL_TIMESTAMP = 'twitter_manual_timestamp';
    const STORAGE_KEY_MANUAL_PATH = 'twitter_manual_path';
    const STORAGE_KEY_MANUAL_TAB = 'twitter_manual_tab';

    // ============ SCROLL ABORT CONTROLLER ============
    let currentScrollAbort = null;
    const BUTTONS_CONTAINER_ID = 'timeline-saver-buttons';

    function abortCurrentScroll() {
        if (currentScrollAbort) {
            currentScrollAbort.aborted = true;
            log('Scroll-Vorgang abgebrochen');
        }
    }

    // ============ HILFSFUNKTIONEN ============

    function log(...args) {
        if (CONFIG.debug) {
            console.log('[Timeline Saver]', ...args);
        }
    }

    function showNotification(message, type = 'info') {
        if (!CONFIG.showNotifications) return;

        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 70px;
            left: 50%;
            transform: translateX(-50%);
            padding: 12px 24px;
            border-radius: 8px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            font-weight: 500;
            z-index: 10000;
            opacity: 0;
            transition: opacity 0.3s ease;
            ${type === 'success'
                ? 'background: #1d9bf0; color: white;'
                : type === 'error'
                ? 'background: #f4212e; color: white;'
                : 'background: #333; color: white;'}
        `;

        document.body.appendChild(notification);

        // Fade in
        requestAnimationFrame(() => {
            notification.style.opacity = '1';
        });

        // Fade out und entfernen
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    function getCurrentPath() {
        return window.location.pathname;
    }

    function isTimelinePage() {
        const path = getCurrentPath();
        // Home Timeline
        if (path === '/home' || path === '/') return true;
        // Profil-Hauptseite (z.B. /username)
        if (path.match(/^\/[^/]+$/)) return true;
        // Profil-Tabs (z.B. /username/with_replies, /username/media, /username/likes)
        if (path.match(/^\/[^/]+\/(with_replies|media|likes|highlights)$/)) return true;
        // Search
        if (path.startsWith('/search')) return true;
        // Bookmarks
        if (path === '/i/bookmarks') return true;
        // Lists
        if (path.match(/^\/i\/lists\/\d+$/)) return true;
        
        return false;
    }

    function extractTweetId(article) {
        // Suche nach dem Status-Link im Article
        const statusLink = article.querySelector('a[href*="/status/"]');
        if (statusLink) {
            const match = statusLink.href.match(/\/status\/(\d+)/);
            if (match) return match[1];
        }
        return null;
    }

    function getVisibleTweets() {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        const visible = [];

        articles.forEach(article => {
            const rect = article.getBoundingClientRect();
            // Tweet ist sichtbar wenn er im oberen Drittel des Viewports ist
            if (rect.top >= 0 && rect.top < window.innerHeight * 0.5) {
                const tweetId = extractTweetId(article);
                if (tweetId) {
                    visible.push({ article, tweetId, top: rect.top });
                }
            }
        });

        return visible;
    }

    function findTweetById(tweetId) {
        const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
        for (const link of links) {
            const article = link.closest('article[data-testid="tweet"]');
            if (article) return article;
        }
        return null;
    }

    // ============ NAVIGATION TABS ============

    function getTabLabel(tab) {
        const span = tab.querySelector('span');
        if (span && span.textContent.trim()) {
            return span.textContent.trim();
        }
        // X puts "For you" directly in the tab without a span
        const text = (tab.innerText || tab.textContent || '').trim();
        if (text) return text;
        return tab.getAttribute('aria-label') || null;
    }

    function getNavigationTabs() {
        const selectors = [
            'nav[role="navigation"] div[role="tablist"]',
            '[data-testid="ScrollSnap-List"]',
            '[role="tablist"]'
        ];

        for (const selector of selectors) {
            for (const navContainer of document.querySelectorAll(selector)) {
                const tabs = navContainer.querySelectorAll('a[role="tab"], div[role="tab"]');
                if (tabs.length < 2) continue;

                const labels = Array.from(tabs).map(getTabLabel);
                if (labels.some(label => label === 'For you' || label === 'Following')) {
                    return Array.from(tabs);
                }
            }
        }

        return [];
    }

    function getCurrentTabName() {
        const tabs = getNavigationTabs();
        for (const tab of tabs) {
            if (tab.getAttribute('aria-selected') === 'true') {
                return getTabLabel(tab);
            }
        }
        return null;
    }

    function clickTab(tabName) {
        if (!tabName) return false;

        const tabs = getNavigationTabs();
        for (const tab of tabs) {
            if (getTabLabel(tab) === tabName) {
                tab.click();
                log(`Tab "${tabName}" geklickt`);
                return true;
            }
        }
        log(`Tab "${tabName}" nicht gefunden`);
        return false;
    }

    async function waitForTimelineReady(maxWaitMs = 15000) {
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
            if (!isTimelinePage()) {
                return true;
            }

            const hasTabs = getNavigationTabs().length > 0;
            const hasTweets = document.querySelectorAll('article[data-testid="tweet"]').length > 0;

            if (hasTabs || hasTweets) {
                log('Timeline bereit (Tabs:', hasTabs, 'Tweets:', hasTweets, ')');
                return true;
            }

            await new Promise(r => setTimeout(r, 500));
        }

        log('Timeline nicht bereit nach', maxWaitMs, 'ms');
        return false;
    }

    // ============ SPEICHERN ============

    function saveCurrentPosition() {
        if (!isTimelinePage()) return;

        const visibleTweets = getVisibleTweets();
        if (visibleTweets.length === 0) return;

        // Nimm den obersten sichtbaren Tweet
        const topTweet = visibleTweets[0];

        GM_setValue(STORAGE_KEY_TWEET_ID, topTweet.tweetId);
        GM_setValue(STORAGE_KEY_TIMESTAMP, Date.now());
        GM_setValue(STORAGE_KEY_PATH, getCurrentPath());

        log('Position gespeichert:', topTweet.tweetId);
    }

    // Manuelle Position speichern (Lesezeichen)
    function saveManualPosition() {
        const visibleTweets = getVisibleTweets();
        if (visibleTweets.length === 0) {
            return false;
        }

        const topTweet = visibleTweets[0];
        const currentTab = getCurrentTabName();

        GM_setValue(STORAGE_KEY_MANUAL_TWEET_ID, topTweet.tweetId);
        GM_setValue(STORAGE_KEY_MANUAL_TIMESTAMP, Date.now());
        GM_setValue(STORAGE_KEY_MANUAL_PATH, getCurrentPath());
        GM_setValue(STORAGE_KEY_MANUAL_TAB, currentTab);

        log('Position saved:', topTweet.tweetId, 'Tab:', currentTab, 'Pfad:', getCurrentPath());

        const tweet = findTweetById(topTweet.tweetId);

        if (tweet) {
            // Visuelles Highlight (unterschiedliche Farbe für manuell)
            const highlightColor = '#202020';
            tweet.style.transition = 'box-shadow 0.3s ease';
            tweet.style.boxShadow = `0 0 0 3px ${highlightColor}`;
            setTimeout(() => {
                tweet.style.boxShadow = '';
            }, 1000);
        }
        
        return true;
    }

    // ============ WIEDERHERSTELLEN ============

    async function restorePosition(useManual = false) {
        // Vorherigen Scroll-Vorgang abbrechen
        abortCurrentScroll();
        
        // Neuen Abort-Controller erstellen
        const abortController = { aborted: false };
        currentScrollAbort = abortController;

        const savedTweetId = GM_getValue(useManual ? STORAGE_KEY_MANUAL_TWEET_ID : STORAGE_KEY_TWEET_ID);
        const savedTimestamp = GM_getValue(useManual ? STORAGE_KEY_MANUAL_TIMESTAMP : STORAGE_KEY_TIMESTAMP);
        const savedPath = GM_getValue(useManual ? STORAGE_KEY_MANUAL_PATH : STORAGE_KEY_PATH);
        const savedTab = useManual ? GM_getValue(STORAGE_KEY_MANUAL_TAB) : null;

        const positionType = useManual ? 'Lesezeichen' : 'Position';

        if (!savedTweetId || !savedTimestamp) {
            log(`Keine gespeicherte ${positionType} gefunden`);
            if (useManual) {
                showNotification('✗ Kein Lesezeichen vorhanden', 'error');
            }
            return;
        }

        // Prüfe ob die Position noch aktuell genug ist (nur für automatische Position)
        const ageMinutes = (Date.now() - savedTimestamp) / 1000 / 60;
        if (!useManual && ageMinutes > CONFIG.maxAgeMinutes) {
            log(`Position zu alt (${ageMinutes.toFixed(1)} Minuten)`);
            return;
        }

        // Prüfe ob wir auf der gleichen Seite sind
        if (savedPath && savedPath !== getCurrentPath()) {
            if (useManual) {
                // Bei manuellem Lesezeichen: Zur gespeicherten Seite navigieren
                log(`Navigiere von "${getCurrentPath()}" zu "${savedPath}"`);
                showNotification(`🔄 Navigating to ${savedPath}...`, 'info');
                
                window.location.href = `https://${window.location.host}${savedPath}`;
                
                // Nach Navigation wird die Seite neu geladen, 
                // daher speichern wir einen Flag um danach fortzusetzen
                GM_setValue('twitter_pending_restore', 'manual');
                return;
            } else {
                log('Andere Seite als gespeichert');
                return;
            }
        }

        const ageText = ageMinutes < 1 ? 'gerade eben' :
                        ageMinutes < 60 ? `vor ${Math.round(ageMinutes)} Min.` :
                        `vor ${Math.round(ageMinutes / 60)} Std.`;

        // Bei manuellem Lesezeichen: Erst zum richtigen Tab wechseln
        if (useManual && savedTab) {
            const currentTab = getCurrentTabName();
            if (currentTab !== savedTab) {
                log(`Wechsle von Tab "${currentTab}" zu "${savedTab}"`);
                showNotification(`🔄 Switching to tab "${savedTab}"...`, 'info');
                
                if (clickTab(savedTab)) {
                    // Warte bis der Tab-Inhalt geladen ist
                    await new Promise(r => setTimeout(r, 2000));
                    if (abortController.aborted) return;
                } else {
                    showNotification(`✗ Tab "${savedTab}" not found`, 'error');
                    return;
                }
            }
        }

        // Erst zum Seitenanfang scrollen, dann von dort aus suchen
        log('Scrolle zum Seitenanfang...');
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 1000));
        if (abortController.aborted) return;

        log(`Versuche ${positionType} wiederherzustellen: Tweet ${savedTweetId} (${ageText})`);
        showNotification(`🔍 Searching for ${positionType}... (${ageText})`, 'info');

        let attempts = 0;
        let found = false;

        while (attempts < CONFIG.maxScrollAttempts && !found && !abortController.aborted) {
            const tweet = findTweetById(savedTweetId);

            if (tweet) {
                tweet.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // Visuelles Highlight (unterschiedliche Farbe für manuell)
                const highlightColor = useManual ? '#7856ff' : '#1d9bf0';
                tweet.style.transition = 'box-shadow 0.3s ease';
                tweet.style.boxShadow = `0 0 0 3px ${highlightColor}`;
                setTimeout(() => {
                    tweet.style.boxShadow = '';
                }, 2000);

                found = true;
                log(`${positionType} gefunden und hingescrollt!`);
                showNotification(`✓ ${positionType} found!`, 'success');
            } else {
                // Scrolle zum Seitenende um neue Tweets zu laden
                window.scrollBy(0, window.outerHeight);
                await new Promise(r => setTimeout(r, CONFIG.scrollStepDelayMs));
                attempts++;

                if (attempts % 10 === 0) {
                    log(`Noch am Suchen... (Versuch ${attempts})`);
                }
            }
        }

        if (abortController.aborted) {
            log('Scroll-Vorgang wurde abgebrochen');
            return;
        }

        if (!found) {
            log(`${positionType} nicht gefunden nach`, attempts, 'Versuchen');
            showNotification(`✗ ${positionType} nicht gefunden`, 'error');
        }
        
        // Controller zurücksetzen
        if (currentScrollAbort === abortController) {
            currentScrollAbort = null;
        }
    }

    // ============ UI: BUTTONS ============

    function createButtons() {
        if (document.getElementById(BUTTONS_CONTAINER_ID)) return;

        // Container für beide Buttons
        const container = document.createElement('div');
        container.id = BUTTONS_CONTAINER_ID;
        container.style.cssText = `
            position: fixed;
            bottom: 180px;
            right: 24px;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 12px;
            z-index: 9999;
        `;

        // === Button 1: Automatische Position (wie bisher) ===
        const autoButton = document.createElement('button');
        autoButton.innerHTML = '📍';
        autoButton.title = 'Zur automatisch gespeicherten Position springen';
        autoButton.style.cssText = `
            width: 44px;
            height: 44px;
            border-radius: 50%;
            border: none;
            background: #1d9bf0;
            color: white;
            font-size: 18px;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            transition: transform 0.2s, background 0.2s;
            padding-left: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        autoButton.addEventListener('mouseenter', () => {
            autoButton.style.transform = 'scale(1.1)';
        });
        autoButton.addEventListener('mouseleave', () => {
            autoButton.style.transform = 'scale(1)';
        });
        autoButton.addEventListener('click', () => {
            restorePosition(false); // Automatische Position
        });

        // === Button 2: Manuelles Lesezeichen (Split-Button) ===
        const manualButtonContainer = document.createElement('div');
        manualButtonContainer.style.cssText = `
            display: flex;
            border-radius: 22px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        `;

        // Linke Hälfte: Speichern
        const saveHalf = document.createElement('button');
        saveHalf.innerHTML = '💾';
        saveHalf.title = 'Lesezeichen hier setzen';
        saveHalf.style.cssText = `
            width: 22px;
            height: 44px;
            border: none;
            background: #7856ff;
            color: white;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s;
            border-right: 1px solid rgba(255,255,255,0.2);
            padding-left: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        saveHalf.addEventListener('mouseenter', () => {
            saveHalf.style.background = '#6644ee';
        });
        saveHalf.addEventListener('mouseleave', () => {
            saveHalf.style.background = '#7856ff';
        });
        saveHalf.addEventListener('click', () => {
            if (saveManualPosition()) {
                // Kurzes visuelles Feedback
                saveHalf.innerHTML = '✓';
                setTimeout(() => { saveHalf.innerHTML = '💾'; }, 1000);
            }
        });

        // Rechte Hälfte: Laden
        const loadHalf = document.createElement('button');
        loadHalf.innerHTML = '🔖';
        loadHalf.title = 'Zum Lesezeichen springen';
        loadHalf.style.cssText = `
            width: 22px;
            height: 44px;
            border: none;
            background: #7856ff;
            color: white;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s;
            padding-left: 2px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        loadHalf.addEventListener('mouseenter', () => {
            loadHalf.style.background = '#6644ee';
        });
        loadHalf.addEventListener('mouseleave', () => {
            loadHalf.style.background = '#7856ff';
        });
        loadHalf.addEventListener('click', () => {
            restorePosition(true); // Manuelle Position
        });

        // Zusammenbauen
        manualButtonContainer.appendChild(saveHalf);
        manualButtonContainer.appendChild(loadHalf);

        container.appendChild(manualButtonContainer);
        container.appendChild(autoButton);

        document.body.appendChild(container);
    }

    function watchButtons() {
        if (!document.body) return;

        const observer = new MutationObserver(() => {
            if (!document.getElementById(BUTTONS_CONTAINER_ID)) {
                createButtons();
            }
        });

        observer.observe(document.body, { childList: true });
    }

    // ============ INITIALISIERUNG ============

    let initialized = false;

    async function init() {
        if (initialized) return;
        initialized = true;

        log('Timeline Position Saver initialisiert');

        createButtons();
        watchButtons();

        // Position auch beim Verlassen speichern + Scroll abbrechen
        window.addEventListener('beforeunload', () => {
            abortCurrentScroll();
            saveCurrentPosition();
        });

        // Scroll abbrechen wenn Tab versteckt wird
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                abortCurrentScroll();
            }
        });

        // Scroll abbrechen bei Escape-Taste
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                abortCurrentScroll();
            }
        });

        await waitForTimelineReady();

        if (GM_getValue('twitter_pending_restore')) {
            GM_setValue('twitter_pending_restore', null);
        }

        restorePosition(true);
        setInterval(saveManualPosition, CONFIG.saveIntervalMs);
    }

    function start() {
        if (!document.body) {
            const observer = new MutationObserver(() => {
                if (document.body) {
                    observer.disconnect();
                    init();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            return;
        }

        init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

})();
