const $ = id => document.getElementById(id);
const canvas = $('wheel'), ctx = canvas.getContext('2d');
const confettiCanvas = $('confetti'), cctx = confettiCanvas.getContext('2d');
const itemsEl = $('items'), countEl = $('count'), spinBtn = $('spin'), resultEl = $('result');
const removeEl = $('removeWinner'), soundEl = $('sound'), paletteEl = $('palette');
const weightedEl = $('weighted'), minEl = $('min'), maxEl = $('max'), cfg = $('cfg');
const removedInfo = $('removedInfo');
const historyBox = $('historyBox'), historyEl = $('history'), showHistoryEl = $('showHistory');

const STORE_KEY = 'random-wheel-v2', OLD_KEY = 'random-wheel-v1';
const MAX = 50;      // most spokes shown on the wheel
const DECOR = 24;    // unlabeled slices used for big number ranges
const TAU = 2 * Math.PI;
const HUB_R = 24;    // radius of the centre hub, in wheel units
const HEX = /^#[0-9a-f]{6}$/i;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- State ----
// An item is { label, color (hex or null = palette), weight, value? }.
const newItem = label => ({ label, color: null, weight: 1 });
const defaultItems = () => Array.from({ length: 8 }, (_, i) => newItem(String(i + 1)));
const stores = {
  list:  { items: defaultItems(), removed: [] },
  range: { items: [], removed: [], min: 1, max: 100, big: false },
};
let mode = 'list';
let cur = stores.list;
let history = [];          // [{ text, color }], newest first
let pendingRemove = null;  // the last winning item (object), removed when the next spin starts
let rotation = 0;          // radians, current wheel angle
let spinning = false;
let highlight = null;      // index of the winning slice, shown after a spin
let settingsHidden = false;

const sizeEl = $('wheelSize');
function applyWheelSize() {
  const v = sizeEl.value;
  document.body.style.setProperty('--wheel', v === 'fit' ? '4000px' : v + 'px');
}

function setSettingsHidden(h) {
  settingsHidden = h;
  $('settings').hidden = h;
  document.body.classList.toggle('zen', h);
  const b = $('toggleSettings');
  const label = h ? 'Show settings' : 'Hide settings';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.setAttribute('aria-expanded', String(!h));
}

// ---- Sound (Web Audio, no files needed) ----
let audio = null;
function getAudio() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audio = new AC();
  }
  if (audio && audio.state === 'suspended') audio.resume();
  return audio;
}
function beep(freq, dur, vol, type = 'triangle', delay = 0) {
  if (!soundEl.checked) return;
  const a = getAudio(); if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(a.destination);
  o.start(t); o.stop(t + dur);
}
const tick = () => beep(900 + Math.random() * 60, 0.04, 0.15, 'square');
const fanfare = () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.35, 0.2, 'triangle', i * 0.12));

// ---- Confetti ----
let particles = [], confettiRunning = false;
function launchConfetti() {
  if (reducedMotion()) return;
  confettiCanvas.width = innerWidth; confettiCanvas.height = innerHeight;
  const r = canvas.getBoundingClientRect();
  const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
  for (let i = 0; i < 140; i++) {
    const ang = Math.random() * TAU, sp = 4 + Math.random() * 9;
    particles.push({
      x: ox, y: oy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 4,
      w: 6 + Math.random() * 6, h: 4 + Math.random() * 5,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
      color: `hsl(${Math.random() * 360} 80% 55%)`, life: 0,
    });
  }
  if (!confettiRunning) { confettiRunning = true; requestAnimationFrame(stepConfetti); }
}
function stepConfetti() {
  cctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  particles = particles.filter(p => p.life < 110 && p.y < confettiCanvas.height + 20);
  for (const p of particles) {
    p.vy += 0.25; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life++;
    cctx.save();
    cctx.globalAlpha = Math.min(1, (110 - p.life) / 30);
    cctx.translate(p.x, p.y); cctx.rotate(p.rot);
    cctx.fillStyle = p.color; cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    cctx.restore();
  }
  if (particles.length) requestAnimationFrame(stepConfetti);
  else { confettiRunning = false; cctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height); }
}

