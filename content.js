(() => {
  'use strict';

  /* =========================================================
     Selection Fence v1.0.1 (based on Selection Block Lock v3.7)

     Security / privacy
     ---------------------------------------------------------
     - No external network communication
     - No persistent storage of page content, selected text, or form input values
     - Only the behavior mode (smart / nearest / block) is stored in chrome.storage.local
     - No GM/UserScript APIs are used
     - Does not run inside iframes
     - Runs in the Chrome content script ISOLATED world
     - Does not read input values such as input.value
     - Does not collect, store, or transmit page text or selected text
     - Temporarily references only the DOM nodes and text offsets required for selection control

     Performance / compatibility
     ---------------------------------------------------------
     - Performs no caret lookup, DOM mutation, or sensitive-context checks until the pointer moves at least 4 px
     - After drag confirmation, re-resolves the current Selection/DOM on the next animation frame
     - Avoids operating on stale elements if hydration or an SPA replaces the DOM immediately after the drag starts
     - Does not inherit an old anchor when a previous selection is still present
     - No continuous timers, MutationObserver, network activity, or background processing
     - Ignores synthetic mouse events
     - Does not interfere with double-click selection, modifier-key operations, or native drag behavior
     - Manages requestAnimationFrame callbacks so they can be cancelled safely
     ========================================================= */


  /* =========================================================
     Configuration
     ========================================================= */

  /*
   * How to constrain the selection when the pointer leaves the text block.
   *
   * 'smart'   : Use the nearest text for small excursions; clamp to the block boundary for large excursions
   * 'nearest' : Always clamp to the text position nearest to the pointer within the starting block
   * 'block'   : Always clamp to the beginning or end of the starting block (similar to v3.4 behavior)
   */
  let clampMode = 'smart';

  /* Treat movement at or above this distance as a drag. CSS px. */
  const DRAG_THRESHOLD = 4;

  /* Auto-pause within this distance of a sensitive field. CSS px. */
  const SENSITIVE_DISTANCE = 320;

  /* Maximum excursion treated as "small" in smart mode. CSS px. */
  const SMART_NEAREST_DISTANCE = 72;

  /* Inner inset used when clamping coordinates back inside the block. CSS px. */
  const CLAMP_INSET = 2;

  const VALID_CLAMP_MODES = new Set([
    'smart',
    'nearest',
    'block'
  ]);

  function normalizeClampMode(value) {
    return VALID_CLAMP_MODES.has(value)
      ? value
      : 'smart';
  }

  function loadClampMode() {
    try {
      chrome.storage.local.get(
        { clampMode: 'smart' },
        result => {
          if (chrome.runtime.lastError) {
            return;
          }

          clampMode = normalizeClampMode(
            result && result.clampMode
          );
        }
      );
    } catch (_) {
      clampMode = 'smart';
    }
  }

  try {
    chrome.storage.onChanged.addListener(
      (changes, areaName) => {
        if (
          areaName === 'local' &&
          changes.clampMode
        ) {
          clampMode = normalizeClampMode(
            changes.clampMode.newValue
          );
        }
      }
    );
  } catch (_) {}

  loadClampMode();


  /* =========================================================
     Runtime state
     ========================================================= */

  /* State after mousedown but before the drag is confirmed. No DOM changes yet. */
  let pending = null;

  /* Waiting state after crossing 4 px, until the next frame re-resolves the start position. */
  let activationCandidate = null;
  let activationFrameId = null;

  /* Selection Lock is currently active. */
  let state = null;

  let correcting = false;
  let clampFrameId = null;
  let releaseFrameId = null;
  let styleElement = null;


  /* =========================================================
     Runtime-unique identifiers
     ========================================================= */

  const TOKEN = (() => {
    try {
      if (
        typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function'
      ) {
        return crypto.randomUUID().replace(/-/g, '');
      }
    } catch (_) {}

    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2)
    );
  })();

  const ROOT_ATTR = `data-sbl-root-${TOKEN}`;
  const PATH_ATTR = `data-sbl-path-${TOKEN}`;
  const ACTIVE_CLASS = `sbl-active-${TOKEN}`;


  /* =========================================================
     Selectors
     ========================================================= */

  const TEXT_BLOCKS = [
    'a',
    'p',
    'li',
    'dt',
    'dd',
    'td',
    'th',
    'blockquote',
    'pre',
    'figcaption',
    'caption',
    'summary',
    'label',
    'legend',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    '[role="heading"]',
    '[role="paragraph"]'
  ].join(',');

  const EXCLUDED_INTERACTION_TARGETS = [
    'input',
    'textarea',
    'select',
    'button',
    '[role="button"]',
    '[contenteditable]:not([contenteditable="false"])'
  ].join(',');

  const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'cc-exp-month',
    'cc-exp-year'
  ]);

  const SENSITIVE_CANDIDATE_SELECTOR = [
    'input[type="password"]',
    'input[autocomplete]',
    'textarea[autocomplete]',
    'select[autocomplete]'
  ].join(',');

  const NON_RENDERED_TEXT_ANCESTORS =
    'script,style,template,noscript';


  /* =========================================================
     CSS
     ========================================================= */

  /*
   * Inject the CSS only once, on the first drag.
   * When ACTIVE_CLASS is absent, none of these rules have any effect.
   */
  function installCSS() {
    if (
      styleElement &&
      styleElement.isConnected
    ) {
      return;
    }

    const style = document.createElement('style');

    style.textContent = `
      html.${ACTIVE_CLASS}
      body *:not([${PATH_ATTR}]):not([${ROOT_ATTR}]):not([${ROOT_ATTR}] *) {
        -webkit-user-select: none !important;
        -moz-user-select: none !important;
        user-select: none !important;
      }

      html.${ACTIVE_CLASS} [${ROOT_ATTR}],
      html.${ACTIVE_CLASS} [${ROOT_ATTR}] * {
        -webkit-user-select: text !important;
        -moz-user-select: text !important;
        user-select: text !important;
      }
    `;

    (
      document.head ||
      document.documentElement
    ).appendChild(style);

    styleElement = style;
  }

  function removeCSS() {
    if (!styleElement) {
      return;
    }

    try {
      styleElement.remove();
    } catch (_) {}

    styleElement = null;
  }


  /* =========================================================
     General DOM helpers
     ========================================================= */

  function elementOf(node) {
    if (!node) {
      return null;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      return node;
    }

    return node.parentElement;
  }

  function isExcludedInteractionTarget(el) {
    if (!(el instanceof Element)) {
      return true;
    }

    return !!el.closest(EXCLUDED_INTERACTION_TARGETS);
  }

  function positionInside(root, pos) {
    if (
      !root ||
      !pos ||
      !pos.node
    ) {
      return false;
    }

    const el = elementOf(pos.node);

    return !!el && (
      el === root ||
      root.contains(el)
    );
  }


  /* =========================================================
     Live Selection recovery
     ========================================================= */

  /*
   * Capture references to the Selection state at mousedown.
   * The text content itself is not retrieved.
   */
  function captureSelectionSnapshot() {
    const selection = window.getSelection();

    if (!selection) {
      return null;
    }

    return {
      rangeCount: selection.rangeCount,
      isCollapsed: selection.isCollapsed,
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset
    };
  }

  function selectionChangedSince(snapshot, selection) {
    if (!snapshot) {
      return true;
    }

    return (
      snapshot.rangeCount !== selection.rangeCount ||
      snapshot.anchorNode !== selection.anchorNode ||
      snapshot.anchorOffset !== selection.anchorOffset ||
      snapshot.focusNode !== selection.focusNode ||
      snapshot.focusOffset !== selection.focusOffset
    );
  }

  function connectedPosition(node, offset) {
    if (
      !node ||
      !node.isConnected ||
      !Number.isInteger(offset) ||
      offset < 0
    ) {
      return null;
    }

    return {
      node,
      offset
    };
  }

  /*
   * v3.6:
   * Instead of resolving the anchor inside the mousemove handler after crossing 4 px,
   * wait until the next animation frame and prefer the Selection.anchor produced by the browser.
   *
   * Even if hydration or another startup process replaces the DOM immediately after page load,
   * do not keep using stale Element references.
   *
   * Only if the browser Selection has not updated yet,
   * fall back to resolving the caret from the original pointer coordinates.
   */
  /*
   * v3.7:
   * Resolve the anchor for a new drag from the position where this mousedown started.
   *
   * If text was already selected, Chrome may temporarily keep the old Selection.anchor
   * while moving only the focus to the new drag position.
   * Reusing that anchor would create a huge selection from the previous selection position
   * to the current pointer position.
   *
   * Therefore:
   * 1. If a non-collapsed selection already existed at mousedown, never inherit its old anchor;
   *    resolve a fresh caret from the current DOM at the mousedown coordinates.
   * 2. If there was no existing selection, prefer the Selection.anchor created by the browser
   *    on the next frame, and fall back to the original coordinates if it has not updated yet.
   * 3. After DOM replacement, use only connected positions and never stale nodes.
   * 3. After DOM replacement, use only connected positions and never stale nodes.
   */
  function resolveLiveDragAnchor(candidate) {
    const snapshot = candidate.initialSelection;

    const coordinateAnchor = caretAt(
      candidate.startX,
      candidate.startY
    );

    const usableCoordinateAnchor = (() => {
      if (
        !coordinateAnchor ||
        !coordinateAnchor.node ||
        !coordinateAnchor.node.isConnected
      ) {
        return null;
      }

      const coordinateElement = elementOf(
        coordinateAnchor.node
      );

      if (
        !coordinateElement ||
        isExcludedInteractionTarget(
          coordinateElement
        )
      ) {
        return null;
      }

      return coordinateAnchor;
    })();

    /* If a previous selection is still present, do not inherit its old anchor. */
    if (
      snapshot &&
      snapshot.rangeCount > 0 &&
      snapshot.isCollapsed === false
    ) {
      return usableCoordinateAnchor;
    }

    const selection = window.getSelection();

    if (
      selection &&
      selection.rangeCount > 0 &&
      selection.anchorNode &&
      selection.anchorNode.isConnected &&
      selectionChangedSince(
        snapshot,
        selection
      )
    ) {
      const liveAnchor = connectedPosition(
        selection.anchorNode,
        selection.anchorOffset
      );

      if (liveAnchor) {
        const liveElement = elementOf(
          liveAnchor.node
        );

        if (
          liveElement &&
          !isExcludedInteractionTarget(
            liveElement
          )
        ) {
          return liveAnchor;
        }
      }
    }

    return usableCoordinateAnchor;
  }


  /* =========================================================
     Sensitive-context detection
     ========================================================= */

  function isSensitiveField(el) {
    if (!(el instanceof Element)) {
      return false;
    }

    if (
      el.localName === 'input' &&
      (el.getAttribute('type') || '').toLowerCase() === 'password'
    ) {
      return true;
    }

    const raw = el.getAttribute('autocomplete');

    if (!raw) {
      return false;
    }

    return raw
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .some(token =>
        SENSITIVE_AUTOCOMPLETE_TOKENS.has(token)
      );
  }

  function isRendered(el) {
    if (
      !(el instanceof Element) ||
      !el.isConnected
    ) {
      return false;
    }

    if (typeof el.checkVisibility === 'function') {
      try {
        if (
          !el.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
            contentVisibilityAuto: true
          })
        ) {
          return false;
        }
      } catch (_) {
        /* Older implementations fall through to the standard visibility checks below. */
      }
    }

    let style;

    try {
      style = getComputedStyle(el);
    } catch (_) {
      return false;
    }

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }

    try {
      const rect = el.getBoundingClientRect();

      return (
        rect.width > 0 &&
        rect.height > 0 &&
        el.getClientRects().length > 0
      );
    } catch (_) {
      return false;
    }
  }

  function distanceToRect(x, y, rect) {
    const dx =
      x < rect.left
        ? rect.left - x
        : x > rect.right
          ? x - rect.right
          : 0;

    const dy =
      y < rect.top
        ? rect.top - y
        : y > rect.bottom
          ? y - rect.bottom
          : 0;

    return Math.hypot(dx, dy);
  }

  function sensitiveContainer(el) {
    if (!(el instanceof Element)) {
      return null;
    }

    return el.closest([
      'form',
      '[role="form"]',
      'dialog',
      '[role="dialog"]'
    ].join(','));
  }

  /*
   * Run only after the drag has been confirmed.
   * Inspect only element types, attributes, and geometry; never read input values.
   */
  function isSensitiveContext(startElement, x, y) {
    if (
      !(startElement instanceof Element) ||
      !startElement.isConnected
    ) {
      return false;
    }

    let closestCandidate = null;

    try {
      closestCandidate = startElement.closest(
        SENSITIVE_CANDIDATE_SELECTOR
      );
    } catch (_) {}

    if (
      closestCandidate &&
      isSensitiveField(closestCandidate)
    ) {
      return true;
    }

    let candidates;

    try {
      candidates = document.querySelectorAll(
        SENSITIVE_CANDIDATE_SELECTOR
      );
    } catch (_) {
      return false;
    }

    for (const field of candidates) {
      if (
        !isSensitiveField(field) ||
        !isRendered(field)
      ) {
        continue;
      }

      const container = sensitiveContainer(field);

      if (
        container &&
        (
          container === startElement ||
          container.contains(startElement)
        )
      ) {
        return true;
      }

      try {
        if (
          distanceToRect(
            x,
            y,
            field.getBoundingClientRect()
          ) <= SENSITIVE_DISTANCE
        ) {
          return true;
        }
      } catch (_) {}
    }

    return false;
  }


  /* =========================================================
     Caret lookup
     ========================================================= */

  function caretAt(x, y) {
    if (
      typeof document.caretPositionFromPoint === 'function'
    ) {
      try {
        const position =
          document.caretPositionFromPoint(x, y);

        if (position) {
          return {
            node: position.offsetNode,
            offset: position.offset
          };
        }
      } catch (_) {}
    }

    if (
      typeof document.caretRangeFromPoint === 'function'
    ) {
      try {
        const range =
          document.caretRangeFromPoint(x, y);

        if (range) {
          return {
            node: range.startContainer,
            offset: range.startOffset
          };
        }
      } catch (_) {}
    }

    return null;
  }


  /* =========================================================
     Selection-root detection
     ========================================================= */

  function findRoot(node) {
    let el = elementOf(node);

    if (!el) {
      return null;
    }

    const semantic = el.closest(TEXT_BLOCKS);

    if (semantic) {
      return semantic;
    }

    let current = el;

    while (
      current &&
      current !== document.body &&
      current !== document.documentElement
    ) {
      let display;

      try {
        display = getComputedStyle(current).display;
      } catch (_) {
        current = current.parentElement;
        continue;
      }

      if (
        [
          'block',
          'inline-block',
          'list-item',
          'table-cell',
          'flow-root',
          'flex',
          'inline-flex',
          'grid',
          'inline-grid'
        ].includes(display)
      ) {
        return current;
      }

      current = current.parentElement;
    }

    /* Never lock the entire body/html as the selection root. */
    return null;
  }


  /* =========================================================
     Meaningful text boundaries
     ========================================================= */

  function firstNonWhitespaceOffset(text) {
    const match = /\S/.exec(text);

    return match
      ? match.index
      : null;
  }

  function lastNonWhitespaceEndOffset(text) {
    for (let i = text.length - 1; i >= 0; i -= 1) {
      if (!/\s/.test(text[i])) {
        return i + 1;
      }
    }

    return null;
  }

  function textAncestorsAreVisible(node) {
    let el = elementOf(node);

    if (!el) {
      return false;
    }

    if (el.closest(NON_RENDERED_TEXT_ANCESTORS)) {
      return false;
    }

    while (
      el &&
      el !== document.documentElement
    ) {
      let style;

      try {
        style = getComputedStyle(el);
      } catch (_) {
        return false;
      }

      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }

      el = el.parentElement;
    }

    return true;
  }

  function isRenderedTextSlice(node, startOffset, endOffset) {
    if (
      !node ||
      node.nodeType !== Node.TEXT_NODE ||
      !node.isConnected ||
      !textAncestorsAreVisible(node)
    ) {
      return false;
    }

    try {
      const range = document.createRange();

      range.setStart(node, startOffset);
      range.setEnd(node, endOffset);

      for (const rect of range.getClientRects()) {
        if (
          rect.width > 0 ||
          rect.height > 0
        ) {
          return true;
        }
      }
    } catch (_) {}

    return false;
  }

  function firstTextPosition(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT
    );

    let node;

    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      const offset = firstNonWhitespaceOffset(text);

      if (offset === null) {
        continue;
      }

      if (
        isRenderedTextSlice(
          node,
          offset,
          Math.min(offset + 1, text.length)
        )
      ) {
        return {
          node,
          offset
        };
      }
    }

    return null;
  }

  function lastTextPosition(root) {
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT
    );

    let node;
    let meaningful = null;

    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      const endOffset =
        lastNonWhitespaceEndOffset(text);

      if (endOffset === null) {
        continue;
      }

      if (
        isRenderedTextSlice(
          node,
          Math.max(0, endOffset - 1),
          endOffset
        )
      ) {
        meaningful = {
          node,
          offset: endOffset
        };
      }
    }

    return meaningful;
  }


  /* =========================================================
     Clamp-position calculation
     ========================================================= */

  function clampedCoordinate(value, start, end, inset) {
    const size = end - start;

    if (size <= 0) {
      return start;
    }

    if (size <= inset * 2) {
      return start + size / 2;
    }

    return Math.min(
      Math.max(value, start + inset),
      end - inset
    );
  }

  function caretClampedToRoot(root, x, y, rect) {
    const safeX = clampedCoordinate(
      x,
      rect.left,
      rect.right,
      CLAMP_INSET
    );

    const safeY = clampedCoordinate(
      y,
      rect.top,
      rect.bottom,
      CLAMP_INSET
    );

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const probes = [
      [safeX, safeY],
      [safeX, centerY],
      [centerX, safeY],
      [clampedCoordinate(rect.left, rect.left, rect.right, CLAMP_INSET), safeY],
      [clampedCoordinate(rect.right, rect.left, rect.right, CLAMP_INSET), safeY]
    ];

    for (const [probeX, probeY] of probes) {
      const pos = caretAt(probeX, probeY);

      if (
        pos &&
        positionInside(root, pos)
      ) {
        return pos;
      }
    }

    return null;
  }

  function shouldUseFirstBoundary(root, x, y, rect) {
    let direction = 'ltr';
    let writingMode = 'horizontal-tb';

    try {
      const style = getComputedStyle(root);

      direction = style.direction || direction;
      writingMode = style.writingMode || writingMode;
    } catch (_) {}

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const vertical =
      writingMode.startsWith('vertical') ||
      writingMode.startsWith('sideways');

    if (vertical) {
      if (y < rect.top) {
        return true;
      }

      if (y > rect.bottom) {
        return false;
      }

      return y <= centerY;
    }

    if (y < rect.top) {
      return true;
    }

    if (y > rect.bottom) {
      return false;
    }

    if (direction === 'rtl') {
      if (x > rect.right) {
        return true;
      }

      if (x < rect.left) {
        return false;
      }

      return x >= centerX;
    }

    if (x < rect.left) {
      return true;
    }

    if (x > rect.right) {
      return false;
    }

    return x <= centerX;
  }

  function blockBoundaryPosition(root, x, y, rect) {
    return shouldUseFirstBoundary(
      root,
      x,
      y,
      rect
    )
      ? firstTextPosition(root)
      : lastTextPosition(root);
  }

  function resolveClampFocus(root, x, y) {
    let rect;

    try {
      rect = root.getBoundingClientRect();
    } catch (_) {
      return null;
    }

    if (
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }

    const boundary = () =>
      blockBoundaryPosition(
        root,
        x,
        y,
        rect
      );

    if (clampMode === 'block') {
      return boundary();
    }

    const nearest = caretClampedToRoot(
      root,
      x,
      y,
      rect
    );

    if (clampMode === 'nearest') {
      return nearest || boundary();
    }

    /* smart */
    if (
      distanceToRect(x, y, rect) <=
      SMART_NEAREST_DISTANCE
    ) {
      return nearest || boundary();
    }

    return boundary();
  }


  /* =========================================================
     Selection control
     ========================================================= */

  function setSelection(anchor, focus) {
    if (
      !anchor ||
      !focus
    ) {
      return;
    }

    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    try {
      correcting = true;

      if (
        typeof selection.setBaseAndExtent === 'function'
      ) {
        selection.setBaseAndExtent(
          anchor.node,
          anchor.offset,
          focus.node,
          focus.offset
        );

        return;
      }

      const range = document.createRange();

      range.setStart(
        anchor.node,
        anchor.offset
      );

      range.collapse(true);

      selection.removeAllRanges();
      selection.addRange(range);

      if (typeof selection.extend === 'function') {
        selection.extend(
          focus.node,
          focus.offset
        );
      }
    } catch (_) {
      /* If an SPA changes the DOM, fail safely and leave the selection untouched. */
    } finally {
      correcting = false;
    }
  }

  function clampToRoot() {
    if (
      !state ||
      !state.root ||
      !state.root.isConnected ||
      !state.anchor.node ||
      !state.anchor.node.isConnected
    ) {
      deactivate();
      return;
    }

    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    /*
     * If the browser Selection is temporarily lost because the DOM was replaced during page startup,
     * rebuild the selection from the current root/anchor and pointer position.
     * rebuild the selection from the current root/anchor and pointer position.
     */
    if (!selection.focusNode) {
      const recoveredFocus =
        resolveClampFocus(
          state.root,
          state.x,
          state.y
        ) ||
        state.lastValidFocus ||
        state.anchor;

      if (recoveredFocus) {
        setSelection(
          state.anchor,
          recoveredFocus
        );
      }

      return;
    }

    let rootRect;

    try {
      rootRect = state.root.getBoundingClientRect();
    } catch (_) {
      deactivate();
      return;
    }

    const pointerOutsideRoot = (
      state.x < rootRect.left ||
      state.x > rootRect.right ||
      state.y < rootRect.top ||
      state.y > rootRect.bottom
    );

    const focusInsideRoot = positionInside(
      state.root,
      {
        node: selection.focusNode,
        offset: selection.focusOffset
      }
    );

    /*
     * If both the pointer and Selection focus are inside the root,
     * leave selection behavior entirely to the browser.
     *
     * If the pointer is outside the root, compensate according to the selected clamp mode
     * even when CSS keeps focusNode inside the root.
     */
    if (
      focusInsideRoot &&
      selection.focusNode &&
      selection.focusNode.isConnected
    ) {
      state.lastValidFocus = {
        node: selection.focusNode,
        offset: selection.focusOffset
      };
    }

    if (
      focusInsideRoot &&
      !pointerOutsideRoot
    ) {
      return;
    }

    const focus =
      resolveClampFocus(
        state.root,
        state.x,
        state.y
      ) ||
      (
        state.lastValidFocus &&
        state.lastValidFocus.node &&
        state.lastValidFocus.node.isConnected &&
        positionInside(
          state.root,
          state.lastValidFocus
        )
          ? state.lastValidFocus
          : state.anchor
      );

    if (focus) {
      setSelection(
        state.anchor,
        focus
      );
    }
  }

  function cancelClamp() {
    if (clampFrameId === null) {
      return;
    }

    cancelAnimationFrame(clampFrameId);
    clampFrameId = null;
  }

  function scheduleClamp() {
    if (
      clampFrameId !== null ||
      !state
    ) {
      return;
    }

    clampFrameId = requestAnimationFrame(() => {
      clampFrameId = null;
      clampToRoot();
    });
  }

  function cancelRelease() {
    if (releaseFrameId === null) {
      return;
    }

    cancelAnimationFrame(releaseFrameId);
    releaseFrameId = null;
  }


  /* =========================================================
     Exact DOM restoration
     ========================================================= */

  function setTrackedAttribute(
    touched,
    element,
    attribute,
    value = ''
  ) {
    touched.push({
      element,
      attribute,
      existed: element.hasAttribute(attribute),
      previousValue: element.getAttribute(attribute)
    });

    element.setAttribute(attribute, value);
  }

  function restoreTrackedAttributes(touched) {
    if (!Array.isArray(touched)) {
      return;
    }

    for (const item of touched) {
      try {
        if (!item.element) {
          continue;
        }

        if (item.existed) {
          item.element.setAttribute(
            item.attribute,
            item.previousValue ?? ''
          );
        } else {
          item.element.removeAttribute(
            item.attribute
          );
        }
      } catch (_) {}
    }
  }


  /* =========================================================
     Deferred activation (v3.7)
     ========================================================= */

  function cancelActivation() {
    if (activationFrameId !== null) {
      cancelAnimationFrame(activationFrameId);
      activationFrameId = null;
    }

    activationCandidate = null;
  }

  function releaseActiveLockSoon() {
    if (!state) {
      return;
    }

    const oldState = state;

    cancelRelease();

    releaseFrameId = requestAnimationFrame(() => {
      releaseFrameId = null;

      if (state === oldState) {
        deactivate();
      }
    });
  }

  function activateCandidate(liveCandidate) {
    if (!liveCandidate) {
      return;
    }

    const anchor = resolveLiveDragAnchor(
      liveCandidate
    );

    if (!anchor) {
      return;
    }

    const startElement = elementOf(anchor.node);

    if (
      !startElement ||
      !startElement.isConnected ||
      isExcludedInteractionTarget(startElement)
    ) {
      return;
    }

    const root = findRoot(anchor.node);

    if (
      !root ||
      !root.isConnected ||
      !positionInside(root, anchor)
    ) {
      return;
    }

    /*
     * If the DOM was replaced, re-check the sensitive context using the Element
     * that currently contains the resolved anchor.
     */
    if (
      isSensitiveContext(
        startElement,
        liveCandidate.startX,
        liveCandidate.startY
      )
    ) {
      return;
    }

    if (
      !activate(
        root,
        anchor,
        liveCandidate.currentX,
        liveCandidate.currentY
      )
    ) {
      return;
    }

    /*
     * For a very quick drag followed by mouseup before the first animation frame,
     * clamp the final selection once before releasing the lock.
     */
    if (liveCandidate.released) {
      clampToRoot();
      releaseActiveLockSoon();
      return;
    }

    scheduleClamp();
  }

  function beginActivation(candidate) {
    cancelActivation();

    activationCandidate = candidate;

    activationFrameId = requestAnimationFrame(() => {
      activationFrameId = null;

      const liveCandidate = activationCandidate;
      activationCandidate = null;

      activateCandidate(liveCandidate);
    });
  }


  /* =========================================================
     Lock lifecycle
     ========================================================= */

  function activate(root, anchor, x, y) {
    deactivate();
    installCSS();

    const touched = [];
    const html = document.documentElement;
    const activeClassAlreadyPresent =
      html.classList.contains(ACTIVE_CLASS);

    try {
      setTrackedAttribute(
        touched,
        root,
        ROOT_ATTR
      );

      let el = root.parentElement;

      while (el) {
        setTrackedAttribute(
          touched,
          el,
          PATH_ATTR
        );

        if (el === document.body) {
          break;
        }

        el = el.parentElement;
      }

      html.classList.add(ACTIVE_CLASS);

      state = {
        root,
        anchor,
        x,
        y,
        lastValidFocus: anchor,
        touched,
        activeClassAlreadyPresent
      };

      return true;
    } catch (_) {
      restoreTrackedAttributes(touched);

      if (!activeClassAlreadyPresent) {
        try {
          html.classList.remove(ACTIVE_CLASS);
        } catch (_) {}
      }

      state = null;
      return false;
    }
  }

  function deactivate() {
    cancelClamp();
    cancelRelease();

    const oldState = state;
    state = null;

    if (!oldState) {
      return;
    }

    restoreTrackedAttributes(oldState.touched);

    if (!oldState.activeClassAlreadyPresent) {
      try {
        document.documentElement
          .classList
          .remove(ACTIVE_CLASS);
      } catch (_) {}
    }
  }

  function resetEverything() {
    pending = null;
    cancelActivation();
    deactivate();
  }

  function destroy() {
    resetEverything();
    removeCSS();
  }


  /* =========================================================
     Event helpers
     ========================================================= */

  function shouldBypassMouseDown(e) {
    return (
      e.button !== 0 ||
      e.detail > 1 ||
      e.altKey ||
      e.shiftKey ||
      e.ctrlKey ||
      e.metaKey
    );
  }


  /* =========================================================
     Mouse events
     ========================================================= */

  document.addEventListener(
    'mousedown',
    e => {
      if (!e.isTrusted) {
        return;
      }

      resetEverything();

      if (
        shouldBypassMouseDown(e) ||
        !(e.target instanceof Element) ||
        isExcludedInteractionTarget(e.target)
      ) {
        return;
      }

      /*
       * At this point, do not perform caret lookup, ancestor traversal, sensitive-context checks, or DOM mutation.
       * Keep only the start coordinates and the initial Selection snapshot in memory.
       */
      pending = {
        startX: e.clientX,
        startY: e.clientY,
        initialSelection: captureSelectionSnapshot()
      };
    },
    true
  );

  document.addEventListener(
    'mousemove',
    e => {
      if (!e.isTrusted) {
        return;
      }

      if (state) {
        if (!(e.buttons & 1)) {
          resetEverything();
          return;
        }

        state.x = e.clientX;
        state.y = e.clientY;

        scheduleClamp();
        return;
      }

      /*
       * After crossing 4 px, wait for the next animation frame to re-resolve Selection/DOM.
       * If additional mousemove events arrive while waiting, update only the latest pointer coordinates.
       */
      if (activationCandidate) {
        if (!(e.buttons & 1)) {
          cancelActivation();
          return;
        }

        activationCandidate.currentX = e.clientX;
        activationCandidate.currentY = e.clientY;
        return;
      }

      if (!pending) {
        return;
      }

      if (!(e.buttons & 1)) {
        pending = null;
        return;
      }

      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;

      if (
        Math.hypot(dx, dy) <
        DRAG_THRESHOLD
      ) {
        return;
      }

      const candidate = {
        ...pending,
        currentX: e.clientX,
        currentY: e.clientY
      };

      pending = null;

      /*
       * Do not decide inside the current mousemove handler; wait until the next animation frame.
       * This lets the browser apply its native Selection changes and any startup DOM updates first,
       * then re-resolve the current anchor/root.
       */
      beginActivation(candidate);
    },
    true
  );

  document.addEventListener(
    'mouseup',
    e => {
      if (!e.isTrusted) {
        return;
      }

      /*
       * Even if mousemove events are coalesced or skipped, if the total mousedown-to-mouseup
       * movement exceeds the threshold, inspect the final Selection on the next frame.
       */
      if (pending) {
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;

        if (
          Math.hypot(dx, dy) >=
          DRAG_THRESHOLD
        ) {
          const candidate = {
            ...pending,
            currentX: e.clientX,
            currentY: e.clientY,
            released: true
          };

          pending = null;
          beginActivation(candidate);
          return;
        }

        pending = null;
      }

      /*
       * If activation is already pending after crossing 4 px, do not cancel it on mouseup;
       * allow the completed post-mouseup Selection to be clamped on the next frame.
       */
      if (activationCandidate) {
        activationCandidate.currentX = e.clientX;
        activationCandidate.currentY = e.clientY;
        activationCandidate.released = true;
        return;
      }

      if (!state) {
        return;
      }

      state.x = e.clientX;
      state.y = e.clientY;
      clampToRoot();

      if (!state) {
        return;
      }

      releaseActiveLockSoon();
    },
    true
  );


  /* =========================================================
     Selection and native-operation events
     ========================================================= */

  document.addEventListener(
    'selectionchange',
    () => {
      if (
        !state ||
        correcting
      ) {
        return;
      }

      scheduleClamp();
    }
  );

  document.addEventListener(
    'dragstart',
    e => {
      if (e.isTrusted) {
        resetEverything();
      }
    },
    true
  );

  document.addEventListener(
    'contextmenu',
    e => {
      if (e.isTrusted) {
        resetEverything();
      }
    },
    true
  );

  document.addEventListener(
    'keydown',
    e => {
      if (
        e.isTrusted &&
        e.key === 'Escape'
      ) {
        resetEverything();
      }
    },
    true
  );


  /* =========================================================
     Safety cleanup
     ========================================================= */

  window.addEventListener(
    'blur',
    resetEverything,
    true
  );

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) {
        resetEverything();
      }
    }
  );

  window.addEventListener(
    'pagehide',
    destroy,
    true
  );
})();
