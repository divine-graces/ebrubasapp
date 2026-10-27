// todos.js: simple to-do list. Open tasks sorted by due date, completed tasks tucked away below.
import { h, topbar, toast, confirmDialog, formModal, emptyState, icon, menuButton, planSwitch } from './ui.js';
import * as db from './db.js';

const pad = n => String(n).padStart(2, '0');
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const fmtDate = s => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter(n => n != null && n !== false));

export async function todoScreen() {
  const items = await db.listTodos();
  let showDone = false;
  const fail = e => toast('Could not save: ' + (e.message || e), 4500);

  // open tasks: due date first (no date last), then the order they were added
  const open = () => items.filter(t => !t.done).sort((a, b) => (a.due || '9999') .localeCompare(b.due || '9999') || (a.createdAt || 0) - (b.createdAt || 0));
  const done = () => items.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  const listBox = h('div');

  const toggle = (t, v) => {
    t.done = v; t.doneAt = v ? Date.now() : null;
    db.updateTodo(t.id, { done: v, doneAt: t.doneAt }).catch(fail);
    render();
  };
  const edit = async t => {
    const r = await formModal({ title: 'Edit task', fields: [
      { name: 'text', label: 'Task', value: t.text, required: true },
      { name: 'due', label: 'Due date (optional)', type: 'date', value: t.due || '' }] });
    if (!r) return;
    t.text = r.text.trim(); t.due = r.due || '';
    db.updateTodo(t.id, { text: t.text, due: t.due }).catch(fail);
    render();
  };
  const remove = async t => {
    if (!(await confirmDialog(`Delete "${t.text}"?`))) return;
    items.splice(items.indexOf(t), 1);
    db.deleteTodo(t.id).catch(fail);
    render();
  };
  const clearDone = async () => {
    const d = done();
    if (!d.length || !(await confirmDialog(`Delete ${d.length} completed task${d.length > 1 ? 's' : ''}?`))) return;
    d.forEach(t => items.splice(items.indexOf(t), 1));
    db.deleteTodos(d.map(t => t.id)).catch(fail);
    render();
  };

  const row = t => {
    const overdue = !t.done && t.due && t.due < todayStr();
    return h('div', { class: 'card flex todo' + (t.done ? ' done' : '') },
      h('label', { class: 'tick' }, h('input', { type: 'checkbox', checked: !!t.done, 'aria-label': 'Done', onchange: e => toggle(t, e.target.checked) })),
      h('div', { class: 'grow', onclick: () => edit(t) },
        h('div', { class: 'title' }, t.text),
        t.due ? h('div', { class: 'small ' + (overdue ? 'err' : 'muted') }, (overdue ? 'Overdue · ' : 'Due ') + fmtDate(t.due)) : null),
      menuButton([{ label: 'Edit', onclick: () => edit(t) }, { label: 'Delete', danger: true, onclick: () => remove(t) }]));
  };

  function render() {
    const o = open(), d = done();
    put(listBox,
      o.length ? o.map(row) : emptyState('list', d.length ? 'All done. Nothing open.' : 'No tasks yet. Add your first one above.'),
      d.length ? [
        h('div', { class: 'between' },
          h('button', { class: 'link', onclick: () => { showDone = !showDone; render(); } }, `${showDone ? 'Hide' : 'Show'} completed (${d.length})`),
          showDone ? h('button', { class: 'link', onclick: clearDone }, 'Clear completed') : null),
        showDone ? d.map(row) : null] : null);
  }

  const input = h('input', { type: 'text', placeholder: 'Add a task…', enterkeyhint: 'done', 'aria-label': 'New task' });
  const form = h('form', { class: 'quickadd', onsubmit: e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const data = { text, done: false, due: '', doneAt: null, createdAt: Date.now() };
    const r = db.addTodo(data);
    r.done.catch(fail);
    items.push({ id: r.id, ...data });
    input.value = '';
    render();
  } }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('plus', 18), 'Add'));

  render();
  return h('div', {}, topbar('Plan'), planSwitch('todo'), form, listBox);
}
