// review.js: one-at-a-time queue of pending questions and flashcards.
import { h, topbar, toast, confirmDialog, renderMd, emptyState, icon } from './ui.js';
import * as db from './db.js';

const md = (text, cls = '', inline = false) => { const d = h('div', { class: 'md ' + cls }); renderMd(d, text, inline); return d; };

// Overview of everything waiting. courseId optional: only that course.
export async function reviewOverview(courseId) {
  const [courses, chapters, pend] = await Promise.all([db.listCourses(), db.listAllChapters(), db.listPendingAll()]);
  const by = {};
  pend.questions.forEach(x => { (by[x.chapterId] ||= { q: 0, c: 0 }).q++; });
  pend.cards.forEach(x => { (by[x.chapterId] ||= { q: 0, c: 0 }).c++; });
  const cName = Object.fromEntries(courses.map(c => [c.id, c.name]));
  const list = chapters.filter(c => by[c.id] && (!courseId || c.courseId === courseId))
    .sort((a, b) => (cName[a.courseId] || '').localeCompare(cName[b.courseId] || '') || a.order - b.order);
  return h('div', {},
    topbar('Review', { back: courseId ? '#/course/' + courseId : '#/' }),
    list.length
      ? list.map(c => h('a', { class: 'card flex tap', href: '#/review/' + c.id },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, c.name),
            h('div', { class: 'muted small' }, `${cName[c.courseId] || ''} · ${by[c.id].q} questions, ${by[c.id].c} cards`)),
          h('span', { class: 'badge' }, by[c.id].q + by[c.id].c),
          h('span', { class: 'chev' }, icon('next', 18))))
      : emptyState('check', 'Nothing is waiting for review.'));
}

export async function reviewQueue(chapterId) {
  const ch = await db.getChapter(chapterId);
  if (!ch) return h('div', {}, topbar('Review', { back: '#/' }), emptyState('inbox', 'This chapter no longer exists.'));
  const p = await db.listPending(chapterId);
  const items = [
    ...p.questions.sort((a, b) => (a.type === 'mcq' ? 0 : 1) - (b.type === 'mcq' ? 0 : 1)).map(x => ({ ...x, kind: 'questions' })),
    ...p.cards.map(x => ({ ...x, kind: 'flashcards' }))
  ];
  const total = items.length;
  let done = 0;
  const box = h('div');
  const fail = e => toast('Could not save: ' + (e.message || e), 4500);

  const next = () => { items.shift(); done++; draw(); };
  const approve = () => { const it = items[0]; db.updateItem(it.kind, it.id, { status: 'approved' }).catch(fail); next(); };
  const remove = async () => {
    if (!(await confirmDialog('Delete this item permanently?'))) return;
    const it = items[0]; db.deleteItem(it.kind, it.id).catch(fail); next();
  };
  const approveRest = async () => {
    if (!(await confirmDialog(`Approve all ${items.length} pending items in "${ch.name}"? They will go straight into tests and flashcards.`, 'Approve all', false))) return;
    await db.setStatus(items, 'approved').catch(fail);
    done += items.length; items.length = 0; draw();
  };

  function view(it) {
    const label = it.kind === 'flashcards' ? 'Flashcard' : it.type === 'mcq' ? 'MCQ' : 'Theory';
    let body;
    if (it.kind === 'flashcards') {
      body = [h('b', {}, 'Front'), md(it.front), h('div', { class: 'expl' }, h('b', {}, 'Back'), md(it.back))];
    } else if (it.type === 'mcq') {
      body = [md(it.q),
        it.options.map((o, i) => h('div', { class: 'opt' + (i === it.answer ? ' correct' : '') }, h('b', {}, 'ABCD'[i] + '.'), md(o, 'inline', true))),
        h('div', { class: 'expl' }, md(it.explanation || '(no explanation)'))];
    } else {
      body = [md(it.q), h('div', { class: 'expl' }, h('b', {}, 'Model answer'), md(it.modelAnswer)),
        h('div', { class: 'expl' }, h('b', {}, 'Key points'), h('ul', { class: 'kp' }, it.keyPoints.map(k => h('li', {}, md(k, '', true)))))];
    }
    return [
      h('div', { class: 'card' }, h('span', { class: 'chip' }, label), body),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger', onclick: remove }, 'Delete'),
        h('button', { class: 'btn', onclick: () => draw(true) }, 'Edit'),
        h('button', { class: 'btn primary', onclick: approve }, 'Approve')),
      h('button', { class: 'btn block', onclick: approveRest }, `Approve all in this chapter (${items.length})`)
    ];
  }

  function edit(it) {
    const ta = (v, rows = 3) => h('textarea', { rows, value: v || '' });
    const f = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
    const err = h('p', { class: 'err', hidden: true });
    let fields, collect;
    if (it.kind === 'flashcards') {
      const a = ta(it.front), b = ta(it.back);
      fields = [f('Front', a), f('Back', b)];
      collect = () => ({ front: a.value.trim(), back: b.value.trim() });
    } else if (it.type === 'mcq') {
      const q = ta(it.q), opts = it.options.map(o => h('input', { type: 'text', value: o }));
      const ans = h('select', { value: String(it.answer) }, 'ABCD'.split('').map((l, i) => h('option', { value: String(i) }, l)));
      const ex = ta(it.explanation, 2);
      fields = [f('Question', q), opts.map((o, i) => f('Option ' + 'ABCD'[i], o)), f('Correct answer', ans), f('Explanation', ex)];
      collect = () => ({ q: q.value.trim(), options: opts.map(o => o.value.trim()), answer: +ans.value, explanation: ex.value.trim() });
    } else {
      const q = ta(it.q), m = ta(it.modelAnswer, 8), k = ta(it.keyPoints.join('\n'), 4);
      fields = [f('Question', q), f('Model answer', m), f('Key points (one per line)', k)];
      collect = () => ({ q: q.value.trim(), modelAnswer: m.value.trim(), keyPoints: k.value.split('\n').map(s => s.trim()).filter(Boolean) });
    }
    const save = async () => {
      const d = collect();
      const empty = Object.entries(d).some(([k, v]) => k === 'explanation' ? false : Array.isArray(v) ? !v.length || v.some(x => !x) : typeof v === 'string' && !v);
      if (empty) { err.textContent = 'Fill in every field (only the explanation may be empty).'; err.hidden = false; return; }
      // Document ids are a hash of the ORIGINAL text and never change. Remember the hash of the new wording too, so importing
      // either the original or the edited wording again is skipped as a duplicate.
      const alias = await db.sha256(it.chapterId + '|' + db.norm(it.kind === 'flashcards' ? d.front : d.q));
      db.updateItem(it.kind, it.id, d, alias === it.id ? null : alias).catch(fail);
      Object.assign(it, d); draw();
    };
    return [h('div', { class: 'card' }, fields, err),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => draw() }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, 'Save edit'))];
  }

  function draw(editing = false) {
    if (!items.length) {
      box.replaceChildren(h('div', { class: 'card' }, emptyState('check', total ? 'All reviewed. Nice work.' : 'Nothing to review in this chapter.'),
        h('a', { class: 'btn primary block', href: '#/chapter/' + chapterId }, 'Open chapter')));
      return;
    }
    box.replaceChildren(
      h('div', { class: 'muted small' }, `${done + 1} of ${total}`),
      h('div', { class: 'progress' }, h('div', { style: `width:${(done / total) * 100}%` })),
      ...(editing ? edit(items[0]) : view(items[0])));
  }

  draw();
  return h('div', {}, topbar('Review: ' + ch.name, { back: '#/chapter/' + chapterId }), box);
}
