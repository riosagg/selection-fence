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

  function requestDiagnostics(type) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (chrome.runtime.lastError || !tabs[0] || !Number.isInteger(tabs[0].id)) {
          reject(new Error('diagnosticsUnavailable'));
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type }, { frameId: 0 }, response => {
          if (chrome.runtime.lastError || !response || response.schemaVersion !== 1) {
            reject(new Error('diagnosticsUnavailable'));
            return;
          }
          resolve(response);
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    localize();

    const status = document.getElementById('status');
    const diagnosticsToggle = document.getElementById('diagnostics-enabled');
    const diagnosticsSection = document.getElementById('diagnostics-section');
    const diagnosticsLog = document.getElementById('diagnostics-log');
    const diagnosticsLabel = document.querySelector('label[for="diagnostics-log"]');
    const diagnosticsStatus = document.getElementById('diagnostics-status');
    const copyButton = document.getElementById('diagnostics-copy');
    let displayedLogRequest = 0;

    function resetDisplayedLog() {
      displayedLogRequest += 1;
      diagnosticsLog.value = '';
      diagnosticsLog.hidden = true;
      diagnosticsLabel.hidden = true;
      copyButton.disabled = true;
    }

    async function showDiagnostics(type) {
      resetDisplayedLog();
      const request = displayedLogRequest;
      diagnosticsStatus.textContent = '';
      try {
        const report = await requestDiagnostics(type);
        if (request !== displayedLogRequest) return;
        diagnosticsToggle.checked = report.enabled;
        if (!report.enabled) {
          diagnosticsStatus.textContent = msg('diagnosticsNotRecording');
          return;
        }
        if (!report.events.length) {
          diagnosticsStatus.textContent = msg('diagnosticsEmpty');
          return;
        }
        diagnosticsLog.value = JSON.stringify(report, null, 2);
        diagnosticsLog.hidden = false;
        diagnosticsLabel.hidden = false;
        copyButton.disabled = false;
        diagnosticsStatus.textContent = msg('diagnosticsReady');
      } catch (_) {
        if (request !== displayedLogRequest) return;
        diagnosticsStatus.textContent = msg('diagnosticsUnavailable');
      }
    }

    chrome.storage.local.get(
      { clampMode: 'smart', diagnosticsEnabled: false },
      result => {
        diagnosticsToggle.disabled = false;
        if (!chrome.runtime.lastError) {
          setChecked(result.clampMode);
          diagnosticsToggle.checked = result.diagnosticsEnabled === true;
          diagnosticsSection.open = diagnosticsToggle.checked;
          diagnosticsStatus.textContent = msg(diagnosticsToggle.checked ? 'diagnosticsConfigured' : 'diagnosticsNotRecording');
        } else {
          diagnosticsStatus.textContent = msg('diagnosticsSaveFailed');
        }
      }
    );

    diagnosticsToggle.addEventListener('change', () => {
      const enabled = diagnosticsToggle.checked;
      diagnosticsToggle.disabled = true;
      chrome.storage.local.set({ diagnosticsEnabled: enabled }, async () => {
        if (chrome.runtime.lastError) {
          diagnosticsToggle.disabled = false;
          diagnosticsToggle.checked = !enabled;
          diagnosticsStatus.textContent = msg('diagnosticsSaveFailed');
          return;
        }
        resetDisplayedLog();
        diagnosticsStatus.textContent = msg('diagnosticsChecking');
        try {
          const report = await requestDiagnostics('selection-fence:diagnostics:sync');
          diagnosticsStatus.textContent = msg(report.enabled === enabled
            ? enabled ? 'diagnosticsEnabled' : 'diagnosticsDisabled'
            : 'diagnosticsNotConfirmed');
        } catch (_) {
          diagnosticsStatus.textContent = msg('diagnosticsNotConfirmed');
        } finally {
          diagnosticsToggle.disabled = false;
        }
      });
    });

    document.getElementById('diagnostics-show').addEventListener('click', () => {
      showDiagnostics('selection-fence:diagnostics:get');
    });
    document.getElementById('diagnostics-clear').addEventListener('click', () => {
      showDiagnostics('selection-fence:diagnostics:clear');
    });
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(diagnosticsLog.value);
        diagnosticsStatus.textContent = msg('diagnosticsCopied');
      } catch (_) {
        diagnosticsLog.focus();
        diagnosticsLog.select();
        diagnosticsStatus.textContent = msg('diagnosticsCopyFailed');
      }
    });

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