// ---- Colours ----
const hslToHex = (h, s, l) => {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('');
};
// Each palette maps (slice index, slice count) -> [hue, saturation, lightness]
const PALETTES = {
  rainbow: (i, n) => [(i * 360 / n + (i % 2) * 8) % 360, 70, 55],
  pastel:  (i, n) => [(i * 360 / n) % 360, 70, 80],
  ocean:   (i, n) => [170 + (i / n) * 70, 65, 38 + (i % 2) * 14],
  sunset:  (i, n) => [(350 + (i / n) * 70) % 360, 85, 52 + (i % 2) * 8],
  forest:  (i, n) => [80 + (i / n) * 80, 45, 34 + (i % 2) * 12],
};
const color = i => cur.items[i].color || hslToHex(...PALETTES[paletteEl.value](i, cur.items.length));
const isLight = hex => {
  const [r, g, b] = [1, 3, 5].map(p => parseInt(hex.substr(p, 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) > 170;
};

// ---- Geometry ----
// Angles are measured clockwise from the top (where the pointer is), before rotation.
const weightedOn = () => mode === 'list' && weightedEl.checked;
const effWeight = it => (weightedOn() && it.weight > 0) ? it.weight : 1;
function geometry() {
  const w = cur.items.map(effWeight), total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  const starts = w.map(x => { const s = acc / total * TAU; acc += x; return s; });
  return { starts, widths: w.map(x => x / total * TAU), total, w };
}
function sliceAt(geo, theta) {
  for (let i = geo.starts.length - 1; i >= 0; i--) if (theta >= geo.starts[i]) return i;
  return 0;
}

// ---- Persistence ----
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      mode, history, settingsHidden,
      weighted: weightedEl.checked, removeWinner: removeEl.checked, sound: soundEl.checked, showHistory: showHistoryEl.checked, wheelSize: sizeEl.value, palette: paletteEl.value,
      list: stores.list,
      range: { min: stores.range.min, max: stores.range.max, removedValues: stores.range.removed.map(x => x.value) },
    }));
  } catch (e) { /* storage unavailable; ignore */ }
}

function cleanItem(x) {
  const o = (x && typeof x === 'object') ? x : { label: x };
  const it = {
    label: String(o.label ?? '').slice(0, 200),
    color: HEX.test(o.color) ? o.color : null,
    weight: (Number.isFinite(o.weight) && o.weight > 0) ? o.weight : 1,
  };
  if (Number.isFinite(o.value)) it.value = o.value;
  return it;
}

let savedRemovedValues = [];
function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { /* ignore */ }
  if (!d) { // migrate settings saved by the first version
    try {
      const v1 = JSON.parse(localStorage.getItem(OLD_KEY));
      if (v1 && Array.isArray(v1.labels)) {
        d = {
          removeWinner: v1.removeWinner, sound: v1.sound, palette: v1.palette,
          list: {
            items: v1.labels.map((l, i) => ({ label: l, color: (v1.colors || [])[i] })),
            removed: (v1.removed || []).map((l, i) => ({ label: l, color: (v1.removedColors || [])[i] })),
          },
        };
      }
    } catch (e) { /* ignore */ }
  }
  if (!d) return;
  try {
    const items = (Array.isArray(d.list?.items) ? d.list.items : []).slice(0, MAX).map(cleanItem);
    if (items.length) stores.list.items = items;
    stores.list.removed = (Array.isArray(d.list?.removed) ? d.list.removed : []).slice(0, 200).map(cleanItem);
    if (Number.isFinite(d.range?.min)) minEl.value = d.range.min;
    if (Number.isFinite(d.range?.max)) maxEl.value = d.range.max;
    savedRemovedValues = Array.isArray(d.range?.removedValues) ? d.range.removedValues : [];
    history = (Array.isArray(d.history) ? d.history : []).slice(0, 10)
      .map(h => ({ text: String(h?.text ?? ''), color: HEX.test(h?.color) ? h.color : '#999999' }));
    setSettingsHidden(!!d.settingsHidden);
    weightedEl.checked = !!d.weighted;
    removeEl.checked = !!d.removeWinner;
    soundEl.checked = d.sound !== false;
    showHistoryEl.checked = d.showHistory !== false;
    if ([...sizeEl.options].some(o => o.value === d.wheelSize)) sizeEl.value = d.wheelSize;
    if (Object.hasOwn(PALETTES, d.palette)) paletteEl.value = d.palette;
    if (d.mode === 'range') { mode = 'range'; document.querySelector('input[name=mode][value=range]').checked = true; }
  } catch (e) { /* ignore corrupt data */ }
}

