/* Recipe Book app. SQLite (sql.js) in the browser, saved to this device's IndexedDB, exportable as a .db file. */
'use strict';

let SQL = null, DB = null;
const $v = document.getElementById('view');
const UNITS = ['g', 'mL', 'tsp', 'tbsp', 'each', 'pinch'];
const AISLES = ['Produce', 'Pantry', 'Baking', 'Dairy', 'Meat & seafood', 'Frozen', 'Bakery', 'Drinks', 'Household', 'Other'];

/* ---------- small helpers ---------- */
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function q(sql, params) {
  const st = DB.prepare(sql); const out = [];
  if (params) st.bind(params);
  while (st.step()) out.push(st.getAsObject());
  st.free(); return out;
}
function run(sql, params) { DB.run(sql, params || []); }
function lastId() { return q('SELECT last_insert_rowid() AS id')[0].id; }
function toast(msg, important) {
  if (!important && Date.now() < (toast._hold || 0)) return;
  const t = document.getElementById('toast'); t.textContent = msg; t.hidden = false;
  if (important) toast._hold = Date.now() + 5000;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, important ? 5000 : 2200);
}
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function nice(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return isNaN(d) ? dateStr : d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}
// Two-click confirm built into the page (the browser's confirm() is not used).
function confirmClick(btn, label, action) {
  btn.addEventListener('click', () => {
    if (btn.dataset.armed === '1') { action(); return; }
    btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = label;
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = old; } }, 4000);
  });
}

/* ---------- saving on this device ---------- */
const IDB_NAME = 'recipe-book', IDB_STORE = 'files', IDB_KEY = 'recipes.db';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet() {
  try { const d = await idb(); return await new Promise((res, rej) => { const t = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(IDB_KEY); t.onsuccess = () => res(t.result || null); t.onerror = () => rej(t.error); }); }
  catch (e) { return null; }
}
async function idbSet(bytes) {
  try { const d = await idb(); await new Promise((res, rej) => { const t = d.transaction(IDB_STORE, 'readwrite'); t.objectStore(IDB_STORE).put(bytes, IDB_KEY); t.oncomplete = res; t.onerror = () => rej(t.error); }); return true; }
  catch (e) { return false; }
}
async function idbClear() {
  try { const d = await idb(); await new Promise((res) => { const t = d.transaction(IDB_STORE, 'readwrite'); t.objectStore(IDB_STORE).delete(IDB_KEY); t.oncomplete = res; t.onerror = res; }); } catch (e) { /* nothing saved */ }
}
function exportBytes() { const b = DB.export(); run('PRAGMA foreign_keys=ON'); return b; }
// "local": started from the Mac launcher, saves to Recipe Book/Data/recipes.db. "browser": GitHub Pages, saves in this browser.
const MODE = { kind: 'browser', rev: null, folder: '' };
async function detectServer() {
  try {
    const r = await fetch('api/ping', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json(); if (j.mode !== 'local') return false;
    MODE.kind = 'local'; MODE.folder = r.headers.get('X-Data-Folder') || ''; return true;
  } catch (e) { return false; }
}
async function serverLoad() {
  const r = await fetch('api/db', { cache: 'no-store' });
  if (!r.ok) throw new Error('The Recipe Book server could not read the database');
  MODE.rev = r.headers.get('X-Rev');
  return new Uint8Array(await r.arrayBuffer());
}
async function serverSave(bytes, force) {
  const headers = { 'X-Recipe-Book': '1', 'Content-Type': 'application/x-sqlite3', 'X-Base-Rev': MODE.rev || '' };
  if (force) headers['X-Force'] = '1';
  const r = await fetch('api/db', { method: 'POST', headers, body: bytes });
  if (r.status === 409) return 'conflict';
  if (!r.ok) throw new Error(await r.text());
  MODE.rev = r.headers.get('X-Rev'); return 'ok';
}
// When you come back to a tab, pick up changes made in another tab first.
async function refreshIfChanged() {
  if (MODE.kind !== 'local' || state.draft) return;
  try {
    const r = await fetch('api/rev', { cache: 'no-store' }); if (!r.ok) return;
    if ((await r.text()) !== MODE.rev) { openDb(await serverLoad()); route(); }
  } catch (e) { /* server stopped; saving will report it */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshIfChanged(); });
window.addEventListener('focus', refreshIfChanged);
async function persist() {
  if (MODE.kind === 'local') {
    try {
      const res = await serverSave(exportBytes());
      if (res === 'conflict') {
        openDb(await serverLoad());
        toast('Recipe Book changed in another window. Loaded the latest copy, so make your change again.', true);
        route();
      }
    } catch (e) { toast('Could not save to your Mac: ' + e.message + '. Is the Recipe Book window still open?', true); }
    return;
  }
  const ok = await idbSet(exportBytes());
  if (!ok) toast('Could not save on this device. Export the database to keep your changes.');
}
function openDb(bytes) {
  if (DB) DB.close();
  DB = new SQL.Database(bytes);
  run('PRAGMA foreign_keys=ON');
  migrate();
}
function migrate() {
  run(`CREATE TABLE IF NOT EXISTS cook_log (id INTEGER PRIMARY KEY, recipe_id INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
       cooked_on TEXT NOT NULL, servings INTEGER, rating INTEGER CHECK (rating BETWEEN 1 AND 5), notes TEXT)`);
  const need = ['ingredient', 'recipe', 'recipe_ingredient', 'step', 'step_uses', 'step_from'];
  const have = q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
  const missing = need.filter(n => !have.includes(n));
  if (missing.length) throw new Error('This database is missing tables: ' + missing.join(', '));
  shopMigrate();
}
async function fetchPublished() {
  const res = await fetch('recipes.db', { cache: 'no-cache' });
  if (!res.ok) throw new Error('recipes.db not found next to index.html');
  return new Uint8Array(await res.arrayBuffer());
}

/* ---------- amounts ---------- */
const FRS = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];
function fmt(x) {
  let w = Math.floor(x + 1e-9), rest = x - w, best = FRS[0], bd = 9;
  FRS.forEach(p => { const d = Math.abs(rest - p[0]); if (d < bd) { bd = d; best = p; } });
  if (best[0] === 1) { w += 1; best = FRS[0]; }
  return ((w > 0 ? String(w) : '') + (w > 0 && best[1] ? ' ' : '') + best[1]) || '0';
}
const smart = (x) => x < 20 ? Math.round(x) : x < 200 ? Math.round(x / 5) * 5 : Math.round(x / 10) * 10;
function amount(d, f) {
  if (d.amount == null || d.amount === '') return { q: '', u: '' };
  const raw = Number(d.amount) * (d.scaling === 'fixed' ? 1 : f);
  if (d.unit === 'g') return { q: String(smart(raw)), u: 'g' };
  if (d.unit === 'mL') return { q: String(smart(raw)), u: 'mL' };
  if (d.unit === 'tsp' || d.unit === 'tbsp') return { q: fmt(Math.max(raw, 0.125)), u: d.unit };
  if (d.unit === 'pinch') return { q: fmt(Math.max(raw, 1)), u: raw > 1.01 ? 'pinches' : 'pinch' };
  if (d.unit === 'each') {
    const v = Math.max(1, Math.round(raw));
    const noun = d.noun ? (v === 1 ? d.noun.replace(/s$/, '') : d.noun) : '';
    return { q: String(v), u: noun, rounded: Math.abs(v - raw) > 0.01 ? 'Rounded from ' + fmt(raw) : '' };
  }
  return { q: fmt(raw), u: d.unit || '' };
}
// Accepts "1.5", "1 1/2", "½", "1½", "3/4".
function parseAmount(s) {
  s = String(s || '').trim(); if (!s) return null;
  const uni = { '½': .5, '¼': .25, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 };
  let total = 0, m;
  for (const ch in uni) if (s.includes(ch)) { total += uni[ch]; s = s.replace(ch, ' '); }
  s = s.trim();
  if ((m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/))) return total + Number(m[1]) + Number(m[2]) / Number(m[3]);
  if ((m = s.match(/^(\d+)\/(\d+)$/))) return total + Number(m[1]) / Number(m[2]);
  if (s === '') return total || null;
  const n = Number(s.replace(',', '.'));
  return isNaN(n) ? null : total + n;
}
function amountText(n) { if (n == null) return ''; const r = Math.round(n * 1000) / 1000; return String(r); }

