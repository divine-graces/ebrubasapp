// quiz.js: MCQ test setup, bucket draw, test runner, result screen.
import { h, topbar, toast, confirmDialog, renderMd, emptyState, icon, loading, go, fitMath } from './ui.js';
import * as db from './db.js';

const LETTERS = 'ABCD';
const KEY = 'quizSession';

const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const md = (text, tag = 'div', cls = '', inline = false) => { const el = h(tag, { class: 'md ' + cls }); renderMd(el, text, inline); return el; };

// ---------- draw: 50% unseen, 30% weak, 20% refresh, short buckets filled from the others ----------
export function drawQuestions(pool, count) {
  const n = Math.min(count, pool.length);
  const st = q => q.stats || {};
  const unseen = shuffle(pool.filter(q => !(st(q).seen > 0)));
  const seen = pool.filter(q => st(q).seen > 0);
  const isWeak = q => st(q).lastResult === 'wrong' || (st(q).streak || 0) < 2;
  const weak = shuffle(seen.filter(isWeak));
  const refresh = seen.filter(q => !isWeak(q)).sort((a, b) => (st(a).lastSeenAt || 0) - (st(b).lastSeenAt || 0)); // oldest first
  const tu = Math.round(n * 0.5), tw = Math.round(n * 0.3), tr = Math.max(0, n - tu - tw);
  const picked = [...unseen.slice(0, tu), ...weak.slice(0, tw), ...refresh.slice(0, tr)];
  const leftovers = [...unseen.slice(tu), ...weak.slice(tw), ...refresh.slice(tr)];
  return shuffle([...picked, ...leftovers.slice(0, n - picked.length)]);
}

// ---------- session (kept on the device so a reload does not lose a test) ----------
let session = null;
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch { /* storage full or blocked */ } };
const restore = () => { if (!session) { try { session = JSON.parse(localStorage.getItem(KEY)); } catch { session = null; } } return session; };
const clear = () => { session = null; try { localStorage.removeItem(KEY); } catch { /* ignore */ } };

// Option order is shuffled per question for display only. chosenIndex is always stored against the ORIGINAL order.
const toQ = q => ({ id: q.id, chapterId: q.chapterId, q: q.q, options: q.options, answer: q.answer, explanation: q.explanation || '', order: shuffle([0, 1, 2, 3]) });
const newSession = (courseId, qs, mode) => ({
  courseId, mode, qs, i: 0, answers: qs.map(() => null), finished: false, saved: false,
  chapterIds: [...new Set(qs.map(q => q.chapterId))]
});

const seg = (items, value, onPick) => {
  const btns = items.map(([v, label, off]) => h('button', {
    class: v === value ? 'on' : '', disabled: off,
    onclick: () => { btns.forEach((b, i) => b.classList.toggle('on', items[i][0] === v)); onPick(v); }
  }, label));
  return h('div', { class: 'seg' }, ...btns);
};

