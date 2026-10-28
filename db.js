// db.js: all Firestore access. Everything lives under users/{uid}/.
import { db } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, getDocFromServer, getDocsFromServer, getCountFromServer, updateDoc, arrayUnion, deleteDoc, setDoc, increment,
  query, where, writeBatch, waitForPendingWrites, documentId
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

let UID = null;
export const setUid = u => { UID = u; clearCache(); };
const col = n => collection(db, 'users', UID, n);
const ref = (n, id) => doc(db, 'users', UID, n, id);
const rows = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

// Sync indicator hook (set by app.js).
let syncHook = () => {};
export const setSyncHook = f => { syncHook = f; };

// Offline, a write's promise only settles once the server confirms it, but the local
// cache is already updated. So don't make the UI wait more than a few seconds.
export function soft(p) {
  syncHook('syncing');
  waitForPendingWrites(db).then(() => syncHook('idle')).catch(() => {});
  p.catch?.(() => {});
  clearCache(); Promise.resolve(p).then(clearCache, clearCache); // every write goes through here, so cached lists never go stale
  return Promise.race([p, new Promise(r => setTimeout(r, 5000))]);
}

// ---------- 60-second read cache ----------
// Caches list/count reads per signed-in user. Cleared by every write (see soft), on sign-in/out and when the connection returns.
// `gen` stops a read that started before a write from being cached after it. Values are cloned in and out, so callers can mutate freely.
const TTL = 60000;
const cache = new Map();
let gen = 0;
const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
export function clearCache() { gen++; cache.clear(); }
window.addEventListener('online', clearCache);
async function cached(key, fn, ok = () => true) {
  const k = UID + ':' + key, hit = cache.get(k);
  if (hit && Date.now() - hit.t < TTL) return clone(hit.v);
  const g = gen, v = await fn();
  if (g === gen && ok(v)) cache.set(k, { t: Date.now(), v: clone(v) });
  return v;
}

// ---------- count queries (server only, 1 read per 1000 matching entries) ----------
// Fails fast when offline and after 8 seconds, so screens never hang. Waits (max 3s) for our own writes to reach the server first.
export let lastIndexError = null; // set when a count needs a composite index that has not been created yet
const noteIndex = e => { if (e?.code === 'failed-precondition') { lastIndexError = e.message || String(e); console.error('Firestore index needed:', lastIndexError); } };
let settling = null;
const settled = () => settling ||= new Promise(res => {
  const t = setTimeout(res, 3000);
  waitForPendingWrites(db).then(() => { clearTimeout(t); res(); }, () => { clearTimeout(t); res(); });
}).finally(() => { settling = null; });
async function serverCount(q) {
  if (!navigator.onLine) throw Object.assign(new Error('offline'), { offline: true });
  await settled();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { offline: true })), 8000); });
  try { return (await Promise.race([getCountFromServer(q), timeout])).data().count; }
  finally { clearTimeout(timer); }
}
const countOrNull = q => serverCount(q).catch(e => { noteIndex(e); return null; });
const inCourse = (name, courseId, ...more) => query(col(name), where('courseId', '==', courseId), ...more);

// Counts for one course card on the Courses home. Any value is null if that count could not be read (offline): show no badge.
// dueAll = approved cards with dueAt <= now, newApproved = approved cards never rated. Needs ONE composite index (see README note):
// flashcards: courseId asc, status asc, srs.dueAt asc.
export const courseHomeCounts = (courseId, now = Date.now()) => cached('home:' + courseId, async () => {
  const chq = inCourse('chapters', courseId);
  const [chapters, pendQ, pendC, dueAll, newApproved] = await Promise.all([
    countOrNull(chq),
    countOrNull(inCourse('questions', courseId, where('status', '==', 'pending'))),
    countOrNull(inCourse('flashcards', courseId, where('status', '==', 'pending'))),
    countOrNull(inCourse('flashcards', courseId, where('status', '==', 'approved'), where('srs.dueAt', '<=', now))),
    countOrNull(inCourse('flashcards', courseId, where('status', '==', 'approved'), where('srs.lastResult', '==', null)))
  ]);
  let ch = chapters;
  if (ch == null) { try { ch = (await getDocs(chq)).size; } catch { ch = 0; } } // offline: count from the local cache (free)
  return { chapters: ch, pendQ, pendC, dueAll, newApproved };
}, v => [v.pendQ, v.pendC, v.dueAll, v.newApproved].every(x => x != null));

