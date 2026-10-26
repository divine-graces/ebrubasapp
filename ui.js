// ui.js: DOM helpers, dialogs, toasts, sync bar, Markdown + math rendering.
export const $ = (s, r = document) => r.querySelector(s);
export const go = p => { location.hash = '#' + p; };

// Tiny element builder. Text children are always added as text, never as HTML.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  if (value !== undefined) el.value = value; // after children, so <select> options exist
  return el;
}

export const loading = () => h('div', { class: 'loading' }, h('div', { class: 'spin' }));

export const topbar = (title, { back, right } = {}) =>
  h('div', { class: 'topbar' },
    back ? h('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, '←') : null,
    h('h1', {}, title), right || null);

// ---------- toasts, dialogs, menus ----------
export function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

function overlay(content) {
  const o = $('#overlay');
  o.replaceChildren(h('div', { class: 'sheet' }, content));
  o.classList.add('on');
  return () => { o.classList.remove('on'); o.replaceChildren(); };
}

export const confirmDialog = (msg, okText = 'Delete', danger = true) => new Promise(res => {
  const close = overlay([
    h('p', {}, msg),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { close(); res(false); } }, 'Cancel'),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { close(); res(true); } }, okText))
  ]);
});

// fields: [{name,label,type:'text'|'textarea'|'select',value,rows,options:[{value,label}],required}]
export const formModal = ({ title, fields, okText = 'Save', hint }) => new Promise(res => {
  const els = fields.map(f =>
    f.type === 'textarea' ? h('textarea', { rows: f.rows || 4, value: f.value || '' })
    : f.type === 'select' ? h('select', { value: f.value }, f.options.map(o => h('option', { value: o.value }, o.label)))
    : h('input', { type: 'text', value: f.value || '', placeholder: f.placeholder || '' }));
  const err = h('p', { class: 'err', hidden: true });
  const close = overlay([
    h('h2', {}, title),
    hint ? h('p', { class: 'muted small' }, hint) : null,
    fields.map((f, i) => h('label', { class: 'field' }, h('span', {}, f.label), els[i])),
    err,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { close(); res(null); } }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => {
        const out = {};
        fields.forEach((f, i) => { out[f.name] = els[i].value; });
        const bad = fields.find(f => f.required && !out[f.name].trim());
        if (bad) { err.textContent = bad.label + ' is required.'; err.hidden = false; return; }
        close(); res(out);
      } }, okText))
  ]);
});

export function menuButton(items) {
  const list = h('div', { class: 'menu-list', hidden: true, onclick: e => e.stopPropagation() },
    items.map(i => h('button', { class: i.danger ? 'danger-text' : '', onclick: () => { list.hidden = true; i.onclick(); } }, i.label)));
  const btn = h('button', { class: 'icon-btn', 'aria-label': 'Menu', onclick: e => {
    e.stopPropagation();
    const open = list.hidden;
    document.querySelectorAll('.menu-list').forEach(l => { l.hidden = true; });
    list.hidden = !open;
  } }, '⋮');
  return h('div', { class: 'menu', onclick: e => e.stopPropagation() }, btn, list);
}
document.addEventListener('click', () => document.querySelectorAll('.menu-list').forEach(l => { l.hidden = true; }));

// ---------- offline / sync indicator ----------
let syncState = 'idle';
export function setSync(s) {
  if (s) syncState = s;
  const b = $('#syncbar');
  if (!navigator.onLine) { b.textContent = 'Offline: changes are kept on this device and sync when you reconnect'; b.className = 'offline'; b.hidden = false; }
  else if (syncState === 'syncing') { b.textContent = 'Syncing…'; b.className = 'syncing'; b.hidden = false; }
  else b.hidden = true;
}
window.addEventListener('online', () => setSync());
window.addEventListener('offline', () => setSync());

// ---------- Markdown + KaTeX ----------
if (window.marked) marked.setOptions({ gfm: true, breaks: true });
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Markdown mangles LaTeX (underscores, backslashes, pipes), so math is swapped for
// placeholders before marked runs and put back afterwards, then KaTeX renders it.
export function renderMd(el, md, inline = false) {
  const math = [];
  const tok = m => { math.push(m); return `MATHTOKEN${math.length - 1}ENDTOKEN`; };
  const src = String(md || '').replace(/\$\$[\s\S]+?\$\$/g, tok).replace(/\$[^$\n]+?\$/g, tok);
  let html = inline ? marked.parseInline(src) : marked.parse(src);
  html = html.replace(/MATHTOKEN(\d+)ENDTOKEN/g, (_, i) => escHtml(math[+i]));
  el.innerHTML = DOMPurify.sanitize(html);
  if (window.renderMathInElement) {
    renderMathInElement(el, {
      delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }],
      throwOnError: false
    });
  }
}
