// stats.js: per-course stats. Everything is computed from the question docs (no separate stats collection).
import { h, topbar, emptyState, loading, go } from './ui.js';
import * as db from './db.js';

const band = pct => pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo';

async function courseStats(courseId) {
  const [chapters, qs, allCards, attempts] = await Promise.all([db.listChapters(courseId), db.listQuestions(courseId), db.listCards(courseId), db.listAttempts(courseId)]);
  const approved = qs.filter(q => q.status === 'approved');
  const cards = allCards.filter(c => c.status === 'approved');
  const rows = chapters.map(c => {
    const own = approved.filter(q => q.chapterId === c.id);
    const seen = own.reduce((n, q) => n + (q.stats?.seen || 0), 0);
    const correct = own.reduce((n, q) => n + (q.stats?.correct || 0), 0);
    return { c, n: own.length, seen, correct, unseen: own.filter(q => !(q.stats?.seen > 0)).length, pct: seen ? Math.round((correct / seen) * 100) : null };
  }).filter(r => r.n > 0);

  // flashcard box distribution: cards never rated are "New", the rest sit in boxes 1 to 5
  const dist = [0, 0, 0, 0, 0, 0];
  cards.forEach(c => { const s = c.srs || {}; dist[s.lastResult ? Math.min(5, Math.max(1, s.box || 1)) : 0]++; });
  const maxBox = Math.max(1, ...dist);
  const boxCard = cards.length ? h('div', { class: 'card' },
    h('div', { class: 'muted small' }, 'Flashcard boxes'),
    h('div', { class: 'title' }, `${cards.length} approved card${cards.length === 1 ? '' : 's'}`),
    h('div', { class: 'box-dist' }, dist.map((n, i) => h('div', {},
      h('span', { class: 'n' }, String(n)),
      h('div', { class: 'bar', style: `height:${n ? Math.max(4, Math.round((n / maxBox) * 70)) : 3}px;${n ? '' : 'opacity:.25'}` }),
      h('span', {}, i === 0 ? 'New' : 'Box ' + i))))) : null;

  // score history: the last 10 finished tests, newest first
  const recent = attempts.filter(a => a.total > 0).slice(0, 10);
  const when = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const histCard = recent.length ? h('div', { class: 'card' },
    h('div', { class: 'muted small' }, 'Test history'),
    recent.map(a => {
      const p = Math.round((a.score / a.total) * 100);
      return h('div', { class: 'hist' },
        h('div', { class: 'between' },
          h('span', {}, h('span', { class: 'chip' }, a.type === 'theory' ? 'Theory' : 'MCQ'), ' ', when(a.date)),
          h('span', {}, h('span', { class: `pct ${band(p)}` }, p + '%'), h('span', { class: 'muted small' }, `  ${a.score}/${a.total}${a.type === 'theory' ? ' got it' : ''}`))),
        h('div', { class: `meter ${band(p)}` }, h('div', { style: `width:${p}%` })));
    })) : null;

  if (!rows.length) return [emptyState('inbox', 'No approved questions in this course yet. Import and approve some, then take a test.'), boxCard].flat(Infinity).filter(Boolean);

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
    histCard,
    boxCard,
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
