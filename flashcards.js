// flashcards.js: flashcard study. Smart mode = 5 boxes (spaced repetition). Free mode = shuffled rounds.
import { h, topbar, toast, confirmDialog, renderMd, emptyState, icon, go, fitMath, seg, studySwitch, loading } from './ui.js';
import * as db from './db.js';

export const GAPS = [1, 3, 7, 14, 30]; // days until the next review, by the box a card moves INTO (box 1..5)
export const DAY = 86400000;
export const NEW_PER_DAY = 20;

const S = c => c.srs || { box: 1, dueAt: 0, lastResult: null };
const isNew = c => !S(c).lastResult;
const byDue = (a, b) => (S(a).dueAt || 0) - (S(b).dueAt || 0);
export const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const md = (text, tag = 'div', cls = '') => { const el = h(tag, { class: 'md ' + cls }); renderMd(el, text); return el; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const inText = ms => {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return plural(m, 'minute');
  const hr = Math.round(m / 60);
  return hr < 24 ? plural(hr, 'hour') : plural(Math.round(hr / 24), 'day');
};

// ---------- spaced repetition rules ----------
// Missed = back to box 1, due in 1 day (both modes).
// Got it = up one box (max 5), but ONLY if the card was due (dueAt <= now) or new (no lastResult).
// A right answer on a card that is not yet due keeps box and dueAt and only updates lastResult.
// dueAt = now + the gap of the box it lands in.
export function nextSrs(srs, right, now = Date.now()) {
  const s = srs || {};
  const introducedAt = s.introducedAt || now;
  if (!right) return { box: 1, dueAt: now + GAPS[0] * DAY, lastResult: 'wrong', introducedAt };
  const wasNew = !s.lastResult;
  const wasDue = (s.dueAt || 0) <= now;
  if (!wasNew && !wasDue) {
    return { box: s.box || 1, dueAt: s.dueAt, lastResult: 'right', introducedAt };
  }
  const box = Math.min(5, (s.box || 1) + 1);
  return { box, dueAt: now + GAPS[box - 1] * DAY, lastResult: 'right', introducedAt };
}

// New cards (never reviewed) are limited to NEW_PER_DAY per local day, counted across all courses and both modes.
// extraUsed = cards first rated today that are NOT in allApproved (other courses), so the limit stays global.
export const allowanceLeft = used => Math.max(0, NEW_PER_DAY - used);
export const newAllowance = (allApproved, now = Date.now(), extraUsed = 0) =>
  allowanceLeft(extraUsed + allApproved.filter(c => (S(c).introducedAt || 0) >= startOfDay(now)).length);

// Smart session: cards with dueAt <= now, oldest first; new cards capped by today's allowance.
export function buildSmartQueue(scoped, allApproved, now = Date.now(), extraUsed = 0) {
  const allowance = newAllowance(allApproved, now, extraUsed);
  const due = scoped.filter(c => (S(c).dueAt || 0) <= now);
  const reviews = due.filter(c => !isNew(c));
  const fresh = due.filter(isNew).sort(byDue);
  const news = fresh.slice(0, allowance);
  return { queue: [...reviews, ...news].sort(byDue), reviewCount: reviews.length, newCount: news.length, newWaiting: fresh.length - news.length, allowance };
}

// {courseId: number of cards you could study right now}, for the badge on the course cards
export function dueCountsByCourse(allApproved, now = Date.now()) {
  const allowance = newAllowance(allApproved, now), out = {};
  for (const c of allApproved) {
    if ((S(c).dueAt || 0) > now) continue;
    out[c.courseId] = out[c.courseId] || { reviews: 0, news: 0 };
    out[c.courseId][isNew(c) ? 'news' : 'reviews']++;
  }
  return Object.fromEntries(Object.entries(out).map(([id, v]) => [id, v.reviews + Math.min(v.news, allowance)]));
}

// Same number as dueCountsByCourse, but from count queries: dueAll = approved cards due (new ones included),
// newApproved = approved cards never rated, used = cards first rated today across all courses.
export const dueFromCounts = (dueAll, newApproved, used) => Math.max(0, dueAll - newApproved) + Math.min(newApproved, allowanceLeft(used));

// ---------- setup screen + sessions ----------
export async function flashSetupScreen({ courseId, chapterId } = {}) {
  const courses = await db.listCourses();
  if (!courses.length) return h('div', {}, topbar('Study'), studySwitch('cards'), emptyState('courses', 'Add a course and import some flashcards first.', h('a', { class: 'btn primary', href: '#/' }, 'Go to Courses')));

  const ticked = new Set();
  const fromCourse = !!courseId;
  if (chapterId) { const ch = await db.getChapter(chapterId); if (ch) { courseId = ch.courseId; ticked.add(chapterId); } }
  if (!courses.some(c => c.id === courseId)) courseId = courses[0].id;
  let mode = 'smart', scope = fromCourse && !chapterId ? 'course' : 'chapters', chapters = [];
  let approved = [], pendCards = 0, elsewhere = 0; // approved cards of the SELECTED course only; elsewhere = cards first rated today in other courses

  const root = h('div');
  const courseSel = h('select', { value: courseId }, courses.map(c => h('option', { value: c.id }, c.name + (c.code ? ` (${c.code})` : ''))));
  const listBox = h('div', { class: 'card checklist' });
  const info = h('p', { class: 'small muted' });
  const pendNote = h('p', { class: 'small', hidden: true });
  const startBtn = h('button', { class: 'btn primary block', disabled: true });

  const cardsOf = () => approved.filter(c => c.courseId === courseSel.value);
  const scoped = () => scope === 'course' ? cardsOf() : cardsOf().filter(c => ticked.has(c.chapterId));

  const refresh = () => {
    const pool = scoped(), now = Date.now();
    startBtn.replaceChildren(icon('play', 18), mode === 'smart' ? 'Start review' : 'Start practice');
    if (!pool.length) {
      info.textContent = scope === 'chapters' && !ticked.size ? 'Tick at least one chapter.' : 'No approved flashcards here yet.';
      startBtn.disabled = true;
    } else if (mode === 'free') {
      info.textContent = `${plural(pool.length, 'approved card')} in this selection. Shuffled rounds, no schedule. Your ratings still move cards between boxes.`;
      startBtn.disabled = false;
    } else {
      const q = buildSmartQueue(pool, approved, now, elsewhere);
      if (q.queue.length) {
        info.textContent = `${plural(q.queue.length, 'card')} due now (${q.reviewCount} to review, ${q.newCount} new). ${q.allowance} new cards left today.`;
      } else {
        const future = pool.map(c => S(c).dueAt).filter(t => t > now).sort((a, b) => a - b);
        info.textContent = 'Nothing is due right now.'
          + (q.newWaiting ? ` ${plural(q.newWaiting, 'new card')} waiting, but today's limit of ${NEW_PER_DAY} new cards is used up.` : '')
          + (future.length ? ` The next card is due in ${inText(future[0] - now)}.` : '')
          + ' You can still practise in Free mode.';
      }
      startBtn.disabled = !q.queue.length;
    }
    const pc = pendCards;
    pendNote.hidden = !pc;
    if (pc) pendNote.replaceChildren(`${pc} flashcard${pc > 1 ? 's are' : ' is'} pending review in this course and will not appear. `, h('a', { href: '#/review/c/' + courseSel.value }, 'Review them'));
  };

  const renderList = () => {
    const now = Date.now();
    const rows = chapters.map(c => {
      const own = cardsOf().filter(x => x.chapterId === c.id), n = own.length;
      const due = own.filter(x => (S(x).dueAt || 0) <= now).length;
      return h('label', { class: n ? '' : 'off' },
        h('input', { type: 'checkbox', checked: ticked.has(c.id), disabled: n === 0, onchange: e => { e.target.checked ? ticked.add(c.id) : ticked.delete(c.id); refresh(); } }),
        h('span', { class: 'grow' }, c.name),
        h('span', { class: 'count' }, mode === 'smart' && n ? `${plural(n, 'card')} · ${due} due` : plural(n, 'card')));
    });
    listBox.replaceChildren(...(rows.length ? rows : [h('p', { class: 'muted' }, 'No chapters in this course yet.')]));
  };

  const loadCourse = async () => {
    const cid = courseSel.value;
    listBox.replaceChildren(loading());
    try {
      const [list, cards, pc, introduced] = await Promise.all([
        db.listChapters(cid), db.listApprovedCardsOf(cid),
        db.pendingCardCount(cid).catch(() => null), db.introducedSince(startOfDay(Date.now())).catch(() => null)]);
      if (cid !== courseSel.value) return; // course changed while loading
      chapters = list; approved = cards; pendCards = pc || 0;
      const today = cards.filter(c => (S(c).introducedAt || 0) >= startOfDay(Date.now())).length;
      elsewhere = introduced == null ? 0 : Math.max(0, introduced - today);
    } catch (e) { console.error('Could not load chapters', e); toast('Could not load chapters: ' + (e.message || e), 4500); chapters = []; approved = []; pendCards = 0; elsewhere = 0; }
    for (const id of [...ticked]) if (!chapters.some(c => c.id === id)) ticked.delete(id);
    renderList(); refresh();
  };
  courseSel.onchange = () => { ticked.clear(); loadCourse(); };

  const selAll = h('button', { class: 'link', onclick: () => {
    const usable = chapters.filter(c => cardsOf().some(x => x.chapterId === c.id));
    if (ticked.size === usable.length) ticked.clear(); else usable.forEach(c => ticked.add(c.id));
    renderList(); refresh();
  } }, 'Select all / none');
  const chaptersBlock = h('div', {}, h('div', { class: 'between' }, h('span', { class: 'muted small' }, 'Chapters'), selAll), listBox);
  chaptersBlock.hidden = scope !== 'chapters';

  const setupNodes = [
    topbar('Study'),
    studySwitch('cards'),
    seg([['smart', 'Smart review'], ['free', 'Free practice']], mode, v => { mode = v; renderList(); refresh(); }),
    h('label', { class: 'field' }, h('span', {}, 'Course'), courseSel),
    seg([['chapters', 'Pick chapters'], ['course', 'Whole course']], scope, v => { scope = v; chaptersBlock.hidden = v !== 'chapters'; refresh(); }),
    chaptersBlock, info, pendNote, startBtn
  ];
  const backToSetup = () => { root.replaceChildren(...setupNodes); renderList(); refresh(); window.scrollTo(0, 0); };

  startBtn.onclick = () => {
    const pool = scoped();
    if (mode === 'free') { if (pool.length) runSession('free', pool); return; }
    const q = buildSmartQueue(pool, approved, Date.now(), elsewhere);
    if (q.queue.length) runSession('smart', q.queue);
  };

  // One session. Card objects are shared with `approved`, so ratings show up on the setup screen straight away.
  function runSession(sessionMode, cards) {
    const sbox = h('div');
    root.replaceChildren(sbox);
    let queue = sessionMode === 'free' ? shuffle(cards) : [...cards];
    const total = cards.length, missedIds = new Set();
    let round = 1, got = 0, missed = 0, answered = 0, flipped = false;
    const fail = e => toast('Could not save: ' + (e.message || e), 4500);
    const remaining = () => new Set(queue.map(c => c.id)).size;

    const rate = right => {
      if (!flipped || !queue.length) return;
      const c = queue.shift();
      c.srs = nextSrs(S(c), right, Date.now()); // keep the in-memory copy current
      db.reviewCard(c.id, c.srs).catch(fail);   // saved in the background (works offline)
      answered++; right ? got++ : missed++;
      // Free mode: a missed card comes back 3 to 5 cards later in the same round (Smart mode: it returns tomorrow)
      if (sessionMode === 'free' && !right) { missedIds.add(c.id); queue.splice(Math.min(queue.length, 2 + Math.floor(Math.random() * 3)), 0, c); }
      draw();
    };

    const summary = complete => {
      const free = sessionMode === 'free';
      const title = free ? (complete ? `Round ${round} complete` : 'Practice ended') : (complete ? 'Review complete' : 'Review ended');
      const detail = free && complete ? `${plural(total, 'card')} · ${missedIds.size} needed a second look`
        : `${got} got it · ${missed} missed`;
      sbox.replaceChildren(
        topbar('Flashcards'),
        h('div', { class: 'card' }, emptyState('check', title), h('p', { class: 'title center-text' }, detail),
          !free && missed ? h('p', { class: 'muted small center-text' }, 'Missed cards go back to box 1 and come back tomorrow.') : null),
        h('div', { class: 'row' },
          free && complete ? h('button', { class: 'btn primary', onclick: () => { queue = shuffle(cards); round++; missedIds.clear(); got = missed = 0; draw(); } }, icon('retry', 18), 'Next round') : null,
          h('button', { class: free && complete ? 'btn' : 'btn primary', onclick: backToSetup }, 'Done')));
      window.scrollTo(0, 0);
    };

    const endSession = async () => {
      if (!answered) return backToSetup();
      if (await confirmDialog('End this session? Cards you already rated are saved.', 'End session', false)) summary(false);
    };

    function draw() {
      if (!queue.length) return summary(true);
      const c = queue[0], s = S(c);
      flipped = false;
      const back = h('div', { class: 'back', hidden: true }, md(c.back));
      const flip = () => { if (flipped) return; flipped = true; back.hidden = false; showBtn.hidden = true; rateRow.hidden = false; fitMath(sbox); };
      const showBtn = h('button', { class: 'btn block', onclick: flip }, icon('eye', 18), 'Show answer');
      const rateRow = h('div', { class: 'row rate', hidden: true },
        h('button', { class: 'btn danger', onclick: () => rate(false) }, icon('x', 18), 'Missed'),
        h('button', { class: 'btn primary', onclick: () => rate(true) }, icon('check', 18), 'Got it'));
      const done = sessionMode === 'free' ? total - remaining() : answered;
      sbox.replaceChildren(
        h('div', { class: 'topbar' },
          h('button', { class: 'icon-btn', 'aria-label': 'End session', onclick: endSession }, icon('x', 24)),
          h('h1', {}, sessionMode === 'smart' ? 'Smart review' : 'Free practice')),
        h('div', { class: 'muted small' }, sessionMode === 'smart' ? `${queue.length} left` : `Round ${round} · ${remaining()} left`),
        h('div', { class: 'progress' }, h('div', { style: `width:${(done / total) * 100}%` })),
        h('div', { class: 'card flash tap', onclick: flip },
          h('span', { class: 'chip' }, isNew(c) ? 'New' : `Box ${s.box || 1}`),
          md(c.front, 'div', 'side'), back),
        showBtn, rateRow);
      fitMath(sbox);
      window.scrollTo(0, 0);
    }
    draw();
  }

  await loadCourse();
  root.replaceChildren(...setupNodes);
  refresh();
  return root;
}
