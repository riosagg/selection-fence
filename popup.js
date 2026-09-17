(() => {
  'use strict';

  const VALID_MODES = new Set([
    'smart',
    'nearest',
    'block'
  ]);

  function msg(key) {
    return chrome.i18n.getMessage(key) || '';
  }

  function localize() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = msg(key);
    });
  }

  function setChecked(mode) {
    const normalized = VALID_MODES.has(mode)
      ? mode
      : 'smart';

    const input = document.querySelector(
      `input[name="clampMode"][value="${normalized}"]`
    );

    if (input) {
      input.checked = true;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    localize();

    const status = document.getElementById('status');

    chrome.storage.local.get(
      { clampMode: 'smart' },
      result => {
        if (!chrome.runtime.lastError) {
          setChecked(result.clampMode);
        }
      }
    );

    document.getElementById('mode-form').addEventListener(
      'change',
      event => {
        const target = event.target;

        if (
          !(target instanceof HTMLInputElement) ||
          target.name !== 'clampMode' ||
          !VALID_MODES.has(target.value)
        ) {
          return;
        }

        chrome.storage.local.set(
          { clampMode: target.value },
          () => {
            if (chrome.runtime.lastError) {
              return;
            }

            status.textContent = msg('saved');
            window.setTimeout(() => {
              status.textContent = '';
            }, 1200);
          }
        );
      }
    );
  });
})();
