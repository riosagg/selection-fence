const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const FIRST = '[data-block="first"]';
const SECOND = '[data-block="second"]';
const TEXT = 'The first paragraph contains several lines of ordinary selectable text. '
  + 'Starting a drag here should keep the selection inside this paragraph, even while the page is loading.';
const html = `<!doctype html><html><head><style>
  body { margin: 40px; font: 16px/24px monospace; }
  p { width: 360px; margin: 0 0 100px; }
</style></head><body><main>
  <p id="first" data-block="first">${TEXT}</p>
  <p id="second" data-block="second">The second paragraph must never become part of a fenced selection.</p>
</main>`;
let server;
let context;
let baseURL;
const responses = new Set();

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.write(html);
    if (req.url === '/loading') {
      // Leave the parser running: tests interact before DOMContentLoaded or load.
      responses.add(res);
      res.on('close', () => responses.delete(res));
    } else {
      res.end('</body></html>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  const extension = process.env.SELECTION_FENCE_EXTENSION_DIR || path.resolve(__dirname, '..');
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
});

after(async () => {
  await context?.close();
  for (const res of responses) res.end('</body></html>');
  if (server) await new Promise(resolve => server.close(resolve));
});

async function openFixture(t, { manualFrames = true, mode = 'smart', diagnostics = false } = {}) {
  const page = await context.newPage();
  t.after(() => page.close());
  const cdp = await context.newCDPSession(page);
  let resolveWorld;
  const worldReady = new Promise(resolve => { resolveWorld = resolve; });
  cdp.on('Runtime.executionContextCreated', ({ context: world }) => {
    if (world.origin.startsWith('chrome-extension://')) resolveWorld(world.id);
  });
  await cdp.send('Runtime.enable');
  await page.goto(`${baseURL}/loading`, { waitUntil: 'commit' });
  await page.locator(FIRST).waitFor({ state: 'visible' });
  const worldId = await worldReady;
  async function isolated(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression, contextId: worldId, returnByValue: true, awaitPromise: true
    });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text);
    return result.result.value;
  }
  await isolated(`new Promise(resolve => chrome.storage.local.set({clampMode: ${JSON.stringify(mode)}, diagnosticsEnabled: ${diagnostics}}, resolve))`);
  if (manualFrames) {
    // Control only the extension world's scheduling and caret APIs. The actual
    // extension, DOM, Selection API and trusted mouse events run in Chromium.
    await isolated(`(() => {
      const frames = new Map();
      let nextId = 0;
      const position = document.caretPositionFromPoint;
      const range = document.caretRangeFromPoint;
      globalThis.requestAnimationFrame = callback => {
        const id = ++nextId;
        frames.set(id, callback);
        return id;
      };
      globalThis.cancelAnimationFrame = id => frames.delete(id);
      globalThis.fenceTest = {
        flush() {
          const batch = [...frames.values()];
          frames.clear();
          batch.forEach(callback => callback(performance.now()));
          return batch.length;
        },
        pending: () => frames.size,
        hideCaret() {
          document.caretPositionFromPoint = () => null;
          document.caretRangeFromPoint = () => null;
        },
        restoreCaret() {
          document.caretPositionFromPoint = position;
          document.caretRangeFromPoint = range;
        }
      };
    })()`);
  }
  async function frames(count = 4) {
    for (let i = 0; i < count; i += 1) {
      if (manualFrames) await isolated('fenceTest.flush()');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
  }
  async function point(selector, offset = 6) {
    return page.locator(selector).evaluate((element, offset) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }, offset);
  }
  async function startDrag({ outside = true, modifiers = [] } = {}) {
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    const start = await point(FIRST);
    const end = outside ? await point(SECOND) : await point(FIRST, 16);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    return { start, end };
  }
  async function selection() {
    return page.evaluate(selector => {
      const root = document.querySelector(selector);
      const selection = getSelection();
      return {
        locked: !!root && root.getAttributeNames().some(name => name.startsWith('data-sbl-root-')),
        active: [...document.documentElement.classList].some(name => name.startsWith('sbl-active-')),
        anchorInside: !!selection.anchorNode && root.contains(selection.anchorNode),
        focusInside: !!selection.focusNode && root.contains(selection.focusNode),
        anchorOffset: selection.anchorOffset,
        text: selection.toString()
      };
    }, FIRST);
  }
  async function assertFenced() {
    const result = await selection();
    assert.equal(result.locked, true, 'the starting paragraph should be locked');
    assert.equal(result.anchorInside, true, 'the anchor should stay in the starting paragraph');
    assert.equal(result.focusInside, true, 'the focus should stay in the starting paragraph');
    assert.ok(result.text.length > 0, 'the selection should retain text');
    assert.ok(TEXT.includes(result.text), 'the selection should contain only the starting paragraph');
    return result;
  }
  async function buttonlessMove(point) {
    // Reproduce the supplied log with a trusted Chromium event whose buttons
    // metadata is already zero, while mouseup has not yet been delivered.
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, buttons: 0, button: 'none'
    });
  }
  async function releaseAt(point) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, buttons: 0, button: 'left', clickCount: 1
    });
  }
  return { page, isolated, frames, point, startDrag, selection, assertFenced, buttonlessMove, releaseAt };
}

async function openDiagnosticPopup(t, fixture) {
  const extensionId = await fixture.isolated('chrome.runtime.id');
  const popup = await context.newPage();
  t.after(() => popup.close());
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#diagnostics-section').evaluate(element => { element.open = true; });
  // Keep the original page active, as when this document is an action popup.
  await fixture.page.bringToFront();
  const tabId = await popup.evaluate(() => new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0].id));
  }));
  async function report(type = 'selection-fence:diagnostics:get') {
    return popup.evaluate(({ tabId, type }) => new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 }, result => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    }), { tabId, type });
  }
  return { popup, report };
}