// How many cards were rated for the first time since `since` (start of today). Used for the daily new-card limit.
// Falls back to reading those few documents (from the cache when offline).
export const introducedSince = since => cached('intro:' + since, async () => {
  const q = query(col('flashcards'), where('srs.introducedAt', '>=', since));
  try { return await serverCount(q); } catch (e) { noteIndex(e); return (await getDocs(q)).size; }
});

export const pendingQuestionCounts = courseId => cached('pq:' + courseId, async () => {
  const f = type => serverCount(inCourse('questions', courseId, where('status', '==', 'pending'), where('type', '==', type)));
  try { const [mcq, theory] = await Promise.all([f('mcq'), f('theory')]); return { mcq, theory }; } catch { return null; }
}, v => v);
export const pendingCardCount = courseId => cached('pc:' + courseId, async () => {
  try { return await serverCount(inCourse('flashcards', courseId, where('status', '==', 'pending'))); } catch { return null; }
}, v => v != null);

// Per-chapter counts for the Course page: {chapterId: {mcq, theory, cards, pending}}. mcq/theory/cards are approved items.
// Pending counts are only asked per chapter when the course has any pending items at all. If a count fails, falls back to
// reading the course's documents (free from the cache when offline) and gives exactly the same numbers.
export const chapterCounts = (courseId, chapterIds) => cached('cc:' + courseId, async () => {
  const out = Object.fromEntries(chapterIds.map(id => [id, { mcq: 0, theory: 0, cards: 0, pending: 0 }]));
  try {
    const q = (id, ...c) => serverCount(query(col('questions'), where('chapterId', '==', id), ...c));
    const f = (id, ...c) => serverCount(query(col('flashcards'), where('chapterId', '==', id), ...c));
    const [pq, pc] = await Promise.all([
      serverCount(inCourse('questions', courseId, where('status', '==', 'pending'))),
      serverCount(inCourse('flashcards', courseId, where('status', '==', 'pending')))
    ]);
    await Promise.all(chapterIds.map(async id => {
      const [mcq, theory, cards, p1, p2] = await Promise.all([
        q(id, where('type', '==', 'mcq'), where('status', '==', 'approved')),
        q(id, where('type', '==', 'theory'), where('status', '==', 'approved')),
        f(id, where('status', '==', 'approved')),
        pq ? q(id, where('status', '==', 'pending')) : 0,
        pc ? f(id, where('status', '==', 'pending')) : 0
      ]);
      out[id] = { mcq, theory, cards, pending: p1 + p2 };
    }));
    return out;
  } catch (e) {
    noteIndex(e);
    const [qs, cards] = await Promise.all([listQuestions(courseId), listCards(courseId)]);
    for (const id of chapterIds) out[id] = { mcq: 0, theory: 0, cards: 0, pending: 0 };
    qs.forEach(x => { const s = out[x.chapterId]; if (s) { if (x.status === 'pending') s.pending++; else s[x.type]++; } });
    cards.forEach(x => { const s = out[x.chapterId]; if (s) { if (x.status === 'pending') s.pending++; else s.cards++; } });
    return out;
  }
});

// ---------- text + ids ----------
export const norm = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// New chapters get a deterministic id so duplicate checks work before the chapter exists.
export const chapterIdFor = async (courseId, key) => (await sha256(courseId + '|' + key)).slice(0, 20);

// ---------- courses ----------
export const listCourses = () => cached('courses', async () => rows(await getDocs(col('courses'))).sort((a, b) => a.createdAt - b.createdAt));
export const getCourse = async id => { const s = await getDoc(ref('courses', id)); return s.exists() ? { id: s.id, ...s.data() } : null; };
export const addCourse = (name, code) => soft(setDoc(doc(col('courses')), { name, code, createdAt: Date.now() }));
export const renameCourse = (id, name, code) => soft(updateDoc(ref('courses', id), { name, code }));

// ---------- chapters ----------
export const listChapters = courseId => cached('chapters:' + courseId, async () =>
  rows(await getDocs(query(col('chapters'), where('courseId', '==', courseId)))).sort((a, b) => a.order - b.order));
export const listAllChapters = async () => rows(await getDocs(col('chapters')));
export const getChapter = async id => { const s = await getDoc(ref('chapters', id)); return s.exists() ? { id: s.id, ...s.data() } : null; };
export const updateChapter = (id, data) => soft(updateDoc(ref('chapters', id), { ...data, updatedAt: Date.now() }));