/* ---------- master ingredient matching ---------- */
function masterList() { return q('SELECT * FROM ingredient ORDER BY name COLLATE NOCASE'); }
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const aliasesOf = (m) => String(m.aliases || '').split(',').map(norm).filter(Boolean);
function resolve(name, master) {
  const n = norm(name); if (!n) return null;
  return master.find(m => norm(m.name) === n) || master.find(m => aliasesOf(m).includes(n)) || null;
}
function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return dp[b.length];
}
function suggestions(name, master) {
  const n = norm(name); if (n.length < 2) return [];
  const sing = n.replace(/(es|s)$/, '');
  return master.map(m => {
    const cands = [norm(m.name)].concat(aliasesOf(m));
    let best = 0;
    cands.forEach(c => {
      const cs = c.replace(/(es|s)$/, '');
      let s = 1 - lev(sing, cs) / Math.max(sing.length, cs.length);
      if (c.includes(n) || n.includes(c)) s = Math.max(s, 0.8);
      if (n.split(' ').some(w => w.length > 3 && c.split(' ').includes(w))) s = Math.max(s, 0.65);
      best = Math.max(best, s);
    });
    return { m, s: best };
  }).filter(x => x.s >= 0.55).sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.m);
}

/* ---------- loading a recipe ---------- */
function loadRecipe(id) {
  const r = q('SELECT * FROM recipe WHERE id=?', [id])[0]; if (!r) return null;
  const lines = q(`SELECT ri.*, i.name AS master_name FROM recipe_ingredient ri JOIN ingredient i ON i.id=ri.ingredient_id
                   WHERE ri.recipe_id=? ORDER BY ri.position`, [id]);
  const ings = {}; lines.forEach(x => { ings[x.key] = x; });
  const srows = q('SELECT id,key,body,timer_text,continues FROM step WHERE recipe_id=? ORDER BY position', [id]);
  const keyOf = {}; srows.forEach(s => { keyOf[s.id] = s.key; });
  const uses = q(`SELECT su.step_id, ri.key FROM step_uses su JOIN recipe_ingredient ri ON ri.id=su.recipe_ingredient_id
                  WHERE ri.recipe_id=? ORDER BY ri.position`, [id]);
  const froms = q(`SELECT sf.step_id, sf.from_step_id FROM step_from sf JOIN step s ON s.id=sf.step_id
                   WHERE s.recipe_id=? ORDER BY sf.position`, [id]);
  const steps = srows.map(s => ({
    key: s.key, body: s.body, timer_text: s.timer_text || '', continues: !!s.continues,
    uses: uses.filter(u => u.step_id === s.id).map(u => u.key),
    from: froms.filter(f => f.step_id === s.id).map(f => keyOf[f.from_step_id])
  }));
  const labels = q('SELECT label FROM recipe_label WHERE recipe_id=? ORDER BY label', [id]).map(x => x.label);
  return { r, lines, ings, steps, labels };
}

/* ---------- Cooking for Engineers layout ----------
   Rows: ingredients in order of first use. A step with no ingredients and nothing to span gets its own row.
   Columns: a step that combines earlier steps sits one column right of the furthest of them.
   A "continues" step stacks below its first combined step in the same column. */
function layout(ings, steps) {
  const rowOf = {}, S = {}; let next = 1; const order = [], groups = [], out = [];
  steps.forEach(st => {
    const own = [];
    (st.uses || []).forEach(k => {
      if (!ings[k]) return;
      if (!(k in rowOf)) { rowOf[k] = next++; order.push(k); }
      own.push(rowOf[k]);
    });
    const froms = (st.from || []).map(k => S[k]).filter(Boolean);
    const primary = st.continues && froms.length ? froms[0] : null;
    const rows = own.slice(); froms.filter(f => f !== primary).forEach(f => { rows.push(f.r1, f.r2); });
    let r1, r2; if (rows.length) { r1 = Math.min(...rows); r2 = Math.max(...rows); } else { r1 = r2 = next++; }
    const col = froms.length ? (primary ? primary.col : Math.max(...froms.map(f => f.col)) + 1) : 2;
    const s = { key: st.key, r1, r2, col, text: st.body, timer: st.timer_text || '', tint: 0 };
    if (own.length) { s.tint = groups.length % 6 + 1; groups.push({ r1: Math.min(...own), r2: Math.max(...own), tint: s.tint }); }
    S[st.key] = s; out.push(s);
  });
  // A later step can start above rows an earlier step in the same column already holds; nudge it right until it fits.
  const taken = {};
  out.forEach(s => {
    const clash = () => { for (let r = s.r1; r <= s.r2; r++) if (taken[r + ',' + s.col]) return true; return false; };
    while (clash()) s.col++;
    for (let r = s.r1; r <= s.r2; r++) taken[r + ',' + s.col] = 1;
  });
  return { rowOf, order, groups, steps: out, rows: next - 1, cols: Math.max(2, ...out.map(s => s.col)) };
}
const TIMER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 3h6"/></svg>';
function gridHTML(ings, steps, f) {
  if (!steps.length) return '<p class="empty">Add a step to see the table.</p>';
  const L = layout(ings, steps);
  const tintOf = {}; L.groups.forEach(g => { for (let x = g.r1; x <= g.r2; x++) tintOf[x] = g.tint; });
  const occ = {}; L.order.forEach(k => { occ[L.rowOf[k] + ',1'] = 1; });
  L.steps.forEach(s => { for (let x = s.r1; x <= s.r2; x++) occ[x + ',' + s.col] = 1; });
  let h = '';
  for (let x = 1; x <= L.rows; x++) for (let c = 1; c <= L.cols; c++) if (!occ[x + ',' + c]) h += `<div class="fill" style="grid-column:${c};grid-row:${x}"></div>`;
  L.order.forEach(k => {
    const d = ings[k], a = amount(d, f), x = L.rowOf[k];
    const unit = a.u ? (d.estimated ? a.u + ' ≈' : a.u) : '';
    h += `<div class="ing" style="grid-column:1;grid-row:${x};background:var(--t${tintOf[x] || 1})"><div><span class="q">${esc(a.q)}</span> ${esc(unit)} ${esc(d.display_name || d.master_name || d.name || '')}` +
      (d.note ? `<span class="d">${esc(d.note)}</span>` : '') + (a.rounded ? `<span class="r">${esc(a.rounded)}</span>` : '') + `</div></div>`;
  });
  L.groups.forEach(g => { h += `<div class="grp" style="grid-column:1;grid-row:${g.r1} / ${g.r2 + 1}"></div>`; });
  L.steps.forEach(s => {
    h += `<div class="act" style="grid-column:${s.col};grid-row:${s.r1} / ${s.r2 + 1};background:${s.tint ? 'var(--t' + s.tint + ')' : 'var(--surface)'}"><div><p>${esc(s.text || '…')}</p>` +
      (s.timer ? `<span class="chip">${TIMER_SVG}${esc(s.timer)}</span>` : '') + `</div></div>`;
  });
  const actCols = L.cols - 1;
  const cols = 'minmax(240px,1.2fr) ' + Array.from({ length: actCols }, (_, i) => i === actCols - 1 ? 'minmax(260px,1.6fr)' : 'minmax(200px,1fr)').join(' ');
  return `<div class="scroller"><div class="grid" style="grid-template-columns:${cols};grid-template-rows:repeat(${L.rows},auto)">${h}</div></div>`;
}
const LEGEND = `<div class="legend"><span><i></i>Heavy box = one action, with its ingredients shaded to match</span><span><i style="background:var(--surface)"></i>Boxes further right combine the boxes to their left</span></div>`;

/* ---------- state ---------- */
const state = { sel: { time: [], type: [], source: [] }, search: '', servings: {}, method: 'table', draft: null, cook: null, ingEdit: null, ingSearch: '' };
try { const m = localStorage.getItem('rb-method'); if (m === 'list' || m === 'table') state.method = m; } catch (e) { /* not available */ }

