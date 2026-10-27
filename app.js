// app.js: entry point. Auth gate, hash router, Courses / Course / Chapter screens.
import { onUser, logout, renderLogin } from './auth.js';
import * as db from './db.js';
import { h, $, topbar, menuButton, toast, confirmDialog, formModal, renderMd, loading, setSync, go, icon, emptyState } from './ui.js';
import { importScreen } from './import.js';
import { reviewOverview, reviewQueue } from './review.js';
import { testSetupScreen, quizScreen } from './quiz.js';
import { statsScreen } from './stats.js';
import { flashSetupScreen, dueCountsByCourse } from './flashcards.js';

const view = $('#view');
let navId = 0, signedIn = false;

// Screens pass arrays (courses.map(...)) and null (conditional banners). replaceChildren would turn
// those into the text "null" / "[object HTMLDivElement]", so flatten and drop empties first.
const show = (live, ...nodes) => {
  if (!live()) return;
  view.replaceChildren(...nodes.flat(Infinity).filter(n => n != null && n !== false));
  window.scrollTo(0, 0);
};
const tally = (arr, key) => arr.reduce((m, x) => { m[x[key]] = (m[x[key]] || 0) + 1; return m; }, {});
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast('Something went wrong: ' + (e.message || e), 4500); } };
const soon = msg => () => toast(msg);

// ---------- router ----------
async function route() {
  if (!signedIn) return;
  const id = ++navId, live = () => id === navId;
  const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const active = ['import', 'stats'].includes(a) ? a : ['study', 'test', 'quiz', 'flashcards'].includes(a) ? 'study' : a === 'review' ? '' : 'courses';
  document.querySelectorAll('#nav a').forEach(x => x.classList.toggle('on', x.dataset.r === active));
  view.replaceChildren(loading());
  try {
    if (!a) await coursesScreen(live);
    else if (a === 'course') await courseScreen(b, live);
    else if (a === 'chapter') await chapterScreen(b, live);
    else if (a === 'import') show(live, await importScreen());
    else if (a === 'review') show(live, b === 'c' ? await reviewOverview(c) : b ? await reviewQueue(b) : await reviewOverview());
    else if (a === 'study' || a === 'test') show(live, await testSetupScreen(b === 'course' ? { courseId: c } : b === 'chapter' ? { chapterId: c } : {}));
    else if (a === 'flashcards') show(live, await flashSetupScreen(b === 'course' ? { courseId: c } : b === 'chapter' ? { chapterId: c } : {}));
    else if (a === 'quiz') show(live, quizScreen());
    else if (a === 'stats') show(live, await statsScreen());
    else go('/');
  } catch (e) {
    console.error(e);
    const hint = e.code === 'permission-denied' ? ' Check that the Firestore rules from the setup steps are published.' : '';
    show(live, topbar('Error'), h('div', { class: 'card' }, h('p', { class: 'err' }, (e.message || String(e)) + hint), h('button', { class: 'btn', onclick: () => route() }, 'Try again')));
  }
}

// ---------- Courses (home) ----------
async function coursesScreen(live) {
  const [courses, chapters, pend, approvedCards] = await Promise.all([db.listCourses(), db.listAllChapters(), db.listPendingAll(), db.listApprovedCards()]);
  const chCount = tally(chapters, 'courseId');
  const due = dueCountsByCourse(approvedCards);
  const pCount = tally([...pend.questions, ...pend.cards], 'courseId');
  const total = pend.questions.length + pend.cards.length;

  const addCourse = safe(async () => {
    const r = await formModal({ title: 'New course', fields: [
      { name: 'name', label: 'Course name', required: true },
      { name: 'code', label: 'Course code (optional)' }] });
    if (!r) return;
    await db.addCourse(r.name.trim(), r.code.trim());
    route();
  });
  const rename = safe(async c => {
    const r = await formModal({ title: 'Rename course', fields: [
      { name: 'name', label: 'Course name', value: c.name, required: true },
      { name: 'code', label: 'Course code', value: c.code || '' }] });
    if (!r) return;
    await db.renameCourse(c.id, r.name.trim(), r.code.trim());
    route();
  });
  const remove = safe(async c => {
    if (!(await confirmDialog(`Delete "${c.name}" and ALL its chapters, notes, questions and flashcards? This cannot be undone.`))) return;
    toast('Deleting…');
    await db.deleteCourse(c.id);
    toast('Course deleted');
    route();
  });

  show(live,
    topbar('Courses', { right: h('button', { class: 'icon-btn', 'aria-label': 'Sign out', onclick: () => confirmDialog('Sign out?', 'Sign out', false).then(ok => ok && logout()) }, icon('logout', 22)) }),
    total ? h('a', { class: 'card flex tap', href: '#/review' }, h('div', { class: 'grow' }, 'Items waiting for review'), h('span', { class: 'badge' }, total)) : null,
    courses.length
      ? courses.map(c => h('div', { class: 'card flex tap', onclick: () => go('/course/' + c.id) },
          h('div', { class: 'tile' }, icon('courses', 20)),
          h('div', { class: 'grow' },
            h('div', { class: 'title' }, c.name),
            h('div', { class: 'muted small' }, [c.code, `${chCount[c.id] || 0} chapters`].filter(Boolean).join(' · '))),
          due[c.id] ? h('a', { class: 'due-badge', href: '#/flashcards/course/' + c.id, onclick: e => e.stopPropagation() }, due[c.id] + ' due') : null,
          pCount[c.id] ? h('a', { class: 'badge', href: '#/review/c/' + c.id, onclick: e => e.stopPropagation() }, pCount[c.id] + ' to review') : null,
          menuButton([{ label: 'Rename', onclick: () => rename(c) }, { label: 'Delete', danger: true, onclick: () => remove(c) }])))
      : emptyState('courses', 'No courses yet. Tap the plus button to add your first one.'),
    h('button', { class: 'fab', 'aria-label': 'Add course', onclick: addCourse }, icon('plus', 28)));
}

