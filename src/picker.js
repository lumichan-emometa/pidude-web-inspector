// Runs as an init script before app scripts. No application source changes.
(() => {
  const config = __PI_PREVIEW_CONFIG__;
  if (window !== window.top || location.origin !== config.origin) return;
  let panel, shadow, hoverBox, pickedBox, taggedLayer, modeButton, interactButton;
  let title, selectorText, status, insertButton, copyButton, parentButton;
  let dialog, minimizeButton, restoreButton;
  let selecting = false, candidate = null, hovered = null, busy = false;
  let candidateId = 0;
  const documentId = crypto.randomUUID();
  const tagged = new Map();
  const frameShields = new Map();
  let frameLayer, cursorStyle;
  const controller = new AbortController();
  const listen = (target, name, handler, options = {}) =>
    target.addEventListener(name, handler, { ...options, signal: controller.signal });
  const tidy = (text, limit) => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  const sensitive = 'input, textarea, select, script, style, noscript, [contenteditable]:not([contenteditable="false"]), [hidden], [aria-hidden="true"]';

  function safeText(element) {
    if (element.closest(sensitive) || !element.checkVisibility()) return '';
    let visited = 0, output = '';
    function walk(node) {
      if (++visited > 600 || output.length >= 300) return;
      if (node.nodeType === Node.TEXT_NODE) {
        output += ' ' + (node.textContent || '').slice(0, 300 - output.length);
        return;
      }
      if (!(node instanceof Element) || node === panel || node.matches(sensitive)) return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      for (const child of node.childNodes) {
        if (visited > 600 || output.length >= 300) break;
        walk(child);
      }
    }
    walk(element);
    return tidy(output, 240);
  }

  function buildSelector(element) {
    const unique = (s) => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node.id) {
        const id = '#' + CSS.escape(node.id);
        if (unique(id)) { parts.unshift(id); break; }
      }
      let anchor = '';
      for (const attr of ['data-testid', 'data-ui']) {
        const value = node.getAttribute(attr);
        if (!value || value.length > 100) continue;
        const s = '[' + attr + '="' + CSS.escape(value) + '"]';
        if (unique(s)) { anchor = s; break; }
      }
      if (anchor) { parts.unshift(anchor); break; }
      let part = node.localName;
      part += [...node.classList].filter((s) => s.length < 60).slice(0, 2).map((s) => '.' + CSS.escape(s)).join('');
      if (node.parentElement) {
        const siblings = [...node.parentElement.children].filter((s) => s.localName === node.localName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ').slice(0, 500);
  }

  function describe(element) {
    let ariaLabel = element.getAttribute('aria-label') || '';
    if (!ariaLabel) {
      ariaLabel = (element.getAttribute('aria-labelledby') || '').split(/\s+/).slice(0, 8)
        .map((id) => document.getElementById(id)).filter(Boolean).map(safeText).join(' ');
    }
    if (!ariaLabel && element.localName === 'img') ariaLabel = element.getAttribute('alt') || '';
    return {
      selector: buildSelector(element), element: element.localName,
      text: safeText(element), role: tidy(element.getAttribute('role') || '', 80),
      ariaLabel: tidy(ariaLabel, 160),
    };
  }

  function normalize(target) {
    if (!(target instanceof Element)) return null;
    // Avoid pretending a shadow-root selector can be resolved in document.
    while (target.getRootNode() instanceof ShadowRoot) target = target.getRootNode().host;
    return target.closest('button, a, input, textarea, select, [role="button"], [role="link"]') ||
      (target instanceof SVGElement ? target.closest('svg') : target);
  }
  function isPicker(event) { return panel && event.composedPath().includes(panel); }
  function cancel(event) { event.preventDefault(); event.stopImmediatePropagation(); }

  function rectangle(box, node) {
    if (!node?.isConnected || !selecting) { box.hidden = true; return; }
    const r = node.getBoundingClientRect();
    box.hidden = false;
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  function draw() {
    if (!panel) return;
    rectangle(hoverBox, hovered);
    rectangle(pickedBox, candidate?.node);
    for (const [frame, state] of frameShields) {
      if (!selecting || !frame.isConnected) {
        if (!state.wasInert) frame.removeAttribute('inert');
        state.box.remove(); frameShields.delete(frame);
      }
    }
    if (selecting) for (const frame of [...document.querySelectorAll('iframe')].slice(0, 100)) {
      if (!frameShields.has(frame)) {
        const box = document.createElement('div');
        box.className = 'frame-shield';
        const wasInert = frame.hasAttribute('inert');
        frame.setAttribute('inert', '');
        listen(box, 'pointermove', () => { hovered = frame; rectangle(hoverBox, frame); });
        listen(box, 'click', (event) => { cancel(event); pick(frame); });
        frameLayer.append(box);
        frameShields.set(frame, { box, wasInert });
      }
      rectangle(frameShields.get(frame).box, frame);
    }
    for (const [node, box] of tagged) {
      if (!node.isConnected) { box.remove(); tagged.delete(node); }
      else rectangle(box, node);
    }
  }
  function setMode(value) {
    if (selecting === value) return;
    selecting = value;
    if (value) {
      cursorStyle = document.createElement('style');
      cursorStyle.textContent = 'html, body, body * { cursor: crosshair !important; }';
      document.head.append(cursorStyle);
    } else { cursorStyle?.remove(); cursorStyle = undefined; }
    hovered = null;
    if (!value) candidate = null;
    modeButton.setAttribute('aria-pressed', String(value));
    interactButton.setAttribute('aria-pressed', String(!value));
    update(); draw();
  }
  function setMinimized(value, moveFocus = true) {
    dialog.hidden = value;
    restoreButton.hidden = !value;
    restoreButton.setAttribute('aria-expanded', String(!value));
    if (moveFocus) (value ? restoreButton : minimizeButton).focus({ preventScroll: true });
  }
  function update() {
    if (!panel) return;
    restoreButton.textContent = selecting ? 'Pi · Select' : 'Pi · Preview';
    restoreButton.setAttribute('aria-label', selecting ? 'Restore Pi Preview, Select mode active' : 'Restore Pi Preview');
    title.textContent = candidate ? candidate.data.element + ' · ' + (candidate.data.ariaLabel || candidate.data.text || 'Selected element') : selecting ? 'Point at an element' : 'Preview behaves normally';
    selectorText.textContent = candidate?.data.selector || 'Select an element to reference it in Pi.';
    insertButton.disabled = copyButton.disabled = !candidate || busy;
    parentButton.disabled = !candidate?.node.parentElement || candidate.node.parentElement === document.documentElement || busy;
  }
  function pick(node) {
    if (!node || busy) return;
    candidate = { node, data: describe(node), id: ++candidateId, tag: undefined };
    setMinimized(false, false);
    hovered = null;
    status.textContent = 'Ready to reference';
    update(); draw();
  }

  async function send(action) {
    if (!candidate || busy) return;
    busy = true;
    const selected = candidate;
    update();
    try {
      const response = await window[config.binding]({
        action, documentId, selectionId: selected.id, candidate: selected.data,
      });
      if (!response.ok) throw new Error(response.error);
      selected.tag = response.tag;
      if (!tagged.has(selected.node)) {
        const box = document.createElement('div');
        box.className = 'outline tagged';
        taggedLayer.append(box);
        tagged.set(selected.node, box);
      }
      if (action === 'copy') {
        try {
          await navigator.clipboard.writeText(response.tag);
          status.textContent = 'Copied ' + response.tag + ' · paired Pi session only';
        } catch {
          status.textContent = 'Clipboard unavailable. Copy manually: ' + response.tag;
        }
      } else status.textContent = 'Inserted ' + response.tag + ' into Pi';
    } catch (error) {
      status.textContent = error.message || 'Pi is disconnected. Reopen /preview.';
    } finally { busy = false; update(); draw(); }
  }

  // Installed before the application: prevent pointerdown as well as click effects.
  for (const eventName of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchend']) {
    listen(window, eventName, (event) => {
      if (!selecting || isPicker(event)) return;
      cancel(event);
      if (eventName === 'click' && event.button === 0) pick(normalize(event.target));
    }, { capture: true, passive: false });
  }
  listen(window, 'pointermove', (event) => {
    if (!selecting || !panel) return;
    hovered = isPicker(event) ? null : normalize(event.target);
    draw();
  }, { capture: true });
  for (const eventName of ['keydown', 'keyup', 'keypress']) {
    listen(window, eventName, (event) => {
      if (!selecting) return;
      if (event.key === 'Escape') { cancel(event); if (eventName === 'keydown') setMode(false); return; }
      if (isPicker(event)) return;
      if (event.key === 'Enter' || event.key === ' ') {
        cancel(event);
        if (eventName === 'keydown') pick(normalize(event.target));
      }
    }, { capture: true });
  }
  listen(window, 'scroll', draw, { capture: true, passive: true });
  listen(window, 'resize', draw, { passive: true });

  function mount() {
    if (panel || !document.body) return;
    panel = document.createElement('pidude-web-inspector');
    // Keep the host out of app layout and isolate all internal styles.
    panel.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;';
    shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { color-scheme:light; }
        * { box-sizing:border-box; }
        .panel { position:fixed; right:16px; bottom:16px; width:min(370px,calc(100vw - 32px)); padding:14px; border:1px solid #c4d3e5; border-radius:12px; background:#fff; color:#20334d; box-shadow:0 8px 32px #20334d26; font:13px/1.45 system-ui,sans-serif; pointer-events:auto; }
        .bar,.actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
        .brand { margin-right:auto; font-weight:750; letter-spacing:-.3px; }
        button { cursor:pointer; border:1px solid #c4d3e5; border-radius:6px; background:#edf3fa; color:#20334d; padding:6px 10px; font:inherit; }
        button[aria-pressed=true],.primary { background:#316bce; border-color:#316bce; color:#fff; }
        #minimize { padding:6px 9px; }
        .restore { position:fixed; right:16px; bottom:16px; pointer-events:auto; padding:10px 14px; border-radius:999px; font:650 13px/1.45 system-ui,sans-serif; box-shadow:0 4px 16px #20334d26; }
        button:disabled { opacity:.45; cursor:default; }
        button:focus-visible { outline:3px solid #db8a17; outline-offset:2px; }
        h2 { font-size:13px; margin:14px 0 3px; overflow-wrap:anywhere; }
        code { display:block; font:11px/1.5 ui-monospace,monospace; color:#617086; overflow-wrap:anywhere; max-height:50px; overflow:auto; margin-bottom:12px; }
        .status { margin:10px 0 0; font-size:11px; color:#617086; overflow-wrap:anywhere; user-select:text; }
        .frame-shield { position:fixed; pointer-events:auto; cursor:crosshair; }
        .outline { position:fixed; outline:2px solid #db8a17; outline-offset:2px; pointer-events:none; }
        .picked { outline-width:3px; outline-offset:4px; }
        .tagged { outline-color:#316bce; }
        [hidden] { display:none!important; }
      </style>
      <div class="frame-layer"></div><div class="tagged-layer"></div><div class="outline hover" hidden></div><div class="outline picked" hidden></div>
      <button id="restore" class="restore" aria-label="Restore Pi Preview" aria-expanded="true" aria-controls="picker-panel" hidden>Pi · Preview</button>
      <section id="picker-panel" class="panel" aria-label="Pi preview picker">
        <div class="bar"><span class="brand">Pi · Preview</span><button id="interact" aria-pressed="true">Interact</button><button id="select" aria-pressed="false">Select</button><button id="minimize" aria-label="Minimize Pi Preview" title="Minimize Pi Preview">−</button></div>
        <h2></h2><code></code>
        <div class="actions"><button id="insert" class="primary">Insert into Pi</button><button id="copy">Copy reference</button><button id="parent">Parent</button></div>
        <p class="status" role="status" aria-live="polite">Escape leaves Select · references stay in this Pi session</p>
      </section>`;
    const query = (s) => shadow.querySelector(s);
    hoverBox = query('.hover'); pickedBox = query('.picked'); taggedLayer = query('.tagged-layer'); frameLayer = query('.frame-layer');
    modeButton = query('#select'); interactButton = query('#interact');
    dialog = query('#picker-panel'); minimizeButton = query('#minimize'); restoreButton = query('#restore');
    listen(minimizeButton, 'click', () => setMinimized(true));
    listen(restoreButton, 'click', () => setMinimized(false));
    title = query('h2'); selectorText = query('code'); status = query('.status');
    insertButton = query('#insert'); copyButton = query('#copy'); parentButton = query('#parent');
    listen(modeButton, 'click', () => setMode(true));
    listen(interactButton, 'click', () => setMode(false));
    listen(insertButton, 'click', () => send('insert'));
    listen(copyButton, 'click', () => send('copy'));
    listen(parentButton, 'click', () => pick(candidate?.node.parentElement));
    // Picker actions should not bubble into application event handlers.
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup']) {
      listen(shadow, name, (event) => event.stopPropagation());
    }
    document.body.append(panel);
    update();
    // Reposition outlines for framework rerenders/layout changes, without animation.
    let timer = setInterval(draw, 200);
    listen(window, 'pagehide', () => { clearInterval(timer); setMode(false); });
    listen(window, 'pageshow', (event) => { if (event.persisted) timer = setInterval(draw, 200); });
    const observer = new MutationObserver(() => {
      if (!panel.isConnected && document.body) document.body.append(panel);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') listen(document, 'DOMContentLoaded', mount, { once: true });
  else mount();
})();
