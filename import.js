// import.js: paste JSON, validate, preview, skip duplicates, save.
import { h, topbar, toast, loading } from './ui.js';
import * as db from './db.js';

const stats0 = () => ({ seen: 0, correct: 0, streak: 0, lastResult: null, lastSeenAt: null });

// ---------- parsing + validation ----------
function locate(raw, pos) {
  const line = raw.slice(0, pos).split('\n').length;
  const col = pos - raw.lastIndexOf('\n', pos - 1);
  const near = raw.slice(Math.max(0, pos - 20), pos + 20).replace(/\s+/g, ' ');
  return { line, col, near };
}

// Single backslashes in LaTeX. Some (\frac, \theta, \beta, \rho, \neq...) are VALID JSON escapes
// and would parse "fine" into a form feed or tab, silently corrupting the maths. So scan the raw text.
function badBackslashes(t) {
  const hits = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '\\') continue;
    const n = t[i + 1], rest = t.slice(i + 1, i + 14);
    if (n === '\\' || n === '"' || n === '/') { i++; continue; }
    if (n === 'u' && /^u[0-9a-fA-F]{4}/.test(rest)) { i += 5; continue; }
    const latexLike = /^[bfrt][a-z]/.test(rest) || /^n(eq|abla|otin|ot|u|e|i|ewline)(?![a-z])/.test(rest);
    if ('bfnrt'.includes(n) && !latexLike) { i++; continue; } // a genuine \n, \t etc.
    hits.push({ i, word: (/^[A-Za-z]+/.exec(rest) || [n])[0] });
  }
  return hits;
}

export function parseImport(raw) {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end < start) return { errors: ['I cannot find any JSON. It should start with { and end with }.'] };
  const text = raw.slice(start, end + 1); // drops code fences and any chatter around the JSON

  const bad = badBackslashes(text);
  if (bad.length) {
    const { line, col } = locate(raw, start + bad[0].i), w = bad[0].word;
    return { errors: [`Line ${line}, column ${col}: single backslash before "${w}". In JSON every LaTeX backslash must be doubled: write \\\\${w} instead of \\${w}. ${bad.length > 1 ? `Found ${bad.length} places like this. ` : ''}Ask Claude to re-send the JSON with doubled backslashes.`] };
  }

  let data;
  try { data = JSON.parse(text); }
  catch (e) {
    const m = e.message;
    const p = /position (\d+)/.exec(m), lc = /line (\d+) column (\d+)/.exec(m);
    let pos = null;
    if (p) pos = +p[1];
    else if (lc) pos = text.split('\n').slice(0, lc[1] - 1).reduce((n, l) => n + l.length + 1, 0) + (+lc[2] - 1);
    if (pos === null) return { errors: [`The JSON is not valid, and I cannot tell where. Typical causes: a missing or extra comma, a missing quote, or a reply that was cut off. (${m})`] };
    const { line, col, near } = locate(raw, start + Math.min(pos, text.length));
    const hint = /[“”‘’]/.test(text[pos] || '') ? 'This looks like a curly quote; only straight quotes are allowed. '
      : pos >= text.length - 2 ? 'The text looks cut off at the end; ask Claude to send the next part. '
      : 'Typical causes: a missing or extra comma, a missing quote, or a " inside text that should be written \\". ';
    return { errors: [`Line ${line}, column ${col}: the JSON breaks here, near "${near}". ${hint}`] };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) return { errors: ['The JSON must be one object { ... }.'] };
  const errs = [];
  const str = v => typeof v === 'string' && v.trim() !== '';
  const lbl = (p, i, q) => `${p} #${i + 1}${str(q) ? ` ("${q.trim().slice(0, 35)}")` : ''}`;
  const list = k => data[k] === undefined ? [] : Array.isArray(data[k]) ? data[k] : (errs.push(`"${k}" must be a list [ ... ].`), []);

  if (data.schemaVersion !== 1) errs.push('"schemaVersion" must be 1.');
  if (!str(data.chapter)) errs.push('"chapter" is missing. Add the chapter name.');
  if (data.note !== undefined) {
    if (!(data.note && str(data.note.body))) errs.push('"note" must look like {"body": "..."} with some text.');
    else if (data.note.body.length > 900000) errs.push('The note is too long for one chapter. Split it into parts.');
  }
  const mcq = list('mcq'), theory = list('theory'), cards = list('flashcards');
  mcq.forEach((m, i) => {
    const l = lbl('MCQ', i, m?.q);
    if (!str(m?.q)) errs.push(`${l}: "q" is missing.`);
    if (!Array.isArray(m?.options) || m.options.length !== 4) errs.push(`${l}: needs exactly 4 options (found ${Array.isArray(m?.options) ? m.options.length : 'none'}).`);
    else if (!m.options.every(str)) errs.push(`${l}: every option needs text.`);
    if (!Number.isInteger(m?.answer) || m.answer < 0 || m.answer > 3) errs.push(`${l}: "answer" must be a whole number from 0 to 3 (found ${JSON.stringify(m?.answer)}). 0 is the first option.`);
  });
  theory.forEach((t, i) => {
    const l = lbl('Theory', i, t?.q);
    if (!str(t?.q)) errs.push(`${l}: "q" is missing.`);
    if (!str(t?.modelAnswer)) errs.push(`${l}: "modelAnswer" is missing.`);
    if (!Array.isArray(t?.keyPoints) || !t.keyPoints.length || !t.keyPoints.every(str)) errs.push(`${l}: "keyPoints" must be a list with at least one point.`);
  });
  cards.forEach((c, i) => {
    const l = lbl('Flashcard', i, c?.front);
    if (!str(c?.front)) errs.push(`${l}: "front" is missing.`);
    if (!str(c?.back)) errs.push(`${l}: "back" is missing.`);
  });
  if (!errs.length && !data.note && !mcq.length && !theory.length && !cards.length) errs.push('Nothing to import: the file has no note, mcq, theory or flashcards.');
  if (errs.length) return { errors: errs.slice(0, 12).concat(errs.length > 12 ? [`…and ${errs.length - 12} more.`] : []) };
  return { data: { chapter: data.chapter.trim(), note: data.note, mcq, theory, cards } };
}

