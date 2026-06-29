(function () {
    'use strict';

    const TAG = '[X Debug Extension]';

    function showBanner() {
        if (document.getElementById('x-debug-ext-banner')) return;

        const el = document.createElement('div');
        el.id = 'x-debug-ext-banner';
        el.textContent = TAG + ' dziala na ' + location.hostname;
        el.style.cssText = [
            'position:fixed',
            'top:0',
            'left:0',
            'right:0',
            'z-index:2147483647',
            'background:#00c853',
            'color:#000',
            'padding:10px 12px',
            'font:bold 15px system-ui,-apple-system,sans-serif',
            'text-align:center',
            'box-shadow:0 2px 8px rgba(0,0,0,.35)'
        ].join(';');

        const root = document.documentElement || document.body;
        if (root) {
            root.appendChild(el);
        }
    }

    function logStartup(phase) {
        console.log(TAG, phase, location.href, 'readyState=', document.readyState);
        showBanner();
    }

    logStartup('document_start');

    document.addEventListener('DOMContentLoaded', () => logStartup('DOMContentLoaded'));
    window.addEventListener('load', () => logStartup('window load'));

    if (!document.getElementById('x-debug-ext-banner')) {
        const observer = new MutationObserver(() => {
            showBanner();
            if (document.getElementById('x-debug-ext-banner')) {
                observer.disconnect();
            }
        });
        observer.observe(document, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 15000);
    }
})();
