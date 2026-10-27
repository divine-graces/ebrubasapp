// db.js: all Firestore access. Everything lives under users/{uid}/.
import { db } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, updateDoc, deleteDoc, setDoc, increment,
  query, where, writeBatch, waitForPendingWrites, documentId
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

let UID = null;
export const setUid = u => { UID = u; };
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
  return Promise.race([p, new Promise(r => setTimeout(r, 5000))]);
}

// ---------- text + ids ----------
export const norm = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// New chapters get a deterministic id so duplicate checks work before the chapter exists.
export const chapterIdFor = async (courseId, key) => (await sha256(courseId + '|' + key)).slice(0, 20);

// ---------- courses ----------
export const listCourses = async () => rows(await getDocs(col('courses'))).sort((a, b) => a.createdAt - b.createdAt);
export const getCourse = async id => { const s = await getDoc(ref('courses', id)); return s.exists() ? { id: s.id, ...s.data() } : null; };
export const addCourse = (name, code) => soft(setDoc(doc(col('courses')), { name, code, createdAt: Date.now() }));
export const renameCourse = (id, name, code) => soft(updateDoc(ref('courses', id), { name, code }));

// ---------- chapters ----------
export const listChapters = async courseId =>
  rows(await getDocs(query(col('chapters'), where('courseId', '==', courseId)))).sort((a, b) => a.order - b.order);
export const listAllChapters = async () => rows(await getDocs(col('chapters')));
export const getChapter = async id => { const s = await getDoc(ref('chapters', id)); return s.exists() ? { id: s.id, ...s.data() } : null; };
export const updateChapter = (id, data) => soft(updateDoc(ref('chapters', id), { ...data, updatedAt: Date.now() }));

// ---------- questions + flashcards ----------
export const listQuestions = async courseId => rows(await getDocs(query(col('questions'), where('courseId', '==', courseId))));
export const listCards = async courseId => rows(await getDocs(query(col('flashcards'), where('courseId', '==', courseId))));

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
export const updateItem = (kind, id, data) => soft(updateDoc(ref(kind, id), data));
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

// Which of these ids already exist? ('in' queries take at most 30 values.)
export async function existingIds(name, ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
  const snaps = await Promise.all(chunks.map(c => getDocs(query(col(name), where(documentId(), 'in', c)))));
  const found = new Set();
  snaps.forEach(s => s.forEach(d => found.add(d.id)));
  return found;
}

// writes the chapter doc (merge) plus all new items, 450 per batch (limit is 500)
export async function saveImport(chapterId, chapterData, items) {
  const writes = [[ref('chapters', chapterId), chapterData], ...items.map(i => [ref(i.col, i.id), i.data])];
  const jobs = [];
  for (let i = 0; i < writes.length; i += 450) {
    const b = writeBatch(db);
    writes.slice(i, i + 450).forEach(([r, d]) => b.set(r, d, { merge: true }));
    jobs.push(b.commit());
  }
  await soft(Promise.all(jobs));
}

// ---------- tests ----------
// seen+1, correct+1 if right, streak+1 if right else 0, lastResult, lastSeenAt.
// increment() is applied on the server side, so it stays correct even if the local copy is stale or offline.
export const recordAnswer = (id, right) => soft(updateDoc(ref('questions', id), {
  'stats.seen': increment(1),
  'stats.correct': increment(right ? 1 : 0),
  'stats.streak': right ? increment(1) : 0,
  'stats.lastResult': right ? 'right' : 'wrong',
  'stats.lastSeenAt': Date.now()
}));
// Theory self-rating. missed: streak = 0. partial: streak unchanged (not mastered, so correct is not bumped either). got: streak + 1.
// seen+1 for all three. lastResult is 'wrong' | 'partial' | 'right'.
export const recordTheory = (id, rating) => soft(updateDoc(ref('questions', id), {
  'stats.seen': increment(1),
  ...(rating === 'got' ? { 'stats.correct': increment(1), 'stats.streak': increment(1) } : {}),
  ...(rating === 'missed' ? { 'stats.streak': 0 } : {}),
  'stats.lastResult': rating === 'got' ? 'right' : rating === 'partial' ? 'partial' : 'wrong',
  'stats.lastSeenAt': Date.now()
}));
// attempt: {courseId, chapterIds[], type, date, score, total, results[{questionId, correct, chosenIndex}]}
// (theory attempts store results[{questionId, correct, rating}] instead of chosenIndex)
export const saveAttempt = a => soft(setDoc(doc(col('attempts')), a));

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