// ---------- test setup ----------
export async function testSetupScreen({ courseId, chapterId } = {}) {
  const courses = await db.listCourses();
  if (!courses.length) return h('div', {}, topbar('Study'), emptyState('courses', 'Add a course and import some questions first.', h('a', { class: 'btn primary', href: '#/' }, 'Go to Courses')));

  const ticked = new Set();
  const fromCourse = !!courseId;
  if (chapterId) { const ch = await db.getChapter(chapterId); if (ch) { courseId = ch.courseId; ticked.add(chapterId); } }
  if (!courses.some(c => c.id === courseId)) courseId = courses[0].id;
  let scope = fromCourse && !chapterId ? 'course' : 'chapters', mode = 'instant';
  let chapters = [], qs = [];

  const approvedMcq = () => qs.filter(q => q.type === 'mcq' && q.status === 'approved');
  const scoped = () => scope === 'course' ? approvedMcq() : approvedMcq().filter(q => ticked.has(q.chapterId));

  const courseSel = h('select', { value: courseId }, courses.map(c => h('option', { value: c.id }, c.name + (c.code ? ` (${c.code})` : ''))));
  const listBox = h('div', { class: 'card checklist' });
  const countIn = h('input', { type: 'number', min: '1', value: '30', inputmode: 'numeric' });
  const avail = h('p', { class: 'muted small' });
  const pendNote = h('p', { class: 'small', hidden: true });
  const startBtn = h('button', { class: 'btn primary block', disabled: true }, icon('play', 18), 'Start test');

  const refresh = () => {
    const n = scoped().length;
    avail.textContent = n ? `${n} approved MCQ${n > 1 ? 's' : ''} available in this selection.`
      : scope === 'chapters' && !ticked.size ? 'Tick at least one chapter.' : 'No approved MCQs here yet.';
    startBtn.disabled = n === 0;
    const pend = qs.filter(q => q.status === 'pending').length;
    pendNote.hidden = !pend;
    if (pend) pendNote.replaceChildren(`${pend} question${pend > 1 ? 's are' : ' is'} pending review in this course and will not appear in tests. `, h('a', { href: '#/review/c/' + courseSel.value }, 'Review them'));
  };

  const renderList = () => {
    const count = id => approvedMcq().filter(q => q.chapterId === id).length;
    const rows = chapters.map(c => {
      const n = count(c.id);
      return h('label', { class: n ? '' : 'off' },
        h('input', { type: 'checkbox', checked: ticked.has(c.id), disabled: n === 0, onchange: e => { e.target.checked ? ticked.add(c.id) : ticked.delete(c.id); refresh(); } }),
        h('span', { class: 'grow' }, c.name), h('span', { class: 'count' }, `${n} MCQ${n === 1 ? '' : 's'}`));
    });
    listBox.replaceChildren(...(rows.length ? rows : [h('p', { class: 'muted' }, 'No chapters in this course yet.')]));
  };

  const loadCourse = async () => {
    const cid = courseSel.value;
    listBox.replaceChildren(loading());
    try {
      const [c, q] = await Promise.all([db.listChapters(cid), db.listQuestions(cid)]);
      if (cid !== courseSel.value) return; // course changed while loading
      chapters = c; qs = q;
    } catch (e) { console.error('Could not load test data', e); toast('Could not load questions: ' + (e.message || e), 4500); chapters = []; qs = []; }
    for (const id of [...ticked]) if (!chapters.some(c => c.id === id)) ticked.delete(id);
    renderList(); refresh();
  };
  courseSel.onchange = () => { ticked.clear(); loadCourse(); };

  const selAll = h('button', { class: 'link', onclick: () => {
    const usable = chapters.filter(c => approvedMcq().some(q => q.chapterId === c.id));
    if (ticked.size === usable.length) ticked.clear(); else usable.forEach(c => ticked.add(c.id));
    renderList(); refresh();
  } }, 'Select all / none');
  const chaptersBlock = h('div', {}, h('div', { class: 'between' }, h('span', { class: 'muted small' }, 'Chapters'), selAll), listBox);
  chaptersBlock.hidden = scope !== 'chapters';

  startBtn.onclick = () => {
    const pool = scoped();
    if (!pool.length) return;
    const want = parseInt(countIn.value, 10);
    if (!(want >= 1)) return toast('Enter how many questions you want (1 or more).');
    const picked = drawQuestions(pool, want).map(toQ);
    if (picked.length < want) toast(`Only ${picked.length} approved questions available, so the test has ${picked.length}.`);
    session = newSession(courseSel.value, picked, mode);
    persist();
    go('/quiz');
  };

  // unfinished test from earlier
  const resume = restore();
  const resumeCard = resume && !resume.finished ? h('div', { class: 'card' },
    h('div', { class: 'title' }, 'Test in progress'),
    h('div', { class: 'muted small' }, `${resume.answers.filter(Boolean).length} of ${resume.qs.length} answered`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => { if (await confirmDialog('Discard the unfinished test? Answers already given stay in your stats.', 'Discard')) { clear(); resumeCard.remove(); } } }, 'Discard'),
      h('button', { class: 'btn primary', onclick: () => go('/quiz') }, 'Resume'))) : null;

  await loadCourse();
  return h('div', {},
    topbar('Study'),
    resumeCard,
    seg([['mcq', 'MCQ'], ['theory', 'Theory (Phase 4)', true]], 'mcq', () => {}),
    h('label', { class: 'field' }, h('span', {}, 'Course'), courseSel),
    seg([['chapters', 'Pick chapters'], ['course', 'Whole course']], scope, v => { scope = v; chaptersBlock.hidden = v !== 'chapters'; refresh(); }),
    chaptersBlock,
    h('label', { class: 'field' }, h('span', {}, 'Number of questions'), countIn),
    avail, pendNote,
    h('div', { class: 'muted small' }, 'Feedback'),
    seg([['instant', 'Instant feedback'], ['end', 'Feedback at the end']], mode, v => { mode = v; }),
    startBtn);
}