/* ---------- library ---------- */
function libraryView() {
  const all = q(`SELECT v.*, (SELECT max(cooked_on) FROM cook_log c WHERE c.recipe_id=v.id) AS last_cooked FROM v_recipe_library v ORDER BY v.title COLLATE NOCASE`);
  const facets = [['time', 'Time', 'time_band', ['Quick', 'Medium', 'Long']], ['type', 'Type', 'type', null], ['source', 'Source', 'source', null]];
  const opts = (col, fixed) => fixed || [...new Set(all.map(r => r[col]).filter(Boolean))].sort();
  const s = norm(state.search);
  const shown = all.filter(r => {
    if (s && !norm(r.title + ' ' + (r.labels || '') + ' ' + (r.source || '') + ' ' + (r.cuisine || '')).includes(s)) return false;
    return facets.every(([k, , col]) => !state.sel[k].length || state.sel[k].includes(r[col]));
  });
  $v.innerHTML = `<div class="stack">
    <div class="spread"><div><h1>Library</h1><div class="meta"><span><b>${shown.length}</b> of ${all.length} recipes</span></div></div>
      <input type="search" id="search" placeholder="Search title, label, source" aria-label="Search recipes" value="${esc(state.search)}" style="max-width:340px"></div>
    <div class="card filters">${facets.map(([k, label, col, fixed]) => `<div class="facet"><h2>${label}</h2>` + (opts(col, fixed).map(o =>
      `<button type="button" class="chipb" data-k="${k}" data-v="${esc(o)}" aria-pressed="${state.sel[k].includes(o)}">${esc(o)}</button>`).join('') || '<span class="muted small">None yet</span>') + `</div>`).join('')}</div>
    <div class="list">${shown.length ? shown.map(r => `<a class="rrow" href="#recipe-${r.id}">
        <div><div class="t">${esc(r.title)}</div><div class="s">${esc(r.source || '')}${r.page ? ' · p. ' + esc(r.page) : ''}${r.last_cooked ? ' · made ' + esc(nice(r.last_cooked)) : ''}</div></div>
        <div>${(r.labels || '').split(', ').filter(Boolean).map(l => `<span class="tag">${esc(l)}</span>`).join('')}</div>
        <span class="band">${esc(r.time_band)} · ${r.total_min} min</span></a>`).join('')
      : `<div class="empty">${all.length ? 'No recipes match these filters.' : 'No recipes yet. <a href="#new">Add your first recipe</a>.'}</div>`}</div></div>`;
  const si = document.getElementById('search');
  si.addEventListener('input', () => { state.search = si.value; const p = si.selectionStart; libraryView(); const n = document.getElementById('search'); n.focus(); n.setSelectionRange(p, p); });
  $v.querySelectorAll('.chipb').forEach(b => b.addEventListener('click', () => {
    const a = state.sel[b.dataset.k], v = b.dataset.v, i = a.indexOf(v); i < 0 ? a.push(v) : a.splice(i, 1); libraryView();
  }));
}

