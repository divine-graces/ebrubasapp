// stats.js: per-course stats. Everything is computed from the question docs (no separate stats collection).
import { h, topbar, emptyState, loading, go } from './ui.js';
import * as db from './db.js';

const band = pct => pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';

async function courseStats(courseId) {
  const [chapters, qs] = await Promise.all([db.listChapters(courseId), db.listQuestions(courseId)]);
  const approved = qs.filter(q => q.status === 'approved');
  const rows = chapters.map(c => {
    const own = approved.filter(q => q.chapterId === c.id);
    const seen = own.reduce((n, q) => n + (q.stats?.seen || 0), 0);
    const correct = own.reduce((n, q) => n + (q.stats?.correct || 0), 0);
    return { c, n: own.length, seen, correct, unseen: own.filter(q => !(q.stats?.seen > 0)).length, pct: seen ? Math.round((correct / seen) * 100) : null };
  }).filter(r => r.n > 0);

  if (!rows.length) return [emptyState('inbox', 'No approved questions in this course yet. Import and approve some, then take a test.')];

  // weakest first (lowest correct/seen); chapters you have not answered yet go last
  rows.sort((a, b) => (a.pct === null) - (b.pct === null) || (a.pct ?? 0) - (b.pct ?? 0) || b.seen - a.seen);

  const seenTotal = rows.reduce((n, r) => n + r.seen, 0), correctTotal = rows.reduce((n, r) => n + r.correct, 0);
  const overall = seenTotal ? Math.round((correctTotal / seenTotal) * 100) : null;
  const unseenTotal = rows.reduce((n, r) => n + r.unseen, 0), qTotal = rows.reduce((n, r) => n + r.n, 0);

  return [
    h('div', { class: 'card' },
      h('div', { class: 'muted small' }, 'Overall accuracy'),
      h('div', { class: 'score' }, overall === null ? 'No data yet' : overall + '%'),
      h('p', { class: 'muted small' }, `${seenTotal} answer${seenTotal === 1 ? '' : 's'} so far · ${unseenTotal} of ${qTotal} questions not seen yet`),
      overall === null ? null : h('div', { class: `meter ${band(overall)}` }, h('div', { style: `width:${overall}%` }))),
    h('h2', { style: 'margin-top:20px' }, 'Weakest chapters first'),
    rows.map(r => h('div', { class: 'card tap', onclick: () => go('/test/chapter/' + r.c.id) },
      h('div', { class: 'between' },
        h('div', { class: 'title' }, r.c.name),
        r.pct === null ? h('span', { class: 'muted small' }, 'not started') : h('span', { class: `pct ${band(r.pct)}` }, r.pct + '%')),
      h('div', { class: 'muted small' }, r.seen ? `${r.correct} of ${r.seen} answers correct · ${r.unseen} unseen of ${r.n}` : `${r.n} question${r.n === 1 ? '' : 's'}, none answered yet`),
      r.pct === null ? null : h('div', { class: `meter ${band(r.pct)}` }, h('div', { style: `width:${r.pct}%` }))))
  ].flat(Infinity);
}

export async function statsScreen() {
  const courses = await db.listCourses();
  if (!courses.length) return h('div', {}, topbar('Stats'), emptyState('stats', 'Add a course and take a test to see your stats here.'));

  let cid = sessionStorage.getItem('statsCourse');
  if (!courses.some(c => c.id === cid)) cid = courses[0].id;
  const sel = h('select', { value: cid }, courses.map(c => h('option', { value: c.id }, c.name)));
  const body = h('div');

  const load = async () => {
    const id = sel.value;
    sessionStorage.setItem('statsCourse', id);
    body.replaceChildren(loading());
    try {
      const nodes = await courseStats(id);
      if (id === sel.value) body.replaceChildren(...nodes);
    } catch (e) {
      console.error('Could not load stats', e);
      body.replaceChildren(h('p', { class: 'err' }, 'Could not load stats: ' + (e.message || e)));
    }
  };
  sel.onchange = load;
  await load();
  return h('div', {}, topbar('Stats'), h('label', { class: 'field' }, h('span', {}, 'Course'), sel), body);
}