// ---------- test runner + result ----------
export function quizScreen() {
  restore();
  if (!session) return h('div', {}, topbar('Test'), emptyState('study', 'No test in progress.', h('a', { class: 'btn primary', href: '#/test' }, 'Start a test')));
  const box = h('div');
  const fail = e => toast('Could not save: ' + (e.message || e), 4500);
  const answered = () => session.answers.filter(Boolean).length;

  const finish = () => {
    const s = session, res = s.answers.filter(Boolean);
    s.finished = true; s.score = res.filter(r => r.correct).length; s.total = res.length;
    if (!s.saved && res.length) {
      s.saved = true;
      db.saveAttempt({ courseId: s.courseId, chapterIds: s.chapterIds, type: 'mcq', date: Date.now(), score: s.score, total: s.total, results: res }).catch(fail);
    }
    persist(); draw();
  };

  const endTest = async () => {
    const n = answered();
    if (!n) { if (await confirmDialog('Leave this test? Nothing has been answered yet.', 'Leave', false)) { clear(); go('/test'); } return; }
    if (await confirmDialog(`End the test now? Your ${n} answer${n > 1 ? 's' : ''} so far are already in your stats and will be scored.`, 'End test', false)) finish();
  };

  function questionView() {
    const s = session, total = s.qs.length;
    s.i = Math.min(Math.max(s.i, 0), total - 1);
    const q = s.qs[s.i], existing = s.answers[s.i];
    let picked = null, locked = !!existing;

    const btns = q.order.map((orig, d) => h('button', { class: 'qopt', onclick: () => choose(d) },
      h('span', { class: 'l' }, LETTERS[d]), md(q.options[orig], 'span', 'inline', true)));
    const expl = h('div', { class: 'card', hidden: true });
    const next = h('button', { class: 'btn primary block', disabled: true }, s.i + 1 < total ? 'Next' : 'See results');

    const showFeedback = a => {
      btns.forEach((b, d) => {
        const orig = q.order[d];
        b.disabled = true;
        b.classList.toggle('right', orig === q.answer);
        b.classList.toggle('wrong', orig === a.chosenIndex && orig !== q.answer);
      });
      expl.replaceChildren(h('b', { class: a.correct ? 'ok' : 'err' }, a.correct ? 'Correct' : 'Not quite'), md(q.explanation || 'No explanation was added for this question.'));
      expl.hidden = false; next.disabled = false;
      fitMath(box); // the explanation had no width while hidden
    };

    // stats update: seen+1, correct+1 if right, streak+1 if right else 0, lastResult, lastSeenAt
    const record = chosen => {
      if (s.answers[s.i]) return s.answers[s.i];
      const correct = chosen === q.answer;
      s.answers[s.i] = { questionId: q.id, correct, chosenIndex: chosen };
      db.recordAnswer(q.id, correct).catch(fail);
      persist();
      return s.answers[s.i];
    };

    function choose(d) {
      if (locked) return;
      if (s.mode === 'instant') { locked = true; showFeedback(record(q.order[d])); }
      else { picked = d; btns.forEach((b, i) => b.classList.toggle('picked', i === d)); next.disabled = false; }
    }

    next.onclick = () => {
      if (s.mode === 'end') { if (picked === null) return; record(q.order[picked]); }
      if (s.i + 1 < total) { s.i++; persist(); draw(); } else finish();
    };

    if (existing) showFeedback(existing); // resumed after answering in instant mode

    return [
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn', 'aria-label': 'End test', onclick: endTest }, icon('x', 24)),
        h('h1', {}, `Question ${s.i + 1} of ${total}`)),
      h('div', { class: 'progress' }, h('div', { style: `width:${(answered() / total) * 100}%` })),
      h('div', { class: 'card' }, md(q.q)),
      ...btns, expl, next
    ];
  }

  function resultView() {
    const s = session;
    const pct = s.total ? Math.round((s.score / s.total) * 100) : 0;
    const misses = s.qs.map((q, i) => ({ q, a: s.answers[i] })).filter(x => x.a && !x.a.correct);
    const retake = () => {
      session = newSession(s.courseId, shuffle(misses.map(m => ({ ...m.q, order: shuffle([0, 1, 2, 3]) }))), s.mode);
      persist(); draw(); window.scrollTo(0, 0);
    };
    return [
      topbar('Results'),
      h('div', { class: 'card' },
        h('div', { class: 'score' }, String(s.score), h('small', {}, ` / ${s.total}`)),
        h('p', { class: 'muted' }, `${pct}% correct`),
        h('div', { class: `meter ${pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo'}` }, h('div', { style: `width:${pct}%` }))),
      h('div', { class: 'row' },
        misses.length ? h('button', { class: 'btn primary', onclick: retake }, icon('retry', 18), 'Retake missed only') : null,
        h('button', { class: 'btn', onclick: () => { clear(); go('/test'); } }, 'New test')),
      misses.length
        ? [h('h2', { style: 'margin-top:20px' }, `Missed (${misses.length})`),
           misses.map(({ q, a }) => h('div', { class: 'card' },
             md(q.q),
             h('div', { class: 'opt wrong stack' }, h('b', {}, 'Your answer'), md(q.options[a.chosenIndex], 'span', 'inline', true)),
             h('div', { class: 'opt correct stack' }, h('b', {}, 'Correct'), md(q.options[q.answer], 'span', 'inline', true)),
             q.explanation ? h('div', { class: 'expl' }, md(q.explanation)) : null))]
        : emptyState('check', 'Perfect score. Nothing missed.')
    ].flat(Infinity);
  }

  function draw() { box.replaceChildren(...(session.finished ? resultView() : questionView())); fitMath(box); window.scrollTo(0, 0); }
  draw();
  return h('div', { class: 'quiz' }, box);
}