// ---- Number range mode ----
function regenRange() {
  const r = stores.range;
  let lo = Number.parseInt(minEl.value, 10), hi = Number.parseInt(maxEl.value, 10);
  if (!Number.isFinite(lo)) lo = 1;
  if (!Number.isFinite(hi)) hi = Math.max(lo, 100);
  const LIM = 1e9;
  lo = Math.max(-LIM, Math.min(LIM, lo)); hi = Math.max(-LIM, Math.min(LIM, hi));
  if (lo > hi) [lo, hi] = [hi, lo];
  r.min = lo; r.max = hi; minEl.value = lo; maxEl.value = hi;
  const span = hi - lo + 1;
  r.big = span > MAX;
  r.removed = [];
  r.items = r.big
    ? Array.from({ length: DECOR }, () => newItem(''))
    : Array.from({ length: span }, (_, i) => ({ ...newItem(String(lo + i)), value: lo + i }));
}

// ---- UI building ----
function updateModeUI() {
  document.querySelectorAll('[data-mode]').forEach(el => { el.hidden = el.dataset.mode !== mode; });
  const big = mode === 'range' && cur.big;
  removeEl.disabled = big;
  removeEl.parentElement.title = big ? 'Not available for ranges larger than ' + MAX : '';
  const r = stores.range;
  $('rangeNote').textContent = r.big
    ? `${(r.max - r.min + 1).toLocaleString()} numbers is too many to show on the wheel (limit ${MAX}), so it just spins and shows the result.`
    : `${r.max - r.min + 1} number${r.max === r.min ? '' : 's'}, shown on the wheel.`;
}

function buildInputs() {
  if (mode === 'list') {
    const n = Math.min(MAX, Math.max(1, parseInt(countEl.value) || 1));
    countEl.value = n;
    const old = cur.items;
    cur.items = Array.from({ length: n }, (_, i) => old[i] ?? newItem(String(i + 1)));
  }
  itemsEl.innerHTML = '';
  if (mode === 'list') {
    const showWeights = weightedEl.checked;
    cur.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'row';

      const swatch = document.createElement('input');
      swatch.type = 'color'; swatch.className = 'swatch'; swatch.value = color(i);
      swatch.title = 'Pick a colour for this spoke';
      swatch.setAttribute('aria-label', `Colour for spoke ${i + 1}`);
      swatch.addEventListener('input', () => { it.color = swatch.value; draw(); save(); });
      row.appendChild(swatch);

      const input = document.createElement('input');
      input.className = 'text'; input.value = it.label;
      input.setAttribute('aria-label', `Label for spoke ${i + 1}`);
      input.addEventListener('input', () => { it.label = input.value; draw(); save(); });
      row.appendChild(input);

      if (showWeights) {
        const w = document.createElement('input');
        w.type = 'number'; w.className = 'weight'; w.min = '0.1'; w.step = '0.5'; w.value = it.weight;
        w.title = 'Weight: a spoke with weight 2 is twice as big and twice as likely as one with weight 1';
        w.setAttribute('aria-label', `Weight for spoke ${i + 1}`);
        w.addEventListener('input', () => {
          const v = parseFloat(w.value);
          if (!(v > 0)) return;            // ignore half-typed values like "" or "-"
          it.weight = v;
          highlight = null;                // slice sizes changed, so the old highlight no longer fits
          draw(); save();
        });
        w.addEventListener('change', () => { w.value = it.weight; }); // snap invalid entries back
        row.appendChild(w);
      }

      const del = document.createElement('button');
      del.className = 'del'; del.type = 'button'; del.textContent = '×';
      del.title = 'Delete this spoke';
      del.setAttribute('aria-label', `Delete spoke ${i + 1}${it.label ? ` (${it.label})` : ''}`);
      del.disabled = cur.items.length <= 1;
      del.addEventListener('click', () => {
        if (spinning || cur.items.length <= 1) return;
        cur.items.splice(i, 1);
        countEl.value = cur.items.length;
        buildInputs();
        // keep keyboard users in place: focus the delete button that took this spoke's slot
        const btns = itemsEl.querySelectorAll('button.del');
        (btns[Math.min(i, btns.length - 1)] || countEl).focus();
      });
      row.appendChild(del);
      itemsEl.appendChild(row);
    });
  }
  highlight = null;
  updateModeUI();
  draw();
  renderRemoved();
  save();
}