for (const mode of ['smart', 'nearest', 'block']) {
  test(`fences an immediate drag while the document is loading (${mode}, native frames)`, async t => {
    const f = await openFixture(t, { manualFrames: false, mode });
    assert.equal(await f.page.evaluate(() => document.readyState), 'loading');
    await f.startDrag();
    await f.frames();
    await f.assertFenced();
    await f.page.mouse.up();
    await f.frames();
    assert.equal((await f.selection()).active, false);
  });
}

test('retries a temporarily unavailable start position without another mousemove', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.isolated('fenceTest.hideCaret(); getSelection().collapse(document.body, 0)');
  await f.frames(1);
  assert.equal((await f.selection()).locked, false);
  await f.isolated('fenceTest.restoreCaret()');
  await f.frames();
  await f.assertFenced();
});

test('falls back to the coordinate caret when the live anchor is body', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.page.evaluate(() => getSelection().collapse(document.body, 0));
  await f.frames();
  await f.assertFenced();
});

test('does not treat a live anchor on the page container as the text block', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.page.evaluate(() => getSelection().collapse(document.querySelector('main'), 0));
  await f.frames();
  await f.assertFenced();
});

test('recovers when the page replaces the active paragraph', async t => {
  const f = await openFixture(t);
  await f.startDrag({ outside: false });
  await f.frames();
  const before = await f.assertFenced();
  await f.page.locator(FIRST).evaluate(element => {
    const replacement = document.createElement('p');
    replacement.id = element.id;
    replacement.dataset.block = 'first';
    replacement.textContent = element.textContent;
    element.replaceWith(replacement);
  });
  const end = await f.point(SECOND);
  await f.page.mouse.move(end.x, end.y);
  await f.frames(6);
  const after = await f.assertFenced();
  assert.equal(after.anchorOffset, before.anchorOffset);
});

test('recovers the original text offset when hydration changes inline markup', async t => {
  const f = await openFixture(t);
  await f.startDrag({ outside: false });
  await f.frames();
  const before = await f.assertFenced();
  await f.page.locator(FIRST).evaluate(element => {
    const text = element.textContent;
    const prefix = document.createElement('span');
    prefix.textContent = text.slice(0, 3);
    const rest = document.createElement('strong');
    rest.textContent = text.slice(3);
    element.replaceChildren(prefix, rest);
  });
  const end = await f.point(SECOND);
  await f.page.mouse.move(end.x, end.y);
  await f.frames(6);
  const after = await f.assertFenced();
  assert.equal(after.anchorOffset, before.anchorOffset - 3);
});

test('recovers an id-less paragraph through a replaced ancestor', async t => {
  const f = await openFixture(t);
  await f.page.locator(FIRST).evaluate(element => element.removeAttribute('id'));
  await f.startDrag({ outside: false });
  await f.frames();
  const before = await f.assertFenced();
  await f.page.locator('main').evaluate(element => {
    const replacement = element.cloneNode(true);
    for (const node of [replacement, ...replacement.querySelectorAll('*')]) {
      for (const name of node.getAttributeNames()) {
        if (name.startsWith('data-sbl-')) node.removeAttribute(name);
      }
    }
    element.replaceWith(replacement);
  });
  const end = await f.point(SECOND);
  await f.page.mouse.move(end.x, end.y);
  await f.frames(6);
  assert.equal((await f.assertFenced()).anchorOffset, before.anchorOffset);
  await f.page.mouse.up();
  await f.frames();
  assert.equal(await f.page.evaluate(() => [...document.querySelectorAll('*')].some(
    element => element.getAttributeNames().some(name => name.startsWith('data-sbl-'))
  )), false, 'temporary root/path attributes should be removed after recovery');
});

test('does not restart the selection on an unrelated replacement paragraph', async t => {
  const f = await openFixture(t);
  await f.startDrag({ outside: false });
  await f.frames();
  await f.assertFenced();
  await f.page.locator(FIRST).evaluate(element => {
    const replacement = document.createElement('p');
    replacement.id = 'unrelated';
    replacement.dataset.block = 'first';
    replacement.textContent = element.textContent;
    element.replaceWith(replacement);
  });
  const end = await f.point(SECOND);
  await f.page.mouse.move(end.x, end.y);
  await f.frames(12);
  assert.equal((await f.selection()).locked, false);
  assert.equal(await f.isolated('fenceTest.pending()'), 0);
  await f.page.mouse.up();
  await f.frames(12);
  assert.equal((await f.selection()).active, false);
  assert.equal(await f.isolated('fenceTest.pending()'), 0);
});

test('rechecks sensitive fields before recovering a replaced paragraph', async t => {
  const f = await openFixture(t);
  await f.startDrag({ outside: false });
  await f.frames();
  await f.assertFenced();
  await f.page.locator(FIRST).evaluate(element => {
    const replacement = document.createElement('p');
    replacement.id = element.id;
    replacement.dataset.block = 'first';
    replacement.textContent = element.textContent;
    element.replaceWith(replacement);
    const password = document.createElement('input');
    password.type = 'password';
    password.style.cssText = 'position:fixed;left:40px;top:40px;width:100px;height:20px';
    document.body.appendChild(password);
  });
  const end = await f.point(SECOND);
  await f.page.mouse.move(end.x, end.y);
  await f.frames(6);
  assert.equal((await f.selection()).active, false);
  assert.equal(await f.isolated('fenceTest.pending()'), 0);
});