/* ---------- recipe ---------- */
function recipeView(id) {
  const data = loadRecipe(id);
  if (!data) { $v.innerHTML = '<p class="empty">Recipe not found. <a href="#library">Back to the library</a></p>'; return; }
  const { r, lines, ings, steps, labels } = data;
  if (!state.servings[id]) state.servings[id] = r.base_servings;
  const sv = state.servings[id], f = sv / r.base_servings;
  const est = lines.some(l => l.estimated);
  const log = q('SELECT * FROM cook_log WHERE recipe_id=? ORDER BY cooked_on DESC, id DESC', [id]);
  const usedKeys = new Set(steps.flatMap(s => s.uses));
  const unused = lines.filter(l => !usedKeys.has(l.key));
  const onList = q('SELECT servings FROM shop_recipe WHERE recipe_id=?', [id])[0];
  const method = state.method === 'list'
    ? `<div class="method-list"><div class="card"><h2 style="margin-bottom:6px">Ingredients</h2>${lines.map(l => { const a = amount(l, f); return `<div class="li"><span><span class="q">${esc(a.q)}</span> ${esc(a.u ? (l.estimated ? a.u + ' ≈' : a.u) : '')} ${esc(l.display_name || l.master_name)}${l.note ? `<span class="d">${esc(l.note)}</span>` : ''}${a.rounded ? `<span class="r">${esc(a.rounded)}</span>` : ''}</span></div>`; }).join('')}</div>
       <div class="card"><h2 style="margin-bottom:12px">Method</h2><ol class="steps-ol">${steps.map(s => `<li><div><p>${esc(s.body)}</p>${s.timer_text ? `<span class="chip">${TIMER_SVG}${esc(s.timer_text)}</span>` : ''}</div></li>`).join('')}</ol></div></div>`
    : LEGEND + gridHTML(ings, steps, f) + (unused.length ? `<p class="warnbox">Not in the table because no step uses them: ${unused.map(l => esc(l.display_name || l.master_name)).join(', ')}. <a href="#edit-${id}">Edit the steps</a>.</p>` : '');
  $v.innerHTML = `<div class="stack">
    <a href="#library">← All recipes</a>
    <div class="spread"><div style="flex:1 1 360px;min-width:0"><h1>${esc(r.title)}</h1><div class="meta">
      ${r.prep_min != null ? `<span><b>Prep</b> ${r.prep_min} min</span>` : ''}${r.cook_min != null ? `<span><b>Cook</b> ${r.cook_min} min</span>` : ''}
      ${r.source ? `<span><b>Source</b> ${esc(r.source)}${r.page ? ', p. ' + esc(r.page) : ''}</span>` : ''}${r.type ? `<span><b>Type</b> ${esc(r.type)}</span>` : ''}${r.cuisine ? `<span><b>Cuisine</b> ${esc(r.cuisine)}</span>` : ''}</div>
      <div style="margin-top:8px">${labels.map(l => `<span class="tag">${esc(l)}</span>`).join('')}</div></div>
      <div class="row"><a class="btn" href="#cook-${id}">Start cooking</a><button class="btn ghost" id="toshop" type="button">${onList ? 'Update shopping list' : 'Add to shopping list'}</button><a class="btn ghost" href="#edit-${id}">Edit</a></div></div>
    <div class="spread" style="align-items:center">
      <div class="stepper" role="group" aria-label="Servings"><button id="dec" type="button" aria-label="Fewer servings">−</button><output aria-live="polite">${sv} ${sv === 1 ? 'serving' : 'servings'}</output><button id="inc" type="button" aria-label="More servings">+</button></div>
      <div class="seg" role="group" aria-label="Method view"><button type="button" data-m="table" aria-pressed="${state.method === 'table'}">Step table</button><button type="button" data-m="list" aria-pressed="${state.method === 'list'}">List</button></div></div>
    ${method}
    <p class="muted small">Written for ${r.base_servings}${sv !== r.base_servings ? ' · scaled ×' + (Math.round(f * 100) / 100) : ''}. Metric only. ${est ? 'Amounts marked ≈ are converted from cups using average densities. ' : ''}Counts round to whole items; fixed amounts do not scale.</p>
    ${r.notes ? `<div class="card"><h2 style="margin-bottom:6px">Notes</h2><p style="white-space:pre-wrap">${esc(r.notes)}</p></div>` : ''}
    <div class="card stack" style="gap:12px"><div class="spread" style="align-items:center"><h2>Cook log</h2><span class="muted small">${log.length ? 'Made ' + log.length + (log.length === 1 ? ' time' : ' times') : 'Not made yet'}</span></div>
      ${logForm('log', sv)}
      ${log.length ? `<div class="log">${log.map(e => `<div class="e"><span>${esc(nice(e.cooked_on))}</span><span>${e.rating ? '★'.repeat(e.rating) : '<span class="muted">No rating</span>'}</span><p>${e.servings ? `<span class="muted">${e.servings} servings.</span> ` : ''}${esc(e.notes || '')}</p></div>`).join('')}</div>` : ''}</div></div>`;
  document.getElementById('dec').onclick = () => { state.servings[id] = Math.max(1, sv - 1); recipeView(id); };
  document.getElementById('inc').onclick = () => { state.servings[id] = Math.min(60, sv + 1); recipeView(id); };
  $v.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { state.method = b.dataset.m; try { localStorage.setItem('rb-method', state.method); } catch (e) { /* fine */ } recipeView(id); });
  wireLogForm('log', id, () => recipeView(id));
  document.getElementById('toshop').onclick = async () => { addRecipeToList(id, sv); await persist(); updateShopCount(); toast('On the shopping list for ' + sv + ' servings'); recipeView(id); };
  document.title = r.title + ' · Recipe Book';
}
function logForm(p, sv) {
  return `<form id="${p}-form" class="stack" style="gap:10px">
    <div class="row" style="align-items:end">
      <label class="f" style="width:170px">Date made<input type="date" id="${p}-date" value="${today()}" required></label>
      <label class="f" style="width:110px">Servings<input type="number" id="${p}-sv" min="1" max="99" value="${sv}"></label>
      <div class="f" style="font-size:13px;font-weight:600;color:var(--muted)">Rating<div class="stars" id="${p}-stars" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-pressed="false" aria-label="${n} of 5">★</button>`).join('')}</div></div></div>
    <label class="f">Notes<textarea id="${p}-notes" placeholder="What worked, what you changed, what to try next time"></textarea></label>
    <div><button class="btn" type="submit">Add to cook log</button></div></form>`;
}
function wireLogForm(p, id, done) {
  let rating = 0;
  const stars = document.querySelectorAll('#' + p + '-stars button');
  stars.forEach(b => b.onclick = () => { rating = Number(b.dataset.n) === rating ? 0 : Number(b.dataset.n); stars.forEach(x => x.setAttribute('aria-pressed', String(Number(x.dataset.n) <= rating))); });
  document.getElementById(p + '-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const date = document.getElementById(p + '-date').value || today();
    const svv = parseInt(document.getElementById(p + '-sv').value, 10) || null;
    run('INSERT INTO cook_log(recipe_id,cooked_on,servings,rating,notes) VALUES (?,?,?,?,?)', [id, date, svv, rating || null, document.getElementById(p + '-notes').value.trim() || null]);
    await persist(); toast('Added to the cook log'); done();
  });
}

/* ---------- cook mode ---------- */
function parseMinutes(t) { const m = String(t || '').match(/(\d+(?:\.\d+)?)\s*(h|hr|hour|hours|min|mins|minutes)?/i); if (!m) return 0; const n = Number(m[1]); return /^h/i.test(m[2] || '') ? n * 60 : n; }
let wake = null;
async function keepAwake(on) {
  try { if (on && 'wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } if (!on && wake) { await wake.release(); wake = null; } } catch (e) { wake = null; }
}
function beep() {
  try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); [0, .35, .7].forEach(t => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(.2, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + t + .3); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + .3); }); } catch (e) { /* no sound */ }
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) { /* no vibration */ }
}
function cookView(id) {
  const data = loadRecipe(id);
  if (!data) { $v.innerHTML = '<p class="empty">Recipe not found.</p>'; return; }
  if (!state.cook || state.cook.id !== id) state.cook = { id, i: 0, timers: {} };
  const c = state.cook, { r, ings, steps } = data;
  const sv = state.servings[id] || r.base_servings, f = sv / r.base_servings;
  keepAwake(true);
  const total = steps.length;
  if (c.i >= total) {
    $v.innerHTML = `<div class="cook"><a href="#recipe-${id}">← Back to recipe</a><h1>${esc(r.title)} done</h1>
      <p class="muted">Log it so you know when you last made it and what to change.</p><div class="card">${logForm('cl', sv)}</div>
      <div class="cooknav"><button class="btn plain" id="back" type="button">Back to last step</button></div></div>`;
    wireLogForm('cl', id, () => { state.cook = null; location.hash = '#recipe-' + id; });
    document.getElementById('back').onclick = () => { c.i = total - 1; cookView(id); };
    return;
  }
  const s = steps[c.i];
  const fromNames = s.from.map(k => { const n = steps.findIndex(x => x.key === k); return n >= 0 ? 'step ' + (n + 1) : ''; }).filter(Boolean);
  const mins = parseMinutes(s.timer_text);
  const t = c.timers[s.key];
  $v.innerHTML = `<div class="cook">
    <div class="spread" style="align-items:center"><a href="#recipe-${id}">← ${esc(r.title)}</a><span class="muted small">${sv} servings</span></div>
    <div class="progress" aria-hidden="true"><span style="width:${Math.round((c.i + 1) / total * 100)}%"></span></div>
    <div class="stepno">Step ${c.i + 1} of ${total}</div>
    ${s.uses.length ? `<div class="uses">${s.uses.map(k => { const d = ings[k]; if (!d) return ''; const a = amount(d, f); return `<div><span class="q">${esc(a.q)}</span> ${esc(a.u ? (d.estimated ? a.u + ' ≈' : a.u) : '')} ${esc(d.display_name || d.master_name)}${d.note ? ` <span class="muted" style="font-size:15px">· ${esc(d.note)}</span>` : ''}</div>`; }).join('')}</div>` : ''}
    ${fromNames.length ? `<div class="from">With what you made in ${fromNames.join(', ')}.</div>` : ''}
    <p class="body">${esc(s.body)}</p>
    ${mins ? `<div class="timer${t && t.left <= 0 ? ' done' : ''}" id="timer"><span class="clock" id="clock">${clock(t ? t.left : mins * 60)}</span>
      <span>${esc(s.timer_text)}</span><span style="flex:1"></span>
      <button class="btn sm ghost" id="tbtn" type="button">${t && t.running ? 'Pause' : t && t.left <= 0 ? 'Restart' : t ? 'Resume' : 'Start timer'}</button>
      ${t ? '<button class="btn sm plain" id="treset" type="button">Reset</button>' : ''}</div>` : ''}
    <div class="cooknav"><button class="btn plain" id="prev" type="button" ${c.i === 0 ? 'disabled' : ''}>Previous</button><button class="btn" id="next" type="button">${c.i === total - 1 ? 'Finish' : 'Next step'}</button></div>
    <p class="muted small">The screen stays on while you cook, where your browser allows it. Timers keep running if you move between steps.</p></div>`;
  document.getElementById('prev').onclick = () => { c.i = Math.max(0, c.i - 1); cookView(id); };
  document.getElementById('next').onclick = () => { c.i++; cookView(id); };
  if (mins) {
    document.getElementById('tbtn').onclick = () => {
      let tm = c.timers[s.key];
      if (!tm || tm.left <= 0) tm = c.timers[s.key] = { left: mins * 60, running: false, end: 0 };
      if (tm.running) { tm.left = Math.max(0, Math.round((tm.end - Date.now()) / 1000)); tm.running = false; }
      else { tm.end = Date.now() + tm.left * 1000; tm.running = true; }
      cookView(id);
    };
    const rs = document.getElementById('treset'); if (rs) rs.onclick = () => { delete c.timers[s.key]; cookView(id); };
  }
}
function clock(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }
setInterval(() => {
  const c = state.cook; if (!c) return;
  Object.keys(c.timers).forEach(k => {
    const t = c.timers[k]; if (!t.running) return;
    t.left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
    if (t.left <= 0) { t.running = false; beep(); toast('Timer done'); if (location.hash.startsWith('#cook-')) cookView(c.id); }
  });
  const el = document.getElementById('clock');
  if (el && location.hash.startsWith('#cook-')) {
    const data = loadRecipeKeyAt(c); const t = data && c.timers[data]; if (t) el.textContent = clock(t.left);
  }
}, 500);
function loadRecipeKeyAt(c) { const s = q('SELECT key FROM step WHERE recipe_id=? ORDER BY position LIMIT 1 OFFSET ?', [c.id, c.i])[0]; return s ? s.key : null; }

/* ---------- editor ---------- */
let seq = 0;
const newKey = (p) => p + Date.now().toString(36) + (seq++).toString(36);
function blankLine() { return { key: newKey('i'), name: '', ingredient_id: null, newIng: null, amount: '', unit: 'g', noun: '', display_name: '', note: '', scaling: 'linear', estimated: false }; }
function blankStep() { return { key: newKey('s'), body: '', timer_text: '', continues: false, uses: [], from: [] }; }
function draftFor(id) {
  if (!id) return { id: null, title: '', source: '', page: '', cuisine: '', type: '', base_servings: 4, prep_min: '', cook_min: '', labels: '', notes: '', lines: [blankLine(), blankLine(), blankLine()], steps: [blankStep(), blankStep()] };
  const d = loadRecipe(id); if (!d) return null;
  return {
    id, title: d.r.title, source: d.r.source || '', page: d.r.page || '', cuisine: d.r.cuisine || '', type: d.r.type || '', base_servings: d.r.base_servings,
    prep_min: d.r.prep_min == null ? '' : d.r.prep_min, cook_min: d.r.cook_min == null ? '' : d.r.cook_min, labels: d.labels.join(', '), notes: d.r.notes || '',
    lines: d.lines.map(l => ({ key: l.key, name: l.master_name, ingredient_id: l.ingredient_id, newIng: null, amount: amountText(l.amount), unit: l.unit || '', noun: l.noun || '',
      display_name: l.display_name && norm(l.display_name) !== norm(l.master_name) ? l.display_name : '', note: l.note || '', scaling: l.scaling, estimated: !!l.estimated })),
    steps: d.steps.map(s => ({ key: s.key, body: s.body, timer_text: s.timer_text, continues: s.continues, uses: s.uses.slice(), from: s.from.slice() }))
  };
}
function lineLabel(l, i) { return l.display_name || l.name || 'Ingredient ' + (i + 1); }
function previewData(d) {
  const ings = {};
  d.lines.forEach(l => { ings[l.key] = { amount: parseAmount(l.amount), unit: l.unit || null, noun: l.noun, scaling: l.scaling, estimated: l.estimated, note: l.note, display_name: l.display_name || l.name || '…' }; });
  return { ings, steps: d.steps.map(s => ({ key: s.key, body: s.body, timer_text: s.timer_text, continues: s.continues, uses: s.uses, from: s.from })) };
}
function lineStatus(l, master) {
  if (!norm(l.name)) return { cls: '', html: '' };
  const m = resolve(l.name, master);
  if (m) { l.ingredient_id = m.id; l.newIng = null; return { cls: 'ok', html: `<div class="status ok">✓ On the master list${norm(m.name) !== norm(l.name) ? ' as ' + esc(m.name) : ''}${m.aisle ? ' · ' + esc(m.aisle) : ''}</div>` }; }
  l.ingredient_id = null;
  if (l.newIng) {
    return { cls: 'warn', html: `<div class="newform"><span style="font-weight:600;flex:1 1 100%">“${esc(l.name.trim())}” will be added to the master list when you save.</span>
      <label class="f">Aisle<select data-act="newaisle">${['', ...AISLES].map(a => `<option ${a === l.newIng.aisle ? 'selected' : ''} value="${esc(a)}">${a || 'Choose…'}</option>`).join('')}</select></label>
      <label class="f">Default unit<select data-act="newunit">${UNITS.map(u => `<option ${u === l.newIng.default_unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
      <button type="button" class="btn sm plain" data-act="cancelnew">Cancel</button></div>` };
  }
  const sug = suggestions(l.name, master);
  return { cls: 'warn', html: `<div class="status warn">Not on the master list</div><div class="suggest">${sug.map(m => `<button type="button" data-act="use" data-id="${m.id}">Use ${esc(m.name)}</button>`).join('')}<button type="button" class="new" data-act="addnew">Add “${esc(l.name.trim())}” as new</button></div>` };
}
function editView(id) {
  if (!state.draft || state.draft._for !== (id || 'new')) { const d = draftFor(id); if (!d) { $v.innerHTML = '<p class="empty">Recipe not found.</p>'; return; } d._for = id || 'new'; state.draft = d; }
  renderEditor();
}
function renderEditor() {
  const d = state.draft, master = masterList();
  const types = [...new Set(q('SELECT DISTINCT type FROM recipe WHERE type IS NOT NULL').map(x => x.type).concat(['Breakfast', 'Lunch', 'Dinner', 'Baking', 'Dessert', 'Side', 'Snack']))].sort();
  const sources = q('SELECT DISTINCT source FROM recipe WHERE source IS NOT NULL ORDER BY source').map(x => x.source);
  const field = (k, label, attrs = '', cls = '') => `<label class="f ${cls}">${label}<input data-f="${k}" value="${esc(d[k])}" ${attrs}></label>`;
  $v.innerHTML = `<div class="stack editor">
    <a href="${d.id ? '#recipe-' + d.id : '#library'}">← ${d.id ? 'Back to recipe' : 'Library'}</a>
    <h1>${d.id ? 'Edit recipe' : 'Add a recipe'}</h1>
    <section class="card stack" style="gap:14px"><h2>Details</h2><div class="fields">
      ${field('title', 'Title', 'required placeholder="e.g. Eatloaf"', 'wide')}
      ${field('source', 'Source or book', 'list="dl-sources" placeholder="Own recipe"')}
      ${field('page', 'Page or link')}
      ${field('type', 'Type', 'list="dl-types"')}
      ${field('cuisine', 'Cuisine')}
      ${field('base_servings', 'Serves', 'type="number" min="1" max="99" required')}
      ${field('prep_min', 'Prep (min)', 'type="number" min="0"')}
      ${field('cook_min', 'Cook (min)', 'type="number" min="0"')}
      ${field('labels', 'Other labels, comma separated', 'placeholder="Plant-based, Freezes well"', 'wide')}
      <label class="f wide">Notes<textarea data-f="notes" placeholder="Tips, swaps, gluten-free changes">${esc(d.notes)}</textarea></label></div>
      <datalist id="dl-types">${types.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      <datalist id="dl-sources">${sources.map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      <datalist id="dl-master">${master.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist></section>

    <section class="card stack" style="gap:6px"><div class="spread" style="align-items:center"><h2>Ingredients</h2><span class="muted small">Metric only. Type ½, 1 1/2 or 0.5.</span></div>
      <div id="lines">${d.lines.map((l, i) => lineHTML(l, i, master)).join('')}</div>
      <div><button type="button" class="btn ghost sm" data-act="addline">+ Add ingredient</button></div></section>

    <section class="card stack" style="gap:6px"><div class="spread" style="align-items:center"><h2>Steps</h2><span class="muted small">Pick the ingredients each step uses and the earlier steps it combines. The table builds itself.</span></div>
      <div id="steps">${d.steps.map((s, i) => stepHTML(s, i, d)).join('')}</div>
      <div><button type="button" class="btn ghost sm" data-act="addstep">+ Add step</button></div></section>

    <section class="stack" style="gap:10px"><h2>Preview</h2><div id="preview"></div></section>
    <div class="stickybar"><div class="row">${d.id ? '<button type="button" class="btn danger" id="del">Delete recipe</button>' : ''}<span id="msg" class="err" role="alert"></span></div>
      <div class="row"><a class="btn plain" href="${d.id ? '#recipe-' + d.id : '#library'}" id="cancel">Cancel</a><button type="button" class="btn" id="save">Save recipe</button></div></div></div>`;
  updatePreview();
  wireEditor();
}
function lineHTML(l, i, master) {
  const st = lineStatus(l, master);
  return `<div class="line" data-line="${l.key}">
    <span class="num">${i + 1}</span>
    <label class="f">Amount<input data-lf="amount" value="${esc(l.amount)}" inputmode="decimal" placeholder="—"></label>
    <label class="f">Unit<select data-lf="unit"><option value="" ${!l.unit ? 'selected' : ''}>none</option>${UNITS.map(u => `<option ${u === l.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
    <div class="namecell"><label class="f">Ingredient<input data-lf="name" list="dl-master" value="${esc(l.name)}" class="${st.cls}" placeholder="Start typing" autocomplete="off"></label><div data-status>${st.html}</div></div>
    <label class="f notecell">Prep or alternative<input data-lf="note" value="${esc(l.note)}" placeholder="chopped · or 1 x 400 g can"></label>
    <label class="f">Scaling<select data-lf="scaling"><option value="linear" ${l.scaling === 'linear' ? 'selected' : ''}>Scales</option><option value="fixed" ${l.scaling === 'fixed' ? 'selected' : ''}>Fixed</option></select></label>
    <button type="button" class="icon-btn" data-act="rmline" aria-label="Remove ingredient ${i + 1}" style="margin-top:21px">×</button>
    <div class="more">
      <label class="check"><input type="checkbox" data-lf="estimated" ${l.estimated ? 'checked' : ''}> Estimated (converted from cups)</label>
      <input data-lf="display_name" value="${esc(l.display_name)}" placeholder="Show as (optional), e.g. shiitake or portobello mushrooms" aria-label="Show as">
      ${l.unit === 'each' ? `<input data-lf="noun" value="${esc(l.noun)}" placeholder="Counted as, e.g. cloves" aria-label="Counted as" style="flex:0 1 180px">` : ''}</div></div>`;
}
function stepHTML(s, i, d) {
  const earlier = d.steps.slice(0, i);
  const takenBy = {}; d.steps.forEach((o, j) => { if (j !== i) o.uses.forEach(k => { takenBy[k] = j + 1; }); });
  return `<div class="stepc" data-step="${s.key}">
    <span class="num">${i + 1}</span>
    <div class="stack" style="gap:10px">
      <label class="f">What to do<textarea data-sf="body" placeholder="Describe the action in your own words">${esc(s.body)}</textarea></label>
      <div class="row"><label class="f" style="width:220px">Timer<input data-sf="timer_text" value="${esc(s.timer_text)}" placeholder="e.g. 25 min"></label>
        ${earlier.length ? `<label class="check" style="margin-top:18px"><input type="checkbox" data-sf="continues" ${s.continues ? 'checked' : ''}> Carries on from the first step picked below</label>` : ''}</div>
      <div class="picks"><span class="lbl">Uses</span>${d.lines.map((l, j) => `<button type="button" class="pick${takenBy[l.key] && !s.uses.includes(l.key) ? ' taken' : ''}" data-act="use-ing" data-k="${l.key}" aria-pressed="${s.uses.includes(l.key)}"${takenBy[l.key] && !s.uses.includes(l.key) ? ` title="Used in step ${takenBy[l.key]}"` : ''}>${esc(lineLabel(l, j))}</button>`).join('') || '<span class="muted small">Add ingredients first</span>'}</div>
      ${earlier.length ? `<div class="picks"><span class="lbl">Combines</span>${earlier.map((o, j) => `<button type="button" class="pick" data-act="use-step" data-k="${o.key}" aria-pressed="${s.from.includes(o.key)}">Step ${j + 1}${o.body ? ': ' + esc(o.body.slice(0, 28)) + (o.body.length > 28 ? '…' : '') : ''}</button>`).join('')}</div>` : ''}
    </div>
    <button type="button" class="icon-btn" data-act="rmstep" aria-label="Remove step ${i + 1}">×</button></div>`;
}
function updatePreview() {
  const d = state.draft, p = previewData(d), f = 1;
  const used = new Set(d.steps.flatMap(s => s.uses));
  const unused = d.lines.filter(l => norm(l.name) && !used.has(l.key));
  const el = document.getElementById('preview'); if (!el) return;
  el.innerHTML = LEGEND + gridHTML(p.ings, p.steps.filter(s => s.body || s.uses.length || s.from.length), f) +
    (unused.length ? `<p class="warnbox">No step uses ${unused.map(l => esc(lineLabel(l, 0))).join(', ')} yet, so ${unused.length === 1 ? 'it is' : 'they are'} not in the table.</p>` : '');
}
function wireEditor() {
  const d = state.draft;
  $v.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('input', () => { d[inp.dataset.f] = inp.value; }));
  const lines = document.getElementById('lines'), steps = document.getElementById('steps');
  const lineOf = (el) => d.lines.find(l => l.key === el.closest('[data-line]').dataset.line);
  const stepOf = (el) => d.steps.find(s => s.key === el.closest('[data-step]').dataset.step);
  lines.addEventListener('input', (e) => {
    const t = e.target, k = t.dataset.lf; if (!k) return; const l = lineOf(t);
    l[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'name') { l.newIng = null; const st = lineStatus(l, masterList()); t.className = st.cls; t.closest('.namecell').querySelector('[data-status]').innerHTML = st.html; }
    updatePreview();
  });
  lines.addEventListener('change', (e) => {
    const t = e.target, k = t.dataset.lf, l = t.closest('[data-line]') && lineOf(t); if (!l) return;
    if (k === 'unit') renderKeep();
    if (k === 'name' || k === 'display_name') { const i = d.lines.indexOf(l); $v.querySelectorAll(`[data-act="use-ing"][data-k="${l.key}"]`).forEach(b => { b.textContent = lineLabel(l, i); }); }
    if (t.dataset.act === 'newaisle') l.newIng.aisle = t.value;
    if (t.dataset.act === 'newunit') l.newIng.default_unit = t.value;
  });
  lines.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return; const l = lineOf(b), a = b.dataset.act;
    if (a === 'use') { const m = masterList().find(x => x.id === Number(b.dataset.id)); l.name = m.name; l.ingredient_id = m.id; renderKeep(); }
    if (a === 'addnew') { l.newIng = { aisle: '', default_unit: l.unit || 'g' }; renderKeep(); }
    if (a === 'cancelnew') { l.newIng = null; renderKeep(); }
    if (a === 'rmline') { d.lines = d.lines.filter(x => x !== l); d.steps.forEach(s => { s.uses = s.uses.filter(k => k !== l.key); }); renderKeep(); }
  });
  steps.addEventListener('input', (e) => {
    const t = e.target, k = t.dataset.sf; if (!k) return; const s = stepOf(t);
    s[k] = t.type === 'checkbox' ? t.checked : t.value; updatePreview();
  });
  steps.addEventListener('change', (e) => {
    if (e.target.dataset.sf !== 'body') return; const st = stepOf(e.target), i = d.steps.indexOf(st);
    $v.querySelectorAll(`[data-act="use-step"][data-k="${st.key}"]`).forEach(b => { b.textContent = 'Step ' + (i + 1) + (st.body ? ': ' + st.body.slice(0, 28) + (st.body.length > 28 ? '…' : '') : ''); });
  });
  steps.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return; const s = stepOf(b), a = b.dataset.act, k = b.dataset.k;
    if (a === 'use-ing') { s.uses = s.uses.includes(k) ? s.uses.filter(x => x !== k) : d.lines.map(l => l.key).filter(x => x === k || s.uses.includes(x)); }
    if (a === 'use-step') { s.from = s.from.includes(k) ? s.from.filter(x => x !== k) : s.from.concat(k); }
    if (a === 'rmstep') { d.steps = d.steps.filter(x => x !== s); d.steps.forEach(o => { o.from = o.from.filter(x => x !== s.key); }); }
    renderKeep();
  });
  $v.querySelector('[data-act="addline"]').onclick = () => { d.lines.push(blankLine()); renderKeep(); const ins = $v.querySelectorAll('[data-lf="name"]'); ins[ins.length - 1].focus(); };
  $v.querySelector('[data-act="addstep"]').onclick = () => { d.steps.push(blankStep()); renderKeep(); const ins = $v.querySelectorAll('[data-sf="body"]'); ins[ins.length - 1].focus(); };
  document.getElementById('save').onclick = saveDraft;
  document.getElementById('cancel').onclick = () => { state.draft = null; };
  const del = document.getElementById('del');
  if (del) confirmClick(del, 'Click again to delete', async () => { run('DELETE FROM recipe WHERE id=?', [d.id]); await persist(); state.draft = null; toast('Recipe deleted'); location.hash = '#library'; });
}
// Re-render the editor without losing the scroll position.
function renderKeep() { const y = window.scrollY; renderEditor(); window.scrollTo(0, y); }
async function saveDraft() {
  const d = state.draft, msg = document.getElementById('msg'), master = masterList();
  const fail = (t) => { msg.textContent = t; };
  if (!d.title.trim()) return fail('Add a title.');
  const base = parseInt(d.base_servings, 10); if (!(base > 0)) return fail('Add how many it serves.');
  const lines = d.lines.filter(l => norm(l.name));
  for (const l of lines) {
    if (!resolve(l.name, master) && !l.newIng) return fail(`“${l.name.trim()}” is not on the master list. Pick a match or add it as new.`);
    if (String(l.amount).trim() && parseAmount(l.amount) == null) return fail(`Could not read the amount for ${l.name.trim()}.`);
    if (String(l.amount).trim() && !l.unit) return fail(`Pick a unit for ${l.name.trim()}.`);
  }
  const steps = d.steps.filter(s => s.body.trim());
  if (!steps.length) return fail('Add at least one step.');
  try {
    run('BEGIN');
    const vals = [d.title.trim(), d.source.trim() || null, String(d.page).trim() || null, d.cuisine.trim() || null, d.type.trim() || null, base,
      d.prep_min === '' ? null : parseInt(d.prep_min, 10), d.cook_min === '' ? null : parseInt(d.cook_min, 10), d.notes.trim() || null];
    let rid = d.id;
    if (rid) {
      run('UPDATE recipe SET title=?,source=?,page=?,cuisine=?,type=?,base_servings=?,prep_min=?,cook_min=?,notes=? WHERE id=?', vals.concat(rid));
      run('DELETE FROM step WHERE recipe_id=?', [rid]); run('DELETE FROM recipe_ingredient WHERE recipe_id=?', [rid]); run('DELETE FROM recipe_label WHERE recipe_id=?', [rid]);
    } else { run('INSERT INTO recipe(title,source,page,cuisine,type,base_servings,prep_min,cook_min,notes) VALUES (?,?,?,?,?,?,?,?,?)', vals); rid = lastId(); }
    [...new Set(d.labels.split(',').map(x => x.trim()).filter(Boolean))].forEach(l => run('INSERT INTO recipe_label VALUES (?,?)', [rid, l]));
    const riId = {};
    lines.forEach((l, i) => {
      let m = resolve(l.name, masterList());
      if (!m) { run('INSERT INTO ingredient(name,aisle,default_unit) VALUES (?,?,?)', [l.name.trim(), l.newIng.aisle || null, l.newIng.default_unit || null]); m = { id: lastId() }; }
      run(`INSERT INTO recipe_ingredient(recipe_id,key,ingredient_id,display_name,amount,unit,noun,scaling,estimated,note,position) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [rid, l.key, m.id, l.display_name.trim() || null, parseAmount(l.amount), l.unit || null, l.unit === 'each' ? (l.noun.trim() || null) : null, l.scaling, l.estimated ? 1 : 0, l.note.trim() || null, i + 1]);
      riId[l.key] = lastId();
    });
    const sid = {};
    steps.forEach((s, i) => {
      const from = s.from.filter(k => sid[k]);
      run('INSERT INTO step(recipe_id,key,position,body,timer_text,continues) VALUES (?,?,?,?,?,?)', [rid, s.key, i + 1, s.body.trim(), s.timer_text.trim() || null, s.continues && from.length ? 1 : 0]);
      sid[s.key] = lastId();
      s.uses.filter(k => riId[k]).forEach(k => run('INSERT OR IGNORE INTO step_uses VALUES (?,?)', [sid[s.key], riId[k]]));
      from.forEach((k, j) => run('INSERT INTO step_from VALUES (?,?,?)', [sid[s.key], sid[k], j + 1]));
    });
    run('COMMIT');
    await persist();
    state.draft = null; toast('Recipe saved'); location.hash = '#recipe-' + rid;
  } catch (e) { try { run('ROLLBACK'); } catch (x) { /* already rolled back */ } fail('Could not save: ' + e.message); }
}

