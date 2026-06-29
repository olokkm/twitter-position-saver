(function () {
    'use strict';

    const TAG = '[X Debug Extension]';

    console.log(TAG, 'document_start', location.href, 'readyState=', document.readyState);

    document.addEventListener('DOMContentLoaded', () => {
        console.log(TAG, 'DOMContentLoaded');
    });

    window.addEventListener('load', () => {
        console.log(TAG, 'window load');
    });

    console.log(TAG, 'IIFE finished');
})();