for (const fallback of [false, true]) {
  for (const hiddenStyle of ['opacity:0', 'content-visibility:hidden']) {
    test(`an invisible ancestor (${hiddenStyle}) does not make its password field pause selection (${fallback ? 'visibility fallback' : 'native visibility'})`, async t => {
      const f = await openFixture(t, { diagnostics: true });
      await f.page.evaluate(hiddenStyle => {
        const hidden = document.createElement('div');
        hidden.style.cssText = hiddenStyle;
        const password = document.createElement('input');
        password.type = 'password';
        password.style.cssText = 'position:fixed;left:40px;top:210px;width:100px;height:20px';
        hidden.appendChild(password);
        document.body.appendChild(hidden);
      }, hiddenStyle);
      if (fallback) await f.isolated('Element.prototype.checkVisibility = undefined');
      await f.startDrag();
      await f.frames();
      await f.assertFenced();
      await f.page.mouse.up();
      await f.frames();
      const { report } = await openDiagnosticPopup(t, f);
      assert.ok(!(await report()).events.some(event => event.event === 'activation.blocked' && event.reason === 'sensitive_context'));
    });
  }
  test(`a visible sensitive field still pauses selection (${fallback ? 'visibility fallback' : 'native visibility'})`, async t => {
    const f = await openFixture(t, { diagnostics: true });
    await f.page.evaluate(() => {
      const container = document.createElement('div');
      container.style.visibility = 'hidden';
      const password = document.createElement('input');
      password.type = 'password';
      password.style.cssText = 'visibility:visible;position:fixed;left:40px;top:210px;width:100px;height:20px';
      container.appendChild(password);
      document.body.appendChild(container);
    });
    if (fallback) await f.isolated('Element.prototype.checkVisibility = undefined');
    await f.startDrag();
    await f.frames();
    assert.equal((await f.selection()).active, false);
    await f.page.mouse.up();
    const { report } = await openDiagnosticPopup(t, f);
    assert.ok((await report()).events.some(event => event.event === 'activation.blocked' && event.reason === 'sensitive_context'));
  });
}

test('retains a quick completed drag while the start position is temporarily unavailable', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.page.mouse.up();
  await f.isolated('fenceTest.hideCaret(); getSelection().collapse(document.body, 0)');
  await f.frames(1);
  await f.isolated('fenceTest.restoreCaret()');
  await f.frames(2);
  const result = await f.selection();
  assert.equal(result.anchorInside, true);
  assert.equal(result.focusInside, true);
  assert.ok(result.text.length > 0);
  await f.frames();
  assert.equal((await f.selection()).active, false);
});

test('preserves Alt bypass', async t => {
  const f = await openFixture(t);
  await f.startDrag({ modifiers: ['Alt'] });
  await f.frames();
  const result = await f.selection();
  assert.equal(result.locked, false);
  assert.equal(result.focusInside, false);
  await f.page.mouse.up();
  await f.page.keyboard.up('Alt');
});

for (const manualFrames of [true, false]) {
  test(`keeps a drag when its mousedown blurs a focused input (${manualFrames ? 'controlled' : 'native'} frames)`, async t => {
    const f = await openFixture(t, { manualFrames, diagnostics: true });
    await f.page.evaluate(() => {
      const input = document.createElement('input');
      input.style.cssText = 'position:fixed;left:600px;top:40px';
      document.body.appendChild(input);
      globalThis.blurEvents = [];
      window.addEventListener('blur', event => {
        blurEvents.push({
          target: event.target === window ? 'window' : event.target.tagName,
          trusted: event.isTrusted
        });
      }, true);
      input.focus();
    });
    assert.equal(await f.page.evaluate(() => document.activeElement.tagName), 'INPUT');
    await f.startDrag();
    assert.deepEqual(await f.page.evaluate(() => blurEvents), [{ target: 'INPUT', trusted: true }]);
    await f.frames();
    await f.assertFenced();
    await f.page.mouse.up();
    await f.frames();
    const result = await f.selection();
    assert.equal(result.active, false);
    assert.equal(result.anchorInside, true);
    assert.equal(result.focusInside, true);
    const { report } = await openDiagnosticPopup(t, f);
    const events = (await report()).events;
    assert.ok(events.some(event => event.event === 'activation.succeeded'));
    assert.ok(!events.some(event => event.event === 'drag.reset' && event.reason === 'window_blur'));
  });
}

test('an actual window blur cancels a locked drag', async t => {
  const f = await openFixture(t, { diagnostics: true });
  const cdp = await context.newCDPSession(f.page);
  // Playwright normally forces focus for every tab, including background tabs.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await f.page.bringToFront();
  assert.equal(await f.page.evaluate(() => document.hasFocus()), true);
  await f.startDrag();
  await f.frames();
  await f.assertFenced();
  await f.page.evaluate(() => {
    window.addEventListener('blur', event => {
      if (!event.isTrusted) return;
      globalThis.windowBlurResult = {
        windowTarget: event.target === window,
        active: [...document.documentElement.classList].some(name => name.startsWith('sbl-active-'))
      };
    }, { once: true });
  });
  const other = await context.newPage();
  t.after(() => other.close());
  await other.bringToFront();
  await f.page.waitForFunction(() => globalThis.windowBlurResult !== undefined);
  assert.deepEqual(await f.page.evaluate(() => windowBlurResult), { windowTarget: true, active: false });
  assert.equal((await f.selection()).active, false);
  assert.equal(await f.isolated('fenceTest.pending()'), 0);
  const { report } = await openDiagnosticPopup(t, f);
  assert.ok((await report()).events.some(event => event.event === 'drag.reset' && event.reason === 'window_blur'));
  await f.page.mouse.up();
});

