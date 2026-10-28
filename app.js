// app.js: entry point. Auth gate, hash router, Courses / Course / Chapter screens.
import { onUser, logout, renderLogin } from './auth.js';
import * as db from './db.js';
import { h, $, topbar, menuButton, toast, confirmDialog, formModal, renderMd, loading, setSync, go, icon, emptyState, watchOnline } from './ui.js';
import { importScreen } from './import.js';
import { reviewOverview, reviewQueue } from './review.js';
import { testSetupScreen, quizScreen, resetQuizSession } from './quiz.js';
import { statsScreen } from './stats.js';
import { flashSetupScreen, dueFromCounts, startOfDay } from './flashcards.js';
import { theoryScreen, resetTheorySession } from './theory.js';
import { todoScreen } from './todos.js';
import { journalScreen } from './journal.js';
import { settingsScreen } from './settings.js';

const view = $('#view');
let navId = 0, signedIn = false, indexWarned = false;

// Screens pass arrays (courses.map(...)) and null (conditional banners). replaceChildren would turn
// those into the text "null" / "[object HTMLDivElement]", so flatten and drop empties first.
const show = (live, ...nodes) => {
  if (!live()) return;
  view.replaceChildren(...nodes.flat(Infinity).filter(n => n != null && n !== false));
  window.scrollTo(0, 0);
};
const tally = (arr, key) => arr.reduce((m, x) => { m[x[key]] = (m[x[key]] || 0) + 1; return m; }, {});
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast('Something went wrong: ' + (e.message || e), 4500); } };

// ---------- router ----------
async function route() {
  if (!signedIn) return;
  const id = ++navId, live = () => id === navId;
  const [a, b, c] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const active = ['import', 'stats'].includes(a) ? a : ['todo', 'journal'].includes(a) ? 'plan' : ['study', 'test', 'quiz', 'theory', 'flashcards'].includes(a) ? 'study' : a === 'review' ? '' : 'courses';
  document.querySelectorAll('#nav a').forEach(x => x.classList.toggle('on', x.dataset.r === active));
  view.replaceChildren(loading());
  try {
    if (!a) await coursesScreen(live);
    else if (a === 'course') await courseScreen(b, live);
    else if (a === 'chapter') await chapterScreen(b, live);
    else if (a === 'import') show(live, await importScreen());
    else if (a === 'review') show(live, b === 'c' ? await reviewOverview(c) : b ? await reviewQueue(b) : await reviewOverview());
    else if (a === 'study' || a === 'test') show(live, await testSetupScreen(b === 'course' ? { courseId: c } : b === 'finals' ? { courseId: c, finals: true } : b === 'chapter' ? { chapterId: c } : {}));
    else if (a === 'flashcards') show(live, await flashSetupScreen(b === 'course' ? { courseId: c } : b === 'chapter' ? { chapterId: c } : {}));
    else if (a === 'quiz') show(live, quizScreen());
    else if (a === 'theory') show(live, theoryScreen());
    else if (a === 'todo') show(live, await todoScreen());
    else if (a === 'journal') show(live, await journalScreen());
    else if (a === 'stats') show(live, await statsScreen());
    else if (a === 'settings') show(live, settingsScreen());
    else go('/');
  } catch (e) {
    console.error(e);
    const hint = e.code === 'permission-denied' ? ' Check that the Firestore rules from the setup steps are published.' : '';
    show(live, topbar('Error'), h('div', { class: 'card' }, h('p', { class: 'err' }, (e.message || String(e)) + hint), h('button', { class: 'btn', onclick: () => route() }, 'Try again')));
  }
}

