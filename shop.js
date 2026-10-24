/* Shopping list and staples. Uses the same database and master ingredient list as the recipes. */
'use strict';

const REASONS = [['ranout', 'Ran out'], ['staple', 'Staples due'], ['recipe', 'For recipes'], ['added', 'Added']];
const shop = { by: 'aisle', stEdit: null, pendingName: null };
try { const b = localStorage.getItem('rb-shop-by'); if (b === 'aisle' || b === 'reason') shop.by = b; } catch (e) { /* not available */ }

function shopMigrate() {
  run(`CREATE TABLE IF NOT EXISTS shop_item (
    id INTEGER PRIMARY KEY,
    ingredient_id INTEGER REFERENCES ingredient(id) ON DELETE CASCADE,
    name TEXT, aisle TEXT,
    amount REAL, unit TEXT, noun TEXT,
    qty TEXT,
    reason TEXT NOT NULL DEFAULT 'added' CHECK (reason IN ('added','ranout','staple','recipe')),
    recipe_id INTEGER REFERENCES recipe(id) ON DELETE CASCADE,
    pantry INTEGER NOT NULL DEFAULT 0,
    checked INTEGER NOT NULL DEFAULT 0,
    added_on TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS shop_recipe (recipe_id INTEGER PRIMARY KEY REFERENCES recipe(id) ON DELETE CASCADE, servings INTEGER NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS staple (ingredient_id INTEGER PRIMARY KEY REFERENCES ingredient(id) ON DELETE CASCADE,
    every_days INTEGER, qty TEXT, last_added TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS purchase (id INTEGER PRIMARY KEY, ingredient_id INTEGER REFERENCES ingredient(id) ON DELETE CASCADE,
    name TEXT, bought_on TEXT NOT NULL)`);
}

/* ---------- dates ---------- */
const isoDate = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
function addDays(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return isoDate(x); }
function daysFrom(a, b) { return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000); }

/* ---------- staples ---------- */
function stapleInfo() {
  const t = today();
  return q(`SELECT s.*, i.name, i.aisle, (SELECT max(bought_on) FROM purchase p WHERE p.ingredient_id=s.ingredient_id) AS last_bought
            FROM staple s JOIN ingredient i ON i.id=s.ingredient_id ORDER BY i.name COLLATE NOCASE`).map(s => {
    const dates = q('SELECT DISTINCT bought_on FROM purchase WHERE ingredient_id=? ORDER BY bought_on DESC LIMIT 6', [s.ingredient_id]).map(r => r.bought_on).reverse();
    let learned = null;
    if (dates.length >= 3) {
      let sum = 0; for (let i = 1; i < dates.length; i++) sum += daysFrom(dates[i - 1], dates[i]);
      learned = Math.max(1, Math.round(sum / (dates.length - 1)));
    }
    const every = s.every_days || learned;
    const due = every && s.last_bought ? addDays(s.last_bought, every) : null;
    const left = due ? daysFrom(t, due) : null;
    const onList = q('SELECT count(*) AS n FROM shop_item WHERE ingredient_id=? AND checked=0 AND pantry=0', [s.ingredient_id])[0].n > 0;
    return { ...s, learned, every, due, left, onList, times: q('SELECT count(*) AS n FROM purchase WHERE ingredient_id=?', [s.ingredient_id])[0].n };
  });
}
// Anything due by tomorrow goes on the list once. Taking it off again does not bring it back until it is next due.
function addDueStaples() {
  const t = today(); let n = 0;
  stapleInfo().forEach(s => {
    if (s.due == null || s.left > 1 || s.onList) return;
    if (s.last_added && s.last_added >= addDays(s.due, -1)) return;
    run('INSERT INTO shop_item(ingredient_id,qty,reason,added_on) VALUES (?,?,?,?)', [s.ingredient_id, s.qty || null, 'staple', t]);
    run('UPDATE staple SET last_added=? WHERE ingredient_id=?', [t, s.ingredient_id]); n++;
  });
  return n;
}
function stapleStatus(s) {
  if (s.due == null) return s.last_bought ? ['Not timed yet', 'none'] : ['Never bought', 'none'];
  if (s.left < 0) return ['Overdue ' + -s.left + (s.left === -1 ? ' day' : ' days'), 'over'];
  if (s.left === 0) return ['Due today', 'due'];
  if (s.left === 1) return ['Due tomorrow', 'due'];
  return ['In ' + s.left + ' days', 'okay'];
}