test('an actual pagehide cleans up a locked drag before navigation', async t => {
  const f = await openFixture(t, { diagnostics: true });
  await f.startDrag();
  await f.frames();
  await f.assertFenced();
  await f.page.evaluate(() => {
    window.addEventListener('pagehide', event => {
      localStorage.setItem('fence-lifecycle-test', JSON.stringify({
        trusted: event.isTrusted,
        windowTarget: event.target === window,
        documentTarget: event.target === document,
        active: [...document.documentElement.classList].some(name => name.startsWith('sbl-active-')),
        marked: !!document.querySelector('[data-block="first"]').getAttributeNames().some(name => name.startsWith('data-sbl-root-')),
        stylePresent: [...document.querySelectorAll('style')].some(style => style.textContent.includes('sbl-active-'))
      }));
    }, { once: true });
  });
  await f.page.goto(`${baseURL}/navigated`);
  assert.deepEqual(await f.page.evaluate(() => JSON.parse(localStorage.getItem('fence-lifecycle-test'))), {
    trusted: true, windowTarget: false, documentTarget: true, active: false, marked: false, stylePresent: false
  });
  await f.page.mouse.up();
});

for (const type of ['blur', 'pagehide']) {
  test(`a synthetic ${type} does not cancel a visible page's locked drag`, async t => {
    const f = await openFixture(t);
    await f.startDrag();
    await f.frames();
    await f.assertFenced();
    await f.page.evaluate(type => window.dispatchEvent(new Event(type)), type);
    await f.frames();
    await f.assertFenced();
    await f.page.mouse.up();
    await f.frames();
    assert.equal((await f.selection()).active, false);
  });
}

for (const phase of ['pending', 'activating', 'locked']) {
  test(`releasing an auxiliary button does not finish a ${phase} primary drag`, async t => {
    const f = await openFixture(t, { diagnostics: true });
    await f.page.evaluate(() => {
      // A site may suppress middle-button autoscroll while the button is held.
      document.addEventListener('mousedown', event => {
        if (event.button === 1) event.preventDefault();
      });
      document.addEventListener('mouseup', event => {
        if (event.button === 1) globalThis.auxiliaryRelease = { trusted: event.isTrusted, buttons: event.buttons };
      });
    });
    const start = await f.point(FIRST);
    const end = await f.point(SECOND);
    await f.page.mouse.move(start.x, start.y);
    await f.page.mouse.down({ button: 'middle' });
    await f.page.mouse.down();
    if (phase !== 'pending') await f.page.mouse.move(end.x, end.y);
    if (phase === 'locked') {
      await f.frames();
      await f.assertFenced();
    }
    await f.page.mouse.up({ button: 'middle' });
    assert.deepEqual(await f.page.evaluate(() => auxiliaryRelease), { trusted: true, buttons: 1 });
    await f.frames();
    await f.page.mouse.move(end.x, end.y);
    await f.frames();
    await f.assertFenced();
    await f.page.mouse.up();
    await f.frames();
    assert.equal((await f.selection()).active, false);
    const { report } = await openDiagnosticPopup(t, f);
    assert.equal((await report()).events.filter(event => event.event === 'release.completed').length, 1);
  });
}

for (const manualFrames of [true, false]) {
  for (const cancelled of [true, false]) {
    test(`${cancelled ? 'a cancelled' : 'an accepted'} native drag ${cancelled ? 'keeps' : 'releases'} the selection gesture (${manualFrames ? 'controlled' : 'native'} frames)`, async t => {
      const f = await openFixture(t, { manualFrames, diagnostics: true });
      await f.page.locator(FIRST).evaluate((element, cancelled) => {
        element.draggable = true;
        globalThis.nativeDragEvents = [];
        document.addEventListener('dragstart', event => {
          if (cancelled) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
          nativeDragEvents.push({ trusted: event.isTrusted, cancelled: event.defaultPrevented });
        });
      }, cancelled);
      const start = await f.point(FIRST);
      const end = await f.point(SECOND);
      await f.page.mouse.move(start.x, start.y);
      await f.page.mouse.down();
      await f.page.mouse.move(end.x, end.y, { steps: 3 });
      assert.deepEqual(await f.page.evaluate(() => nativeDragEvents), [{ trusted: true, cancelled }]);
      await f.frames();
      if (cancelled) await f.assertFenced();
      else assert.equal((await f.selection()).active, false);
      await f.page.mouse.up();
      await f.frames();
      const { report } = await openDiagnosticPopup(t, f);
      assert.equal((await report()).events.some(event => event.event === 'drag.reset' && event.reason === 'native_drag'), !cancelled);
    });
  }
}

test('an old native-drag cleanup task does not cancel a new selection', async t => {
  const f = await openFixture(t);
  await f.isolated(`(() => {
    const original = window.setTimeout;
    const tasks = [];
    window.setTimeout = (callback, delay, ...args) => {
      if (delay !== 0) return original(callback, delay, ...args);
      tasks.push(() => callback(...args));
      return 0;
    };
    fenceTest.nativeDragTasks = tasks;
  })()`);
  await f.page.locator(FIRST).evaluate(element => { element.draggable = true; });
  const start = await f.point(FIRST);
  const end = await f.point(SECOND);
  await f.page.mouse.move(start.x, start.y);
  await f.page.mouse.down();
  await f.page.mouse.move(end.x, end.y, { steps: 3 });
  assert.equal(await f.isolated('fenceTest.nativeDragTasks.length'), 1);
  await f.page.keyboard.press('Escape');
  await f.page.mouse.up();
  await f.page.locator(FIRST).evaluate(element => { element.draggable = false; });
  await f.startDrag();
  await f.frames();
  await f.assertFenced();
  await f.isolated('fenceTest.nativeDragTasks.splice(0).forEach(callback => callback())');
  await f.frames();
  await f.assertFenced();
  await f.page.mouse.up();
  await f.frames();
  assert.equal((await f.selection()).active, false);
});