// ---------- questions + flashcards ----------
export const listQuestions = courseId => cached('q:' + courseId, async () => rows(await getDocs(query(col('questions'), where('courseId', '==', courseId)))));
export const listCards = courseId => cached('c:' + courseId, async () => rows(await getDocs(query(col('flashcards'), where('courseId', '==', courseId)))));
// approved items of ONE course (tests and stats never need pending ones)
export const listApprovedQuestions = courseId => cached('aq:' + courseId, async () =>
  rows(await getDocs(query(col('questions'), where('courseId', '==', courseId), where('status', '==', 'approved')))));
export const listApprovedCardsOf = courseId => cached('ac:' + courseId, async () =>
  rows(await getDocs(query(col('flashcards'), where('courseId', '==', courseId), where('status', '==', 'approved')))));

// every approved flashcard across all courses (the daily new-card limit is counted across everything)
export const listApprovedCards = async () => rows(await getDocs(query(col('flashcards'), where('status', '==', 'approved'))));
// srs: {box, dueAt, lastResult, introducedAt}. Dotted paths so only the srs fields change.
export const reviewCard = (id, srs) => soft(updateDoc(ref('flashcards', id), {
  'srs.box': srs.box, 'srs.dueAt': srs.dueAt, 'srs.lastResult': srs.lastResult, 'srs.introducedAt': srs.introducedAt
}));

export async function listPending(chapterId) {
  const f = n => getDocs(query(col(n), where('chapterId', '==', chapterId), where('status', '==', 'pending')));
  const [q, c] = await Promise.all([f('questions'), f('flashcards')]);
  return { questions: rows(q), cards: rows(c) };
}
export async function listPendingAll() {
  const f = n => getDocs(query(col(n), where('status', '==', 'pending')));
  const [q, c] = await Promise.all([f('questions'), f('flashcards')]);
  return { questions: rows(q), cards: rows(c) };
}
// aliasId (optional): after a text edit (q / front), the hash of the NEW wording. It is added to aliasIds so that importing the
// edited wording again is still recognised as a duplicate (the original wording is covered by the document id itself).
export const updateItem = (kind, id, data, aliasId = null) =>
  soft(updateDoc(ref(kind, id), aliasId ? { ...data, aliasIds: arrayUnion(aliasId) } : data));
export const deleteItem = (kind, id) => soft(deleteDoc(ref(kind, id)));

// items: [{kind:'questions'|'flashcards', id}]
export async function setStatus(items, status) {
  const jobs = [];
  for (let i = 0; i < items.length; i += 450) {
    const b = writeBatch(db);
    items.slice(i, i + 450).forEach(x => b.update(ref(x.kind, x.id), { status }));
    jobs.push(b.commit());
  }
  await soft(Promise.all(jobs));
}

// An id counts as existing if it is a document id OR is listed in some document's aliasIds (the hash of a wording that
// document was edited to). Ids are hashes that include the chapter id, so an alias can only match within the same chapter.
const addAliasHits = (snaps, ids, found) => {
  const want = new Set(ids);
  snaps.forEach(s => s.forEach(d => (d.data().aliasIds || []).forEach(a => want.has(a) && found.add(a))));
};

// Which of these ids already exist? ('in' and 'array-contains-any' queries take at most 30 values.)
export async function existingIds(name, ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const [byId, byAlias] = await Promise.all([
    Promise.all(chunks.map(c => getDocs(query(col(name), where(documentId(), 'in', c))))),
    Promise.all(chunks.map(c => getDocs(query(col(name), where('aliasIds', 'array-contains-any', c)))))
  ]);
  const found = new Set();
  byId.forEach(s => s.forEach(d => found.add(d.id)));
  addAliasHits(byAlias, ids, found);
  return found;
}

// Which of these ids exist on the SERVER right now? Never reads the local cache.
// If the server cannot be reached, throws an error with .offline = true (so the caller saves nothing).
const offlineError = () => Object.assign(new Error('Could not reach the server, so nothing was saved. Connect to the internet and try again.'), { offline: true });
async function existingIdsServer(name, ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 20000); });
  try {
    const [byId, byAlias] = await Promise.race([
      Promise.all([
        Promise.all(chunks.map(c => getDocsFromServer(query(col(name), where(documentId(), 'in', c))))),
        Promise.all(chunks.map(c => getDocsFromServer(query(col(name), where('aliasIds', 'array-contains-any', c)))))
      ]),
      timeout
    ]);
    const found = new Set();
    byId.forEach(s => s.forEach(d => found.add(d.id)));
    addAliasHits(byAlias, ids, found);
    return found;
  } catch (e) {
    if (e?.code === 'permission-denied') throw e;
    throw offlineError();
  } finally { clearTimeout(timer); }
}

