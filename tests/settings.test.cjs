const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function delayedSettings() {
  let completeRead;
  let onChanged;
  let onMessage;
  const sandbox = {
    performance,
    document: {
      readyState: 'complete', visibilityState: 'visible',
      hasFocus: () => true, addEventListener() {}
    },
    window: { addEventListener() {} },
    chrome: {
      runtime: {
        id: 'test-extension', getManifest: () => ({ version: 'test' }),
        onMessage: { addListener(listener) { onMessage = listener; } }
      },
      storage: {
        local: { get(defaults, callback) { completeRead = callback; } },
        onChanged: { addListener(listener) { onChanged = listener; } }
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../content.js'), 'utf8'), sandbox);
  return {
    completeRead,
    completeLatestRead: result => completeRead(result),
    message: (type, response) => onMessage({ type }, { id: 'test-extension' }, response),
    change: changes => onChanged(changes, 'local'),
    report() {
      let result;
      onMessage({ type: 'selection-fence:diagnostics:get' }, { id: 'test-extension' }, value => { result = value; });
      return result;
    }
  };
}

test('a delayed initial read does not disable diagnostics after they were enabled', () => {
  const f = delayedSettings();
  f.change({ diagnosticsEnabled: { newValue: true } });
  f.completeRead({ clampMode: 'smart', diagnosticsEnabled: false });
  assert.equal(f.report().enabled, true);
  assert.equal(f.report().events[0].event, 'diagnostics.enabled');
});

test('a delayed initial read does not re-enable diagnostics after they were disabled', () => {
  const f = delayedSettings();
  f.change({ diagnosticsEnabled: { newValue: false } });
  f.completeRead({ clampMode: 'smart', diagnosticsEnabled: true });
  assert.equal(f.report().enabled, false);
  assert.equal(f.report().events.length, 0);
});

test('a delayed initial read does not overwrite a newer selection mode', () => {
  const f = delayedSettings();
  f.change({ clampMode: { newValue: 'block' } });
  f.completeRead({ clampMode: 'smart', diagnosticsEnabled: false });
  assert.equal(f.report().status.mode, 'block');
});

test('acknowledging the logging preference invalidates an older startup read', () => {
  const f = delayedSettings();
  let acknowledged;
  f.message('selection-fence:diagnostics:sync', result => { acknowledged = result; });
  f.completeLatestRead({ diagnosticsEnabled: true });
  assert.equal(acknowledged.enabled, true);
  f.completeRead({ clampMode: 'smart', diagnosticsEnabled: false });
  assert.equal(f.report().enabled, true);
});