/* ---------- ingredients ---------- */
function ingredientsView() {
  const all = q(`SELECT i.*, (SELECT count(DISTINCT recipe_id) FROM recipe_ingredient ri WHERE ri.ingredient_id=i.id) AS uses FROM ingredient i ORDER BY i.name COLLATE NOCASE`);
  const s = norm(state.ingSearch);
  const shown = all.filter(i => !s || norm(i.name + ' ' + (i.aliases || '') + ' ' + (i.aisle || '')).includes(s));
  const ed = state.ingEdit;
  const row = (i) => ed === i.id ? `<tr data-id="${i.id}"><td colspan="7"><div class="stack" style="gap:10px">
      <div class="fields">
        <label class="f">Name<input id="e-name" value="${esc(i.name)}"></label>
        <label class="f">Aliases, comma separated<input id="e-aliases" value="${esc(i.aliases)}"></label>
        <label class="f">Aisle<select id="e-aisle">${['', ...new Set(AISLES.concat(i.aisle ? [i.aisle] : []))].map(a => `<option ${a === (i.aisle || '') ? 'selected' : ''} value="${esc(a)}">${a || '—'}</option>`).join('')}</select></label>
        <label class="f">Default unit<select id="e-unit"><option value="">—</option>${UNITS.map(u => `<option ${u === i.default_unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
        <label class="f">Density (g per mL)<input id="e-dens" type="number" step="0.01" min="0" value="${i.density_g_ml == null ? '' : i.density_g_ml}"></label>
        <label class="check" style="margin-top:18px"><input type="checkbox" id="e-staple" ${i.is_staple ? 'checked' : ''}> Usually in the pantry</label></div>
      <div class="row"><button class="btn sm" id="e-save" type="button">Save</button><button class="btn sm plain" id="e-cancel" type="button">Cancel</button>
        <span style="flex:1"></span>
        <label class="f" style="width:220px">Merge into<select id="e-merge"><option value="">Choose…</option>${all.filter(o => o.id !== i.id).map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select></label>
        <button class="btn sm danger" id="e-mergebtn" type="button" style="margin-top:18px">Merge</button>
        ${i.uses ? '' : '<button class="btn sm danger" id="e-del" type="button" style="margin-top:18px">Delete</button>'}</div>
      <p class="muted small">Merging moves every recipe that uses ${esc(i.name)} onto the other ingredient, keeps “${esc(i.name)}” as an alias, then removes this entry.</p>
      <span class="err" id="e-msg" role="alert"></span></div></td></tr>`
    : `<tr><td><b>${esc(i.name)}</b>${i.is_staple ? ' <span class="tag">Pantry</span>' : ''}</td><td class="muted">${esc(i.aliases)}</td><td>${esc(i.aisle || '')}</td><td>${esc(i.default_unit || '')}</td><td class="n">${i.density_g_ml == null ? '' : i.density_g_ml}</td><td class="n">${i.uses}</td><td><button class="btn sm plain" data-edit="${i.id}" type="button">Edit</button></td></tr>`;
  $v.innerHTML = `<div class="stack">
    <div class="spread"><div><h1>Ingredients</h1><div class="meta"><span>The master list every recipe points to. <b>${all.length}</b> ingredients.</span></div></div>
      <input type="search" id="isearch" placeholder="Search name, alias, aisle" aria-label="Search ingredients" value="${esc(state.ingSearch)}" style="max-width:300px"></div>
    <form class="card row" id="addform" style="align-items:end"><label class="f" style="flex:2 1 200px">New ingredient<input id="a-name" placeholder="e.g. Chickpeas" required></label>
      <label class="f" style="flex:1 1 140px">Aisle<select id="a-aisle"><option value="">—</option>${AISLES.map(a => `<option>${a}</option>`).join('')}</select></label>
      <label class="f" style="flex:1 1 110px">Default unit<select id="a-unit"><option value="">—</option>${UNITS.map(u => `<option>${u}</option>`).join('')}</select></label>
      <button class="btn" type="submit">Add</button><span class="err" id="a-msg" role="alert"></span></form>
    <div class="tablewrap"><table class="itable"><thead><tr><th>Name</th><th>Aliases</th><th>Aisle</th><th>Unit</th><th>Density</th><th>Recipes</th><th></th></tr></thead>
      <tbody>${shown.map(row).join('') || '<tr><td colspan="7" class="empty">No ingredients match.</td></tr>'}</tbody></table></div></div>`;
  const si = document.getElementById('isearch');
  si.addEventListener('input', () => { state.ingSearch = si.value; const p = si.selectionStart; ingredientsView(); const n = document.getElementById('isearch'); n.focus(); n.setSelectionRange(p, p); });
  $v.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { state.ingEdit = Number(b.dataset.edit); ingredientsView(); });
  document.getElementById('addform').addEventListener('submit', async (e) => {
    e.preventDefault(); const name = document.getElementById('a-name').value.trim(); if (!name) return;
    if (resolve(name, masterList())) { document.getElementById('a-msg').textContent = name + ' is already on the list.'; return; }
    run('INSERT INTO ingredient(name,aisle,default_unit) VALUES (?,?,?)', [name, document.getElementById('a-aisle').value || null, document.getElementById('a-unit').value || null]);
    await persist(); toast('Added ' + name); ingredientsView();
  });
  if (ed) {
    const i = all.find(x => x.id === ed); if (!i) { state.ingEdit = null; return; }
    const m = (t) => { document.getElementById('e-msg').textContent = t; };
    document.getElementById('e-cancel').onclick = () => { state.ingEdit = null; ingredientsView(); };
    document.getElementById('e-save').onclick = async () => {
      const name = document.getElementById('e-name').value.trim(); if (!name) return m('Name cannot be empty.');
      const dens = document.getElementById('e-dens').value;
      try {
        run('UPDATE ingredient SET name=?,aliases=?,aisle=?,default_unit=?,density_g_ml=?,is_staple=? WHERE id=?',
          [name, document.getElementById('e-aliases').value.split(',').map(x => x.trim()).filter(Boolean).join(','), document.getElementById('e-aisle').value || null,
            document.getElementById('e-unit').value || null, dens === '' ? null : Number(dens), document.getElementById('e-staple').checked ? 1 : 0, i.id]);
      } catch (e) { return m(/UNIQUE/.test(e.message) ? 'Another ingredient already has that name. Merge them instead.' : e.message); }
      await persist(); state.ingEdit = null; toast('Saved'); ingredientsView();
    };
    confirmClick(document.getElementById('e-mergebtn'), 'Click again to merge', async () => {
      const into = Number(document.getElementById('e-merge').value); if (!into) return m('Choose the ingredient to merge into.');
      const target = all.find(x => x.id === into);
      const al = [...new Set(String(target.aliases || '').split(',').map(x => x.trim()).filter(Boolean).concat([i.name], String(i.aliases || '').split(',').map(x => x.trim()).filter(Boolean)))]
        .filter(a => norm(a) !== norm(target.name)).join(',');
      run('BEGIN'); run('UPDATE recipe_ingredient SET ingredient_id=? WHERE ingredient_id=?', [into, i.id]); run('UPDATE shop_item SET ingredient_id=? WHERE ingredient_id=?', [into, i.id]); run('UPDATE purchase SET ingredient_id=? WHERE ingredient_id=?', [into, i.id]); run('UPDATE OR IGNORE staple SET ingredient_id=? WHERE ingredient_id=?', [into, i.id]); run('DELETE FROM staple WHERE ingredient_id=?', [i.id]); run('UPDATE ingredient SET aliases=? WHERE id=?', [al, into]); run('DELETE FROM ingredient WHERE id=?', [i.id]); run('COMMIT');
      await persist(); state.ingEdit = null; toast('Merged into ' + target.name); ingredientsView();
    });
    const del = document.getElementById('e-del');
    if (del) confirmClick(del, 'Click again to delete', async () => { run('DELETE FROM ingredient WHERE id=?', [i.id]); await persist(); state.ingEdit = null; toast('Deleted'); ingredientsView(); });
  }
}

/* ---------- data ---------- */
function dataView() {
  const n = (t) => q('SELECT count(*) AS n FROM ' + t)[0].n;
  $v.innerHTML = `<div class="stack">
    <div><h1>Data</h1><p class="muted" style="margin-top:8px;max-width:70ch">${MODE.kind === 'local'
      ? `Every change saves straight to your Mac, in <code>${esc(MODE.folder || 'Recipe Book/Data')}/recipes.db</code>. A copy goes into the <code>Backups</code> folder each day you use it, and the last 30 days are kept.`
      : 'Your recipes are saved in this browser on this device. Export the database to back it up or move it to another device. To use the copy on your Mac, start Recipe Book from its launcher and import the file there.'}</p></div>
    <div class="card row" style="gap:28px"><span><b class="q">${n('recipe')}</b> recipes</span><span><b class="q">${n('ingredient')}</b> ingredients</span><span><b class="q">${n('step')}</b> steps</span><span><b class="q">${n('cook_log')}</b> cook log entries</span><span><b class="q">${n('staple')}</b> staples</span><span><b class="q">${n('purchase')}</b> purchases</span></div>
    <div class="card stack" style="gap:10px"><h2>Export</h2><p class="muted">Downloads a copy of everything as a SQLite file.</p><div><button class="btn" id="exp" type="button">Export recipes.db</button></div></div>
    <div class="card stack" style="gap:10px"><h2>Import</h2><p class="muted">Replaces what is on this device with a database file you exported earlier.</p>
      <div class="row"><input type="file" id="imp" accept=".db,.sqlite,application/x-sqlite3,application/octet-stream" style="max-width:360px"><span class="err" id="imsg" role="alert"></span></div></div>
    ${MODE.kind === 'local' ? '' : `<div class="card stack" style="gap:10px"><h2>Load the published copy</h2><p class="muted">Throws away the changes saved on this device and reloads <code>recipes.db</code> from the site. Export first if you want to keep them.</p>
      <div><button class="btn danger" id="reset" type="button">Load published copy</button></div></div>`}</div>`;
  document.getElementById('exp').onclick = () => {
    const blob = new Blob([exportBytes()], { type: 'application/x-sqlite3' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'recipes.db';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast('Exported recipes.db');
  };
  document.getElementById('imp').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer()); const old = exportBytes();
    try { openDb(bytes); if (MODE.kind === 'local') await serverSave(exportBytes(), true); else await persist(); toast('Imported ' + file.name); dataView(); }
    catch (err) { openDb(old); document.getElementById('imsg').textContent = 'That file is not a recipe database: ' + err.message; }
  });
  if (MODE.kind !== 'local') confirmClick(document.getElementById('reset'), 'Click again to replace this device’s copy', async () => {
    try { openDb(await fetchPublished()); await idbClear(); await persist(); toast('Loaded the published copy'); dataView(); }
    catch (err) { toast(err.message); }
  });
}

/* ---------- routing ---------- */
function route() {
  if (!DB) return;
  const h = location.hash.replace('#', '') || 'library';
  if (!h.startsWith('cook-')) { keepAwake(false); }
  let nav = 'library';
  if (h.startsWith('recipe-')) recipeView(parseInt(h.slice(7), 10));
  else if (h.startsWith('cook-')) cookView(parseInt(h.slice(5), 10));
  else if (h.startsWith('edit-')) { nav = ''; editView(parseInt(h.slice(5), 10)); }
  else if (h === 'new') { nav = 'new'; editView(null); }
  else if (h === 'ingredients') { nav = 'ingredients'; ingredientsView(); }
  else if (h === 'data') { nav = 'data'; dataView(); }
  else if (h === 'shop') { nav = 'shop'; shopView(); }
  else if (h === 'staples') { nav = 'shop'; staplesView(); }
  else { document.title = 'Recipe Book'; libraryView(); }
  updateShopCount();
  if (!h.startsWith('recipe-') && !h.startsWith('cook-') && h !== 'shop' && h !== 'staples') document.title = { new: 'Add recipe', ingredients: 'Ingredients', data: 'Data' }[h] ? { new: 'Add recipe', ingredients: 'Ingredients', data: 'Data' }[h] + ' · Recipe Book' : document.title;
  document.querySelectorAll('[data-nav]').forEach(a => { if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (!h.startsWith('edit-') && h !== 'new') state.draft = state.draft && (h.startsWith('edit-') || h === 'new') ? state.draft : null;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
(async function start() {
  try {
    SQL = await initSqlJs({ locateFile: (f) => f });
    if (await detectServer()) {
      openDb(await serverLoad());
      document.getElementById('where').textContent = 'Saving to your Mac';
    } else {
      const saved = await idbGet();
      if (saved) openDb(saved);
      else { openDb(await fetchPublished()); await persist(); }
      try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* optional */ }
      document.getElementById('where').textContent = 'Saving in this browser';
    }
    route();
  } catch (e) {
    $v.innerHTML = `<div class="card"><p class="err">Could not open the recipe database.</p><p class="muted" style="margin-top:6px">${esc(e.message)}. Serve this folder from a web server (GitHub Pages works). Opening index.html straight from disk is blocked by the browser.</p></div>`;
  }
})();
