import { BLOCKS, CATEGORIES, BASE_COLORS, BUILTIN_PRESETS, SUPPORT_BLOCKS, shadeRGB } from './palette.js';
import { buildMapData, SHADE_NAMES } from './mapart.js';
import { buildLitematicFile } from './litematic.js';
import { rgbToHex } from './color.js';
import { Viewer3D } from './viewer3d.js';

const $ = id => document.getElementById(id);
const MAP = 128;
const HINT_MAP = 'wheel: zoom · drag: pan · C: compare';
const HINT_3D = 'drag: orbit · wheel: zoom · right-drag / arrows: fly · green arrow = north';

// ── state ────────────────────────────────────────────────────────────────────
const state = {
  image: null,            // { canvas, name, w, h }
  view: 'map',
  mapsX: 1, mapsY: 1,
  fit: 'cover',
  mode: 'staircase', staircaseStyle: 'valley',
  dither: 'floyd', ditherStrength: 100,
  adjust: { brightness: 0, contrast: 0, saturation: 0 },
  supports: 'gravity', supportBlock: 'cobblestone',
  enabled: new Set(BLOCKS.map(b => b.id)),
  result: null,
  srcCanvas: null,        // fitted original (for compare)
  previewCanvas: null,    // final map colors
};
let viewer;               // Viewer3D, created at boot

// ── persistence ──────────────────────────────────────────────────────────────
const LS_SET = 'mapsmith.settings', LS_PRESETS = 'mapsmith.presets';
function saveSettings() {
  try {
    localStorage.setItem(LS_SET, JSON.stringify({
      mapsX: state.mapsX, mapsY: state.mapsY, fit: state.fit, mode: state.mode,
      staircaseStyle: state.staircaseStyle, dither: state.dither, ditherStrength: state.ditherStrength,
      adjust: state.adjust, supports: state.supports, supportBlock: state.supportBlock,
      enabled: [...state.enabled], exportName: $('exportName').value,
    }));
  } catch { /* private mode */ }
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SET));
    if (!s) return;
    Object.assign(state, {
      mapsX: s.mapsX ?? 1, mapsY: s.mapsY ?? 1, fit: s.fit ?? 'cover', mode: s.mode ?? 'staircase',
      staircaseStyle: s.staircaseStyle ?? 'valley', dither: s.dither ?? 'floyd',
      ditherStrength: s.ditherStrength ?? 100, adjust: s.adjust ?? state.adjust,
      supports: s.supports ?? 'gravity', supportBlock: s.supportBlock ?? 'cobblestone',
    });
    if (Array.isArray(s.enabled) && s.enabled.length) state.enabled = new Set(s.enabled);
    if (s.exportName) $('exportName').value = s.exportName;
  } catch { /* ignore */ }
}
const customPresets = (() => {
  try { return JSON.parse(localStorage.getItem(LS_PRESETS)) || []; } catch { return []; }
})();
const saveCustomPresets = () => { try { localStorage.setItem(LS_PRESETS, JSON.stringify(customPresets)); } catch {} };

// ── toasts ───────────────────────────────────────────────────────────────────
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2600);
}

// ── image loading ────────────────────────────────────────────────────────────
async function loadImageFile(file) {
  try {
    const bmp = await createImageBitmap(file);
    setImage(bmp, file.name);
  } catch { toast('Could not read that image', 'err'); }
}
function setImage(source, name) {
  const c = document.createElement('canvas');
  c.width = source.width; c.height = source.height;
  c.getContext('2d').drawImage(source, 0, 0);
  state.image = { canvas: c, name, w: source.width, h: source.height };
  $('imgMeta').hidden = false;
  $('imgName').textContent = name;
  $('imgDims').textContent = `${source.width} × ${source.height} px`;
  const t = $('thumb'), tc = t.getContext('2d');
  tc.clearRect(0, 0, 44, 44);
  const s = Math.max(44 / source.width, 44 / source.height);
  tc.drawImage(c, (44 - source.width * s) / 2, (44 - source.height * s) / 2, source.width * s, source.height * s);
  if (name && /^[\w\- ]+\./.test(name)) {
    $('exportName').value = name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').toLowerCase();
  }
  view.userMoved = false;
  scheduleProcess();
}