// ---------- screen ----------
export async function importScreen() {
  const courses = await db.listCourses();
  if (!courses.length) return h('div', {}, topbar('Import'), h('div', { class: 'empty' }, 'Create a course first, then come back to import.', h('br'), h('a', { href: '#/' }, 'Go to Courses')));

  let chapters = [], prev = null, touched = false, mode = 'append';
  const pre = sessionStorage.getItem('importCourse'); sessionStorage.removeItem('importCourse');

  const out = h('div');
  const invalidate = () => { prev = null; out.replaceChildren(); };
  const showErr = list => out.replaceChildren(h('div', { class: 'card' }, h('b', {}, 'Cannot import yet'), list.map(e => h('p', { class: 'err' }, e))));

  const courseSel = h('select', {}, h('option', { value: '' }, 'Choose a course…'), courses.map(c => h('option', { value: c.id }, c.name + (c.code ? ` (${c.code})` : ''))));
  const chapSel = h('select');
  const newName = h('input', { type: 'text', placeholder: 'New chapter name' });
  const paste = h('textarea', { rows: 9, class: 'mono', placeholder: 'Paste the JSON from Claude here' });
  const verified = h('input', { type: 'checkbox' });
  const previewBtn = h('button', { class: 'btn primary block' }, 'Preview');

  const fillChaps = sel => {
    chapSel.replaceChildren(h('option', { value: '__new' }, 'New chapter'), chapters.map(c => h('option', { value: c.id }, c.name)));
    chapSel.value = sel || '__new';
    newName.hidden = chapSel.value !== '__new';
  };
  const loadChaps = async () => { chapters = courseSel.value ? await db.listChapters(courseSel.value) : []; fillChaps(); };

  courseSel.onchange = async () => { touched = false; invalidate(); await loadChaps(); };
  chapSel.onchange = () => { touched = true; newName.hidden = chapSel.value !== '__new'; invalidate(); };
  newName.oninput = () => { touched = true; invalidate(); };
  paste.oninput = () => { touched = false; invalidate(); };

  const segBtns = ['append', 'replace'].map(m => h('button', {
    type: 'button', class: 'btn' + (m === mode ? ' primary' : ''),
    onclick: () => { mode = m; segBtns.forEach((b, i) => b.classList.toggle('primary', ['append', 'replace'][i] === mode)); invalidate(); }
  }, m === 'append' ? 'Append note' : 'Replace note'));

  if (pre && courses.some(c => c.id === pre)) { courseSel.value = pre; await loadChaps(); } else fillChaps();

  const clip = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { paste.value = await navigator.clipboard.readText(); paste.oninput(); } catch { toast('Clipboard blocked. Long-press the box and paste instead.'); }
  } }, 'Paste from clipboard');

  previewBtn.onclick = async () => {
    try {
      previewBtn.disabled = true; out.replaceChildren(loading());
      if (!courseSel.value) return showErr(['Pick a course first.']);
      if (!paste.value.trim()) return showErr(['Paste the JSON first.']);
      const r = parseImport(paste.value);
      if (r.errors) return showErr(r.errors);
      const d = r.data, courseId = courseSel.value;

      if (!touched) { // pre-fill chapter from the JSON, matching by nameKey
        const m = chapters.find(c => c.nameKey === db.norm(d.chapter));
        fillChaps(m ? m.id : '__new');
        if (!m) newName.value = d.chapter;
      }
      let existing = null, name, key;
      if (chapSel.value !== '__new') { existing = chapters.find(c => c.id === chapSel.value); name = existing.name; key = existing.nameKey; }
      else {
        name = newName.value.trim();
        if (!name) return showErr(['Type a name for the new chapter.']);
        key = db.norm(name);
        existing = chapters.find(c => c.nameKey === key) || null;
        if (existing) { fillChaps(existing.id); name = existing.name; }
      }
      const chapterId = existing ? existing.id : await db.chapterIdFor(courseId, key);

      // build items, skipping duplicates inside the file and against what is already saved
      const items = [], seen = new Set(); let dupes = 0;
      const add = async (c, text, data) => {
        const id = await db.sha256(chapterId + '|' + db.norm(text));
        if (seen.has(c + id)) { dupes++; return; }
        seen.add(c + id); items.push({ col: c, id, data });
      };
      const base = { courseId, chapterId };
      for (const m of d.mcq) await add('questions', m.q, { ...base, type: 'mcq', q: m.q.trim(), options: m.options, answer: m.answer, explanation: m.explanation || '', stats: stats0() });
      for (const t of d.theory) await add('questions', t.q, { ...base, type: 'theory', q: t.q.trim(), modelAnswer: t.modelAnswer, keyPoints: t.keyPoints, explanation: '', stats: stats0() });
      for (const f of d.cards) await add('flashcards', f.front, { ...base, front: f.front.trim(), back: f.back, srs: { box: 1, dueAt: 0, lastResult: null } });
      const found = await Promise.all(['questions', 'flashcards'].map(c => db.existingIds(c, items.filter(i => i.col === c).map(i => i.id))));
      const have = { questions: found[0], flashcards: found[1] };
      const fresh = items.filter(i => !have[i.col].has(i.id));
      dupes += items.length - fresh.length;

      let noteBody = null;
      if (d.note) {
        const body = d.note.body, old = existing?.noteBody || '';
        if (mode === 'replace' || !old.trim()) noteBody = body;
        else if (old.includes(body.trim())) dupes++; // same note imported twice
        else noteBody = old.trimEnd() + '\n\n' + body;
        if (noteBody && noteBody.length > 900000) return showErr(['The combined note would be too large for one chapter. Import it as a separate chapter part.']);
      }

      prev = { courseId, chapterId, existing, name, key, noteBody, items: fresh, order: chapters.length };
      const n = t => fresh.filter(i => i.data.type === t).length;
      const parts = [];
      if (noteBody != null) parts.push('1 note');
      if (n('mcq')) parts.push(`${n('mcq')} MCQs`);
      if (n('theory')) parts.push(`${n('theory')} theory`);
      const nc = fresh.filter(i => i.col === 'flashcards').length;
      if (nc) parts.push(`${nc} cards`);
      if (dupes) parts.push(`${dupes} duplicate${dupes > 1 ? 's' : ''} skipped`);

      const status = h('p', { class: 'muted' });
      const upd = () => { status.textContent = 'Saving as: ' + (verified.checked ? 'approved (verified)' : 'pending'); };
      verified.onchange = upd; upd();
      const nothing = noteBody == null && !fresh.length;
      const saveBtn = h('button', { class: 'btn primary block', onclick: save }, 'Save');
      out.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'muted small' }, `Chapter: ${name} (${existing ? 'existing' : 'new'})`),
        h('p', { class: 'title' }, nothing ? 'Nothing new to save. ' + parts.join(', ') : parts.join(', ')),
        nothing ? null : [status, saveBtn]));
    } catch (e) { console.error(e); showErr(['Something went wrong: ' + (e.message || e)]); }
    finally { previewBtn.disabled = false; }
  };

  async function save(ev) {
    if (!prev) return;
    const btn = ev.currentTarget; btn.disabled = true;
    try {
      const p = prev, now = Date.now(), status = verified.checked ? 'approved' : 'pending';
      const docs = p.items.map(i => ({ ...i, data: { ...i.data, status, createdAt: now, ...(i.col === 'flashcards' ? { srs: { ...i.data.srs, dueAt: now } } : {}) } }));
      const chapterData = p.existing
        ? { updatedAt: now, ...(p.noteBody != null ? { noteBody: p.noteBody } : {}) }
        : { courseId: p.courseId, name: p.name, nameKey: p.key, order: p.order, noteBody: p.noteBody ?? '', createdAt: now, updatedAt: now };
      await db.saveImport(p.chapterId, chapterData, docs);

      paste.value = ''; verified.checked = false; touched = false; prev = null; // the verified box never carries over
      await loadChaps();
      out.replaceChildren(h('div', { class: 'card' },
        h('p', { class: 'ok title' }, `Saved to ${p.name} as ${status}.`),
        h('div', { class: 'row' },
          docs.length && status === 'pending' ? h('a', { class: 'btn primary', href: '#/review/' + p.chapterId }, `Review ${docs.length}`) : null,
          h('a', { class: 'btn', href: '#/chapter/' + p.chapterId }, 'Open chapter'))));
      toast('Saved');
    } catch (e) { console.error(e); btn.disabled = false; toast('Save failed: ' + (e.message || e), 5000); }
  }

  return h('div', {},
    topbar('Import'),
    h('label', { class: 'field' }, h('span', {}, 'Course'), courseSel),
    h('label', { class: 'field' }, h('span', {}, 'Chapter'), chapSel, newName),
    h('div', { class: 'row' }, segBtns),
    h('label', { class: 'field' }, h('span', {}, 'JSON'), paste),
    clip,
    h('label', { class: 'check' }, verified, 'Already verified, skip review'),
    previewBtn, out);
}