/* ---------- recipes on the list ---------- */
function addRecipeToList(id, servings) {
  const d = loadRecipe(id); if (!d) return;
  const f = servings / d.r.base_servings;
  const wasChecked = new Set(q('SELECT ingredient_id FROM shop_item WHERE recipe_id=? AND checked=1', [id]).map(r => r.ingredient_id));
  const pantry = new Set(q('SELECT id FROM ingredient WHERE is_staple=1').map(r => r.id));
  run('BEGIN');
  run('DELETE FROM shop_item WHERE recipe_id=?', [id]);
  d.lines.forEach(l => {
    const amt = l.amount == null ? null : Number(l.amount) * (l.scaling === 'fixed' ? 1 : f);
    run(`INSERT INTO shop_item(ingredient_id,amount,unit,noun,reason,recipe_id,pantry,checked,added_on) VALUES (?,?,?,?,?,?,?,?,?)`,
      [l.ingredient_id, amt, l.unit, l.noun, 'recipe', id, pantry.has(l.ingredient_id) ? 1 : 0, wasChecked.has(l.ingredient_id) ? 1 : 0, today()]);
  });
  run('INSERT OR REPLACE INTO shop_recipe(recipe_id,servings) VALUES (?,?)', [id, servings]);
  run('COMMIT');
}
function removeRecipeFromList(id) { run('DELETE FROM shop_item WHERE recipe_id=?', [id]); run('DELETE FROM shop_recipe WHERE recipe_id=?', [id]); }

/* ---------- list lines: one per ingredient, amounts from several recipes added together ---------- */
function shopLines() {
  const rows = q(`SELECT si.*, COALESCE(i.name, si.name) AS label, COALESCE(i.aisle, si.aisle, 'Other') AS aisle_name, r.title AS recipe_title
                  FROM shop_item si LEFT JOIN ingredient i ON i.id=si.ingredient_id LEFT JOIN recipe r ON r.id=si.recipe_id ORDER BY si.id`);
  const groups = new Map();
  rows.forEach(x => {
    const k = (x.ingredient_id ? 'i' + x.ingredient_id : 'n' + norm(x.label)) + (x.pantry ? ':p' : '');
    if (!groups.has(k)) groups.set(k, { key: k, ingredient_id: x.ingredient_id, label: x.label, aisle: x.aisle_name || 'Other', pantry: !!x.pantry, rows: [] });
    groups.get(k).rows.push(x);
  });
  // Already buying it? Then the recipe's pantry amount joins that line instead of "check you have".
  [...groups.keys()].filter(k => k.endsWith(':p') && groups.has(k.slice(0, -2))).forEach(k => { groups.get(k.slice(0, -2)).rows.push(...groups.get(k).rows); groups.delete(k); });
  return [...groups.values()].map(g => {
    const byUnit = {}, texts = [], recipes = [], reasons = new Set();
    let unmeasured = false;
    g.rows.forEach(x => {
      reasons.add(x.reason);
      if (x.recipe_title && !recipes.includes(x.recipe_title)) recipes.push(x.recipe_title);
      if (x.amount != null) { const u = x.unit || ''; byUnit[u] = byUnit[u] || { amount: 0, unit: x.unit, noun: x.noun }; byUnit[u].amount += x.amount; }
      else if (x.reason === 'recipe') unmeasured = true;
      if (x.qty) texts.push(x.qty);
    });
    let amt = Object.values(byUnit).map(d => { const a = amount({ ...d, scaling: 'linear' }, 1); return (a.q + ' ' + a.u).trim(); }).concat(texts).join(' + ');
    if (!amt && unmeasured) amt = 'to taste';
    const order = REASONS.map(r => r[0]);
    return { ...g, amt, recipes, reasons: [...reasons].sort((a, b) => order.indexOf(a) - order.indexOf(b)), checked: g.rows.every(x => x.checked), ids: g.rows.map(x => x.id) };
  });
}
const aisleOrder = (a) => { const i = AISLES.indexOf(a); return i < 0 ? AISLES.length - 1 : i; };