// ---------- Download for offline ----------
// A button plus a status line. run(onProgress) does the work and returns the counts. Disabled (with a short message) while offline.
function downloadControl(label, run) {
  const btn = h('button', { class: 'btn block' }, icon('download', 18), label);
  const msg = h('p', { class: 'muted small center-text' });
  let busy = false, text = '', isErr = false;
  const sync = () => {
    const on = navigator.onLine;
    btn.disabled = !on || busy;
    msg.className = (on && isErr ? 'err' : 'muted') + ' small center-text';
    msg.textContent = on ? text : 'Connect to the internet to download.';
  };
  const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  btn.onclick = async () => {
    if (busy || !navigator.onLine) return;
    busy = true; isErr = false; text = 'Downloading… 0%'; sync();
    try {
      const r = await run((done, total, name) => {
        text = `Downloading${name ? ' ' + name : ''}… ${total ? Math.round((done / total) * 100) : 100}%`; sync();
      });
      text = `Saved ${count(r.chapters, 'chapter')}, ${count(r.questions, 'question')}, ${count(r.cards, 'card')} for offline use.`;
    } catch (e) {
      console.error(e); isErr = true; text = e.message || 'Download failed.';
    } finally { busy = false; sync(); }
  };
  const box = h('div', {}, btn, msg);
  watchOnline(btn, sync); // re-checks on the online/offline events (and once now)
  return box;
}

// ---------- Courses (home) ----------
async function coursesScreen(live) {
  const courses = await db.listCourses();
  // Count queries only (one set per course, in parallel): no chapters, questions or cards are downloaded.
  // A count that fails offline is null, and a null count simply shows no badge.
  const [used, counts] = await Promise.all([
    db.introducedSince(startOfDay(Date.now())).catch(() => null),
    Promise.all(courses.map(c => db.courseHomeCounts(c.id)))]);
  const chCount = {}, due = {}, pCount = {};
  courses.forEach((c, i) => {
    const k = counts[i];
    chCount[c.id] = k.chapters;
    if (k.pendQ != null && k.pendC != null) pCount[c.id] = k.pendQ + k.pendC;
    if (used != null && k.dueAll != null && k.newApproved != null) due[c.id] = dueFromCounts(k.dueAll, k.newApproved, used);
  });
  const total = Object.values(pCount).reduce((n, x) => n + x, 0);
  if (db.lastIndexError && !indexWarned) { indexWarned = true; toast('Due-card badges need a Firestore index. Open the browser console for the link.', 8000); }

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
    topbar('Courses', { right: h('div', { style: 'display:inline-flex' },
      // small dot on the gear when the last export is over 30 days old (or there never was one)
      h('button', { class: 'icon-btn', 'aria-label': db.exportOverdue() ? 'Settings (backup due)' : 'Settings', style: 'position:relative', onclick: () => go('/settings') },
        icon('settings', 22),
        db.exportOverdue() ? h('span', { style: 'position:absolute;top:9px;right:9px;width:10px;height:10px;border-radius:50%;background:var(--warn);border:2px solid var(--bg)' }) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Sign out', onclick: () => confirmDialog('Sign out?', 'Sign out', false).then(ok => ok && logout()) }, icon('logout', 22))) }),
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
    courses.length ? downloadControl('Download everything', p => db.downloadAll(p)) : null,
    h('button', { class: 'fab', 'aria-label': 'Add course', onclick: addCourse }, icon('plus', 28)));
}

// ---------- Course page ----------
async function courseScreen(courseId, live) {
  const [course, chapters] = await Promise.all([db.getCourse(courseId), db.listChapters(courseId)]);
  if (!course) return show(live, topbar('Not found', { back: '#/' }), emptyState('inbox', 'This course no longer exists.'));
  const st = await db.chapterCounts(courseId, chapters.map(c => c.id)); // count queries, not documents
  const pend = Object.values(st).reduce((n, s) => n + s.pending, 0);

  show(live,
    topbar(course.name, { back: '#/' }),
    h('div', { class: 'grid3' },
      h('button', { class: 'btn', onclick: () => go('/test/course/' + courseId) }, 'Take test'),
      h('button', { class: 'btn', onclick: () => go('/flashcards/course/' + courseId) }, 'Flashcards'),
      h('button', { class: 'btn', onclick: () => go('/test/finals/' + courseId) }, 'Finals mode')),
    downloadControl('Download for offline', p => db.downloadCourse(courseId, p)),
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

// ---------- sign out: forget everything kept in the browser for this account ----------
// quizSession and theorySession (with its draft answers) are cleared by their own modules, in memory and in localStorage.
// statsCourse and importCourse are the per-user keys in sessionStorage. Nothing else is touched.
function clearUserData() {
  resetQuizSession();
  resetTheorySession();
  for (const k of ['statsCourse', 'importCourse']) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } }
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
    clearUserData();
    $('#shell').hidden = true;
    const l = $('#login'); l.hidden = false; renderLogin(l);
  }
});