function renderRemoved() {
  const removed = cur.removed;
  removedInfo.hidden = !removed.length;
  if (!removed.length) return;
  removedInfo.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'removed-head';
  head.innerHTML = `<span>Removed (${removed.length})</span>`;
  const all = document.createElement('button');
  all.className = 'small'; all.textContent = 'Restore all';
  all.onclick = () => restore(removed.map((_, i) => i));
  head.appendChild(all);

  const chips = document.createElement('div');
  chips.className = 'chips';
  removed.forEach((it, i) => {
    const c = document.createElement('button');
    c.className = 'chip';
    c.title = `Restore "${it.label}"`;
    const s = document.createElement('span');
    s.textContent = it.label || '(blank)';
    c.append(s, '↩');
    c.onclick = () => restore([i]);
    chips.appendChild(c);
  });
  removedInfo.append(head, chips);
}

// Put removed items (by index into `removed`) back on the wheel.
function restore(indices) {
  if (spinning) return;
  const room = MAX - cur.items.length;
  const picked = indices.slice(0, Math.max(0, room));
  if (!picked.length) { // wheel is full: change nothing, but say why
    renderRemoved();
    const p = document.createElement('p');
    p.className = 'note'; p.textContent = `The wheel is full (${MAX} spokes max).`;
    removedInfo.appendChild(p);
    return;
  }
  cur.items = cur.items.concat(picked.map(i => cur.removed[i]));
  if (mode === 'range') cur.items.sort((a, b) => a.value - b.value);
  cur.removed = cur.removed.filter((_, i) => !picked.includes(i));
  pendingRemove = null; resultEl.textContent = '';
  countEl.value = cur.items.length;
  buildInputs();
}

// ---- Drawing ----
function draw() {
  const items = cur.items, n = items.length;
  // Draw in an 800x800 coordinate space; the canvas itself is higher-res so it stays sharp when large.
  const W = 800, c = W / 2, r = c - 8;
  const geo = geometry();
  ctx.setTransform(canvas.width / W, 0, 0, canvas.width / W, 0, 0);
  ctx.clearRect(0, 0, W, W);
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(rotation);
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + geo.starts[i], a1 = a0 + geo.widths[i];
    const dim = highlight !== null && i !== highlight;
    ctx.globalAlpha = dim ? 0.35 : 1;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, a0, a1); ctx.closePath();
    const fill = color(i);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();

    if (items[i].label) {
      ctx.save();
      ctx.rotate(a0 + geo.widths[i] / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const light = isLight(fill);
      ctx.fillStyle = light ? '#222' : '#fff';
      ctx.shadowColor = light ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
      const size = Math.max(9, Math.min(36, 0.4 * r * geo.widths[i]));
      ctx.font = `bold ${size}px system-ui, sans-serif`;
      // Text runs along the slice's middle line. Work out the stretch of that line where the slice
      // is wide enough to hold the text (it narrows towards the hub), then centre the text in it.
      const half = Math.min(geo.widths[i] / 2, 1.3);
      const inner = Math.max(HUB_R + 12, (size * 0.6) / Math.tan(half));
      const outer = r - 16;
      const room = Math.max(40, outer - inner);
      let t = items[i].label;
      while (t.length > 1 && ctx.measureText(t).width > room) t = t.slice(0, -2) + '…';
      ctx.fillText(t, inner + (outer - inner) / 2, 0);
      ctx.restore();
    }
  }
  // Winner outline goes in a second pass so neighbouring slices can't paint over it.
  if (highlight !== null && highlight < n) {
    const a0 = -Math.PI / 2 + geo.starts[highlight];
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, a0, a0 + geo.widths[highlight]); ctx.closePath();
    ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  // hub
  ctx.beginPath(); ctx.arc(c, c, HUB_R, 0, TAU);
  ctx.fillStyle = '#222'; ctx.fill();

  const desc = cur.big
    ? `Number wheel from ${stores.range.min} to ${stores.range.max}`
    : `Wheel with ${n} spoke${n === 1 ? '' : 's'}: ${items.map(it => it.label || 'blank').join(', ')}`;
  if (canvas.getAttribute('aria-label') !== desc) canvas.setAttribute('aria-label', desc);
}

