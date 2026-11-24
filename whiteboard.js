/*
 * Whiteboard — a small, dependency-free infinite canvas.
 * Pen, highlighter, eraser, shapes, arrows, text, sticky notes, images,
 * select / move / resize, undo / redo, pan / zoom, autosave, PNG + JSON export.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const STORAGE_KEY = 'whiteboard:v1';
  const CLIP_PREFIX = 'whiteboard-elements:';
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const COLORS = ['#1f2937', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  const STICKY_COLORS = ['#fef08a', '#fecaca', '#fed7aa', '#fde68a', '#bbf7d0', '#bfdbfe', '#e9d5ff', '#fbcfe8'];
  const WIDTHS = [2, 4, 8, 14];
  const TEXT_SIZE = 24, STICKY_FONT = 20, STICKY_PAD = 14, LINE_HEIGHT = 1.25;
  const MIN_ZOOM = 0.1, MAX_ZOOM = 8, ERASER_PX = 10, HANDLE_PX = 8;
  const BG = '#fafaf9', GRID = '#d6d3d1', ACCENT = '#3b82f6';
  const TYPES = new Set(['path', 'rect', 'ellipse', 'line', 'arrow', 'text', 'sticky', 'image']);
  const TOOL_KEYS = { v: 'select', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', t: 'text', n: 'sticky' };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const r2 = (v) => Math.round(v * 100) / 100;

  const canvas = $('#board');
  const ctx = canvas.getContext('2d');

  // ---------------------------------------------------------------- state
  const state = { tool: 'pen', color: COLORS[0], width: 4, fill: false, elements: [], selected: new Set() };
  const cam = { x: 0, y: 0, zoom: 1 };
  let draft = null;        // element being drawn
  let action = null;       // current pointer interaction
  let editing = null;      // active text editor
  let pinch = null;        // two-finger gesture
  let spaceDown = false;
  let pointerScreen = null;
  const pointers = new Map();
  const undoStack = [], redoStack = [];
  let dpr = 1, vw = 0, vh = 0;

  // ---------------------------------------------------------------- coordinates
  const toWorld = (sx, sy) => ({ x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y });
  const toScreen = (wx, wy) => ({ x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom });
  const viewBounds = () => ({ x1: cam.x, y1: cam.y, x2: cam.x + vw / cam.zoom, y2: cam.y + vh / cam.zoom });
  const viewCenter = () => toWorld(vw / 2, vh / 2);

  function resize() {
    dpr = window.devicePixelRatio || 1;
    vw = window.innerWidth; vh = window.innerHeight;
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
    canvas.style.width = vw + 'px'; canvas.style.height = vh + 'px';
    requestRender();
  }

  // ---------------------------------------------------------------- history & persistence
  const snapshot = () => JSON.stringify(state.elements);
  const byId = (id) => state.elements.find((e) => e.id === id);
  const selectedElements = () => state.elements.filter((e) => state.selected.has(e.id));

  function pushUndo(before) {
    undoStack.push(before);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(json) {
    state.elements = JSON.parse(json);
    for (const id of [...state.selected]) if (!byId(id)) state.selected.delete(id);
  }
  function undo() {
    commitEdit();
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    afterChange();
  }
  function redo() {
    commitEdit();
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    afterChange();
  }
  function afterChange() { save(); updateUI(); requestRender(); }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: 1, elements: state.elements, camera: cam,
          settings: { tool: state.tool, color: state.color, width: state.width, fill: state.fill },
        }));
      } catch (err) {
        toast('Autosave failed — the board is too big for browser storage. Use “Save board”.');
      }
    }, 300);
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!d) return;
      if (Array.isArray(d.elements)) state.elements = d.elements.filter(isValidElement);
      if (d.camera) Object.assign(cam, d.camera);
      if (d.settings) Object.assign(state, d.settings);
    } catch { /* ignore corrupt storage */ }
  }
  const isValidElement = (el) => el && typeof el === 'object' && TYPES.has(el.type) && typeof el.id === 'string';

  // ---------------------------------------------------------------- geometry
  const normRect = (el) => ({ x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) });
  const intersects = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;

  function measureTextEl(el) {
    ctx.save();
    ctx.font = `${el.size}px ${FONT}`;
    const lines = String(el.text).split('\n');
    let w = 0;
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    ctx.restore();
    return { w: Math.max(w, el.size * 0.5), h: lines.length * el.size * LINE_HEIGHT };
  }

  function getBounds(el) {
    let x1, y1, x2, y2, pad = 0;
    switch (el.type) {
      case 'path':
        x1 = y1 = Infinity; x2 = y2 = -Infinity;
        for (const [x, y] of el.points) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
        pad = el.width / 2;
        break;
      case 'rect': case 'ellipse': case 'line': case 'arrow':
        x1 = Math.min(el.x1, el.x2); y1 = Math.min(el.y1, el.y2);
        x2 = Math.max(el.x1, el.x2); y2 = Math.max(el.y1, el.y2);
        pad = el.width / 2 + (el.type === 'arrow' ? Math.max(12, el.width * 3.5) * 0.5 : 0);
        break;
      case 'text': {
        const m = measureTextEl(el);
        x1 = el.x; y1 = el.y; x2 = el.x + m.w; y2 = el.y + m.h;
        break;
      }
      default: // sticky, image
        x1 = el.x; y1 = el.y; x2 = el.x + el.w; y2 = el.y + el.h;
    }
    return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
  }

  function unionBounds(els) {
    if (!els.length) return null;
    const u = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const el of els) {
      const b = getBounds(el);
      u.x1 = Math.min(u.x1, b.x1); u.y1 = Math.min(u.y1, b.y1);
      u.x2 = Math.max(u.x2, b.x2); u.y2 = Math.max(u.y2, b.y2);
    }
    return u;
  }

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function hitTest(el, x, y, tol) {
    switch (el.type) {
      case 'path': {
        const b = getBounds(el);
        if (x < b.x1 - tol || x > b.x2 + tol || y < b.y1 - tol || y > b.y2 + tol) return false;
        const p = el.points, r = el.width / 2 + tol;
        if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= r;
        for (let i = 1; i < p.length; i++) if (distToSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= r) return true;
        return false;
      }
      case 'line': case 'arrow':
        return distToSeg(x, y, el.x1, el.y1, el.x2, el.y2) <= el.width / 2 + tol;
      case 'ellipse': {
        const r = normRect(el);
        const rx = r.w / 2 + el.width / 2 + tol, ry = r.h / 2 + el.width / 2 + tol;
        const dx = x - (r.x + r.w / 2), dy = y - (r.y + r.h / 2);
        return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
      }
      default: {
        const b = getBounds(el);
        return x >= b.x1 - tol && x <= b.x2 + tol && y >= b.y1 - tol && y <= b.y2 + tol;
      }
    }
  }

  function topHit(x, y) {
    const tol = 6 / cam.zoom;
    for (let i = state.elements.length - 1; i >= 0; i--) if (hitTest(state.elements[i], x, y, tol)) return state.elements[i];
    return null;
  }

  /** Returns a transformed copy of an element. f maps a world point; s scales font sizes. */
  function mapElement(o, f, s) {
    const el = { ...o };
    switch (o.type) {
      case 'path': el.points = o.points.map(([x, y]) => f(x, y)); break;
      case 'rect': case 'ellipse': case 'line': case 'arrow':
        [el.x1, el.y1] = f(o.x1, o.y1); [el.x2, el.y2] = f(o.x2, o.y2); break;
      case 'text': [el.x, el.y] = f(o.x, o.y); el.size = Math.max(6, r2(o.size * s)); break;
      default: { // sticky, image
        const [ax, ay] = f(o.x, o.y), [bx, by] = f(o.x + o.w, o.y + o.h);
        el.x = Math.min(ax, bx); el.y = Math.min(ay, by);
        el.w = Math.max(20, Math.abs(bx - ax)); el.h = Math.max(20, Math.abs(by - ay));
        if (o.type === 'sticky') el.fontSize = Math.max(8, r2((o.fontSize || STICKY_FONT) * s));
      }
    }
    return el;
  }

  function replaceElements(map) { state.elements = state.elements.map((e) => map.get(e.id) || e); }

  function stickyColorFor(c) {
    const i = COLORS.indexOf(c);
    if (i >= 0) return STICKY_COLORS[i];
    const n = parseInt(c.slice(1), 16);
    const mix = (v) => Math.round(v + (255 - v) * 0.65);
    return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
  }

  // ---------------------------------------------------------------- drawing
  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function wrapText(c, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const test = line ? line + ' ' + word : word;
        if (c.measureText(test).width <= maxW) { line = test; continue; }
        if (line) out.push(line);
        let chunk = ''; // hard-break words that are wider than the note
        for (const ch of word) {
          if (chunk && c.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch; } else chunk += ch;
        }
        line = chunk;
      }
      out.push(line);
    }
    return out;
  }

  function drawPath(c, el) {
    const p = el.points;
    if (p.length === 1) {
      c.beginPath(); c.arc(p[0][0], p[0][1], el.width / 2, 0, Math.PI * 2); c.fill();
      return;
    }
    c.beginPath();
    c.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      c.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
    }
    c.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    c.stroke();
  }

  function drawArrowHead(c, el) {
    const ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    const len = Math.max(12, el.width * 3.5), spread = Math.PI / 7;
    c.beginPath();
    c.moveTo(el.x2 - len * Math.cos(ang - spread), el.y2 - len * Math.sin(ang - spread));
    c.lineTo(el.x2, el.y2);
    c.lineTo(el.x2 - len * Math.cos(ang + spread), el.y2 - len * Math.sin(ang + spread));
    c.stroke();
  }

  function fillAndStroke(c, el) {
    if (el.fill) { c.globalAlpha = 0.22; c.fill(); c.globalAlpha = 1; }
    c.stroke();
  }

  function drawSticky(c, el, hideText) {
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.16)'; c.shadowBlur = 14; c.shadowOffsetY = 4;
    c.fillStyle = el.color;
    c.fillRect(el.x, el.y, el.w, el.h);
    c.restore();
    if (hideText || !el.text) return;
    const fs = el.fontSize || STICKY_FONT, pad = STICKY_PAD * fs / STICKY_FONT;
    c.save();
    c.beginPath(); c.rect(el.x, el.y, el.w, el.h); c.clip();
    c.fillStyle = '#1f2937'; c.font = `${fs}px ${FONT}`; c.textBaseline = 'top';
    wrapText(c, el.text, el.w - pad * 2).forEach((ln, i) => c.fillText(ln, el.x + pad, el.y + pad + i * fs * LINE_HEIGHT));
    c.restore();
  }

  const imgCache = new Map();
  function getImg(src) {
    let img = imgCache.get(src);
    if (!img) { img = new Image(); img.onload = requestRender; img.src = src; imgCache.set(src, img); }
    return img;
  }

  function drawElement(c, el, hideText = false) {
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = el.color; c.fillStyle = el.color; c.lineWidth = el.width;
    switch (el.type) {
      case 'path':
        c.globalAlpha = el.opacity ?? 1;
        drawPath(c, el);
        break;
      case 'rect': {
        const r = normRect(el);
        roundRectPath(c, r.x, r.y, r.w, r.h, Math.min(10, r.w / 4, r.h / 4));
        fillAndStroke(c, el);
        break;
      }
      case 'ellipse': {
        const r = normRect(el);
        c.beginPath(); c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        fillAndStroke(c, el);
        break;
      }
      case 'line': case 'arrow':
        c.beginPath(); c.moveTo(el.x1, el.y1); c.lineTo(el.x2, el.y2); c.stroke();
        if (el.type === 'arrow') drawArrowHead(c, el);
        break;
      case 'text':
        if (hideText) break;
        c.font = `${el.size}px ${FONT}`; c.textBaseline = 'top';
        String(el.text).split('\n').forEach((ln, i) => c.fillText(ln, el.x, el.y + i * el.size * LINE_HEIGHT));
        break;
      case 'sticky':
        drawSticky(c, el, hideText);
        break;
      case 'image': {
        const img = getImg(el.src);
        if (img.complete && img.naturalWidth) c.drawImage(img, el.x, el.y, el.w, el.h);
        else { c.fillStyle = '#e7e5e4'; c.fillRect(el.x, el.y, el.w, el.h); }
        break;
      }
    }
    c.restore();
  }

  function drawGrid() {
    let step = 24;
    while (step * cam.zoom < 14) step *= 2;
    const s = step * cam.zoom;
    const ox = ((-cam.x * cam.zoom) % s + s) % s, oy = ((-cam.y * cam.zoom) % s + s) % s;
    const r = clamp(cam.zoom * 1.3, 1, 1.8);
    ctx.fillStyle = GRID;
    ctx.beginPath();
    for (let x = ox; x < vw; x += s) for (let y = oy; y < vh; y += s) ctx.rect(x - r / 2, y - r / 2, r, r);
    ctx.fill();
  }

  function selectionScreenRect() {
    const b = unionBounds(selectedElements());
    if (!b) return null;
    const a = toScreen(b.x1, b.y1), c = toScreen(b.x2, b.y2), m = 6;
    return { x1: a.x - m, y1: a.y - m, x2: c.x + m, y2: c.y + m };
  }

  function handleAt(sx, sy) {
    const r = selectionScreenRect();
    if (!r) return null;
    const corners = { nw: [r.x1, r.y1], ne: [r.x2, r.y1], sw: [r.x1, r.y2], se: [r.x2, r.y2] };
    for (const [k, [hx, hy]] of Object.entries(corners)) if (Math.abs(sx - hx) <= HANDLE_PX && Math.abs(sy - hy) <= HANDLE_PX) return k;
    return null;
  }

  let renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG; ctx.fillRect(0, 0, vw, vh);
    drawGrid();

    const z = cam.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
    const view = viewBounds();
    for (const el of state.elements) {
      if (!intersects(getBounds(el), view)) continue;
      drawElement(ctx, el, editing && editing.id === el.id);
    }
    if (draft) drawElement(ctx, draft);

    // Screen-space overlays
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sel = selectedElements();
    if (sel.length && !(action && action.type === 'draw')) {
      ctx.strokeStyle = ACCENT;
      if (sel.length > 1) {
        ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        for (const el of sel) {
          const b = getBounds(el), a = toScreen(b.x1, b.y1), c = toScreen(b.x2, b.y2);
          ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
        }
        ctx.setLineDash([]);
      }
      const r = selectionScreenRect();
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
      if (!editing) {
        ctx.fillStyle = '#fff';
        for (const [hx, hy] of [[r.x1, r.y1], [r.x2, r.y1], [r.x1, r.y2], [r.x2, r.y2]]) {
          roundRectPath(ctx, hx - 5, hy - 5, 10, 10, 3);
          ctx.fill(); ctx.stroke();
        }
      }
    }
    if (action && action.type === 'marquee') {
      const a = toScreen(action.x1, action.y1), c = toScreen(action.x2, action.y2);
      ctx.fillStyle = 'rgba(59,130,246,0.08)'; ctx.strokeStyle = ACCENT; ctx.lineWidth = 1;
      ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
      ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    }
    if (state.tool === 'eraser' && pointerScreen && !spaceDown) {
      ctx.beginPath(); ctx.arc(pointerScreen.x, pointerScreen.y, ERASER_PX, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fill();
      ctx.strokeStyle = '#78716c'; ctx.lineWidth = 1; ctx.stroke();
    }
    positionEditor();
  }

  // ---------------------------------------------------------------- camera
  function zoomAt(sx, sy, factor) {
    const w = toWorld(sx, sy);
    cam.zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    cam.x = w.x - sx / cam.zoom; cam.y = w.y - sy / cam.zoom;
    updateZoomLabel(); save(); requestRender();
  }
  const zoomBy = (f) => zoomAt(vw / 2, vh / 2, f);
  const resetZoom = () => zoomAt(vw / 2, vh / 2, 1 / cam.zoom);

  function fitToContent() {
    const b = unionBounds(state.elements);
    if (!b) { cam.zoom = 1; cam.x = -vw / 2; cam.y = -vh / 2; afterChange(); return; }
    const pad = 80;
    cam.zoom = clamp(Math.min(vw / (b.x2 - b.x1 + pad * 2), vh / (b.y2 - b.y1 + pad * 2)), MIN_ZOOM, 2);
    cam.x = (b.x1 + b.x2) / 2 - vw / 2 / cam.zoom;
    cam.y = (b.y1 + b.y2) / 2 - vh / 2 / cam.zoom;
    updateZoomLabel(); save(); requestRender();
  }

  // ---------------------------------------------------------------- tools
  function setTool(t) {
    if (t !== state.tool) {
      state.tool = t;
      if (t !== 'select') state.selected.clear();
    }
    setCursorForTool(); updateUI(); requestRender(); save();
  }
  function setCursorForTool() {
    canvas.style.cursor = spaceDown ? 'grab'
      : ({ select: 'default', hand: 'grab', eraser: 'none', text: 'text' }[state.tool] || 'crosshair');
  }

  function applyToSelection(fn) {
    const sel = selectedElements();
    if (!sel.length) return;
    const before = snapshot();
    sel.forEach(fn);
    pushUndo(before); afterChange();
  }
  function setColor(c) {
    state.color = c;
    applyToSelection((el) => {
      if (el.type === 'sticky') el.color = stickyColorFor(c);
      else if (el.type !== 'image') el.color = c;
    });
    updateUI(); save();
  }
  function setWidth(w) {
    state.width = w;
    applyToSelection((el) => {
      if (el.type === 'path') el.width = (el.opacity ?? 1) < 1 ? w * 3 + 6 : w;
      else if ('width' in el) el.width = w;
    });
    updateUI(); save();
  }
  function toggleFill() {
    state.fill = !state.fill;
    applyToSelection((el) => { if (el.type === 'rect' || el.type === 'ellipse') el.fill = state.fill; });
    updateUI(); save();
  }

  function deleteSelection() {
    if (!state.selected.size) return;
    const before = snapshot();
    state.elements = state.elements.filter((e) => !state.selected.has(e.id));
    state.selected.clear();
    pushUndo(before); afterChange();
  }
  function reorder(toFront) {
    const sel = selectedElements();
    if (!sel.length) return;
    const before = snapshot();
    const rest = state.elements.filter((e) => !state.selected.has(e.id));
    state.elements = toFront ? [...rest, ...sel] : [...sel, ...rest];
    pushUndo(before); afterChange();
  }
  function nudge(dx, dy) {
    const sel = selectedElements();
    if (!sel.length) return;
    const before = snapshot();
    replaceElements(new Map(sel.map((o) => [o.id, mapElement(o, (x, y) => [x + dx, y + dy], 1)])));
    pushUndo(before); afterChange();
  }
  function insertElements(items, offset) {
    const valid = items.filter(isValidElement);
    if (!valid.length) return;
    const before = snapshot();
    const news = valid.map((o) => ({ ...mapElement(o, (x, y) => [x + offset, y + offset], 1), id: uid() }));
    state.elements.push(...news);
    setTool('select');
    state.selected = new Set(news.map((n) => n.id));
    pushUndo(before); afterChange();
  }

  function createText(p, text = '') {
    const before = snapshot();
    const el = { id: uid(), type: 'text', x: r2(p.x), y: r2(p.y - TEXT_SIZE * 0.6), text, color: state.color, size: TEXT_SIZE };
    state.elements.push(el);
    setTool('select');
    state.selected = new Set([el.id]);
    if (text) { pushUndo(before); afterChange(); } else startEdit(el, true, before);
  }
  function createSticky(p) {
    const before = snapshot();
    const el = { id: uid(), type: 'sticky', x: r2(p.x - 100), y: r2(p.y - 100), w: 200, h: 200, color: stickyColorFor(state.color), text: '', fontSize: STICKY_FONT };
    state.elements.push(el);
    setTool('select');
    state.selected = new Set([el.id]);
    startEdit(el, true, before);
  }

  function addImageFile(file, at) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        let src = reader.result;
        const MAX = 1600, scale = Math.min(1, MAX / Math.max(w, h));
        if (scale < 1) { // downscale big images so autosave fits in localStorage
          const c = document.createElement('canvas');
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          src = file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.88);
        }
        const disp = Math.min(1, 480 / Math.max(w, h));
        const dw = r2(w * disp), dh = r2(h * disp);
        const before = snapshot();
        const el = { id: uid(), type: 'image', x: r2(at.x - dw / 2), y: r2(at.y - dh / 2), w: dw, h: dh, src };
        state.elements.push(el);
        setTool('select');
        state.selected = new Set([el.id]);
        pushUndo(before); afterChange();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ---------------------------------------------------------------- text editing
  function startEdit(el, isNew = false, before = null) {
    commitEdit();
    const ta = document.createElement('textarea');
    ta.className = 'wb-editor ' + el.type;
    ta.style.fontFamily = FONT;
    ta.wrap = el.type === 'sticky' ? 'soft' : 'off';
    ta.spellcheck = true;
    ta.value = el.text || '';
    document.body.appendChild(ta);
    editing = { id: el.id, ta, isNew, before: before ?? snapshot(), original: el.text || '' };

    ta.addEventListener('input', () => {
      const cur = byId(el.id);
      if (cur) { cur.text = ta.value; requestRender(); }
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); ta.blur(); }
    });
    positionEditor();
    requestRender();
    // Focus after the current pointer event finishes, otherwise the click would immediately blur it.
    setTimeout(() => {
      if (!editing || editing.ta !== ta) return;
      ta.focus();
      if (!isNew) ta.select();
      ta.addEventListener('blur', commitEdit);
    }, 0);
  }

  function positionEditor() {
    if (!editing) return;
    const el = byId(editing.id);
    if (!el) { editing.ta.remove(); editing = null; return; }
    const z = cam.zoom, s = editing.ta.style, p = toScreen(el.x, el.y);
    s.left = p.x + 'px'; s.top = p.y + 'px';
    if (el.type === 'text') {
      const m = measureTextEl(el);
      s.fontSize = el.size * z + 'px'; s.color = el.color; s.padding = '0';
      s.width = (m.w + el.size) * z + 'px'; s.height = m.h * z + 'px';
    } else {
      const fs = el.fontSize || STICKY_FONT, pad = STICKY_PAD * fs / STICKY_FONT;
      s.fontSize = fs * z + 'px'; s.color = '#1f2937'; s.padding = pad * z + 'px';
      s.width = el.w * z + 'px'; s.height = el.h * z + 'px';
    }
  }

  function commitEdit() {
    if (!editing) return;
    const { id, ta, isNew, before, original } = editing;
    editing = null;
    ta.remove();
    const el = byId(id);
    if (!el) { requestRender(); return; }
    el.text = ta.value;
    if (el.type === 'text' && !el.text.trim()) {
      state.elements = state.elements.filter((e) => e.id !== id);
      state.selected.delete(id);
      if (!isNew) pushUndo(before);
    } else if (isNew || el.text !== original) {
      pushUndo(before);
    }
    afterChange();
  }

  // ---------------------------------------------------------------- erasing
  function eraseAlong(a, b) {
    const r = ERASER_PX / cam.zoom;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r / 2)));
    const hit = new Set();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      for (const el of state.elements) if (!hit.has(el.id) && hitTest(el, x, y, r)) hit.add(el.id);
    }
    if (hit.size) {
      state.elements = state.elements.filter((e) => !hit.has(e.id));
      hit.forEach((id) => state.selected.delete(id));
      action.changed = true;
    }
  }

  // ---------------------------------------------------------------- pointer input
  function pinchInfo() {
    const [a, b] = [...pointers.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  function startPinch() {
    if (action) { // a second finger cancels whatever the first one started
      if (action.type === 'draw' || action.type === 'shape') draft = null;
      else if (action.before && action.changed) restore(action.before);
      action = null;
    }
    pinch = pinchInfo();
    requestRender();
  }
  function updatePinch() {
    const cur = pinchInfo();
    cam.x -= (cur.mid.x - pinch.mid.x) / cam.zoom;
    cam.y -= (cur.mid.y - pinch.mid.y) / cam.zoom;
    zoomAt(cur.mid.x, cur.mid.y, cur.dist / (pinch.dist || 1));
    pinch = cur;
  }

  function onPointerDown(e) {
    closeMenu();
    if (editing) { commitEdit(); return; }
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;

    if (e.button === 1 || spaceDown || state.tool === 'hand') {
      action = { type: 'pan', lastX: e.clientX, lastY: e.clientY };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    const p = toWorld(e.clientX, e.clientY);

    switch (state.tool) {
      case 'pen': case 'highlighter': {
        const hl = state.tool === 'highlighter';
        draft = { id: uid(), type: 'path', points: [[r2(p.x), r2(p.y)]], color: state.color, width: hl ? state.width * 3 + 6 : state.width, opacity: hl ? 0.35 : 1 };
        action = { type: 'draw' };
        break;
      }
      case 'rect': case 'ellipse': case 'line': case 'arrow':
        draft = { id: uid(), type: state.tool, x1: r2(p.x), y1: r2(p.y), x2: r2(p.x), y2: r2(p.y), color: state.color, width: state.width, fill: state.fill };
        action = { type: 'shape', sx: e.clientX, sy: e.clientY };
        break;
      case 'text': {
        const hit = topHit(p.x, p.y);
        if (hit && (hit.type === 'text' || hit.type === 'sticky')) { setTool('select'); state.selected = new Set([hit.id]); startEdit(hit); }
        else createText(p);
        break;
      }
      case 'sticky':
        createSticky(p);
        break;
      case 'eraser':
        action = { type: 'erase', before: snapshot(), changed: false, last: p };
        eraseAlong(p, p);
        break;
      case 'select':
        selectDown(e, p);
        break;
    }
    requestRender();
  }

  function selectDown(e, p) {
    const sel = selectedElements();
    const h = sel.length ? handleAt(e.clientX, e.clientY) : null;
    if (h) {
      action = {
        type: 'resize', handle: h, bounds: unionBounds(sel), originals: new Map(sel.map((el) => [el.id, el])),
        keepAspect: sel.some((el) => el.type === 'text' || el.type === 'image'), before: snapshot(), changed: false,
      };
      return;
    }
    const hit = topHit(p.x, p.y);
    if (hit) {
      if (e.shiftKey) {
        if (state.selected.has(hit.id)) { state.selected.delete(hit.id); updateUI(); return; }
        state.selected.add(hit.id);
      } else if (!state.selected.has(hit.id)) {
        state.selected = new Set([hit.id]);
      }
      action = { type: 'move', start: p, originals: new Map(selectedElements().map((el) => [el.id, el])), before: snapshot(), changed: false };
    } else {
      if (!e.shiftKey) state.selected.clear();
      action = { type: 'marquee', x1: p.x, y1: p.y, x2: p.x, y2: p.y, base: new Set(state.selected) };
    }
    updateUI();
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { if (pointers.size >= 2) updatePinch(); return; }
    pointerScreen = { x: e.clientX, y: e.clientY };
    const p = toWorld(e.clientX, e.clientY);

    if (!action) {
      if (state.tool === 'select' && !spaceDown) updateHoverCursor(e, p);
      if (state.tool === 'eraser') requestRender();
      return;
    }

    switch (action.type) {
      case 'pan':
        cam.x -= (e.clientX - action.lastX) / cam.zoom;
        cam.y -= (e.clientY - action.lastY) / cam.zoom;
        action.lastX = e.clientX; action.lastY = e.clientY;
        save();
        break;
      case 'draw': {
        const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
        for (const ev of evs.length ? evs : [e]) {
          const q = toWorld(ev.clientX, ev.clientY), last = draft.points[draft.points.length - 1];
          if (Math.hypot(q.x - last[0], q.y - last[1]) > 1 / cam.zoom) draft.points.push([r2(q.x), r2(q.y)]);
        }
        break;
      }
      case 'shape': {
        let x2 = p.x, y2 = p.y;
        if (e.shiftKey) {
          const dx = x2 - draft.x1, dy = y2 - draft.y1;
          if (draft.type === 'rect' || draft.type === 'ellipse') {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            x2 = draft.x1 + Math.sign(dx || 1) * d; y2 = draft.y1 + Math.sign(dy || 1) * d;
          } else {
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
            x2 = draft.x1 + Math.cos(ang) * len; y2 = draft.y1 + Math.sin(ang) * len;
          }
        }
        draft.x2 = r2(x2); draft.y2 = r2(y2);
        break;
      }
      case 'move': {
        const dx = p.x - action.start.x, dy = p.y - action.start.y;
        const f = (x, y) => [r2(x + dx), r2(y + dy)];
        replaceElements(new Map([...action.originals].map(([id, o]) => [id, mapElement(o, f, 1)])));
        action.changed = true;
        break;
      }
      case 'resize': {
        const { bounds: b, handle: h } = action;
        const ax = h.includes('w') ? b.x2 : b.x1, ay = h.includes('n') ? b.y2 : b.y1;
        const hx = h.includes('w') ? b.x1 : b.x2, hy = h.includes('n') ? b.y1 : b.y2;
        let sx = Math.max(0.05, (p.x - ax) / ((hx - ax) || 1));
        let sy = Math.max(0.05, (p.y - ay) / ((hy - ay) || 1));
        if (e.shiftKey || action.keepAspect) sx = sy = Math.max(sx, sy);
        const f = (x, y) => [r2(ax + (x - ax) * sx), r2(ay + (y - ay) * sy)];
        const s = Math.sqrt(sx * sy);
        replaceElements(new Map([...action.originals].map(([id, o]) => [id, mapElement(o, f, s)])));
        action.changed = true;
        break;
      }
      case 'marquee': {
        action.x2 = p.x; action.y2 = p.y;
        const m = { x1: Math.min(action.x1, p.x), y1: Math.min(action.y1, p.y), x2: Math.max(action.x1, p.x), y2: Math.max(action.y1, p.y) };
        const sel = new Set(action.base);
        for (const el of state.elements) if (intersects(getBounds(el), m)) sel.add(el.id);
        state.selected = sel;
        break;
      }
      case 'erase':
        eraseAlong(action.last, p);
        action.last = p;
        break;
    }
    requestRender();
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!action) return;
    const a = action;
    action = null;

    switch (a.type) {
      case 'pan':
        setCursorForTool();
        break;
      case 'draw': {
        const before = snapshot();
        state.elements.push(draft);
        draft = null;
        pushUndo(before);
        break;
      }
      case 'shape': {
        if (Math.hypot(e.clientX - a.sx, e.clientY - a.sy) < 4) { // a click drops a default-sized shape
          const cx = draft.x1, cy = draft.y1;
          if (draft.type === 'rect' || draft.type === 'ellipse') Object.assign(draft, { x1: cx - 60, y1: cy - 60, x2: cx + 60, y2: cy + 60 });
          else Object.assign(draft, { x1: cx - 75, x2: cx + 75, y2: cy });
        }
        const before = snapshot();
        state.elements.push(draft);
        draft = null;
        pushUndo(before);
        break;
      }
      case 'move': case 'resize': case 'erase':
        if (a.changed) pushUndo(a.before);
        break;
    }
    afterChange();
  }

  function updateHoverCursor(e, p) {
    const h = state.selected.size ? handleAt(e.clientX, e.clientY) : null;
    if (h) canvas.style.cursor = h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize';
    else canvas.style.cursor = topHit(p.x, p.y) ? 'move' : 'default';
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { if (!action) { pointerScreen = null; requestRender(); } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('dblclick', (e) => {
    if (state.tool !== 'select') return;
    const p = toWorld(e.clientX, e.clientY);
    const hit = topHit(p.x, p.y);
    if (hit && (hit.type === 'text' || hit.type === 'sticky')) { state.selected = new Set([hit.id]); startEdit(hit); }
    else if (!hit) createText(p);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)));
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      cam.x += (e.deltaX * k) / cam.zoom; cam.y += (e.deltaY * k) / cam.zoom;
      save(); requestRender();
    }
  }, { passive: false });

  // Safari trackpad pinch
  let gestureBase = 1;
  window.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureBase = cam.zoom; });
  window.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, (gestureBase * e.scale) / cam.zoom); });

  // Drag & drop images
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const p = toWorld(e.clientX, e.clientY);
    [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')).forEach((f, i) => addImageFile(f, { x: p.x + i * 30, y: p.y + i * 30 }));
  });

  // ---------------------------------------------------------------- clipboard
  const isTyping = (t) => t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
  let lastPaste = { text: '', count: 0 };

  function onCopy(e, cut) {
    if (isTyping(e.target)) return;
    const sel = selectedElements();
    if (!sel.length) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', CLIP_PREFIX + JSON.stringify(sel));
    lastPaste = { text: '', count: 0 };
    if (cut) deleteSelection();
  }
  document.addEventListener('copy', (e) => onCopy(e, false));
  document.addEventListener('cut', (e) => onCopy(e, true));
  document.addEventListener('paste', (e) => {
    if (isTyping(e.target)) return;
    const dt = e.clipboardData;
    if (!dt) return;
    const file = [...dt.files].find((f) => f.type.startsWith('image/'))
      || [...dt.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).find(Boolean);
    if (file) { e.preventDefault(); addImageFile(file, viewCenter()); return; }
    const text = dt.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (text.startsWith(CLIP_PREFIX)) {
      try {
        lastPaste = text === lastPaste.text ? { text, count: lastPaste.count + 1 } : { text, count: 1 };
        insertElements(JSON.parse(text.slice(CLIP_PREFIX.length)), 24 * lastPaste.count);
      } catch { toast('Could not paste those items'); }
    } else if (text.trim()) {
      createText(viewCenter(), text);
    }
  });

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    if ($('#help').classList.contains('open')) { if (e.key === 'Escape' || e.key === '?') toggleHelp(false); return; }
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();

    if (e.key === ' ') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; if (!action) canvas.style.cursor = 'grab'; requestRender(); }
      return;
    }
    if (mod) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'a') { e.preventDefault(); setTool('select'); state.selected = new Set(state.elements.map((el) => el.id)); updateUI(); requestRender(); }
      else if (k === 'd') { e.preventDefault(); insertElements(selectedElements(), 24); }
      else if (k === '0') { e.preventDefault(); resetZoom(); }
      else if (k === '=' || k === '+') { e.preventDefault(); zoomBy(1.2); }
      else if (k === '-') { e.preventDefault(); zoomBy(1 / 1.2); }
      else if (k === 's') { e.preventDefault(); exportJSON(); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key === 'Escape') { state.selected.clear(); closeMenu(); updateUI(); requestRender(); return; }
    if (e.key === 'Enter') {
      const sel = selectedElements();
      if (sel.length === 1 && (sel[0].type === 'text' || sel[0].type === 'sticky')) { e.preventDefault(); startEdit(sel[0]); }
      return;
    }
    if (e.key.startsWith('Arrow')) {
      if (!state.selected.size) return;
      e.preventDefault();
      const d = (e.shiftKey ? 10 : 1) / cam.zoom;
      nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
      return;
    }
    if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) { fitToContent(); return; }
    if (e.key === '?') { toggleHelp(true); return; }
    if (e.key === ']') { reorder(true); return; }
    if (e.key === '[') { reorder(false); return; }
    if (k === 'f') { toggleFill(); return; }
    if (k === 'i') { $('#imageInput').click(); return; }
    if (TOOL_KEYS[k] && !e.altKey) setTool(TOOL_KEYS[k]);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { spaceDown = false; if (!action) setCursorForTool(); requestRender(); }
  });
  window.addEventListener('blur', () => { spaceDown = false; setCursorForTool(); });

  // ---------------------------------------------------------------- export / import
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportPNG() {
    if (!state.elements.length) { toast('The board is empty'); return; }
    const b = unionBounds(state.elements), pad = 40;
    const w = b.x2 - b.x1 + pad * 2, h = b.y2 - b.y1 + pad * 2;
    const s = Math.min(2, 8000 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * s); c.height = Math.ceil(h * s);
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    x.setTransform(s, 0, 0, s, (pad - b.x1) * s, (pad - b.y1) * s);
    for (const el of state.elements) drawElement(x, el);
    c.toBlob((blob) => download(blob, `whiteboard-${stamp()}.png`));
  }
  function exportJSON() {
    download(new Blob([JSON.stringify({ version: 1, elements: state.elements })], { type: 'application/json' }), `whiteboard-${stamp()}.json`);
  }
  function importJSON(file) {
    file.text().then((t) => {
      const d = JSON.parse(t);
      const els = Array.isArray(d) ? d : d.elements;
      if (!Array.isArray(els)) throw new Error('bad file');
      commitEdit();
      const before = snapshot();
      state.elements = els.filter(isValidElement);
      state.selected.clear();
      pushUndo(before);
      fitToContent(); afterChange();
      toast('Board opened');
    }).catch(() => toast('That file is not a whiteboard board'));
  }
  function clearBoard() {
    if (!state.elements.length) return;
    if (!confirm('Clear the whole board? You can undo this.')) return;
    const before = snapshot();
    state.elements = []; state.selected.clear();
    pushUndo(before); afterChange();
  }

  // ---------------------------------------------------------------- UI
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function toggleHelp(open) { $('#help').classList.toggle('open', open); }
  function closeMenu() { $('#menu').classList.remove('open'); }

  function updateZoomLabel() { $('#zoomLabel').textContent = Math.round(cam.zoom * 100) + '%'; }
  function updateUI() {
    $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
    $$('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === state.color));
    const custom = !COLORS.includes(state.color);
    $('.custom-color').classList.toggle('active', custom);
    if (custom) $('#customColor').value = state.color;
    $$('[data-width]').forEach((b) => b.classList.toggle('active', +b.dataset.width === state.width));
    $('#fillBtn').classList.toggle('active', state.fill);
    $('#undoBtn').disabled = !undoStack.length;
    $('#redoBtn').disabled = !redoStack.length;
    updateZoomLabel();
  }

  function buildUI() {
    const sw = $('#swatches');
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch'; b.dataset.color = c; b.style.setProperty('--c', c); b.title = c;
      b.addEventListener('click', () => setColor(c));
      sw.appendChild(b);
    }
    $('#customColor').addEventListener('change', (e) => setColor(e.target.value));

    const wd = $('#widths');
    for (const w of WIDTHS) {
      const b = document.createElement('button');
      b.className = 'width-btn'; b.dataset.width = w; b.title = `Stroke ${w}px`;
      const dot = document.createElement('span');
      const d = Math.min(18, w + 3);
      dot.style.width = dot.style.height = d + 'px';
      b.appendChild(dot);
      b.addEventListener('click', () => setWidth(w));
      wd.appendChild(b);
    }
    $('#fillBtn').addEventListener('click', toggleFill);

    $$('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#imageBtn').addEventListener('click', () => $('#imageInput').click());
    $('#imageInput').addEventListener('change', (e) => {
      const c = viewCenter();
      [...e.target.files].forEach((f, i) => addImageFile(f, { x: c.x + i * 30, y: c.y + i * 30 }));
      e.target.value = '';
    });
    $('#jsonInput').addEventListener('change', (e) => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ''; });

    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#zoomInBtn').addEventListener('click', () => zoomBy(1.2));
    $('#zoomOutBtn').addEventListener('click', () => zoomBy(1 / 1.2));
    $('#zoomLabel').addEventListener('click', resetZoom);
    $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').classList.toggle('open'); });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#top')) closeMenu(); });
    $('#menu').addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]')?.dataset.action;
      if (!act) return;
      closeMenu();
      ({ fit: fitToContent, png: exportPNG, save: exportJSON, open: () => $('#jsonInput').click(), help: () => toggleHelp(true), clear: clearBoard })[act]();
    });
    $('#help').addEventListener('click', (e) => { if (e.target.id === 'help') toggleHelp(false); });
  }

  // ---------------------------------------------------------------- boot
  window.addEventListener('resize', resize);
  load();
  buildUI();
  resize();
  setCursorForTool();
  updateUI();

  // Small public handle for tinkering from the dev console.
  window.whiteboard = { state, camera: cam, undo, redo, exportPNG, exportJSON, fitToContent, setTool };
})();