// Writes the chapter doc (merge) plus only the items that do NOT already exist on the server, 450 per batch
// (limit is 500). Existing questions/cards are never overwritten, so their stats, srs and status are kept.
// Checks everything before the first write: if the server cannot be reached, nothing is saved.
// Returns { written: [items actually saved], skipped: number }.
export async function saveImport(chapterId, chapterData, items) {
  if (!navigator.onLine) throw offlineError();
  const [q, f] = await Promise.all(['questions', 'flashcards'].map(n => existingIdsServer(n, items.filter(i => i.col === n).map(i => i.id))));
  const have = { questions: q, flashcards: f };
  const fresh = items.filter(i => !have[i.col].has(i.id));
  const writes = [[ref('chapters', chapterId), chapterData, true], ...fresh.map(i => [ref(i.col, i.id), i.data, false])];
  const jobs = [];
  for (let i = 0; i < writes.length; i += 450) {
    const b = writeBatch(db);
    writes.slice(i, i + 450).forEach(([r, d, merge]) => merge ? b.set(r, d, { merge: true }) : b.set(r, d));
    jobs.push(b.commit());
  }
  await soft(Promise.all(jobs));
  return { written: fresh, skipped: items.length - fresh.length };
}

// ---------- tests ----------
// A question can disappear while a test is running (its chapter was deleted, maybe on another device). Saving stats for it then
// fails with "not-found". That is harmless, so it is logged to the console only and the test carries on.
// Any other error is passed on, so the caller still shows it.
const ignoreMissing = p => p.catch(e => {
  if (e?.code === 'not-found') { console.warn('Stats not saved: that question no longer exists.', e.message); return; }
  throw e;
});

// seen+1, correct+1 if right, streak+1 if right else 0, lastResult, lastSeenAt.
// increment() is applied on the server side, so it stays correct even if the local copy is stale or offline.
export const recordAnswer = (id, right) => soft(ignoreMissing(updateDoc(ref('questions', id), {
  'stats.seen': increment(1),
  'stats.correct': increment(right ? 1 : 0),
  'stats.streak': right ? increment(1) : 0,
  'stats.lastResult': right ? 'right' : 'wrong',
  'stats.lastSeenAt': Date.now()
})));
// Theory self-rating. missed: streak = 0. partial: streak unchanged (not mastered, so correct is not bumped either). got: streak + 1.
// seen+1 for all three. lastResult is 'wrong' | 'partial' | 'right'.
export const recordTheory = (id, rating) => soft(ignoreMissing(updateDoc(ref('questions', id), {
  'stats.seen': increment(1),
  ...(rating === 'got' ? { 'stats.correct': increment(1), 'stats.streak': increment(1) } : {}),
  ...(rating === 'missed' ? { 'stats.streak': 0 } : {}),
  'stats.lastResult': rating === 'got' ? 'right' : rating === 'partial' ? 'partial' : 'wrong',
  'stats.lastSeenAt': Date.now()
})));
// newest first
export const listAttempts = courseId => cached('att:' + courseId, async () =>
  rows(await getDocs(query(col('attempts'), where('courseId', '==', courseId)))).sort((a, b) => (b.date || 0) - (a.date || 0)));
// attempt: {courseId, chapterIds[], type, date, score, total, results[{questionId, correct, chosenIndex}]}
// (theory attempts store results[{questionId, correct, rating}] instead of chosenIndex)
export const saveAttempt = a => soft(setDoc(doc(col('attempts')), a));

