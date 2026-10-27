// theory.js: theory test runner and result screen. No auto-grading: you write (or do it on paper), reveal, then rate yourself.
import { h, topbar, toast, confirmDialog, renderMd, emptyState, icon, go, fitMath } from './ui.js';
import * as db from './db.js';

const KEY = 'theorySession';

const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const md = (text, tag = 'div', cls = '', inline = false) => { const el = h(tag, { class: 'md ' + cls }); renderMd(el, text, inline); return el; };
// replaceChildren does not flatten arrays or skip nulls, so go through this
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter(n => n != null && n !== false));

// ---------- session (kept on the device so a reload does not lose a test) ----------
let session = null;
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch { /* storage full or blocked */ } };
const restore = () => { if (!session) { try { session = JSON.parse(localStorage.getItem(KEY)); } catch { session = null; } } return session; };
const clear = () => { session = null; try { localStorage.removeItem(KEY); } catch { /* ignore */ } };

const newSession = (courseId, qs) => ({
  courseId,
  qs: qs.map(q => ({ id: q.id, chapterId: q.chapterId, q: q.q, modelAnswer: q.modelAnswer, keyPoints: q.keyPoints })),
  i: 0, answers: qs.map(() => null), drafts: qs.map(() => ''), finished: false, saved: false,
  chapterIds: [...new Set(qs.map(q => q.chapterId))]
});

// called by the setup screen in quiz.js
export function startTheory(courseId, qs) {
  session = newSession(courseId, qs);
  persist();
  go('/theory');
}

// "Test in progress" card for the setup screen (null when there is nothing to resume)
export function theoryResumeCard() {
  const s = restore();
  if (!s || s.finished) return null;
  const card = h('div', { class: 'card' },
    h('div', { class: 'title' }, 'Theory test in progress'),
    h('div', { class: 'muted small' }, `${s.answers.filter(Boolean).length} of ${s.qs.length} rated`),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => { if (await confirmDialog('Discard the unfinished theory test? Questions you already rated stay in your stats.', 'Discard')) { clear(); card.remove(); } } }, 'Discard'),
      h('button', { class: 'btn primary', onclick: () => go('/theory') }, 'Resume')));
  return card;
}

