// ==UserScript==
// @name         X Debug Test (minimal)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Minimal test - only console.log, nothing else
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

console.log('[X Debug Test] document-start, href=', location.href);

document.addEventListener('DOMContentLoaded', () => {
    console.log('[X Debug Test] DOMContentLoaded');
});

window.addEventListener('load', () => {
    console.log('[X Debug Test] window load');
});

(function () {
    'use strict';
    console.log('[X Debug Test] IIFE ran, readyState=', document.readyState);
})();