function lineRow(g) {
  const tags = g.reasons.filter(r => r !== 'added').map(r => r === 'recipe'
    ? `<span class="rtag recipe">for ${esc(g.recipes.join(', '))}</span>`
    : `<span class="rtag ${r}">${r === 'ranout' ? 'Ran out' : 'Staple'}</span>`).join('');
  return `<div class="sline${g.checked ? ' done' : ''}">
    <label><input type="checkbox" data-ids="${g.ids.join(',')}" ${g.checked ? 'checked' : ''}>
      <span class="txt"><span class="nm">${esc(g.label)}</span>${g.amt ? ` <span class="q">${esc(g.amt)}</span>` : ''}<span class="sub">${tags}</span></span></label>
    <button class="icon-btn" type="button" data-del="${g.ids.join(',')}" aria-label="Remove ${esc(g.label)}">×</button></div>`;
}

function listText(lines) {
  const out = ['Shopping list, ' + nice(today())];
  const todo = lines.filter(g => !g.pantry && !g.checked).sort((a, b) => aisleOrder(a.aisle) - aisleOrder(b.aisle) || a.label.localeCompare(b.label));
  let cur = null;
  todo.forEach(g => { if (g.aisle !== cur) { cur = g.aisle; out.push('', cur.toUpperCase()); } out.push('- ' + g.label + (g.amt ? ', ' + g.amt : '')); });
  return out.join('\n');
}

function shopTabs(which) {
  return `<div class="seg" role="tablist" aria-label="Shopping pages"><a role="tab" href="#shop" aria-selected="${which === 'list'}">List</a><a role="tab" href="#staples" aria-selected="${which === 'staples'}">Staples</a></div>`;
}
function masterDatalist(id) { return `<datalist id="${id}">${masterList().map(m => `<option value="${esc(m.name)}"></option>`).join('')}</datalist>`; }