// ---------- screen ----------
export function theoryScreen() {
  restore();
  if (!session) return h('div', {}, topbar('Theory test'), emptyState('study', 'No theory test in progress.', h('a', { class: 'btn primary', href: '#/test' }, 'Start a test')));
  const box = h('div');
  const fail = e => toast('Could not save: ' + (e.message || e), 4500);
  const answered = () => session.answers.filter(Boolean).length;

  const finish = () => {
    const s = session, res = s.answers.filter(Boolean);
    s.finished = true; s.score = res.filter(r => r.rating === 'got').length; s.total = res.length;
    if (!s.saved && res.length) {
      s.saved = true;
      db.saveAttempt({ courseId: s.courseId, chapterIds: s.chapterIds, type: 'theory', date: Date.now(), score: s.score, total: s.total, results: res }).catch(fail);
    }
    persist(); draw();
  };

  const endTest = async () => {
    const n = answered();
    if (!n) { if (await confirmDialog('Leave this test? Nothing has been rated yet.', 'Leave', false)) { clear(); go('/test'); } return; }
    if (await confirmDialog(`End the test now? Your ${n} rating${n > 1 ? 's' : ''} so far are already in your stats and will be scored.`, 'End test', false)) finish();
  };

  function questionView() {
    const s = session, total = s.qs.length;
    s.i = Math.min(Math.max(s.i, 0), total - 1);
    const q = s.qs[s.i], idx = s.i;
    const stage = h('div');
    const ta = h('textarea', { rows: 7, placeholder: 'Write your answer here, or do it on paper…', value: s.drafts[idx] || '' });
    ta.addEventListener('input', () => { s.drafts[idx] = ta.value; persist(); });

    const rate = rating => {
      if (s.answers[idx]) return;
      s.answers[idx] = { questionId: q.id, correct: rating === 'got', rating };
      db.recordTheory(q.id, rating).catch(fail);
      if (idx + 1 < total) { s.i = idx + 1; persist(); draw(); } else finish();
    };

    const reveal = paper => {
      const written = !paper && ta.value.trim();
      put(stage,
        written ? h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Your answer'), md(ta.value)) : null,
        paper ? h('p', { class: 'muted small' }, 'Marked as done on paper.') : null,
        h('div', { class: 'card' }, h('span', { class: 'chip' }, 'Model answer'), md(q.modelAnswer)),
        h('div', { class: 'card' },
          h('b', {}, 'Key points'), h('div', { class: 'muted small' }, 'Tick the ones your answer had.'),
          q.keyPoints.map(k => h('label', { class: 'check' }, h('input', { type: 'checkbox' }), md(k, 'span', 'inline', true)))),
        h('div', { class: 'muted small' }, 'How did you do?'),
        h('div', { class: 'row rate' },
          h('button', { class: 'btn danger', onclick: () => rate('missed') }, icon('x', 18), 'Missed'),
          h('button', { class: 'btn', onclick: () => rate('partial') }, 'Partial'),
          h('button', { class: 'btn primary', onclick: () => rate('got') }, icon('check', 18), 'Got it')));
      fitMath(box);
      window.scrollTo(0, 0);
    };

    put(stage,
      h('label', { class: 'field' }, h('span', {}, 'Your answer'), ta),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => reveal(true) }, 'I did it on paper'),
        h('button', { class: 'btn primary', onclick: () => reveal(false) }, icon('eye', 18), 'Reveal answer')));

    return [
      h('div', { class: 'topbar' },
        h('button', { class: 'icon-btn', 'aria-label': 'End test', onclick: endTest }, icon('x', 24)),
        h('h1', {}, `Question ${idx + 1} of ${total}`)),
      h('div', { class: 'progress' }, h('div', { style: `width:${(answered() / total) * 100}%` })),
      h('div', { class: 'card' }, md(q.q)),
      stage
    ];
  }

  function resultView() {
    const s = session, res = s.answers.filter(Boolean);
    const count = r => res.filter(a => a.rating === r).length;
    const got = count('got'), partial = count('partial'), missed = count('missed');
    const pct = s.total ? Math.round((got / s.total) * 100) : 0;
    const weak = s.qs.map((q, i) => ({ q, a: s.answers[i] })).filter(x => x.a && x.a.rating !== 'got');
    const retake = () => {
      session = newSession(s.courseId, shuffle(weak.map(x => x.q)));
      persist(); draw();
    };
    return [
      topbar('Results'),
      h('div', { class: 'card' },
        h('div', { class: 'score' }, String(got), h('small', {}, ` / ${s.total} got it`)),
        h('p', { class: 'muted' }, `${got} got it · ${partial} partial · ${missed} missed`),
        h('div', { class: `meter ${pct >= 80 ? 'hi' : pct >= 50 ? 'mid' : 'lo'}` }, h('div', { style: `width:${pct}%` }))),
      h('div', { class: 'row' },
        weak.length ? h('button', { class: 'btn primary', onclick: retake }, icon('retry', 18), 'Retake missed and partial') : null,
        h('button', { class: 'btn', onclick: () => { clear(); go('/test'); } }, 'New test')),
      weak.length
        ? [h('h2', { style: 'margin-top:20px' }, `To revisit (${weak.length})`),
           weak.map(({ q, a }) => h('div', { class: 'card' },
             h('span', { class: 'chip' }, a.rating === 'partial' ? 'Partial' : 'Missed'),
             md(q.q),
             h('div', { class: 'expl' }, h('b', {}, 'Model answer'), md(q.modelAnswer)),
             h('div', { class: 'expl' }, h('b', {}, 'Key points'), h('ul', { class: 'kp' }, q.keyPoints.map(k => h('li', {}, md(k, 'span', '', true)))))))]
        : emptyState('check', 'Got everything. Nothing to revisit.')
    ].flat(Infinity);
  }

  function draw() { put(box, session.finished ? resultView() : questionView()); fitMath(box); window.scrollTo(0, 0); }
  draw();
  return h('div', { class: 'quiz' }, box);
}
