const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise lifecycle source/target combinations deterministically with the real
// content-script listeners. Chromium tests also cover trusted input/window blur,
// artificial lifecycle events during a lock, and actual navigation cleanup.
function openRuntime() {
  const documentListeners = new Map();
  const windowListeners = new Map();
  let onMessage;
  class Element {
    localName = 'p';
    closest() { return null; }
  }
  const element = new Element();
  const window = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    getSelection: () => ({ rangeCount: 0, isCollapsed: true })
  };
  const document = {
    readyState: 'complete', visibilityState: 'visible', hasFocus: () => true,
    addEventListener(type, listener) { documentListeners.set(type, listener); }
  };
  const sandbox = {
    performance, Element, window, document,
    chrome: {
      runtime: {
        id: 'test-extension', getManifest: () => ({ version: 'test' }),
        onMessage: { addListener(listener) { onMessage = listener; } }
      },
      storage: {
        local: { get(defaults, callback) { callback(defaults); } },
        onChanged: { addListener() {} }
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../content.js'), 'utf8'), sandbox);
  return {
    start() {
      documentListeners.get('mousedown')({
        isTrusted: true, target: element, button: 0, detail: 1, clientX: 40, clientY: 40
      });
    },
    emit(type, { trusted, target }) {
      windowListeners.get(type)({
        isTrusted: trusted, target: target === 'window' ? window : target === 'document' ? document : element
      });
    },
    phase() {
      let report;
      onMessage({ type: 'selection-fence:diagnostics:get' }, { id: 'test-extension' }, value => { report = value; });
      return report.status.phase;
    }
  };
}

for (const type of ['blur', 'pagehide']) {
  for (const { trusted, target } of [
    { trusted: true, target: 'window' },
    { trusted: false, target: 'window' },
    { trusted: true, target: 'element' },
    { trusted: true, target: 'document' }
  ]) {
    const cancels = trusted && (target === 'window' || (type === 'pagehide' && target === 'document'));
    test(`${type} ${cancels ? 'cancels' : 'preserves'} a pending drag (trusted=${trusted}, target=${target})`, () => {
      const f = openRuntime();
      f.start();
      assert.equal(f.phase(), 'pending');
      f.emit(type, { trusted, target });
      assert.equal(f.phase(), cancels ? 'idle' : 'pending');
    });
  }
}