// ---------- to-do + journal (independent of courses, so nothing to cascade) ----------
// add* return the new id straight away (for instant UI) plus a promise that settles when the write is done.
const addTo = (name, data) => { const r = doc(col(name)); return { id: r.id, done: soft(setDoc(r, data)) }; };
export const listTodos = async () => rows(await getDocs(col('todos')));
export const addTodo = data => addTo('todos', data);
export const updateTodo = (id, data) => soft(updateDoc(ref('todos', id), data));
export const deleteTodo = id => soft(deleteDoc(ref('todos', id)));
export async function deleteTodos(ids) {
  const jobs = [];
  for (let i = 0; i < ids.length; i += 450) {
    const b = writeBatch(db);
    ids.slice(i, i + 450).forEach(id => b.delete(ref('todos', id)));
    jobs.push(b.commit());
  }
  await soft(Promise.all(jobs));
}
export const listJournal = async () => rows(await getDocs(col('journal')));
export const addJournal = data => addTo('journal', data);
export const updateJournal = (id, data) => soft(updateDoc(ref('journal', id), { ...data, updatedAt: Date.now() }));
export const deleteJournal = id => soft(deleteDoc(ref('journal', id)));

// ---------- download for offline ----------
// Reads from the SERVER (getDocsFromServer), which also writes every document into Firestore's persistent cache,
// so the course can then be opened, tested and revised with no connection. Costs one read per document downloaded.
async function serverFetch(make, verb = 'download') {
  const offline = () => Object.assign(new Error(`Connect to the internet to ${verb}.`), { offline: true });
  if (!navigator.onLine) throw offline();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`The ${verb} timed out. Check your connection and try again.`), { offline: true })), 30000); });
  try { return await Promise.race([make(), timeout]); }
  catch (e) { throw e.code === 'unavailable' ? offline() : e; }
  finally { clearTimeout(timer); }
}

// One course: its chapters, questions, flashcards and attempts. onStep(n) is called after each of the 4 collections (n = 0..4).
// Returns the counts. withDoc = false skips re-reading the course document (downloadAll already fetched it).
export async function downloadCourse(courseId, onStep = () => {}, withDoc = true) {
  const got = { chapters: 0, questions: 0, cards: 0, attempts: 0 };
  let n = 0;
  onStep(0);
  if (withDoc) await serverFetch(() => getDocFromServer(ref('courses', courseId)));
  await Promise.all([['chapters', 'chapters'], ['questions', 'questions'], ['flashcards', 'cards'], ['attempts', 'attempts']].map(async ([name, key]) => {
    const snap = await serverFetch(() => getDocsFromServer(inCourse(name, courseId)));
    got[key] = snap.size;
    onStep(++n);
  }));
  return got;
}

// Every course, one after the other. onProgress(done, total, courseName).
export async function downloadAll(onProgress = () => {}) {
  const snap = await serverFetch(() => getDocsFromServer(col('courses')));
  const courses = snap.docs.map(d => ({ id: d.id, name: d.data().name || '' }));
  const sum = { courses: courses.length, chapters: 0, questions: 0, cards: 0, attempts: 0 };
  const total = courses.length * 4;
  for (let i = 0; i < courses.length; i++) {
    const got = await downloadCourse(courses[i].id, n => onProgress(i * 4 + n, total, courses[i].name), false);
    for (const k of ['chapters', 'questions', 'cards', 'attempts']) sum[k] += got[k];
  }
  onProgress(total, total, '');
  return sum;
}

// ---------- backup: export and restore ----------
const BACKUP_COLLECTIONS = ['courses', 'chapters', 'questions', 'flashcards', 'attempts', 'todos', 'journal'];
const BACKUP_APP = 'study-app-backup';

// When did this account last export? Kept in localStorage under a key that includes the uid, so another account on the same
// browser never sees it. A reminder is due if there was never an export or the last one is over 30 days old.
const exportKey = () => 'lastExport:' + UID;
export const lastExportAt = () => { try { return Number(localStorage.getItem(exportKey())) || null; } catch { return null; } };
export const markExported = () => { try { localStorage.setItem(exportKey(), String(Date.now())); } catch { /* ignore */ } };
export const exportOverdue = (days = 30) => { const t = lastExportAt(); return !t || Date.now() - t > days * 86400000; };

// Every document of every collection, read from the SERVER (an offline cache could be incomplete). Costs one read per document.
// Format: { app, version, exportedAt, data: { courses: [{ id, data }], chapters: [...], ... } }
export async function exportAll(onStep = () => {}) {
  const data = Object.fromEntries(BACKUP_COLLECTIONS.map(n => [n, []]));
  let n = 0;
  await Promise.all(BACKUP_COLLECTIONS.map(async name => {
    const snap = await serverFetch(() => getDocsFromServer(col(name)), 'export');
    data[name] = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    onStep(++n, BACKUP_COLLECTIONS.length);
  }));
  return { app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString(), data };
}

