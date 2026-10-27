// journal.js: dated journal entries, newest first. Entries are Markdown (with $math$ if you want it).
import { h, topbar, toast, confirmDialog, formModal, renderMd, emptyState, icon, menuButton, planSwitch, fitMath } from './ui.js';
import * as db from './db.js';
import { todayStr, fmtDate } from './todos.js';

const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter(n => n != null && n !== false));

export async function journalScreen() {
  const items = await db.listJournal();
  const fail = e => toast('Could not save: ' + (e.message || e), 4500);
  const listBox = h('div');
  const root = h('div');

  const sorted = () => [...items].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));

  const fields = e => [
    { name: 'date', label: 'Date', type: 'date', value: e ? e.date : todayStr(), required: true },
    { name: 'body', label: 'Entry (Markdown and $math$ work)', type: 'textarea', rows: 12, value: e ? e.body : '', required: true }];

  const add = async () => {
    const r = await formModal({ title: 'New entry', okText: 'Save entry', fields: fields() });
    if (!r) return;
    const data = { date: r.date, body: r.body.trim(), createdAt: Date.now(), updatedAt: Date.now() };
    const w = db.addJournal(data);
    w.done.catch(fail);
    items.push({ id: w.id, ...data });
    render();
  };
  const edit = async e => {
    const r = await formModal({ title: 'Edit entry', fields: fields(e) });
    if (!r) return;
    e.date = r.date; e.body = r.body.trim();
    db.updateJournal(e.id, { date: e.date, body: e.body }).catch(fail);
    render();
  };
  const remove = async e => {
    if (!(await confirmDialog(`Delete the entry from ${fmtDate(e.date)}?`))) return;
    items.splice(items.indexOf(e), 1);
    db.deleteJournal(e.id).catch(fail);
    render();
  };

  function render() {
    const list = sorted();
    put(listBox, list.length
      ? list.map(e => {
          const body = h('div', { class: 'md' });
          renderMd(body, e.body);
          return h('div', { class: 'card' },
            h('div', { class: 'between' },
              h('span', { class: 'chip' }, e.date ? fmtDate(e.date) : 'No date'),
              menuButton([{ label: 'Edit', onclick: () => edit(e) }, { label: 'Delete', danger: true, onclick: () => remove(e) }])),
            body);
        })
      : emptyState('file', 'No entries yet. Tap the plus button to write your first one.'));
    requestAnimationFrame(() => fitMath(root)); // needs layout, so wait until the screen is on the page
  }

  render();
  put(root, topbar('Plan'), planSwitch('journal'), listBox,
    h('button', { class: 'fab', 'aria-label': 'New entry', onclick: add }, icon('plus', 28)));
  return root;
}
