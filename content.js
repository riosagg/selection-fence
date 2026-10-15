(() => {
  'use strict';

  /* =========================================================
     Selection Fence v1.0.1 (based on Selection Block Lock v3.7)

     Security / privacy
     ---------------------------------------------------------
     - No external network communication
     - No persistent storage of page content, selected text, or form input values
     - Only the behavior mode and diagnostic logging preference are stored in chrome.storage.local
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
     - Retries transient startup failures without discarding the current drag
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
  let diagnosticsEnabled = false;
  const DIAGNOSTIC_LIMIT = 200;
  const scriptStartedAt = performance.now();
  const diagnosticEvents = [];
  let droppedDiagnosticEvents = 0;
  let diagnosticSequence = 0;
  let interactionSequence = 0;
  let modeSettingsRevision = 0;
  let diagnosticSettingsRevision = 0;

  /* Treat movement at or above this distance as a drag. CSS px. */
  const DRAG_THRESHOLD = 4;

  /* Retry transient startup failures for a short burst, then wait for new input. */
  const MAX_ACTIVATION_ATTEMPTS = 8;

  /* Some input sources report buttons=0 before delivering mouseup. */
  const MOUSEUP_WAIT_MS = 250;

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

  function loadSettings() {
    const modeRevision = modeSettingsRevision;
    const diagnosticsRevision = diagnosticSettingsRevision;
    try {
      chrome.storage.local.get(
        { clampMode: 'smart', diagnosticsEnabled: false },
        result => {
          if (chrome.runtime.lastError) {
            return;
          }

          // A storage change may arrive before this older read completes.
          if (modeSettingsRevision === modeRevision) {
            clampMode = normalizeClampMode(result && result.clampMode);
          }
          if (diagnosticSettingsRevision === diagnosticsRevision) {
            setDiagnosticsEnabled(result && result.diagnosticsEnabled === true);
          }
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
          modeSettingsRevision += 1;
          clampMode = normalizeClampMode(
            changes.clampMode.newValue
          );
          diagnostic('settings.mode_changed');
        }
        if (areaName === 'local' && changes.diagnosticsEnabled) {
          diagnosticSettingsRevision += 1;
          setDiagnosticsEnabled(changes.diagnosticsEnabled.newValue === true);
        }
      }
    );
  } catch (_) {}

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
  let mouseupWait = null;
  let styleElement = null;

  /* =========================================================
     Optional, bounded diagnostics (no page text, URLs, or DOM identifiers)
     ========================================================= */

  function diagnosticPhase() {
    if (state) return 'locked';
    if (activationCandidate) return 'activating';
    if (pending) return 'pending';
    return 'idle';
  }

  function diagnostic(event, details = {}) {
    if (!diagnosticsEnabled) return;

    if (diagnosticEvents.length === DIAGNOSTIC_LIMIT) {
      diagnosticEvents.shift();
      droppedDiagnosticEvents += 1;
    }
    diagnosticEvents.push({
      sequence: ++diagnosticSequence,
      elapsedMs: Math.round(performance.now() - scriptStartedAt),
      interaction: interactionSequence,
      event,
      phase: diagnosticPhase(),
      mode: clampMode,
      readyState: document.readyState,
      ...details
    });
  }

  function diagnosticTag(element) {
    if (!diagnosticsEnabled || !(element instanceof Element)) return null;
    // Custom tag names, ids, classes, attributes and node objects are never exported.
    return /^(a|p|li|dt|dd|td|th|blockquote|pre|figcaption|caption|summary|label|legend|h[1-6]|div|span|strong|em|code|main|article|section|nav|aside|header|footer|body|html|input|textarea|select|button|form|dialog)$/.test(element.localName)
      ? element.localName
      : 'other';
  }

  function diagnosticPosition(position) {
    if (!diagnosticsEnabled || !position || !position.node) return null;
    return {
      kind: position.node.nodeType === Node.TEXT_NODE ? 'text' : 'other',
      tag: diagnosticTag(elementOf(position.node)),
      connected: position.node.isConnected,
      offset: position.offset
    };
  }

  function diagnosticError(error) {
    // Exception messages may contain site data; retain only standard error names.
    return /^(Error|TypeError|ReferenceError|IndexSizeError|InvalidStateError|NotFoundError|SecurityError)$/.test(error && error.name)
      ? error.name
      : 'Error';
  }

  function diagnosticSelection() {
    if (!diagnosticsEnabled) return null;
    const selection = window.getSelection();
    if (!selection) return null;
    const anchor = { node: selection.anchorNode, offset: selection.anchorOffset };
    const focus = { node: selection.focusNode, offset: selection.focusOffset };
    return {
      collapsed: selection.isCollapsed,
      anchor: diagnosticPosition(anchor),
      focus: diagnosticPosition(focus),
      anchorInsideRoot: state ? positionInside(state.root, anchor) : null,
      focusInsideRoot: state ? positionInside(state.root, focus) : null
    };
  }

  function setDiagnosticsEnabled(enabled) {
    if (diagnosticsEnabled === enabled) return;
    diagnosticsEnabled = enabled;
    diagnosticEvents.length = 0;
    droppedDiagnosticEvents = 0;
    if (enabled) diagnostic('diagnostics.enabled');
  }

  function diagnosticReport() {
    return {
      schemaVersion: 1,
      extensionVersion: chrome.runtime.getManifest().version,
      enabled: diagnosticsEnabled,
      limit: DIAGNOSTIC_LIMIT,
      droppedEvents: droppedDiagnosticEvents,
      status: {
        phase: diagnosticPhase(),
        mode: clampMode,
        readyState: document.readyState,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        awaitingMouseUp: mouseupWait !== null,
        attempts: activationCandidate ? activationCandidate.attempts : 0,
        lastFailure: activationCandidate ? activationCandidate.failureReason || null : null
      },
      events: diagnosticEvents.slice()
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message && message.type === 'selection-fence:diagnostics:get') {
      sendResponse(diagnosticReport());
    } else if (message && message.type === 'selection-fence:diagnostics:clear') {
      diagnosticEvents.length = 0;
      droppedDiagnosticEvents = 0;
      sendResponse(diagnosticReport());
    } else if (message && message.type === 'selection-fence:diagnostics:sync') {
      const revision = diagnosticSettingsRevision;
      chrome.storage.local.get({ diagnosticsEnabled: false }, result => {
        if (!chrome.runtime.lastError && diagnosticSettingsRevision === revision) {
          // Invalidate older in-flight reads, including startup settings.
          diagnosticSettingsRevision += 1;
          setDiagnosticsEnabled(result.diagnosticsEnabled === true);
        }
        sendResponse(diagnosticReport());
      });
      return true;
    }
  });

  loadSettings();


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
      offset < 0 ||
      offset > (
        node.nodeType === Node.TEXT_NODE
          ? node.length
          : node.childNodes.length
      )
    ) {
      return null;
    }

    return {
      node,
      offset
    };
  }

  function usableDragAnchor(position) {
    if (!position || !connectedPosition(position.node, position.offset)) {
      return null;
    }

    const element = elementOf(position.node);
    const root = findRoot(position.node);

    return (
      element &&
      !isExcludedInteractionTarget(element) &&
      root &&
      root.isConnected &&
      positionInside(root, position)
    ) ? position : null;
  }

  /* Prefer the browser's new anchor only when it identifies a usable text block. */
  function resolveLiveDragAnchor(candidate) {
    if (candidate.origin) {
      candidate.anchorSource = 'bookmark';
      return resolveOriginAnchor(candidate.origin, candidate);
    }

    candidate.failureReason = 'start_position_unavailable';
    candidate.anchorSource = 'coordinates';
    const snapshot = candidate.initialSelection;
    const coordinateAnchor = usableDragAnchor(caretAt(
      candidate.startX,
      candidate.startY
    ));

    /* If a previous selection is still present, do not inherit its old anchor. */
    if (
      snapshot &&
      snapshot.rangeCount > 0 &&
      snapshot.isCollapsed === false
    ) {
      return coordinateAnchor;
    }

    const selection = window.getSelection();

    if (
      selection &&
      selection.rangeCount > 0 &&
      selection.anchorNode &&
      selection.anchorNode.nodeType === Node.TEXT_NODE &&
      selection.anchorNode.isConnected &&
      selectionChangedSince(
        snapshot,
        selection
      )
    ) {
      const liveAnchor = usableDragAnchor({
        node: selection.anchorNode,
        offset: selection.anchorOffset
      });

      if (liveAnchor) {
        candidate.anchorSource = 'native_selection';
        return liveAnchor;
      }
    }

    return coordinateAnchor;
  }

  /*
   * Keep a structural bookmark and numeric text offsets for this drag only.
   * No page text is copied. This survives replacement of both the root and its
   * text nodes without using the current pointer as a new selection origin.
   */
  function captureDragOrigin(root, anchor) {
    const lineage = [];
    let current = root;

    while (current.parentElement) {
      const parent = current.parentElement;
      lineage.push({
        parent,
        index: Array.prototype.indexOf.call(parent.children, current),
        siblingCount: parent.children.length,
        tag: current.localName,
        id: current.id
      });
      current = parent;
    }

    const anchorPath = [];
    current = anchor.node;

    while (current !== root) {
      const parent = current.parentNode;
      anchorPath.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textLength = 0;
    let textOffset = null;
    let node;

    while ((node = walker.nextNode())) {
      if (node === anchor.node) {
        textOffset = textLength + anchor.offset;
      }
      textLength += node.length;
    }

    return { root, lineage, anchorPath, anchorOffset: anchor.offset, textOffset, textLength };
  }

  function resolveOriginAnchor(origin, candidate) {
    candidate.failureReason = 'origin_root_missing';
    let root = origin.root;

    if (!root.isConnected) {
      const index = origin.lineage.findIndex(step => step.parent.isConnected);
      if (index < 0) {
        return null;
      }

      root = origin.lineage[index].parent;
      for (let i = index; i >= 0; i -= 1) {
        const step = origin.lineage[i];
        const child = step.id
          ? Array.from(root.children).find(element => element.id === step.id)
          : root.children[step.index];

        if (
          !child ||
          child.localName !== step.tag ||
          (!step.id && root.children.length !== step.siblingCount)
        ) {
          candidate.failureReason = 'origin_structure_changed';
          return null;
        }
        root = child;
      }
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textLength = 0;
    let position = null;
    let node;

    while ((node = walker.nextNode())) {
      if (
        origin.textOffset !== null &&
        !position &&
        origin.textOffset <= textLength + node.length
      ) {
        position = { node, offset: origin.textOffset - textLength };
      }
      textLength += node.length;
    }

    // Changed content or an incompatible replacement cannot safely reuse the offset.
    if (textLength !== origin.textLength) {
      candidate.failureReason = 'origin_text_length_changed';
      return null;
    }

    if (origin.textOffset === null) {
      node = root;
      for (const index of origin.anchorPath) {
        node = node.childNodes[index];
        if (!node) {
          candidate.failureReason = 'origin_anchor_invalid';
          return null;
        }
      }
      position = { node, offset: origin.anchorOffset };
    }

    candidate.failureReason = 'origin_anchor_invalid';
    return usableDragAnchor(position) && findRoot(position.node) === root
      ? position
      : null;
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
      // Older visibility APIs may be absent or ignore opacity options. These
      // ancestor properties hide descendants even when the field's own style
      // looks visible. Visibility itself can be overridden by a descendant.
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (
          ancestorStyle.display === 'none' ||
          ancestorStyle.contentVisibility === 'hidden' ||
          Number(ancestorStyle.opacity) === 0
        ) return false;
      }
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
    } catch (error) {
      diagnostic('selection.write_failed', { error: diagnosticError(error) });
      /* If an SPA changes the DOM, fail safely and leave the selection untouched. */
    } finally {
      correcting = false;
    }
  }

  function clampToRoot() {
    if (!state) {
      return;
    }

    if (
      !state.root ||
      !state.root.isConnected ||
      !connectedPosition(state.anchor.node, state.anchor.offset) ||
      !positionInside(state.root, state.anchor)
    ) {
      diagnostic('recovery.needed', {
        rootConnected: !!state.root && state.root.isConnected,
        anchor: diagnosticPosition(state.anchor)
      });
      const candidate = {
        ...state.drag,
        origin: state.origin,
        currentX: state.x,
        currentY: state.y,
        released: state.released,
        releaseSource: state.releaseSource
      };
      deactivate('dom_changed');
      beginActivation(candidate);
      return;
    }

    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    /*
     * If the browser Selection is temporarily lost because the DOM was replaced during page startup,
     * rebuild the selection from the current root/anchor and pointer position.
     */
    if (!selection.focusNode) {
      if (state.lastClampReason !== 'selection_missing') {
        diagnostic('selection.clamped', { reason: 'selection_missing' });
        state.lastClampReason = 'selection_missing';
      }
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
    } catch (error) {
      diagnostic('selection.geometry_failed', { error: diagnosticError(error) });
      deactivate('root_geometry_failed');
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
     * If the pointer and Selection focus are inside the root and the anchor is
     * unchanged, leave selection behavior entirely to the browser.
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
      !pointerOutsideRoot &&
      selection.anchorNode === state.anchor.node &&
      selection.anchorOffset === state.anchor.offset
    ) {
      state.lastClampReason = null;
      return;
    }

    const clampReason = pointerOutsideRoot
      ? 'pointer_outside_root'
      : focusInsideRoot ? 'anchor_changed' : 'focus_outside_root';
    if (state.lastClampReason !== clampReason) {
      diagnostic('selection.clamped', { reason: clampReason, focusInsideRoot });
      state.lastClampReason = clampReason;
    }

    const focus =
      (focusInsideRoot && !pointerOutsideRoot && connectedPosition(
        selection.focusNode,
        selection.focusOffset
      )) ||
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
     Deferred activation and bounded startup recovery
     ========================================================= */

  function cancelActivation(reason = 'new_candidate') {
    if (activationCandidate) {
      diagnostic('activation.cancelled', {
        reason,
        attempts: activationCandidate.attempts,
        lastFailure: activationCandidate.failureReason || null
      });
    }
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
        // The mouseup capture handler runs before page handlers and native
        // finalization. Clamp their final result before cancelling pending work.
        diagnostic('release.finalizing', {
          source: oldState.releaseSource,
          selection: diagnosticSelection()
        });
        clampToRoot();
        // DOM recovery may have replaced the state; let it finish independently.
        if (state === oldState) {
          diagnostic('release.completed', {
            source: oldState.releaseSource,
            selection: diagnosticSelection()
          });
          deactivate(oldState.releaseSource === 'mouseup_timeout' ? 'mouseup_timeout' : 'mouse_released');
        }
      }
    });
  }

  function activateCandidate(liveCandidate) {
    if (!liveCandidate) {
      return 'blocked';
    }

    const anchor = resolveLiveDragAnchor(
      liveCandidate
    );

    if (!anchor) {
      return 'retry';
    }

    diagnostic('anchor.resolved', {
      source: liveCandidate.anchorSource,
      anchor: diagnosticPosition(anchor)
    });

    const startElement = elementOf(anchor.node);

    if (
      !startElement ||
      !startElement.isConnected ||
      isExcludedInteractionTarget(startElement)
    ) {
      diagnostic('activation.blocked', { reason: 'excluded_target' });
      return 'blocked';
    }

    const root = findRoot(anchor.node);

    if (
      !root ||
      !root.isConnected ||
      !positionInside(root, anchor)
    ) {
      liveCandidate.failureReason = 'root_unavailable';
      return 'retry';
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
      diagnostic('activation.blocked', { reason: 'sensitive_context' });
      return 'blocked';
    }

    if (
      !activate(
        root,
        anchor,
        liveCandidate.currentX,
        liveCandidate.currentY,
        liveCandidate
      )
    ) {
      liveCandidate.failureReason = 'lock_installation_failed';
      return 'retry';
    }

    diagnostic(liveCandidate.origin ? 'recovery.succeeded' : 'activation.succeeded', {
      attempts: liveCandidate.attempts + 1,
      waitMs: Math.round(performance.now() - liveCandidate.startedAt),
      rootTag: diagnosticTag(root),
      released: !!liveCandidate.released
    });

    /* Correct on this frame, including quick drags already followed by mouseup. */
    clampToRoot();

    if (liveCandidate.released) {
      releaseActiveLockSoon();
    }

    return 'active';
  }

  function scheduleActivation() {
    if (activationFrameId !== null || !activationCandidate) {
      return;
    }

    activationFrameId = requestAnimationFrame(() => {
      activationFrameId = null;
      const liveCandidate = activationCandidate;

      if (!liveCandidate) return;

      const result = activateCandidate(liveCandidate);
      if (activationCandidate !== liveCandidate) return;

      if (result !== 'retry') {
        activationCandidate = null;
        if (result === 'blocked') cancelMouseUpWait('activation_blocked');
        return;
      }

      liveCandidate.attempts += 1;
      diagnostic('activation.retry', {
        reason: liveCandidate.failureReason,
        attempt: liveCandidate.attempts,
        recovery: !!liveCandidate.origin,
        released: !!liveCandidate.released
      });
      if (liveCandidate.attempts < MAX_ACTIVATION_ATTEMPTS) {
        scheduleActivation();
      } else if (liveCandidate.released) {
        cancelActivation('retry_limit_after_release');
      } else {
        diagnostic('activation.waiting_for_input', {
          reason: liveCandidate.failureReason,
          attempts: liveCandidate.attempts
        });
      }
      // While held, retain the candidate without spinning. New input can retry it.
    });
  }

  function beginActivation(candidate) {
    cancelActivation();
    activationCandidate = { ...candidate, attempts: 0 };
    diagnostic('activation.scheduled', {
      recovery: !!candidate.origin,
      released: !!candidate.released
    });
    scheduleActivation();
  }


  /* =========================================================
     Lock lifecycle
     ========================================================= */

  function activate(root, anchor, x, y, drag) {
    deactivate('new_lock');
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
        drag,
        origin: drag.origin || captureDragOrigin(root, anchor),
        released: !!drag.released,
        releaseSource: drag.releaseSource || null,
        lastValidFocus: anchor,
        touched,
        activeClassAlreadyPresent
      };

      return true;
    } catch (error) {
      diagnostic('activation.install_failed', { error: diagnosticError(error) });
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

  function deactivate(reason) {
    cancelClamp();
    cancelRelease();

    const oldState = state;
    state = null;

    if (!oldState) {
      return;
    }

    diagnostic('lock.released', { reason, rootTag: diagnosticTag(oldState.root) });
    restoreTrackedAttributes(oldState.touched);

    if (!oldState.activeClassAlreadyPresent) {
      try {
        document.documentElement
          .classList
          .remove(ACTIVE_CLASS);
      } catch (_) {}
    }
  }

  function resetEverything(reason) {
    if (pending || activationCandidate || state) {
      diagnostic('drag.reset', { reason });
    }
    pending = null;
    cancelMouseUpWait(reason);
    cancelActivation(reason);
    deactivate(reason);
  }

  function destroy() {
    resetEverything('page_hidden');
    removeCSS();
  }


  /* =========================================================
     Event helpers
     ========================================================= */

  function shouldBypassMouseDown(e) {
    if (e.button !== 0) return 'non_primary_button';
    if (e.detail > 1) return 'multi_click';
    if (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return 'modifier_key';
    return null;
  }

  function cancelMouseUpWait(reason) {
    if (!mouseupWait) return;
    window.clearTimeout(mouseupWait.timerId);
    diagnostic('release.wait_cancelled', {
      reason,
      waitMs: Math.round(performance.now() - mouseupWait.startedAt)
    });
    mouseupWait = null;
  }

  function deferReleaseUntilMouseUp(x, y, buttons) {
    if (mouseupWait) return;

    // Keep the first release hint's position. Later hover movements must not
    // move the selection endpoint or indefinitely extend the waiting period.
    const waiting = { x, y, interaction: interactionSequence, startedAt: performance.now() };
    mouseupWait = waiting;
    diagnostic('release.awaiting_mouseup', {
      buttons,
      graceMs: MOUSEUP_WAIT_MS,
      selection: diagnosticSelection()
    });
    waiting.timerId = window.setTimeout(() => {
      if (mouseupWait !== waiting) return;
      mouseupWait = null;
      if (waiting.interaction !== interactionSequence) return;
      diagnostic('release.mouseup_timeout', {
        waitMs: Math.round(performance.now() - waiting.startedAt)
      });
      completeMouseRelease(waiting.x, waiting.y, 'mouseup_timeout');
    }, MOUSEUP_WAIT_MS);
  }

  function completeMouseRelease(x, y, source) {
    cancelMouseUpWait(source);

    // Also handles quick drags with no held-button mousemove before release.
    if (pending) {
      const distance = Math.hypot(x - pending.startX, y - pending.startY);
      if (distance >= DRAG_THRESHOLD) {
        const candidate = {
          ...pending, currentX: x, currentY: y, released: true, releaseSource: source
        };
        diagnostic('drag.threshold_crossed', { source, distance: Math.round(distance) });
        pending = null;
        beginActivation(candidate);
        return;
      }
      diagnostic('drag.not_started', { reason: 'below_drag_threshold', distance: Math.round(distance) });
      pending = null;
    }

    if (activationCandidate) {
      activationCandidate.currentX = x;
      activationCandidate.currentY = y;
      activationCandidate.released = true;
      activationCandidate.releaseSource = source;
      activationCandidate.attempts = 0;
      scheduleActivation();
      return;
    }

    if (!state) return;
    state.x = x;
    state.y = y;
    state.released = true;
    state.releaseSource = source;
    clampToRoot();
    if (state) releaseActiveLockSoon();
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

      resetEverything('new_mousedown');
      interactionSequence += 1;
      diagnostic('pointer.down', {
        clickCount: e.detail,
        button: e.button,
        alt: e.altKey,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        targetTag: diagnosticTag(e.target)
      });

      const bypassReason = shouldBypassMouseDown(e) || (
        !(e.target instanceof Element)
          ? 'non_element_target'
          : isExcludedInteractionTarget(e.target) ? 'excluded_target' : null
      );
      if (bypassReason) {
        diagnostic('interaction.bypassed', { reason: bypassReason });
        return;
      }

      /*
       * At this point, do not perform caret lookup, ancestor traversal, sensitive-context checks, or DOM mutation.
       * Keep only the start coordinates and the initial Selection snapshot in memory.
       */
      pending = {
        startedAt: performance.now(),
        startX: e.clientX,
        startY: e.clientY,
        initialSelection: captureSelectionSnapshot()
      };
      diagnostic('drag.pending', {
        existingSelection: !!pending.initialSelection && !pending.initialSelection.isCollapsed
      });
    },
    true
  );

  document.addEventListener(
    'mousemove',
    e => {
      if (!e.isTrusted) {
        return;
      }

      if (e.buttons & 1) cancelMouseUpWait('button_held_again');

      if (state) {
        if (!(e.buttons & 1)) {
          // Hover events immediately after mouseup must not cancel finalization
          // or replace the release coordinates with a later pointer position.
          if (state.released) return;
          deferReleaseUntilMouseUp(e.clientX, e.clientY, e.buttons);
          scheduleClamp();
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
          if (!activationCandidate.released) {
            deferReleaseUntilMouseUp(e.clientX, e.clientY, e.buttons);
          }
          return;
        }

        activationCandidate.currentX = e.clientX;
        activationCandidate.currentY = e.clientY;
        if (activationFrameId === null) {
          diagnostic('activation.resumed', { source: 'mousemove' });
          activationCandidate.attempts = 0;
          scheduleActivation();
        }
        return;
      }

      if (!pending) {
        return;
      }

      if (!(e.buttons & 1)) {
        deferReleaseUntilMouseUp(e.clientX, e.clientY, e.buttons);
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

      diagnostic('drag.threshold_crossed', { source: 'mousemove', distance: Math.round(Math.hypot(dx, dy)) });
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
      diagnostic('pointer.up', { button: e.button, buttons: e.buttons, selection: diagnosticSelection() });
      if (e.button !== 0) {
        diagnostic('release.ignored', { reason: 'non_primary_button', button: e.button, buttons: e.buttons });
        return;
      }
      completeMouseRelease(e.clientX, e.clientY, 'mouseup');
    },
    true
  );


  /* =========================================================
     Selection and native-operation events
     ========================================================= */

  document.addEventListener(
    'selectionchange',
    () => {
      if (activationCandidate && !correcting) {
        if (!activationCandidate.released && activationFrameId === null) {
          diagnostic('activation.resumed', { source: 'selectionchange' });
          activationCandidate.attempts = 0;
        }
        scheduleActivation();
        return;
      }

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
      if (!e.isTrusted || (!pending && !activationCandidate && !state)) return;
      const interaction = interactionSequence;
      // Page handlers can still cancel dragstart after this capture listener.
      // A task, rather than a microtask, observes their final cancellation state.
      window.setTimeout(() => {
        if (interaction !== interactionSequence) return;
        if (e.defaultPrevented) {
          diagnostic('native_drag.cancelled');
          return;
        }
        resetEverything('native_drag');
      }, 0);
    },
    true
  );

  document.addEventListener(
    'contextmenu',
    e => {
      if (e.isTrusted) {
        resetEverything('context_menu');
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
        resetEverything('escape');
      }
    },
    true
  );


  /* =========================================================
     Safety cleanup
     ========================================================= */

  window.addEventListener(
    'blur',
    e => {
      // Capture also receives blur from inputs and other focused elements.
      // Their normal focus loss during mousedown must not cancel the new drag.
      if (e.isTrusted && e.target === window) resetEverything('window_blur');
    },
    true
  );

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) {
        resetEverything('document_hidden');
      }
    }
  );

  window.addEventListener(
    'pagehide',
    e => {
      // Chromium's native pagehide uses Document as its legacy event target.
      if (e.isTrusted && (e.target === document || e.target === window)) destroy();
    },
    true
  );
})();
