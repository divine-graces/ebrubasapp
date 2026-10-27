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

// ---------- icons (Lucide/Feather style: 24px grid, 2px round strokes, colour from currentColor) ----------
const ICONS = {
  courses: '<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>',
  study: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  stats: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  next: '<polyline points="9 18 15 12 9 6"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  retry: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'
};
// Static strings only, never user data, so parsing them as HTML is safe.
export function icon(name, size = 22) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstChild;
}
export const emptyState = (name, text, action) =>
  h('div', { class: 'empty' }, h('div', { class: 'empty-art' }, icon(name, 38)), h('p', {}, text), action || null);

export const topbar = (title, { back, right } = {}) =>
  h('div', { class: 'topbar' },
    back ? h('a', { class: 'icon-btn', href: back, 'aria-label': 'Back' }, icon('back', 24)) : null,
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
  } }, icon('more', 22));
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

// ---------- long formulas: wrap, then scale, never scroll ----------
// 1. KaTeX already wraps inline math at + - = signs.
// 2. A long \text{...} block can wrap too, but KaTeX writes its spaces as non-breaking spaces, so those become normal spaces.
// 3. Whatever still does not fit (one big fraction, display math) is scaled down to the width of its container.
// 4. If it still does not fit at the readability floor, display math is re-rendered inline so it can wrap; if that does not
//    help either (an unbreakable \left( ... \right) group), the original stays and scrolls inside its own box, never the page.
// Needs layout, so call it AFTER the nodes are in the page.
let fitRoot = null;
function fitNow(root, minScale = 0.5) {
  const ks = [...root.querySelectorAll('.katex')];
  ks.forEach(k => { k.style.fontSize = ''; k.classList.remove('wrap'); }); // natural size first, so re-fitting works
  root.querySelectorAll('.md.scrolls').forEach(e => e.classList.remove('scrolls'));
  ks.forEach(k0 => {
    let k = k0;
    const host = k.closest('.md') || root, avail = host.clientWidth;
    if (!avail) return; // hidden (e.g. the explanation before it is revealed)
    let display = !!k.closest('.katex-display');
    const need = () => display
      ? k.scrollWidth
      : Math.max(0, ...[...k.querySelectorAll('.katex-html > .base')].map(b => b.getBoundingClientRect().width));
    // Widths do not shrink perfectly in step with font size (glyph rounding), so measure again after each shrink.
    const shrink = () => {
      let scale = 1;
      for (let pass = 0; pass < 5; pass++) {
        const n = need();
        if (n <= avail + 1 || scale <= minScale) break;
        scale = Math.max(minScale, scale * avail * 0.98 / n); // aim 2% under: text size changes in steps, not smoothly
        k.style.fontSize = (1.21 * scale).toFixed(3) + 'em'; // 1.21em = KaTeX default
      }
      return need() <= avail + 1;
    };
    if (!display && need() > avail + 1 && k.querySelector('.text')) {
      k.querySelectorAll('.text').forEach(t => {
        const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeValue = n.nodeValue.replace(/\u00a0/g, ' ');
      });
      k.classList.add('wrap');
    }
    // last resort: only a formula that really cannot fit gets a scroll box (display math already has its own)
    const giveUp = () => { if (!display && need() > avail + 1) host.classList.add('scrolls'); };
    if (shrink()) return;
    if (!display || !window.katex) return giveUp();
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!tex) return;
    const holder = k.closest('.katex-display'), tmp = document.createElement('span');
    window.katex.render(tex, tmp, { displayMode: false, throwOnError: false });
    const inline = tmp.querySelector('.katex');
    if (!inline) return;
    holder.replaceWith(inline);
    const original = k; k = inline; display = false;
    if (!shrink()) { inline.replaceWith(holder); k = original; display = true; } // no gain: put the display version back
    else giveUp();
  });
}
export function fitMath(root) {
  fitRoot = root;
  fitNow(root);
}
// widths change when KaTeX's fonts finish loading, and on rotation / keyboard: re-fit the current screen
const refit = () => { if (fitRoot) requestAnimationFrame(() => fitNow(fitRoot)); };
document.fonts?.addEventListener('loadingdone', refit);
window.addEventListener('resize', refit);