test('Escape cancels an activation that is waiting for a usable start position', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.isolated('fenceTest.hideCaret(); getSelection().removeAllRanges()');
  await f.frames(1);
  await f.page.keyboard.press('Escape');
  await f.isolated('fenceTest.restoreCaret()');
  await f.frames();
  assert.equal((await f.selection()).active, false);
  assert.equal(await f.isolated('fenceTest.pending()'), 0);
});

test('bounds automatic retries and resumes on a later pointer movement', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.isolated('fenceTest.hideCaret(); getSelection().removeAllRanges()');
  await f.frames(12);
  assert.equal(await f.isolated('fenceTest.pending()'), 0, 'retries must stop without spinning');
  await f.isolated('fenceTest.restoreCaret()');
  const end = await f.point(SECOND, 10);
  await f.page.mouse.move(end.x, end.y);
  await f.frames();
  await f.assertFenced();
});

test('abandons an unavailable completed drag after the retry limit', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.page.mouse.up();
  await f.isolated('fenceTest.hideCaret(); getSelection().removeAllRanges()');
  await f.frames(12);
  await f.isolated('fenceTest.restoreCaret()');
  await f.frames();
  assert.equal((await f.selection()).active, false);
  assert.equal(await f.isolated('fenceTest.pending()'), 0);
});

test('diagnostics are off by default and do not retain interaction events', async t => {
  const f = await openFixture(t);
  await f.startDrag();
  await f.frames();
  await f.page.mouse.up();
  await f.frames();
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.equal(result.enabled, false);
  assert.deepEqual(result.events, []);
  assert.equal(result.status.phase, 'idle');
});

test('diagnostics record a transient failure, retries, success and release', async t => {
  const f = await openFixture(t, { diagnostics: true });
  await f.startDrag();
  await f.isolated('fenceTest.hideCaret(); getSelection().collapse(document.body, 0)');
  await f.frames(1);
  await f.isolated('fenceTest.restoreCaret()');
  await f.frames();
  await f.assertFenced();
  await f.page.mouse.up();
  await f.frames();
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.ok(result.events.some(event => event.event === 'activation.retry' && event.reason === 'start_position_unavailable'));
  assert.ok(result.events.some(event => event.event === 'activation.succeeded' && event.attempts === 2));
  assert.ok(result.events.some(event => event.event === 'lock.released' && event.reason === 'mouse_released'));
  assert.ok(result.events.every(event => Number.isFinite(event.elapsedMs)));
});

test('double-click bypass is unchanged and its click count is recorded', async t => {
  const f = await openFixture(t, { diagnostics: true });
  const start = await f.point(FIRST);
  const end = await f.point(SECOND);
  await f.page.mouse.move(start.x, start.y);
  await f.page.mouse.down({ clickCount: 2 });
  await f.page.mouse.move(end.x, end.y);
  await f.frames();
  assert.equal((await f.selection()).locked, false);
  assert.equal((await f.selection()).focusInside, false);
  await f.page.mouse.up();
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.ok(result.events.some(event => event.event === 'pointer.down' && event.clickCount === 2));
  assert.ok(result.events.some(event => event.event === 'interaction.bypassed' && event.reason === 'multi_click'));
  assert.ok(!result.events.some(event => event.event === 'activation.succeeded'));
});

test('diagnostics identify incompatible DOM recovery and the retry limit', async t => {
  const f = await openFixture(t, { diagnostics: true });
  await f.startDrag({ outside: false });
  await f.frames();
  await f.page.locator(FIRST).evaluate(element => { element.textContent = 'Changed content'; });
  const end = await f.point(SECOND);
  await f.page.mouse.move(end.x, end.y);
  await f.frames(12);
  await f.page.mouse.up();
  await f.frames(12);
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.ok(result.events.some(event => event.event === 'recovery.needed'));
  assert.ok(result.events.some(event => event.event === 'activation.retry' && event.reason === 'origin_text_length_changed'));
  assert.ok(result.events.some(event => event.event === 'activation.cancelled' && event.reason === 'retry_limit_after_release'));
});

test('diagnostics distinguish successful DOM recovery from initial activation', async t => {
  const f = await openFixture(t, { diagnostics: true });
  await f.startDrag({ outside: false });
  await f.frames();
  await f.page.locator(FIRST).evaluate(element => { element.textContent = element.textContent; });
  const end = await f.point(SECOND);
  await f.page.mouse.move(end.x, end.y);
  await f.frames();
  await f.assertFenced();
  await f.page.mouse.up();
  await f.frames();
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.ok(result.events.some(event => event.event === 'recovery.needed'));
  assert.ok(result.events.some(event => event.event === 'recovery.succeeded'));
  assert.ok(result.events.some(event => event.event === 'anchor.resolved' && event.source === 'bookmark'));
});