/* ---------- shopping list page ---------- */
async function shopView() {
  const added = addDueStaples();
  if (added) { await persist(); toast(added === 1 ? 'Added 1 staple that is due' : 'Added ' + added + ' staples that are due'); }
  renderShop();
}
function renderShop() {
  const lines = shopLines();
  const need = lines.filter(g => !g.pantry);
  const pantry = lines.filter(g => g.pantry);
  const left = need.filter(g => !g.checked).length, ticked = need.filter(g => g.checked).length;
  const plan = q('SELECT sr.*, r.title, r.base_servings FROM shop_recipe sr JOIN recipe r ON r.id=sr.recipe_id ORDER BY r.title COLLATE NOCASE');
  const recipes = q('SELECT id, title, base_servings FROM recipe ORDER BY title COLLATE NOCASE');

  let sections = [];
  if (shop.by === 'aisle') {
    const aisles = [...new Set(need.map(g => g.aisle))].sort((a, b) => aisleOrder(a) - aisleOrder(b) || a.localeCompare(b));
    sections = aisles.map(a => [a, need.filter(g => g.aisle === a).sort((x, y) => x.checked - y.checked || x.label.localeCompare(y.label))]);
  } else {
    sections = REASONS.map(([k, label]) => [label, need.filter(g => g.reasons[0] === k).sort((x, y) => x.checked - y.checked || aisleOrder(x.aisle) - aisleOrder(y.aisle))]).filter(s => s[1].length);
  }

  $v.innerHTML = `<div class="stack">
    <div class="spread"><div><h1>Shopping</h1><div class="meta"><span><b>${left}</b> to get</span>${ticked ? `<span><b>${ticked}</b> in the trolley</span>` : ''}</div></div>${shopTabs('list')}</div>
    <form class="card addbar" id="sadd" autocomplete="off">
      <label class="f grow">Item<input id="s-name" list="s-master" placeholder="e.g. Bananas" required></label>${masterDatalist('s-master')}
      <label class="f qty">Amount, optional<input id="s-qty" placeholder="e.g. 1 kg"></label>
      <label class="f aisle">Aisle, if new<select id="s-aisle">${AISLES.map(a => `<option ${a === 'Other' ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      <button class="btn" type="submit" data-r="added">Add</button>
      <button class="btn ghost" type="submit" data-r="ranout">Ran out</button>
      <div class="sugg" id="s-msg" role="status"></div></form>
    <div class="spread" style="align-items:center">
      <div class="seg" role="group" aria-label="Group the list"><button type="button" data-by="aisle" aria-pressed="${shop.by === 'aisle'}">By aisle</button><button type="button" data-by="reason" aria-pressed="${shop.by === 'reason'}">By reason</button></div>
      <button class="btn plain" id="s-copy" type="button" ${left ? '' : 'disabled'}>Copy list</button></div>
    ${sections.length ? sections.map(([h, gs]) => `<section class="slist" aria-label="${esc(h)}"><h2>${esc(h)}</h2>${gs.map(lineRow).join('')}</section>`).join('')
      : `<div class="card empty">The list is empty. Add things above, mark something you ran out of, or add a recipe below.</div>`}
    ${pantry.length ? `<section class="slist pantry" aria-label="Check you have"><h2>Check you have</h2><p class="muted small" style="padding:0 16px 8px">Recipes use these pantry items. Tap “Need it” to put one on the list.</p>
      ${pantry.map(g => `<div class="sline"><span class="txt"><span class="nm">${esc(g.label)}</span>${g.amt ? ` <span class="q">${esc(g.amt)}</span>` : ''}<span class="sub"><span class="rtag recipe">for ${esc(g.recipes.join(', '))}</span></span></span>
        <button class="btn sm ghost" type="button" data-need="${g.ids.join(',')}">Need it</button></div>`).join('')}</section>` : ''}
    <div class="card stack" style="gap:12px"><h2>Recipes on this list</h2>
      ${plan.length ? `<div class="plan">${plan.map(p => `<div class="prow"><a href="#recipe-${p.recipe_id}">${esc(p.title)}</a>
          <div class="stepper" role="group" aria-label="Servings for ${esc(p.title)}"><button type="button" data-pdec="${p.recipe_id}" aria-label="Fewer servings">−</button><output>${p.servings} servings</output><button type="button" data-pinc="${p.recipe_id}" aria-label="More servings">+</button></div>
          <button class="btn sm plain" type="button" data-prem="${p.recipe_id}">Remove</button></div>`).join('')}</div>` : '<p class="muted">None yet. Add one here or from any recipe page.</p>'}
      ${recipes.length ? `<form class="row" id="padd" style="align-items:end"><label class="f" style="flex:2 1 220px">Recipe<select id="p-recipe">${recipes.map(r => `<option value="${r.id}" data-s="${r.base_servings}">${esc(r.title)}</option>`).join('')}</select></label>
        <label class="f" style="width:110px">Servings<input id="p-serv" type="number" min="1" max="60" value="${recipes[0].base_servings}"></label><button class="btn ghost" type="submit">Add recipe</button></form>` : ''}</div>
    ${need.length || pantry.length ? `<div class="stickybar"><span class="muted small">${ticked ? 'Done shopping clears what you ticked and records it for your staples.' : 'Tick things off as they go in the trolley.'}</span>
      <div class="row"><button class="btn plain sm" id="s-clear" type="button">Clear list</button><button class="btn" id="s-done" type="button" ${ticked ? '' : 'disabled'}>Done shopping</button></div></div>` : ''}</div>`;
  wireShop(lines);
  document.title = 'Shopping · Recipe Book';
}
function rerenderShop() { const y = window.scrollY; renderShop(); window.scrollTo(0, y); updateShopCount(); }

function addToList(ing, qty, reason) {
  run('INSERT INTO shop_item(ingredient_id,qty,reason,added_on) VALUES (?,?,?,?)', [ing.id, qty || null, reason, today()]);
}
function wireShop(lines) {
  const form = document.getElementById('sadd'), msg = document.getElementById('s-msg');
  const nameEl = document.getElementById('s-name');
  const finish = async (ing, qty, reason) => {
    addToList(ing, qty, reason); await persist();
    toast((reason === 'ranout' ? 'Ran out of ' : 'Added ') + ing.name); rerenderShop();
    const n = document.getElementById('s-name'); n && n.focus();
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameEl.value.trim(); if (!name) return;
    const qty = document.getElementById('s-qty').value.trim();
    const reason = (e.submitter && e.submitter.dataset.r) || 'added';
    const master = masterList();
    const hit = resolve(name, master);
    if (hit) return finish(hit, qty, reason);
    const sug = suggestions(name, master);
    const addNew = async () => {
      run('INSERT INTO ingredient(name,aisle) VALUES (?,?)', [name.charAt(0).toUpperCase() + name.slice(1), document.getElementById('s-aisle').value || 'Other']);
      finish(q('SELECT * FROM ingredient WHERE id=?', [lastId()])[0], qty, reason);
    };
    if (!sug.length) return addNew();
    msg.innerHTML = `<span>“${esc(name)}” is not on your ingredient list.</span>${sug.map(m => `<button type="button" data-use="${m.id}">Use ${esc(m.name)}</button>`).join('')}<button type="button" class="new" id="s-new">Add “${esc(name)}” as new</button>`;
    msg.querySelectorAll('[data-use]').forEach(b => b.onclick = () => finish(master.find(m => m.id === Number(b.dataset.use)), qty, reason));
    document.getElementById('s-new').onclick = addNew;
  });
  nameEl.addEventListener('input', () => { msg.innerHTML = ''; });

  $v.querySelectorAll('[data-by]').forEach(b => b.onclick = () => { shop.by = b.dataset.by; try { localStorage.setItem('rb-shop-by', shop.by); } catch (e) { /* fine */ } rerenderShop(); });
  $v.querySelectorAll('.sline input[type=checkbox]').forEach(c => c.addEventListener('change', async () => {
    const ids = c.dataset.ids.split(',').map(Number);
    ids.forEach(id => run('UPDATE shop_item SET checked=? WHERE id=?', [c.checked ? 1 : 0, id]));
    await persist(); rerenderShop();
  }));
  $v.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const ids = b.dataset.del.split(',').map(Number);
    ids.forEach(id => run('DELETE FROM shop_item WHERE id=?', [id]));
    run('DELETE FROM shop_recipe WHERE recipe_id NOT IN (SELECT recipe_id FROM shop_item WHERE recipe_id IS NOT NULL)');
    await persist(); rerenderShop();
  });
  $v.querySelectorAll('[data-need]').forEach(b => b.onclick = async () => {
    b.dataset.need.split(',').map(Number).forEach(id => run('UPDATE shop_item SET pantry=0 WHERE id=?', [id]));
    await persist(); rerenderShop();
  });
  const servOf = (id) => q('SELECT servings FROM shop_recipe WHERE recipe_id=?', [id])[0].servings;
  $v.querySelectorAll('[data-pdec]').forEach(b => b.onclick = async () => { const id = Number(b.dataset.pdec); addRecipeToList(id, Math.max(1, servOf(id) - 1)); await persist(); rerenderShop(); });
  $v.querySelectorAll('[data-pinc]').forEach(b => b.onclick = async () => { const id = Number(b.dataset.pinc); addRecipeToList(id, Math.min(60, servOf(id) + 1)); await persist(); rerenderShop(); });
  $v.querySelectorAll('[data-prem]').forEach(b => b.onclick = async () => { removeRecipeFromList(Number(b.dataset.prem)); await persist(); toast('Removed the recipe from the list'); rerenderShop(); });
  const padd = document.getElementById('padd');
  if (padd) {
    const sel = document.getElementById('p-recipe'), sv = document.getElementById('p-serv');
    sel.onchange = () => { sv.value = sel.selectedOptions[0].dataset.s; };
    padd.addEventListener('submit', async (e) => {
      e.preventDefault(); const id = Number(sel.value), n = Math.min(60, Math.max(1, parseInt(sv.value, 10) || 1));
      addRecipeToList(id, n); await persist(); toast('Added ' + sel.selectedOptions[0].textContent + ' for ' + n); rerenderShop();
    });
  }
  const copy = document.getElementById('s-copy');
  copy.onclick = async () => {
    const text = listText(lines);
    try {
      if (navigator.share && matchMedia('(pointer:coarse)').matches) { await navigator.share({ title: 'Shopping list', text }); return; }
      await navigator.clipboard.writeText(text); toast('Copied the list. Paste it into Notes or a message.');
    } catch (e) { if (e && e.name === 'AbortError') return; toast('Could not copy here. Select the list and copy it instead.'); }
  };
  const done = document.getElementById('s-done');
  if (done && !done.disabled) confirmClick(done, 'Click again to finish', async () => {
    const t = today(), got = lines.filter(g => !g.pantry && g.checked);
    run('BEGIN');
    got.forEach(g => {
      if (g.ingredient_id) run('INSERT INTO purchase(ingredient_id,bought_on) VALUES (?,?)', [g.ingredient_id, t]);
      else run('INSERT INTO purchase(name,bought_on) VALUES (?,?)', [g.label, t]);
    });
    run('DELETE FROM shop_item WHERE checked=1');
    run('DELETE FROM shop_item WHERE recipe_id IS NOT NULL AND recipe_id NOT IN (SELECT recipe_id FROM shop_item WHERE pantry=0 AND recipe_id IS NOT NULL)');
    run('DELETE FROM shop_recipe WHERE recipe_id NOT IN (SELECT recipe_id FROM shop_item WHERE recipe_id IS NOT NULL)');
    run('COMMIT');
    await persist(); toast('Shopping done. Recorded ' + got.length + (got.length === 1 ? ' item' : ' items') + '.'); rerenderShop();
  });
  const clear = document.getElementById('s-clear');
  if (clear) confirmClick(clear, 'Click again to clear everything', async () => {
    run('DELETE FROM shop_item'); run('DELETE FROM shop_recipe'); await persist(); toast('Cleared the list'); rerenderShop();
  });
}

/* ---------- staples page ---------- */
function staplesView() {
  const rows = stapleInfo();
  const ed = shop.stEdit;
  const everyText = (s) => s.every_days ? 'Every ' + s.every_days + ' days' : s.learned ? 'Every ' + s.learned + ' days <span class="muted small">(learned)</span>' : '<span class="muted">Not set</span>';
  const hint = (s) => s.every_days && s.learned && Math.abs(s.learned - s.every_days) >= 2
    ? `<div class="small" style="margin-top:4px">You buy it about every ${s.learned} days. <button class="linkbtn" type="button" data-learn="${s.ingredient_id}" data-n="${s.learned}">Use ${s.learned}</button></div>` : '';
  const row = (s) => {
    const [st, cls] = stapleStatus(s);
    if (ed === s.ingredient_id) return `<tr><td colspan="6"><div class="row" style="align-items:end">
        <b style="flex:1 1 160px">${esc(s.name)}</b>
        <label class="f" style="width:140px">Every (days)<input id="se-every" type="number" min="1" max="365" value="${s.every_days || ''}" placeholder="${s.learned ? 'learned: ' + s.learned : 'learn it'}"></label>
        <label class="f" style="width:160px">Usual amount<input id="se-qty" value="${esc(s.qty || '')}" placeholder="e.g. 2 L"></label>
        <button class="btn sm" id="se-save" type="button">Save</button><button class="btn sm plain" id="se-cancel" type="button">Cancel</button>
        <span style="flex:1"></span><button class="btn sm danger" id="se-del" type="button">Stop tracking</button></div></td></tr>`;
    return `<tr><td><b>${esc(s.name)}</b>${s.qty ? ` <span class="q small">${esc(s.qty)}</span>` : ''}${s.onList ? ' <span class="tag">On the list</span>' : ''}</td>
      <td>${everyText(s)}${hint(s)}</td><td>${s.last_bought ? esc(nice(s.last_bought)) : '<span class="muted">—</span>'}<div class="muted small">${s.times ? 'Bought ' + s.times + (s.times === 1 ? ' time' : ' times') : ''}</div></td>
      <td>${s.due ? esc(nice(s.due)) : '<span class="muted">—</span>'}</td><td><span class="stat ${cls}">${st}</span></td>
      <td class="acts"><button class="btn sm plain" type="button" data-bought="${s.ingredient_id}">Bought today</button><button class="btn sm plain" type="button" data-sedit="${s.ingredient_id}">Edit</button></td></tr>`;
  };
  $v.innerHTML = `<div class="stack">
    <div class="spread"><div><h1>Staples</h1><div class="meta"><span>Things you buy again and again. When one is due it goes on the shopping list by itself.</span></div></div>${shopTabs('staples')}</div>
    <form class="card addbar" id="stadd" autocomplete="off">
      <label class="f grow">Item<input id="st-name" list="st-master" placeholder="e.g. Milk" required></label>${masterDatalist('st-master')}
      <label class="f qty">Every (days)<input id="st-every" type="number" min="1" max="365" placeholder="blank = learn it"></label>
      <label class="f qty">Usual amount<input id="st-qty" placeholder="e.g. 2 L"></label>
      <label class="f qty">Last bought<input id="st-last" type="date" value="${today()}"></label>
      <label class="f aisle">Aisle, if new<select id="st-aisle">${AISLES.map(a => `<option ${a === 'Other' ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
      <button class="btn" type="submit">Add staple</button><div class="sugg" id="st-msg" role="status"></div></form>
    <div class="tablewrap"><table class="itable stable"><thead><tr><th>Item</th><th>How often</th><th>Last bought</th><th>Next due</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map(row).join('') || '<tr><td colspan="6" class="empty">No staples yet. Add milk, bread, coffee: whatever you keep buying.</td></tr>'}</tbody></table></div>
    <p class="muted small" style="max-width:72ch">Leave “Every” blank and the app works out the gap from when you actually buy it: after three shops it knows. Ticking a staple off and pressing Done shopping counts as buying it. A staple that is due goes on the list the day before.</p></div>`;
  document.title = 'Staples · Recipe Book';

  const form = document.getElementById('stadd'), msg = document.getElementById('st-msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('st-name').value.trim(); if (!name) return;
    const every = parseInt(document.getElementById('st-every').value, 10) || null;
    const qty = document.getElementById('st-qty').value.trim() || null;
    const last = document.getElementById('st-last').value || null;
    const master = masterList();
    const go = async (ing) => {
      if (q('SELECT 1 FROM staple WHERE ingredient_id=?', [ing.id]).length) { msg.innerHTML = `<span>${esc(ing.name)} is already a staple.</span>`; return; }
      run('INSERT INTO staple(ingredient_id,every_days,qty) VALUES (?,?,?)', [ing.id, every, qty]);
      if (last) run('INSERT INTO purchase(ingredient_id,bought_on) VALUES (?,?)', [ing.id, last]);
      await persist(); toast('Tracking ' + ing.name); staplesView();
    };
    const hit = resolve(name, master); if (hit) return go(hit);
    const addNew = () => { run('INSERT INTO ingredient(name,aisle) VALUES (?,?)', [name.charAt(0).toUpperCase() + name.slice(1), document.getElementById('st-aisle').value || 'Other']); go(q('SELECT * FROM ingredient WHERE id=?', [lastId()])[0]); };
    const sug = suggestions(name, master); if (!sug.length) return addNew();
    msg.innerHTML = `<span>“${esc(name)}” is not on your ingredient list.</span>${sug.map(m => `<button type="button" data-use="${m.id}">Use ${esc(m.name)}</button>`).join('')}<button type="button" class="new" id="st-new">Add “${esc(name)}” as new</button>`;
    msg.querySelectorAll('[data-use]').forEach(b => b.onclick = () => go(master.find(m => m.id === Number(b.dataset.use))));
    document.getElementById('st-new').onclick = addNew;
  });
  $v.querySelectorAll('[data-bought]').forEach(b => b.onclick = async () => {
    const id = Number(b.dataset.bought);
    if (!q('SELECT 1 FROM purchase WHERE ingredient_id=? AND bought_on=?', [id, today()]).length) run('INSERT INTO purchase(ingredient_id,bought_on) VALUES (?,?)', [id, today()]);
    run("DELETE FROM shop_item WHERE ingredient_id=? AND reason='staple'", [id]);
    await persist(); toast('Recorded'); staplesView(); updateShopCount();
  });
  $v.querySelectorAll('[data-learn]').forEach(b => b.onclick = async () => { run('UPDATE staple SET every_days=? WHERE ingredient_id=?', [Number(b.dataset.n), Number(b.dataset.learn)]); await persist(); staplesView(); });
  $v.querySelectorAll('[data-sedit]').forEach(b => b.onclick = () => { shop.stEdit = Number(b.dataset.sedit); staplesView(); });
  if (ed) {
    const s = rows.find(x => x.ingredient_id === ed); if (!s) { shop.stEdit = null; return; }
    document.getElementById('se-cancel').onclick = () => { shop.stEdit = null; staplesView(); };
    document.getElementById('se-save').onclick = async () => {
      run('UPDATE staple SET every_days=?, qty=? WHERE ingredient_id=?', [parseInt(document.getElementById('se-every').value, 10) || null, document.getElementById('se-qty').value.trim() || null, ed]);
      await persist(); shop.stEdit = null; toast('Saved'); staplesView();
    };
    confirmClick(document.getElementById('se-del'), 'Click again to stop', async () => { run('DELETE FROM staple WHERE ingredient_id=?', [ed]); await persist(); shop.stEdit = null; toast('Stopped tracking ' + s.name); staplesView(); });
  }
}

function updateShopCount() {
  const el = document.getElementById('shopcount'); if (!el || !DB) return;
  const n = shopLines().filter(g => !g.pantry && !g.checked).length;
  el.textContent = n; el.hidden = !n;
}