// procedural sample images
const SAMPLES = {
  aurora(ctx, s) {
    const sky = ctx.createLinearGradient(0, 0, 0, s);
    sky.addColorStop(0, '#020614'); sky.addColorStop(.45, '#0b1e3d'); sky.addColorStop(.75, '#38346b'); sky.addColorStop(1, '#c96a4a');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 140; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * .8})`;
      ctx.fillRect(Math.random() * s, Math.random() * s * .6, 1.6, 1.6);
    }
    for (let band = 0; band < 3; band++) {
      ctx.beginPath();
      for (let x = 0; x <= s; x += 8) {
        const y = s * (.18 + band * .09) + Math.sin(x / 70 + band * 2) * 34 + Math.sin(x / 23) * 9;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.lineWidth = 42 - band * 9;
      ctx.strokeStyle = ['rgba(64,255,170,.30)', 'rgba(120,255,120,.22)', 'rgba(90,200,255,.18)'][band];
      ctx.stroke();
    }
    ctx.fillStyle = '#f7e8b0';
    ctx.beginPath(); ctx.arc(s * .78, s * .30, 26, 0, 7); ctx.fill();
    ctx.fillStyle = '#0a0d18';
    ctx.beginPath(); ctx.moveTo(0, s);
    for (let x = 0; x <= s; x += 4) ctx.lineTo(x, s * .78 - Math.abs(Math.sin(x / 90)) * s * .22 - Math.sin(x / 31) * 12);
    ctx.lineTo(s, s); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#101a2e';
    ctx.beginPath(); ctx.moveTo(0, s);
    for (let x = 0; x <= s; x += 4) ctx.lineTo(x, s * .9 - Math.abs(Math.sin(x / 55 + 2)) * s * .14);
    ctx.lineTo(s, s); ctx.closePath(); ctx.fill();
  },
  wheel(ctx, s) {
    const cx = s / 2, cy = s / 2;
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy) / (s / 2);
      const i = (y * s + x) * 4;
      if (r > 1) { img.data[i + 3] = 0; continue; }
      const h = (Math.atan2(dy, dx) / Math.PI + 1) * 180;
      const [R, G, B] = hslToRgb(h, Math.min(1, r * 1.15), .55);
      img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  },
  testcard(ctx, s) {
    const bars = ['#ffffff', '#f2e33c', '#3ce0d8', '#3ce03c', '#e03ce0', '#e04040', '#3c50e0', '#111111'];
    bars.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect((s / bars.length) * i, 0, s / bars.length + 1, s * .55); });
    for (let x = 0; x < s; x++) {
      const v = Math.round(255 * x / s);
      ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, s * .55, 1, s * .15);
    }
    const g = ctx.createLinearGradient(0, 0, s, 0);
    g.addColorStop(0, '#ff4e00'); g.addColorStop(.5, '#7cffb0'); g.addColorStop(1, '#004eff');
    ctx.fillStyle = g; ctx.fillRect(0, s * .7, s, s * .3);
    ctx.fillStyle = '#0a0a0a'; ctx.beginPath(); ctx.arc(s / 2, s * .32, s * .13, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(s / 2, s * .32, s * .07, 0, 7); ctx.fill();
  },
};
function hslToRgb(h, sa, l) {
  const c = (1 - Math.abs(2 * l - 1)) * sa, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
function loadSample(id) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  SAMPLES[id](c.getContext('2d'), 512);
  setImage(c, `${id} (sample)`);
}

// ── processing ───────────────────────────────────────────────────────────────
let processTimer = null;
function scheduleProcess(delay = 160) {
  clearTimeout(processTimer);
  processTimer = setTimeout(runProcess, delay);
  saveSettings();
}

function fitDraw(ctx, img, W, H, fit) {
  ctx.clearRect(0, 0, W, H);
  if (fit === 'stretch') { ctx.drawImage(img, 0, 0, W, H); return; }
  const s = fit === 'cover' ? Math.max(W / img.width, H / img.height) : Math.min(W / img.width, H / img.height);
  const w = img.width * s, h = img.height * s;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

async function runProcess() {
  if (!state.image) return;
  if (state.enabled.size === 0) { toast('Select at least one block', 'err'); return; }
  $('busy').hidden = false;
  await new Promise(r => setTimeout(r, 20)); // let the overlay paint

  try {
    const W = state.mapsX * MAP, H = state.mapsY * MAP;
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const sctx = src.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    fitDraw(sctx, state.image.canvas, W, H, state.fit);
    state.srcCanvas = src;

    const imageData = sctx.getImageData(0, 0, W, H);
    const result = buildMapData(
      { width: W, height: H, data: imageData.data },
      {
        mode: state.mode, staircaseStyle: state.staircaseStyle,
        dither: state.dither, ditherStrength: state.ditherStrength / 100,
        adjustments: state.adjust, enabledBlocks: [...state.enabled],
        supports: state.supports, supportBlock: state.supportBlock,
      },
    );
    state.result = result;
    viewer.setResult(result);
    if (viewer.active && viewer.lastBuild?.tooBig) toast('Build too large for the 3D view', 'err');

    const pc = document.createElement('canvas');
    pc.width = W; pc.height = H;
    pc.getContext('2d').putImageData(new ImageData(result.previewRGBA, W, H), 0, 0);
    state.previewCanvas = pc;

    $('emptyState').hidden = true;
    if (!view.userMoved) view.fit();
    view.draw();
    renderStats();
    renderMaterials();
    markShadowedRows();
  } catch (e) {
    console.error(e);
    toast('Processing failed — see console', 'err');
  } finally {
    $('busy').hidden = true;
  }
}

// ── viewport (zoom / pan / grid / compare / hover) ───────────────────────────
const view = {
  canvas: $('view'), vp: $('viewport'),
  zoom: 1, panX: 0, panY: 0, dpr: window.devicePixelRatio || 1,
  showGrid: true, compare: false, userMoved: false,

  resize() {
    const r = this.vp.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.draw();
  },
  fit() {
    if (!state.previewCanvas) return;
    const r = this.vp.getBoundingClientRect();
    const z = Math.min(r.width / state.previewCanvas.width, r.height / state.previewCanvas.height) * .92;
    this.zoom = z;
    this.panX = (r.width - state.previewCanvas.width * z) / 2;
    this.panY = (r.height - state.previewCanvas.height * z) / 2;
    this.draw(); this.syncLabel();
  },
  syncLabel() { $('zoomLabel').textContent = `${Math.round(this.zoom * 100)}%`; },
  draw() {
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const img = this.compare ? state.srcCanvas : state.previewCanvas;
    if (!img) return;
    ctx.setTransform(this.dpr * this.zoom, 0, 0, this.dpr * this.zoom, this.dpr * this.panX, this.dpr * this.panY);
    ctx.imageSmoothingEnabled = this.zoom < 1;
    ctx.drawImage(img, 0, 0);

    if (this.showGrid && this.zoom > .18) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.lineWidth = 1;
      for (let mx = 0; mx <= state.mapsX; mx++) {
        const x = this.panX + mx * MAP * this.zoom;
        ctx.strokeStyle = 'rgba(159,232,112,.5)';
        ctx.beginPath(); ctx.moveTo(x, this.panY); ctx.lineTo(x, this.panY + img.height * this.zoom); ctx.stroke();
      }
      for (let my = 0; my <= state.mapsY; my++) {
        const y = this.panY + my * MAP * this.zoom;
        ctx.strokeStyle = 'rgba(159,232,112,.5)';
        ctx.beginPath(); ctx.moveTo(this.panX, y); ctx.lineTo(this.panX + img.width * this.zoom, y); ctx.stroke();
      }
    }
  },
  zoomAt(cx, cy, factor) {
    const nz = Math.min(48, Math.max(.04, this.zoom * factor));
    const k = nz / this.zoom;
    this.panX = cx - (cx - this.panX) * k;
    this.panY = cy - (cy - this.panY) * k;
    this.zoom = nz;
    this.userMoved = true;
    this.draw(); this.syncLabel();
  },
};

function initViewport() {
  new ResizeObserver(() => view.resize()).observe(view.vp);
  view.vp.addEventListener('wheel', e => {
    if (state.view === '3d') return; // OrbitControls owns the wheel
    e.preventDefault();
    const r = view.vp.getBoundingClientRect();
    view.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.18 : 1 / 1.18);
  }, { passive: false });

  let drag = null;
  view.vp.addEventListener('pointerdown', e => {
    if (state.view === '3d') return;
    drag = { x: e.clientX, y: e.clientY, px: view.panX, py: view.panY };
    view.vp.setPointerCapture(e.pointerId);
    view.vp.classList.add('panning');
  });
  view.vp.addEventListener('pointermove', e => {
    if (state.view === '3d') return;
    if (drag) {
      view.panX = drag.px + e.clientX - drag.x;
      view.panY = drag.py + e.clientY - drag.y;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) view.userMoved = true;
      view.draw();
    }
    hover(e);
  });
  const end = () => { drag = null; view.vp.classList.remove('panning'); };
  view.vp.addEventListener('pointerup', end);
  view.vp.addEventListener('pointercancel', end);
  view.vp.addEventListener('pointerleave', () => { $('statusPos').textContent = '—'; $('statusBlock').textContent = ''; });

  $('btnZoomIn').onclick = () => centerZoom(1.3);
  $('btnZoomOut').onclick = () => centerZoom(1 / 1.3);
  $('btnFit').onclick = () => { view.userMoved = false; view.fit(); };
  $('btn100').onclick = () => {
    const r = view.vp.getBoundingClientRect();
    view.zoomAt(r.width / 2, r.height / 2, 1 / view.zoom); // absolute 100%
  };
  $('btnGrid').onclick = e => { view.showGrid = !view.showGrid; e.currentTarget.classList.toggle('on', view.showGrid); view.draw(); };

  const cmp = $('btnCompare');
  const setCompare = v => { if (state.view === 'map' && view.compare !== v && state.srcCanvas) { view.compare = v; view.draw(); } };
  cmp.addEventListener('pointerdown', () => setCompare(true));
  window.addEventListener('pointerup', () => setCompare(false));
  window.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'c' && !e.repeat && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) setCompare(true); });
  window.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'c') setCompare(false); });

  function centerZoom(f) {
    const r = view.vp.getBoundingClientRect();
    view.zoomAt(r.width / 2, r.height / 2, f);
  }
}

// ── Map view ⇄ Minecraft (3D) view ───────────────────────────────────────────
function initViewToggle() {
  const setSeg = segInit($('segView'), 'map', async v => {
    if (v === state.view) return;
    state.view = v;
    $('viewport').classList.toggle('mode3d', v === '3d');
    $('mapTools').style.display = v === '3d' ? 'none' : 'flex';
    $('statusHint').textContent = v === '3d' ? HINT_3D : HINT_MAP;
    $('statusPos').textContent = '—';
    $('statusBlock').textContent = '';
    if (v === '3d') {
      $('busy').hidden = false;
      try {
        await viewer.show(state.result);
        if (viewer.lastBuild?.tooBig) toast('Build too large for the 3D view — try fewer maps', 'err');
      } catch (e) {
        console.error(e);
        toast('3D view unavailable (three.js failed to load — check internet)', 'err');
        state.view = 'map';
        setSeg('map');
        $('viewport').classList.remove('mode3d');
        $('mapTools').style.display = 'flex';
        $('statusHint').textContent = HINT_MAP;
      } finally {
        $('busy').hidden = true;
      }
    } else {
      viewer.hide();
      view.resize();
    }
  });
}

function hover(e) {
  if (!state.result) return;
  const r = view.vp.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left - view.panX) / view.zoom);
  const z = Math.floor((e.clientY - r.top - view.panY) / view.zoom);
  const { width, height, grid, palette, heights, mode } = state.result;
  if (x < 0 || z < 0 || x >= width || z >= height) { $('statusPos').textContent = '—'; $('statusBlock').textContent = ''; return; }
  $('statusPos').textContent = `x ${x} · z ${z}`;
  const gi = grid[z * width + x];
  if (gi < 0) { $('statusBlock').textContent = 'transparent (air)'; return; }
  const p = palette[gi];
  $('statusBlock').textContent = `${p.block.name} · ${SHADE_NAMES[p.shade]}${mode === 'staircase' ? ` · y+${heights[z * width + x]}` : ''}`;
}

// ── stats & materials ────────────────────────────────────────────────────────
const fmt = n => n.toLocaleString('en-US');
function renderStats() {
  const r = state.result;
  if (!r) return;
  $('stMaps').textContent = `${state.mapsX}×${state.mapsY}`;
  $('stBlocks').textContent = fmt(r.totalBlocks);
  $('stColors').textContent = new Set([...r.grid].filter(v => v >= 0).map(v => r.palette[v].colorId)).size;
  const hEl = $('stHeight');
  const hVal = r.mode === 'flat' ? 1 : r.ySize;
  hEl.textContent = r.mode === 'flat' ? 'flat' : `${hVal} tall`;
  const tooTall = hVal > 384;
  hEl.classList.toggle('warn', tooTall);
  $('heightWarn').hidden = !tooTall;
  $('outDims').textContent = `${state.mapsX * MAP} × ${state.mapsY * MAP} px`;
}

function stacksLabel(count) {
  const stacks = Math.floor(count / 64), rest = count % 64;
  let s = stacks > 0 ? `${stacks} st${rest ? ` + ${rest}` : ''}` : `${count}`;
  if (count >= 1728) s += ` · ${(count / 1728).toFixed(1)} shulker${count >= 3456 ? 's' : ''}`;
  return s;
}
function renderMaterials() {
  const r = state.result;
  const wrap = $('mats');
  wrap.innerHTML = '';
  if (!r) return;
  const max = Math.max(...r.materials.map(m => m.count));
  for (const row of r.materials) {
    const el = document.createElement('div');
    el.className = 'mrow';
    const rgb = row.isSupport ? [110, 110, 110] : shadeRGB(BASE_COLORS[row.block.color].rgb, 1);
    el.innerHTML = `
      <span class="sw" style="background:${rgbToHex(rgb)}"></span>
      <span class="m-name">${row.block.name}${row.isSupport ? '<span class="sub">noobline + supports</span>' : ''}</span>
      <span class="m-count"><b>${fmt(row.count)}</b><span>${stacksLabel(row.count)}</span></span>
      <span class="bar" style="width:${Math.max(2, row.count / max * 100)}%"></span>`;
    wrap.append(el);
  }
}
$('btnCopyMats').onclick = async () => {
  if (!state.result) return;
  const lines = state.result.materials.map(m => `${String(m.count).padStart(6)} × ${m.block.name}${m.isSupport ? ' (noobline + supports)' : ''}`);
  lines.push('', `total: ${state.result.totalBlocks} blocks · ${state.mapsX}×${state.mapsY} maps`);
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('Materials copied'); }
  catch { toast('Clipboard unavailable', 'err'); }
};

// ── palette UI ───────────────────────────────────────────────────────────────
const groupEls = new Map();
function buildPaletteUI() {
  const wrap = $('palGroups');
  wrap.innerHTML = '';
  for (const cat of CATEGORIES) {
    const blocks = BLOCKS.filter(b => b.cat === cat.id);
    const g = document.createElement('div');
    g.className = 'pgroup';
    const head = document.createElement('div');
    head.className = 'pgroup-head';
    head.innerHTML = `<input type="checkbox" data-group="${cat.id}" /><span class="g-label">${cat.label}</span><span class="g-count"></span><span class="chev">▶</span>`;
    const body = document.createElement('div');
    body.className = 'pgroup-body';
    body.innerHTML = `<div class="g-actions"><button data-ga="all">select all</button><button data-ga="none">deselect all</button></div>${cat.note ? `<div class="pgroup-note">⚠ ${cat.note}</div>` : ''}`;
    for (const b of blocks) {
      const row = document.createElement('label');
      row.className = 'brow';
      row.dataset.block = b.id;
      const flags = [b.g ? '<span class="flag">falls</span>' : '', b.w ? '<span class="flag">water</span>' : '', b.s ? '<span class="flag">support</span>' : ''].join('');
      row.innerHTML = `<input type="checkbox" /><span class="sw" style="background:${rgbToHex(shadeRGB(BASE_COLORS[b.color].rgb, 1))}"></span><span class="b-name">${b.name}</span>${flags}`;
      row.querySelector('input').addEventListener('change', ev => {
        ev.target.checked ? state.enabled.add(b.id) : state.enabled.delete(b.id);
        syncPaletteUI(); scheduleProcess();
      });
      body.append(row);
    }
    head.addEventListener('click', ev => {
      if (ev.target.matches('input')) return;
      g.classList.toggle('open');
    });
    head.querySelector('input').addEventListener('change', ev => {
      blocks.forEach(b => ev.target.checked ? state.enabled.add(b.id) : state.enabled.delete(b.id));
      syncPaletteUI(); scheduleProcess();
    });
    body.querySelector('[data-ga="all"]').onclick = () => { blocks.forEach(b => state.enabled.add(b.id)); syncPaletteUI(); scheduleProcess(); };
    body.querySelector('[data-ga="none"]').onclick = () => { blocks.forEach(b => state.enabled.delete(b.id)); syncPaletteUI(); scheduleProcess(); };
    g.append(head, body);
    wrap.append(g);
    groupEls.set(cat.id, { g, head, blocks });
  }
  syncPaletteUI();
}

function syncPaletteUI() {
  for (const [catId, { g, head, blocks }] of groupEls) {
    const on = blocks.filter(b => state.enabled.has(b.id)).length;
    const cb = head.querySelector('input');
    cb.checked = on === blocks.length;
    cb.indeterminate = on > 0 && on < blocks.length;
    head.querySelector('.g-count').textContent = `${on}/${blocks.length}`;
    g.querySelectorAll('.brow').forEach(row => {
      row.querySelector('input').checked = state.enabled.has(row.dataset.block);
    });
  }
  const colors = new Set(BLOCKS.filter(b => state.enabled.has(b.id)).map(b => b.color));
  $('paletteCount').textContent = `${state.enabled.size} blocks · ${colors.size}/60 colors`;
  renderPresetChips();
}

// grey out enabled blocks whose color is covered by an earlier block
function markShadowedRows() {
  const rep = new Map();
  for (const b of BLOCKS) if (state.enabled.has(b.id) && !rep.has(b.color)) rep.set(b.color, b);
  document.querySelectorAll('.brow').forEach(row => {
    const b = BLOCKS.find(x => x.id === row.dataset.block);
    const isShadowed = state.enabled.has(b.id) && rep.get(b.color) !== b;
    row.classList.toggle('shadowed', isShadowed);
    row.title = isShadowed ? `Color already provided by ${rep.get(b.color).name} (first selected wins)` : '';
  });
}

function allPresets() {
  return [...BUILTIN_PRESETS, ...customPresets.map(p => ({ ...p, custom: true }))];
}
function renderPresetChips() {
  const wrap = $('presetChips');
  wrap.innerHTML = '';
  for (const p of allPresets()) {
    const chip = document.createElement('button');
    chip.className = 'chip-p';
    const active = p.blocks.length === state.enabled.size && p.blocks.every(id => state.enabled.has(id));
    chip.classList.toggle('on', active);
    chip.title = p.desc || 'Custom preset';
    chip.innerHTML = p.custom ? `${p.name} <span class="x" title="Delete preset">×</span>` : p.name;
    chip.onclick = ev => {
      if (ev.target.classList.contains('x')) {
        customPresets.splice(customPresets.findIndex(c => c.name === p.name), 1);
        saveCustomPresets(); renderPresetChips();
        toast(`Deleted “${p.name}”`);
        return;
      }
      state.enabled = new Set(p.blocks);
      syncPaletteUI(); scheduleProcess();
    };
    wrap.append(chip);
  }
}

function initPaletteTools() {
  $('palAll').onclick = () => { state.enabled = new Set(BLOCKS.map(b => b.id)); syncPaletteUI(); scheduleProcess(); };
  $('palNone').onclick = () => { state.enabled.clear(); syncPaletteUI(); scheduleProcess(); };
  $('palSearch').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const [, { g }] of groupEls) {
      let any = false;
      g.querySelectorAll('.brow').forEach(row => {
        const hit = !q || row.querySelector('.b-name').textContent.toLowerCase().includes(q);
        row.style.display = hit ? '' : 'none';
        if (hit) any = true;
      });
      g.style.display = any ? '' : 'none';
      g.classList.toggle('open', !!q && any);
    }
  });
  $('btnSavePreset').onclick = () => {
    const name = $('presetName').value.trim();
    if (!name) { toast('Give the preset a name', 'err'); return; }
    if (state.enabled.size === 0) { toast('Nothing selected', 'err'); return; }
    const existing = customPresets.find(p => p.name === name);
    if (existing) existing.blocks = [...state.enabled];
    else customPresets.push({ id: `custom_${Date.now()}`, name, blocks: [...state.enabled] });
    saveCustomPresets(); renderPresetChips();
    $('presetName').value = '';
    toast(`Saved “${name}”`);
  };
}

// ── generic control wiring ───────────────────────────────────────────────────
function segInit(el, initial, cb) {
  const btns = [...el.querySelectorAll('button')];
  const set = v => btns.forEach(b => b.classList.toggle('on', b.dataset.v === v));
  set(initial);
  btns.forEach(b => b.addEventListener('click', () => { set(b.dataset.v); cb(b.dataset.v); }));
  return set;
}

function initControls() {
  document.querySelectorAll('[data-step]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [key, d] = btn.dataset.step.split(':');
      state[key] = Math.min(8, Math.max(1, state[key] + Number(d)));
      $(key).textContent = state[key];
      $('outDims').textContent = `${state.mapsX * MAP} × ${state.mapsY * MAP} px`;
      view.userMoved = false;
      scheduleProcess(300);
    });
  });
  $('mapsX').textContent = state.mapsX;
  $('mapsY').textContent = state.mapsY;
  $('outDims').textContent = `${state.mapsX * MAP} × ${state.mapsY * MAP} px`;

  segInit($('segFit'), state.fit, v => { state.fit = v; scheduleProcess(); });
  segInit($('segMode'), state.mode, v => {
    state.mode = v;
    $('fieldStyle').style.display = v === 'flat' ? 'none' : '';
    $('modeHint').textContent = v === 'flat'
      ? '1 shade per color — easy to build, smaller palette.'
      : '3 shades per color — richer palette, blocks placed at varying heights.';
    scheduleProcess();
  });
  $('fieldStyle').style.display = state.mode === 'flat' ? 'none' : '';
  segInit($('segStyle'), state.staircaseStyle, v => { state.staircaseStyle = v; scheduleProcess(); });

  $('selSupports').value = state.supports;
  $('selSupports').onchange = e => { state.supports = e.target.value; scheduleProcess(); };
  const sb = $('selSupportBlock');
  sb.innerHTML = SUPPORT_BLOCKS.map(b => `<option value="${b.id}">${b.name}</option>`).join('');
  sb.value = state.supportBlock;
  sb.onchange = e => { state.supportBlock = e.target.value; scheduleProcess(); };

  $('selDither').value = state.dither;
  $('selDither').onchange = e => { state.dither = e.target.value; scheduleProcess(); };

  const bindSlider = (rng, out, key, label) => {
    const el = $(rng), o = $(out);
    const apply = v => o.textContent = label ? `${v}%` : `${v}`;
    el.value = key === 'ditherStrength' ? state.ditherStrength : state.adjust[key];
    apply(el.value);
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (key === 'ditherStrength') state.ditherStrength = v; else state.adjust[key] = v;
      apply(v);
      scheduleProcess(220);
    });
    return el;
  };
  bindSlider('rngStrength', 'outStrength', 'ditherStrength', true);
  bindSlider('rngBrightness', 'outBrightness', 'brightness');
  bindSlider('rngContrast', 'outContrast', 'contrast');
  bindSlider('rngSaturation', 'outSaturation', 'saturation');
  $('btnResetAdjust').onclick = () => {
    state.adjust = { brightness: 0, contrast: 0, saturation: 0 };
    state.ditherStrength = 100;
    ['rngBrightness', 'rngContrast', 'rngSaturation'].forEach(id => { $(id).value = 0; });
    $('rngStrength').value = 100;
    ['outBrightness', 'outContrast', 'outSaturation'].forEach(id => { $(id).textContent = '0'; });
    $('outStrength').textContent = '100%';
    scheduleProcess();
  };
}

// ── file input / drop / paste ────────────────────────────────────────────────
function initFileInputs() {
  const dz = $('dropzone'), fi = $('fileInput');
  dz.onclick = () => fi.click();
  dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') fi.click(); };
  $('btnReplace').onclick = () => fi.click();
  fi.onchange = () => { if (fi.files[0]) loadImageFile(fi.files[0]); fi.value = ''; };

  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; dz.classList.add('drag'); });
  window.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dz.classList.remove('drag'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; dz.classList.remove('drag');
    const f = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
    if (f) loadImageFile(f);
  });
  window.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) loadImageFile(item.getAsFile());
  });
  document.querySelectorAll('[data-sample]').forEach(b => b.onclick = () => loadSample(b.dataset.sample));
}

// ── export ───────────────────────────────────────────────────────────────────
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function initExport() {
  $('btnExport').onclick = async () => {
    if (!state.result) { toast('Load an image first', 'err'); return; }
    const name = ($('exportName').value.trim() || 'map_art').replace(/[^\w\-]+/g, '_');
    try {
      const bytes = await buildLitematicFile(state.result, { name, author: 'Mapsmith', description: `${state.mapsX}×${state.mapsY} map art · ${state.mode}` });
      download(new Blob([bytes], { type: 'application/octet-stream' }), `${name}.litematic`);
      toast(`${name}.litematic downloaded`);
    } catch (e) {
      console.error(e);
      toast('Export failed — see console', 'err');
    }
    saveSettings();
  };
  $('btnExportPng').onclick = () => {
    if (!state.previewCanvas) { toast('Load an image first', 'err'); return; }
    state.previewCanvas.toBlob(b => download(b, `${($('exportName').value.trim() || 'map_art')}.png`));
    toast('PNG exported');
  };
}

// ── boot ─────────────────────────────────────────────────────────────────────
loadSettings();
viewer = new Viewer3D($('view3d'));
buildPaletteUI();
initPaletteTools();
initControls();
initViewport();
initViewToggle();
initFileInputs();
initExport();
view.resize();

// debug handle for tests
window.__mapsmith = { state, view, get viewer() { return viewer; } };