test('selection write errors record only their error type', async t => {
  const f = await openFixture(t, { diagnostics: true });
  await f.isolated(`(() => {
    const selection = getSelection();
    selection.setBaseAndExtent = () => { throw new TypeError('PRIVATE_ERROR_TEXT_AND_URL'); };
  })()`);
  await f.startDrag();
  await f.frames(1);
  await f.page.mouse.up();
  await f.frames();
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.ok(result.events.some(event => event.event === 'selection.write_failed' && event.error === 'TypeError'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_ERROR_TEXT_AND_URL'));
});

test('diagnostics omit page text, input values, URL, ids, classes and custom tag names', async t => {
  const f = await openFixture(t, { diagnostics: true });
  const secret = 'PRIVATE_SENTINEL_69ab';
  await f.page.locator(FIRST).evaluate((element, secret) => {
    element.textContent += secret;
    element.id = secret;
    element.className = secret;
    const input = document.createElement('input');
    input.type = 'password';
    input.value = secret;
    input.style.cssText = 'position:fixed;top:100px;left:40px;width:100px;height:20px';
    document.body.appendChild(input);
    const custom = document.createElement(`private-${secret.toLowerCase()}`);
    custom.textContent = secret;
    document.body.appendChild(custom);
    history.replaceState(null, '', `/?secret=${secret}`);
  }, secret);
  await f.startDrag();
  await f.frames();
  await f.page.mouse.up();
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.ok(result.events.some(event => event.event === 'activation.blocked' && event.reason === 'sensitive_context'));
  const serialized = JSON.stringify(result).toLowerCase();
  assert.ok(!serialized.includes(secret.toLowerCase()));
  assert.ok(!serialized.includes(TEXT.toLowerCase()));
  assert.ok(!serialized.includes(baseURL));
});

test('diagnostic logs are bounded, clearable, and erased when disabled', async t => {
  const f = await openFixture(t, { diagnostics: true });
  const start = await f.point(FIRST);
  await f.page.mouse.move(start.x, start.y);
  for (let i = 0; i < 75; i += 1) {
    await f.page.mouse.down({ clickCount: 2 });
    await f.page.mouse.up();
  }
  const { report } = await openDiagnosticPopup(t, f);
  const result = await report();
  assert.equal(result.events.length, result.limit);
  assert.ok(result.droppedEvents > 0);
  assert.ok(result.events[0].sequence > 1);
  const cleared = await report('selection-fence:diagnostics:clear');
  assert.deepEqual(cleared.events, []);
  assert.equal(cleared.droppedEvents, 0);
  await f.isolated('new Promise(resolve => chrome.storage.local.set({diagnosticsEnabled: false}, resolve))');
  await f.frames(1);
  assert.deepEqual((await report()).events, []);
  assert.equal((await report()).enabled, false);
  const stored = await f.isolated('new Promise(resolve => chrome.storage.local.get(null, resolve))');
  assert.deepEqual(Object.keys(stored).sort(), ['clampMode', 'diagnosticsEnabled']);
});

test('popup enables logging, displays the current page report, copies and clears it', async t => {
  const f = await openFixture(t);
  const { popup, report } = await openDiagnosticPopup(t, f);
  await popup.locator('#diagnostics-enabled').check();
  await popup.waitForFunction(() => document.getElementById('diagnostics-status').textContent === chrome.i18n.getMessage('diagnosticsEnabled'));
  await f.frames(1);
  assert.equal((await report()).enabled, true);
  await f.page.bringToFront();
  await f.startDrag();
  await f.frames();
  await f.page.mouse.up();
  await f.frames();
  await popup.evaluate(() => document.getElementById('diagnostics-show').click());
  await popup.waitForFunction(() => document.getElementById('diagnostics-log').value.length > 0);
  const text = await popup.locator('#diagnostics-log').inputValue();
  assert.ok(JSON.parse(text).events.some(event => event.event === 'activation.succeeded'));
  // Test the copy handler without overwriting the user's actual clipboard.
  await popup.evaluate(() => {
    navigator.clipboard.writeText = async text => { globalThis.copiedDiagnosticText = text; };
  });
  await popup.locator('#diagnostics-copy').click();
  assert.equal(await popup.evaluate(() => globalThis.copiedDiagnosticText), text);
  await popup.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  });
  await popup.locator('#diagnostics-copy').click();
  assert.equal(await popup.locator('#diagnostics-status').textContent(), await popup.evaluate(
    () => chrome.i18n.getMessage('diagnosticsCopyFailed')
  ));
  assert.equal(await popup.locator('#diagnostics-log').evaluate(element => element.selectionEnd), text.length);
  await f.page.bringToFront();
  await popup.evaluate(() => document.getElementById('diagnostics-clear').click());
  await popup.waitForFunction(() => document.getElementById('diagnostics-status').textContent === chrome.i18n.getMessage('diagnosticsEmpty'));
  assert.equal(await popup.locator('#diagnostics-log').inputValue(), '');
  assert.equal(await popup.locator('#diagnostics-copy').isDisabled(), true);
  await popup.locator('#diagnostics-enabled').uncheck();
  await popup.waitForFunction(() => document.getElementById('diagnostics-status').textContent === chrome.i18n.getMessage('diagnosticsDisabled'));
  await f.frames(1);
  assert.equal((await report()).enabled, false);
  assert.equal(await popup.locator('#diagnostics-log').inputValue(), '');
});

test('popup clears stale logs and explains when the current page has no content script', async t => {
  const f = await openFixture(t, { diagnostics: true });
  const { popup } = await openDiagnosticPopup(t, f);
  await popup.evaluate(() => document.getElementById('diagnostics-show').click());
  await popup.waitForFunction(() => document.getElementById('diagnostics-log').value.length > 0);
  await f.page.goto('about:blank');
  await f.page.bringToFront();
  await popup.evaluate(() => document.getElementById('diagnostics-show').click());
  await popup.waitForFunction(() => document.getElementById('diagnostics-status').textContent === chrome.i18n.getMessage('diagnosticsUnavailable'));
  assert.equal(await popup.locator('#diagnostics-log').inputValue(), '');
  assert.equal(await popup.locator('#diagnostics-copy').isDisabled(), true);
});