// ---------- Course page ----------
async function courseScreen(courseId, live) {
  const [course, chapters, qs, cards] = await Promise.all([db.getCourse(courseId), db.listChapters(courseId), db.listQuestions(courseId), db.listCards(courseId)]);
  if (!course) return show(live, topbar('Not found', { back: '#/' }), emptyState('inbox', 'This course no longer exists.'));
  const st = {};
  const S = id => (st[id] ||= { mcq: 0, theory: 0, cards: 0, pending: 0 });
  qs.forEach(q => { const s = S(q.chapterId); if (q.status === 'pending') s.pending++; else s[q.type]++; });
  cards.forEach(c => { const s = S(c.chapterId); if (c.status === 'pending') s.pending++; else s.cards++; });
  const pend = Object.values(st).reduce((n, s) => n + s.pending, 0);

  show(live,
    topbar(course.name, { back: '#/' }),
    h('div', { class: 'grid3' },
      h('button', { class: 'btn', onclick: () => go('/test/course/' + courseId) }, 'Take test'),
      h('button', { class: 'btn', onclick: () => go('/flashcards/course/' + courseId) }, 'Flashcards'),
      h('button', { class: 'btn', onclick: soon('Finals mode arrives in Phase 4') }, 'Finals mode')),
    pend ? h('a', { class: 'card flex tap', href: '#/review/c/' + courseId }, h('div', { class: 'grow' }, 'Items waiting for review'), h('span', { class: 'badge' }, pend)) : null,
    chapters.length
      ? chapters.map(c => {
          const s = st[c.id] || { mcq: 0, theory: 0, cards: 0, pending: 0 };
          return h('a', { class: 'card flex tap', href: '#/chapter/' + c.id },
            h('div', { class: 'grow' },
              h('div', { class: 'title' }, c.name),
              h('div', { class: 'muted small' }, `Note ${c.noteBody ? 'yes' : 'no'} · ${s.mcq} MCQ · ${s.theory} theory · ${s.cards} cards`)),
            s.pending ? h('span', { class: 'badge' }, s.pending + ' pending') : null,
            h('span', { class: 'chev' }, icon('next', 18)));
        })
      : emptyState('layers', 'No chapters yet. Import a note to create the first one.'),
    h('button', { class: 'btn primary block', onclick: () => { sessionStorage.setItem('importCourse', courseId); go('/import'); } }, 'Import into this course'));
}

// ---------- Chapter page ----------
async function chapterScreen(id, live) {
  const ch = await db.getChapter(id);
  if (!ch) return show(live, topbar('Not found', { back: '#/' }), emptyState('inbox', 'This chapter no longer exists.'));
  const p = await db.listPending(id);
  const pend = p.questions.length + p.cards.length;

  const editNote = safe(async () => {
    const r = await formModal({ title: 'Edit note', okText: 'Save note', fields: [{ name: 'body', label: 'Markdown, with $math$ and $$math$$', type: 'textarea', rows: 16, value: ch.noteBody || '' }] });
    if (!r) return;
    await db.updateChapter(id, { noteBody: r.body });
    route();
  });
  const rename = safe(async () => {
    const r = await formModal({ title: 'Rename chapter', fields: [{ name: 'name', label: 'Chapter name', value: ch.name, required: true }] });
    if (!r) return;
    const key = db.norm(r.name);
    const sibs = await db.listChapters(ch.courseId);
    if (sibs.some(s => s.id !== id && s.nameKey === key)) return toast('Another chapter in this course already has that name.');
    await db.updateChapter(id, { name: r.name.trim(), nameKey: key });
    route();
  });
  const remove = safe(async () => {
    if (!(await confirmDialog(`Delete "${ch.name}" with its note, questions and flashcards? This cannot be undone.`))) return;
    toast('Deleting…');
    await db.deleteChapter(id);
    toast('Chapter deleted');
    go('/course/' + ch.courseId);
  });

  const note = h('div', { class: 'card md' });
  if (ch.noteBody) renderMd(note, ch.noteBody);
  else note.append(emptyState('file', 'No note yet. Import one into this chapter.'));

  show(live,
    topbar(ch.name, { back: '#/course/' + ch.courseId, right: menuButton([
      { label: 'Edit note', onclick: editNote }, { label: 'Rename', onclick: rename }, { label: 'Delete chapter', danger: true, onclick: remove }]) }),
    pend ? h('a', { class: 'card flex tap', href: '#/review/' + id }, h('div', { class: 'grow' }, 'Items waiting for review'), h('span', { class: 'badge' }, pend)) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => go('/test/chapter/' + id) }, 'Study this chapter'),
      h('button', { class: 'btn', onclick: () => go('/flashcards/chapter/' + id) }, 'Flashcards')),
    note);
}

// ---------- boot ----------
db.setSyncHook(setSync);
window.addEventListener('hashchange', route);
onUser(user => {
  $('#boot').hidden = true;
  signedIn = !!user;
  if (user) {
    db.setUid(user.uid);
    $('#login').hidden = true; $('#shell').hidden = false;
    setSync();
    route();
  } else {
    db.setUid(null);
    $('#shell').hidden = true;
    const l = $('#login'); l.hidden = false; renderLogin(l);
  }
});
