// settings.js: backup and restore. Export reads every collection from the server and downloads one JSON file.
// Restore never overwrites an existing document unless "Overwrite existing" is ticked.
import * as db from './db.js';
import { h, topbar, toast, confirmDialog, icon, watchOnline } from './ui.js';

const LABELS = {
  courses: ['course', 'courses'], chapters: ['chapter', 'chapters'], questions: ['question', 'questions'],
  flashcards: ['card', 'cards'], attempts: ['attempt', 'attempts'], todos: ['to-do', 'to-dos'], journal: ['journal entry', 'journal entries']
};
const countText = counts => Object.keys(LABELS).filter(k => counts[k]).map(k => `${counts[k]} ${LABELS[k][counts[k] === 1 ? 0 : 1]}`).join(', ') || 'nothing';
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const pad = n => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function settingsScreen() {
  let busy = false, pending = null; // pending = { backup, preview } after a file has been chosen

  // ---------- export ----------
  const lastLine = h('p', { class: 'muted small' });
  const exportBtn = h('button', { class: 'btn primary block' }, icon('download', 18), 'Export all data as JSON');
  const exportMsg = h('p', { class: 'muted small center-text' });
  const showLast = () => {
    const t = db.lastExportAt(), overdue = db.exportOverdue();
    const days = t ? Math.floor((Date.now() - t) / 86400000) : 0;
    lastLine.replaceChildren(
      t ? `Last export: ${fmtDate(t)} (${days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'}). ` : 'You have never exported your data. ',
      overdue ? h('span', { class: 'badge' }, 'Backup due') : null);
  };
  exportBtn.onclick = async () => {
    if (busy || !navigator.onLine) return;
    busy = true; exportMsg.className = 'muted small center-text'; exportMsg.textContent = 'Reading your data… 0 of 7'; sync();
    try {
      const backup = await db.exportAll((d, t) => { exportMsg.textContent = `Reading your data… ${d} of ${t}`; });
      const counts = Object.fromEntries(Object.keys(LABELS).map(k => [k, (backup.data[k] || []).length]));
      const name = `study-backup-${ymd()}.json`;
      saveFile(name, JSON.stringify(backup));
      db.markExported(); showLast();
      exportMsg.textContent = `Exported ${countText(counts)} to ${name}.`;
    } catch (e) {
      console.error(e); exportMsg.className = 'err small center-text'; exportMsg.textContent = e.message || 'Export failed.';
    } finally { busy = false; sync(); }
  };

  // ---------- restore ----------
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const pickBtn = h('button', { class: 'btn block' }, icon('import', 18), 'Restore from backup');
  const restoreBox = h('div');
  const restoreMsg = h('p', { class: 'muted small center-text' });
  pickBtn.onclick = () => { if (!busy && navigator.onLine) fileInput.click(); };

  const say = (text, isErr = false) => { restoreMsg.className = (isErr ? 'err' : 'muted') + ' small center-text'; restoreMsg.textContent = text; };

  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // so the same file can be picked again
    if (!file) return;
    pending = null; restoreBox.replaceChildren(); say('');
    busy = true; sync(); say('Reading the file…');
    try {
      let backup;
      try { backup = JSON.parse(await file.text()); }
      catch { throw new Error('That file is not valid JSON, so it is not a backup made by this app.'); }
      const chk = db.checkBackup(backup);
      if (chk.error) throw new Error(chk.error);
      say('Checking what already exists…');
      const preview = await db.previewBackup(backup);
      pending = { backup, preview, fileName: file.name };
      say('');
      drawPreview();
    } catch (e) { console.error(e); pending = null; say(e.message || 'Could not read that backup.', true); }
    finally { busy = false; sync(); }
  };

  let restoreBtn = null;
  function drawPreview() {
    const { backup, preview } = pending;
    const total = Object.values(preview.counts).reduce((a, b) => a + b, 0);
    const existing = Object.values(preview.existing).reduce((a, b) => a + b, 0);
    const missing = total - existing;
    const overwrite = h('input', { type: 'checkbox' }); // always starts unticked, never remembered
    restoreBtn = h('button', { class: 'btn primary block' }, 'Restore');
    restoreBtn.onclick = async () => {
      if (busy || !navigator.onLine) return;
      const over = overwrite.checked;
      if (!over && !missing) return toast('Everything in this backup already exists. Tick "Overwrite existing" to replace it.', 5000);
      const ok = await confirmDialog(over
        ? `Restore ${total} documents? ${existing} that already exist will be REPLACED by the version in the backup.`
        : `Restore ${missing} missing documents? ${existing} that already exist will be left untouched.`, 'Restore', over);
      if (!ok) return;
      busy = true; sync(); say('Restoring… 0%');
      try {
        const r = await db.restoreBackup(backup, { overwrite: over }, (d, t) => say(`Restoring… ${t ? Math.round((d / t) * 100) : 100}%`));
        pending = null; restoreBox.replaceChildren();
        say(`Restored ${r.restored + r.overwritten} documents` + (r.skipped ? `, ${r.skipped} already existed and ${r.skipped === 1 ? 'was' : 'were'} left unchanged` : '') + (r.overwritten ? ` (${r.overwritten} replaced)` : '') + '.');
        toast('Backup restored');
      } catch (e) { console.error(e); say(e.message || 'Restore failed.', true); }
      finally { busy = false; sync(); }
    };
    restoreBox.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'muted small' }, `${pending.fileName}${backup.exportedAt ? ' · exported ' + fmtDate(backup.exportedAt) : ''}`),
      h('p', { class: 'title' }, 'Contains ' + countText(preview.counts)),
      h('p', { class: existing ? 'small' : 'muted small', style: existing ? 'color:var(--warn)' : null },
        existing ? `${existing} of ${total} documents already exist.` : 'None of these exist yet.'),
      h('label', { class: 'check' }, overwrite, 'Overwrite existing'),
      h('p', { class: 'muted small' }, 'Off: documents that already exist are not touched. On: they are replaced by the backup version.'),
      missing || existing ? restoreBtn : null,
      !total ? h('p', { class: 'muted' }, 'This backup is empty.') : null));
    if (!total) restoreBtn = null;
    sync();
  }

  // ---------- offline guard ----------
  const offMsg = h('p', { class: 'err small center-text', hidden: true }, 'Connect to the internet to export or restore.');
  function sync() {
    const on = navigator.onLine;
    exportBtn.disabled = !on || busy;
    pickBtn.disabled = !on || busy;
    if (restoreBtn) restoreBtn.disabled = !on || busy;
    offMsg.hidden = on;
  }

  showLast();
  const root = h('div', {},
    topbar('Settings', { back: '#/' }),
    h('div', { class: 'card' },
      h('p', { class: 'title' }, 'Backup'),
      h('p', { class: 'muted small' }, 'One JSON file with all your courses, notes, questions, flashcards, attempts, to-dos and journal. Keep it somewhere safe.'),
      lastLine, exportBtn, exportMsg),
    h('div', { class: 'card' },
      h('p', { class: 'title' }, 'Restore'),
      h('p', { class: 'muted small' }, 'Pick a backup file to see what is in it first. Nothing is written until you confirm.'),
      pickBtn, fileInput, restoreMsg, restoreBox),
    offMsg);
  watchOnline(root, sync);
  return root;
}