for (const manualFrames of [true, false]) {
  test(`finalizes a selection changed by a mouseup handler (${manualFrames ? 'controlled' : 'native'} frames)`, async t => {
    const f = await openFixture(t, { manualFrames, diagnostics: true });
    await f.startDrag({ outside: false });
    await f.frames();
    await f.assertFenced();
    await f.page.evaluate(() => {
      document.addEventListener('mouseup', () => {
        getSelection().setBaseAndExtent(
          document.querySelector('[data-block="first"]').firstChild, 6,
          document.querySelector('[data-block="second"]').firstChild, 20
        );
      }, { once: true });
    });
    await f.page.mouse.up();
    await f.frames();
    const result = await f.selection();
    assert.equal(result.focusInside, true, 'the post-mouseup selection must be clamped before release');
    assert.equal(result.anchorInside, true);
    assert.equal(result.active, false);
    assert.ok(TEXT.includes(result.text));
    const { report } = await openDiagnosticPopup(t, f);
    const events = (await report()).events;
    const finalizing = events.find(event => event.event === 'release.finalizing');
    const completed = events.find(event => event.event === 'release.completed');
    assert.equal(finalizing.selection.focusInsideRoot, false);
    assert.equal(completed.selection.focusInsideRoot, true);
  });
}

test('a hover after mouseup does not cancel final selection correction', async t => {
  const f = await openFixture(t);
  const { end } = await f.startDrag({ outside: false });
  await f.frames();
  await f.assertFenced();
  await f.page.evaluate(() => {
    document.addEventListener('mouseup', () => {
      getSelection().setBaseAndExtent(
        document.querySelector('[data-block="first"]').firstChild, 6,
        document.querySelector('[data-block="second"]').firstChild, 20
      );
    }, { once: true });
  });
  await f.page.mouse.up();
  await f.page.mouse.move(end.x + 10, end.y);
  await f.frames();
  const result = await f.selection();
  assert.equal(result.focusInside, true);
  assert.equal(result.active, false);
});

test('recovers DOM replaced by a mouseup handler before final release', async t => {
  const f = await openFixture(t);
  await f.startDrag({ outside: false });
  await f.frames();
  const before = await f.assertFenced();
  await f.page.evaluate(() => {
    document.addEventListener('mouseup', () => {
      const old = document.querySelector('[data-block="first"]');
      const replacement = document.createElement('p');
      replacement.id = old.id;
      replacement.dataset.block = 'first';
      replacement.textContent = old.textContent;
      old.replaceWith(replacement);
    }, { once: true });
  });
  await f.page.mouse.up();
  await f.frames(6);
  const result = await f.selection();
  assert.equal(result.anchorInside, true);
  assert.equal(result.focusInside, true);
  assert.equal(result.anchorOffset, before.anchorOffset);
  assert.equal(result.active, false);
});

test('popup does not offer a disabled diagnostic report as a usable log', async t => {
  const f = await openFixture(t);
  const { popup } = await openDiagnosticPopup(t, f);
  await popup.evaluate(() => document.getElementById('diagnostics-show').click());
  await popup.waitForFunction(() => document.getElementById('diagnostics-status').textContent.length > 0);
  assert.equal(await popup.locator('#diagnostics-copy').isDisabled(), true);
  assert.equal(await popup.locator('#diagnostics-log').inputValue(), '');
});

test('an older mouseup finalizer does not change a new drag', async t => {
  const f = await openFixture(t);
  await f.startDrag({ outside: false });
  await f.frames();
  await f.assertFenced();
  await f.page.mouse.up();
  const start = await f.point(SECOND);
  const end = await f.point(SECOND, 16);
  await f.page.mouse.move(start.x, start.y);
  await f.page.mouse.down();
  await f.page.mouse.move(end.x, end.y);
  await f.frames();
  assert.equal(await f.page.locator(SECOND).evaluate(element => {
    const selection = getSelection();
    return element.contains(selection.anchorNode) && element.contains(selection.focusNode)
      && element.getAttributeNames().some(name => name.startsWith('data-sbl-root-'));
  }), true);
  await f.page.mouse.up();
  await f.frames();
  assert.equal((await f.selection()).active, false);
});

for (const manualFrames of [true, false]) {
  test(`keeps the lock when buttons=0 arrives before mouseup (${manualFrames ? 'controlled' : 'native'} frames)`, async t => {
    const f = await openFixture(t, { manualFrames, diagnostics: true });
    const { end } = await f.startDrag();
    await f.frames();
    await f.assertFenced();
    await f.buttonlessMove(end);
    // Wait longer than the observed 21 ms ordering gap before sending mouseup.
    await f.frames(2);
    await f.assertFenced();
    await f.page.evaluate(() => {
      document.addEventListener('mouseup', () => {
        getSelection().setBaseAndExtent(
          document.querySelector('[data-block="first"]').firstChild, 6,
          document.querySelector('[data-block="second"]').firstChild, 20
        );
      }, { once: true });
    });
    await f.page.mouse.up();
    await f.frames();
    const result = await f.selection();
    assert.equal(result.anchorInside, true);
    assert.equal(result.focusInside, true);
    assert.equal(result.active, false);
  });
}