// ---- Results & history ----
function showResult(text, extra = '') {
  resultEl.textContent = '';
  const e = document.createElement('span');
  e.setAttribute('aria-hidden', 'true'); e.textContent = '🎉 ';
  resultEl.append(e, text + extra);
}
function renderHistory() {
  historyBox.hidden = !history.length || !showHistoryEl.checked;
  historyEl.innerHTML = '';
  history.forEach(h => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = h.color; dot.setAttribute('aria-hidden', 'true');
    const t = document.createElement('span');
    t.className = 'txt'; t.textContent = h.text; t.title = h.text;
    li.append(dot, t);
    historyEl.appendChild(li);
  });
}

// ---- Spinning ----
function spin() {
  if (spinning) return;
  if (pendingRemove !== null) {
    const idx = cur.items.indexOf(pendingRemove); // -1 if the item has since gone (e.g. list replaced)
    if (idx >= 0) {
      cur.removed.push(cur.items.splice(idx, 1)[0]);
      countEl.value = cur.items.length;
      rotation = 0;
      buildInputs();
    }
    pendingRemove = null;
  }
  if (cur.items.length < 2) {
    resultEl.textContent = 'Need at least 2 spokes to spin.';
    return;
  }
  spinning = true; spinBtn.disabled = true; cfg.disabled = true; resultEl.textContent = '';
  highlight = null;
  getAudio(); // create/resume audio inside the user gesture

  const geo = geometry(), n = cur.items.length;
  // Pick the winner by weight.
  let pick = Math.random() * geo.total, winner = n - 1;
  for (let i = 0; i < n; i++) { if ((pick -= geo.w[i]) < 0) { winner = i; break; } }

  // Land at a random spot within the winning slice (not exactly the centre).
  const center = geo.starts[winner] + geo.widths[winner] / 2;
  const jitter = (Math.random() - 0.5) * geo.widths[winner] * 0.8;
  const target = -(center + jitter);
  const start = rotation;
  const reduced = reducedMotion();
  const turns = reduced ? 0 : 5 + Math.floor(Math.random() * 3);
  let delta = ((target - start) % TAU + TAU) % TAU;
  delta += turns * TAU;
  const dur = reduced ? 700 : 4500, t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 4);
  let lastSlice = null;

  (function frame(now) {
    const t = Math.min(1, (now - t0) / dur);
    rotation = start + delta * ease(t);
    // slice currently under the pointer; tick whenever it changes
    const slice = sliceAt(geo, ((-rotation % TAU) + TAU) % TAU);
    if (lastSlice !== null && slice !== lastSlice) tick();
    lastSlice = slice;
    draw();
    if (t < 1) return requestAnimationFrame(frame);

    rotation %= TAU;
    spinning = false; spinBtn.disabled = false; cfg.disabled = false;
    highlight = winner; draw();
    fanfare(); launchConfetti();

    const big = cur.big;
    const text = big
      ? String(stores.range.min + Math.floor(Math.random() * (stores.range.max - stores.range.min + 1)))
      : (cur.items[winner].label || '(blank)');
    let extra = '';
    if (removeEl.checked && !big) { pendingRemove = cur.items[winner]; extra = ' (removed on next spin)'; }
    showResult(text, extra);

    history.unshift({ text, color: color(winner) });
    history.length = Math.min(history.length, 10);
    renderHistory();
    save();
  })(t0);
}

// ---- Events ----
countEl.addEventListener('change', buildInputs);
spinBtn.addEventListener('click', spin);