// Plain-English check of a parsed backup file. Returns { error } or { counts }.
export function checkBackup(b) {
  if (!b || typeof b !== 'object' || b.app !== BACKUP_APP || !b.data || typeof b.data !== 'object') return { error: 'This is not a backup file made by this app.' };
  if (b.version !== 1) return { error: `This backup is version ${b.version}, which this app cannot read.` };
  const counts = {};
  for (const name of BACKUP_COLLECTIONS) {
    const list = b.data[name] ?? [];
    if (!Array.isArray(list)) return { error: `The "${name}" part of this backup is damaged.` };
    for (const [i, d] of list.entries()) {
      const idOk = d && typeof d.id === 'string' && d.id && !d.id.includes('/') && d.id !== '.' && d.id !== '..' && !/^__.*__$/.test(d.id);
      if (!idOk || !d.data || typeof d.data !== 'object' || Array.isArray(d.data)) return { error: `Item ${i + 1} in "${name}" is damaged (it needs an id and its data).` };
    }
    counts[name] = list.length;
  }
  return { counts };
}

// Which of these document ids exist on the server right now (plain ids only, aliases do not matter here)?
async function docIdsOnServer(name, ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const snaps = await Promise.all(chunks.map(c => serverFetch(() => getDocsFromServer(query(col(name), where(documentId(), 'in', c))), 'restore')));
  const found = new Set();
  snaps.forEach(s => s.forEach(d => found.add(d.id)));
  return found;
}

// What a restore would do: how many documents the backup has per collection and how many of them already exist.
export async function previewBackup(b) {
  const counts = {}, existing = {};
  for (const name of BACKUP_COLLECTIONS) {
    const list = b.data[name] || [];
    counts[name] = list.length;
    existing[name] = (await docIdsOnServer(name, list.map(d => d.id))).size;
  }
  return { counts, existing };
}

// Writes the backup back with the same document ids, 450 per batch (limit is 500). Existing documents are left alone unless
// overwrite is true, in which case they are replaced by the backup version. Everything is checked against the server BEFORE the
// first write, so if the server cannot be reached nothing is written. Returns { restored, skipped, overwritten }.
export async function restoreBackup(b, { overwrite = false } = {}, onProgress = () => {}) {
  const chk = checkBackup(b);
  if (chk.error) throw new Error(chk.error);
  const writes = [], result = { restored: 0, skipped: 0, overwritten: 0 };
  for (const name of BACKUP_COLLECTIONS) {
    const list = b.data[name] || [];
    const have = await docIdsOnServer(name, list.map(d => d.id));
    for (const d of list) {
      if (have.has(d.id)) { if (overwrite) { writes.push([ref(name, d.id), d.data]); result.overwritten++; } else result.skipped++; }
      else { writes.push([ref(name, d.id), d.data]); result.restored++; }
    }
  }
  clearCache();
  onProgress(0, writes.length);
  for (let i = 0; i < writes.length; i += 450) {
    const batch = writeBatch(db);
    writes.slice(i, i + 450).forEach(([r, data]) => batch.set(r, data)); // whole document, exactly as backed up
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('The restore timed out. Check your connection, then run it again: documents that already exist are skipped.')), 60000); });
    try { await Promise.race([batch.commit(), timeout]); } finally { clearTimeout(timer); }
    onProgress(Math.min(i + 450, writes.length), writes.length);
  }
  clearCache();
  return result;
}

// ---------- cascade deletes (Firestore does not do this for us) ----------
async function deleteWhere(name, field, value) {
  const snap = await getDocs(query(col(name), where(field, '==', value)));
  const refs = snap.docs.map(d => d.ref);
  const jobs = [];
  for (let i = 0; i < refs.length; i += 500) {
    const b = writeBatch(db);
    refs.slice(i, i + 500).forEach(r => b.delete(r));
    jobs.push(b.commit());
  }
  await soft(Promise.all(jobs));
}
export async function deleteChapter(id) {
  await Promise.all([deleteWhere('questions', 'chapterId', id), deleteWhere('flashcards', 'chapterId', id)]);
  await soft(deleteDoc(ref('chapters', id)));
}
export async function deleteCourse(id) {
  await Promise.all(['questions', 'flashcards', 'chapters', 'attempts'].map(n => deleteWhere(n, 'courseId', id)));
  await soft(deleteDoc(ref('courses', id)));
}