test('preserves an activation candidate when buttons=0 precedes mouseup', async t => {
  const f = await openFixture(t);
  const { end } = await f.startDrag();
  await f.buttonlessMove(end);
  await f.frames(2);
  await f.assertFenced();
  await f.page.mouse.up();
  await f.frames();
  const result = await f.selection();
  assert.equal(result.focusInside, true);
  assert.equal(result.active, false);
});

test('preserves the initial press when the only movement has buttons=0', async t => {
  const f = await openFixture(t);
  const start = await f.point(FIRST);
  const end = await f.point(SECOND);
  await f.page.mouse.move(start.x, start.y);
  await f.page.mouse.down();
  await f.buttonlessMove(end);
  await f.frames(2);
  await f.releaseAt(end);
  await f.frames();
  const result = await f.selection();
  assert.equal(result.anchorInside, true);
  assert.equal(result.focusInside, true);
  assert.ok(result.text.length > 0);
  assert.equal(result.active, false);
});

for (const phase of ['locked', 'pending']) {
  test(`finishes a ${phase} drag if mouseup never arrives`, async t => {
    const f = await openFixture(t, { manualFrames: false, diagnostics: true });
    let end;
    let originalText;
    if (phase === 'locked') {
      ({ end } = await f.startDrag({ outside: false }));
      await f.frames();
      originalText = (await f.assertFenced()).text;
    } else {
      const start = await f.point(FIRST);
      end = await f.point(SECOND);
      await f.page.mouse.move(start.x, start.y);
      await f.page.mouse.down();
    }
    await f.buttonlessMove(end);
    await f.frames(2);
    if (phase === 'locked') {
      await f.assertFenced();
      // Later hover positions must neither extend the wait nor replace its endpoint.
      await f.buttonlessMove(await f.point(SECOND));
    }
    await f.page.waitForFunction(() => {
      const active = [...document.documentElement.classList].some(name => name.startsWith('sbl-active-'));
      return !active && getSelection().toString().length > 0;
    });
    await f.frames(2);
    const result = await f.selection();
    assert.equal(result.active, false);
    assert.equal(result.anchorInside, true);
    assert.equal(result.focusInside, true);
    if (phase === 'locked') assert.equal(result.text, originalText);
    const { report } = await openDiagnosticPopup(t, f);
    const events = (await report()).events;
    assert.equal(events.filter(event => event.event === 'release.awaiting_mouseup').length, 1);
    assert.ok(events.some(event => event.event === 'release.mouseup_timeout'));
    assert.ok(events.some(event => event.event === 'release.completed' && event.source === 'mouseup_timeout'));
    assert.ok(!events.some(event => event.event === 'pointer.up'), 'a missing mouseup must not be fabricated');
  });
}

test('resumed held-button movement cancels a premature release hint', async t => {
  const f = await openFixture(t, { manualFrames: false, diagnostics: true });
  const { end } = await f.startDrag({ outside: false });
  await f.frames();
  await f.buttonlessMove(end);
  await f.frames(1);
  await f.page.mouse.move(end.x + 10, end.y);
  await f.page.waitForTimeout(350); // Past the cancelled 250 ms fallback deadline.
  await f.assertFenced();
  await f.page.mouse.up();
  await f.frames();
  const { report } = await openDiagnosticPopup(t, f);
  const events = (await report()).events;
  assert.ok(events.some(event => event.event === 'release.wait_cancelled' && event.reason === 'button_held_again'));
  assert.ok(!events.some(event => event.event === 'release.mouseup_timeout'));
});

test('a new press cancels the previous gesture release deadline', async t => {
  const f = await openFixture(t, { manualFrames: false, diagnostics: true });
  const { end } = await f.startDrag({ outside: false });
  await f.frames();
  await f.buttonlessMove(end);
  const start = await f.point(SECOND);
  const next = await f.point(SECOND, 16);
  const input = await context.newCDPSession(f.page);
  await input.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1
  });
  await f.page.mouse.move(next.x, next.y);
  await f.frames();
  await f.page.waitForTimeout(350); // An old fallback must not finalize this new drag.
  assert.equal(await f.page.locator(SECOND).evaluate(element =>
    element.getAttributeNames().some(name => name.startsWith('data-sbl-root-'))
  ), true);
  await f.page.mouse.up();
  await f.frames();
  const { report } = await openDiagnosticPopup(t, f);
  const events = (await report()).events;
  assert.ok(events.some(event => event.event === 'release.wait_cancelled' && event.reason === 'new_mousedown'));
  assert.ok(!events.some(event => event.event === 'release.mouseup_timeout'));
});

test('Escape cancels a pending mouseup wait and its fallback', async t => {
  const f = await openFixture(t, { manualFrames: false, diagnostics: true });
  const { end } = await f.startDrag({ outside: false });
  await f.frames();
  await f.buttonlessMove(end);
  await f.page.keyboard.press('Escape');
  await f.page.waitForTimeout(350);
  assert.equal((await f.selection()).active, false);
  const { report } = await openDiagnosticPopup(t, f);
  const events = (await report()).events;
  assert.ok(events.some(event => event.event === 'release.wait_cancelled' && event.reason === 'escape'));
  assert.ok(!events.some(event => event.event === 'release.mouseup_timeout'));
});

test('a release hint for an ordinary click does not create a drag', async t => {
  const f = await openFixture(t);
  const start = await f.point(FIRST);
  await f.page.mouse.move(start.x, start.y);
  await f.page.mouse.down();
  await f.buttonlessMove(start);
  await f.frames(2);
  await f.page.mouse.up();
  await f.frames();
  const result = await f.selection();
  assert.equal(result.active, false);
  assert.equal(result.text, '');
});