// Space spins from anywhere on the page. It's left alone when:
//  - you're typing in a text/number field, or
//  - a control was reached with the keyboard (so Space still ticks a checkbox, opens a dropdown, etc.), or
//  - the Spin button itself is focused (it handles Space natively).
// A control you merely clicked with the mouse doesn't count, so Space still spins after changing a setting.
function spaceShouldSpin(t) {
  if (!(t instanceof Element) || t === spinBtn) return false;
  if (t.matches('textarea, [contenteditable], input:not([type=checkbox]):not([type=radio]):not([type=color])')) return false;
  if (t.matches(':focus-visible') && t.closest('input, select, button, summary')) return false;
  return true;
}
let swallowSpaceKeyup = false;
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (!spaceShouldSpin(e.target)) return;
  e.preventDefault();
  if (e.repeat) return;
  swallowSpaceKeyup = true; // stop a focused checkbox/button from also toggling on key release
  spin();
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && swallowSpaceKeyup) { swallowSpaceKeyup = false; e.preventDefault(); }
});

document.querySelectorAll('input[name=mode]').forEach(radio => radio.addEventListener('change', () => {
  if (!radio.checked || spinning) return;
  mode = radio.value; cur = stores[mode];
  pendingRemove = null; resultEl.textContent = '';
  if (mode === 'range' && !cur.items.length) regenRange();
  countEl.value = stores.list.items.length;
  buildInputs();
}));

[minEl, maxEl].forEach(el => el.addEventListener('change', () => {
  if (spinning) return;
  regenRange();
  pendingRemove = null; resultEl.textContent = '';
  buildInputs();
}));

weightedEl.addEventListener('change', () => { buildInputs(); });
$('numbers').addEventListener('click', () => {
  cur.items.forEach((it, i) => { it.label = String(i + 1); });
  buildInputs();
});
soundEl.addEventListener('change', save);
showHistoryEl.addEventListener('change', () => { renderHistory(); save(); });
sizeEl.addEventListener('change', () => { applyWheelSize(); save(); });
paletteEl.addEventListener('change', () => { if (!spinning) buildInputs(); });
$('resetColors').addEventListener('click', () => {
  if (spinning) return;
  [...cur.items, ...cur.removed].forEach(it => { it.color = null; });
  buildInputs();
});
removeEl.addEventListener('change', () => {
  if (!removeEl.checked) pendingRemove = null;
  save();
});
$('applyPaste').addEventListener('click', () => {
  if (spinning) return;
  const lines = $('paste').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, MAX);
  if (!lines.length) return;
  cur.items = lines.map(newItem); cur.removed = [];
  pendingRemove = null; resultEl.textContent = '';
  countEl.value = cur.items.length;
  buildInputs();
});
$('toggleSettings').addEventListener('click', () => { setSettingsHidden(!settingsHidden); save(); });
// Reset: first click arms the button, second click (within 4s) does it.
function resetAll() {
  if (spinning) return;
  stores.list = { items: defaultItems(), removed: [] };
  minEl.value = 1; maxEl.value = 100;
  regenRange();
  mode = 'list'; cur = stores.list;
  document.querySelector('input[name=mode][value=list]').checked = true;
  weightedEl.checked = false; removeEl.checked = false;
  soundEl.checked = true; showHistoryEl.checked = true;
  sizeEl.value = '460'; applyWheelSize();
  paletteEl.value = 'rainbow';
  history = []; renderHistory();
  pendingRemove = null; rotation = 0; highlight = null;
  resultEl.textContent = ''; $('paste').value = '';
  countEl.value = cur.items.length;
  buildInputs(); // redraws and saves
}
let resetTimer = null;
const resetBtn = $('resetAll');
function disarmReset() { clearTimeout(resetTimer); resetBtn.classList.remove('danger'); resetBtn.textContent = 'Reset'; }
resetBtn.addEventListener('click', () => {
  if (resetBtn.classList.contains('danger')) { disarmReset(); resetAll(); return; }
  resetBtn.classList.add('danger'); resetBtn.textContent = 'Click again to confirm';
  resetTimer = setTimeout(disarmReset, 4000);
});
resetBtn.addEventListener('blur', disarmReset);
$('clearHistory').addEventListener('click', () => { history = []; renderHistory(); save(); });

// ---- Init ----
load();
regenRange();
if (savedRemovedValues.length) {
  const r = stores.range;
  savedRemovedValues.forEach(v => {
    const k = r.items.findIndex(it => it.value === v);
    if (k >= 0 && r.items.length > 1) r.removed.push(r.items.splice(k, 1)[0]);
  });
}
cur = stores[mode];
countEl.value = stores.list.items.length;
applyWheelSize();
renderHistory();
buildInputs();
