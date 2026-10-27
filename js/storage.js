/* storage.js — persistence + business rules. No DOM access here.
   LibraryAPI is the ONLY thing the UI talks to. Every method returns {ok:true,data} or {ok:false,error},
   so it can later be re-implemented with Supabase / stored procedures without touching the UI.
   NOTE: demo roles are enforced here only to mimic permissions. This is NOT security (anyone can edit LocalStorage). */

const DateUtil = {
  iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
  today() { return this.iso(new Date()); },
  parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); },
  addDays(s, n) { const d = this.parse(s); d.setDate(d.getDate() + n); return this.iso(d); },
  diff(a, b) { return Math.round((this.parse(a) - this.parse(b)) / 86400000); }, // a - b, whole calendar days
  stamp(d) { d = d || new Date(); const p = n => String(n).padStart(2, '0'); return `${this.iso(d)}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
};

const Storage = {
  KEY: 'lms_demo_data_v1', VERSION: 2, recovered: false, saveFailed: false,
  COPY_STATUSES: ['Available', 'Borrowed', 'Reserved', 'Damaged', 'Under Repair', 'Lost', 'Withdrawn'],

  isValid(s) {
    try {
      const A = Array.isArray, dre = /^\d{4}-\d{2}-\d{2}$/;
      if (!s || typeof s !== 'object' || !s.settings || typeof s.settings !== 'object') return false;
      if (!['books', 'copies', 'members', 'transactions'].every(k => A(s[k]))) return false;
      const bookIds = new Set(), copyIds = new Set(), memIds = new Set(), txnIds = new Set();
      for (const b of s.books) { if (!b || typeof b.id !== 'string' || typeof b.title !== 'string' || typeof b.isbn !== 'string' || bookIds.has(b.id)) return false; bookIds.add(b.id); }
      for (const c of s.copies) { if (!c || typeof c.id !== 'string' || copyIds.has(c.id) || !bookIds.has(c.bookId) || !this.COPY_STATUSES.includes(c.status)) return false; copyIds.add(c.id); }
      for (const m of s.members) { if (!m || typeof m.id !== 'string' || typeof m.name !== 'string' || memIds.has(m.id) || !['Student', 'Faculty'].includes(m.type)) return false; memIds.add(m.id); }
      for (const t of s.transactions) {
        if (!t || typeof t.id !== 'string' || txnIds.has(t.id) || !copyIds.has(t.copyId) || !memIds.has(t.memberId) || !dre.test(t.borrowDate) || !dre.test(t.dueDate) || !['Borrowed', 'Returned', 'Lost'].includes(t.status)) return false;
        txnIds.add(t.id);
      }
      return true;
    } catch (e) { return false; }
  },

  migrate(s) {
    const D = SeedData.defaultSettings(), pad = (n, l) => String(n).padStart(l, '0');
    const settings = {};
    Object.keys(D).forEach(k => {
      const v = s.settings[k];
      if (typeof D[k] === 'number') settings[k] = (v !== '' && v !== null && Number.isFinite(Number(v))) ? Number(v) : D[k];
      else if (typeof D[k] === 'boolean') settings[k] = typeof v === 'boolean' ? v : D[k];
      else settings[k] = (typeof v === 'string' && v.trim()) ? v : D[k];
    });
    s.settings = settings;
    ['reservations', 'damageReports', 'conditionLog'].forEach(k => { if (!Array.isArray(s[k])) s[k] = []; });
    const isStr = v => typeof v === 'string';
    s.reservations = s.reservations.filter(r => r && isStr(r.id) && isStr(r.bookId) && isStr(r.memberId) && isStr(r.status));
    s.damageReports = s.damageReports.filter(r => r && isStr(r.id) && isStr(r.copyId) && isStr(r.reportedAt) && ['Reported', 'Under Repair', 'Resolved', 'Closed'].includes(r.status));
    s.conditionLog = s.conditionLog.filter(l => l && isStr(l.id) && isStr(l.at) && isStr(l.copyId));
    if (Array.isArray(s.eventLog)) s.eventLog = s.eventLog.filter(e => e && isStr(e.id) && isStr(e.at) && isStr(e.type));
    s.transactions.forEach(t => {
      t.renewals = Array.isArray(t.renewals) ? t.renewals.filter(r => r && isStr(r.at) && isStr(r.previousDueDate) && isStr(r.newDueDate)) : [];
      t.renewalCount = Number.isFinite(Number(t.renewalCount)) ? Number(t.renewalCount) : t.renewals.length;
      t.originalDueDate = t.originalDueDate || t.dueDate;
      t.priorOverdueDays = Number(t.priorOverdueDays) || 0;
      t.daysLate = Number(t.daysLate) || 0; t.fine = Number(t.fine) || 0;
    });
    // Part 1 data had Damaged/Lost copies with no report: create one so the new workflow can manage them.
    s.copies.filter(c => ['Damaged', 'Under Repair', 'Lost'].includes(c.status) && !s.damageReports.some(r => r.copyId === c.id && ['Reported', 'Under Repair'].includes(r.status))).forEach(c => {
      const type = c.status === 'Lost' ? 'Lost' : 'Damaged', at = DateUtil.stamp();
      const id = 'DR-' + pad(Math.max(0, ...s.damageReports.map(r => parseInt(String(r.id).slice(3), 10) || 0)) + 1, 4);
      s.damageReports.push({ id, copyId: c.id, bookId: c.bookId, type, description: 'Migrated from earlier demo data (no description recorded).', reportedAt: at, reportedBy: 'System', status: c.status === 'Under Repair' ? 'Under Repair' : 'Reported', previousStatus: 'Available', repairStartedAt: c.status === 'Under Repair' ? at : null, repairNotes: '', resolvedAt: null, resolution: null, resolutionNotes: '', loanTxnId: null });
      s.conditionLog.push({ id: 'CL-' + pad(Math.max(0, ...s.conditionLog.map(l => parseInt(String(l.id).slice(3), 10) || 0)) + 1, 4), copyId: c.id, bookId: c.bookId, at, event: `Migrated: ${c.status}`, fromStatus: c.status, toStatus: c.status, fromCondition: c.condition, toCondition: c.condition, note: 'Created when upgrading demo data.', by: 'System' });
    });
    if (!Array.isArray(s.eventLog)) s.eventLog = this.backfill(s);
    if (!['Student', 'Faculty', 'Librarian', 'System Administrator'].includes(s.demoRole)) s.demoRole = 'Librarian';
    s.demoMemberId = (typeof s.demoMemberId === 'string' && s.members.some(m => m.id === s.demoMemberId)) ? s.demoMemberId : '';
    s.version = this.VERSION;
    return s;
  },

  // Builds the persistent event log ONCE from records that already exist (older saved data / first seed).
  // Entries are flagged backfilled:true; all later events are written by real actions in the app.
  backfill(s) {
    const ev = [];
    const add = (type, at, f, description, actor) => ev.push({ type, at, txnId: null, copyId: null, bookId: null, memberId: null, reportId: null, ...f, actor: actor || 'Not recorded', description: description || '', backfilled: true });
    s.transactions.forEach(t => {
      const f = { txnId: t.id, copyId: t.copyId, bookId: t.bookId, memberId: t.memberId };
      add('Book Borrowed', t.borrowAt || t.borrowDate + 'T09:00:00', f, `${t.copyId} borrowed; due ${t.originalDueDate || t.dueDate}.`);
      (t.renewals || []).forEach((r, i) => add('Loan Renewed', r.at, f, `Renewal #${i + 1}: due date ${r.previousDueDate} → ${r.newDueDate} (+${r.days || '?'} days).`, r.by));
      if (t.status === 'Returned') add('Book Returned', t.returnAt || (t.returnDate || t.dueDate) + 'T16:00:00', f, t.daysLate ? `${t.daysLate} day(s) late; fine ₱${Number(t.fine || 0).toFixed(2)}.` : 'Returned on time.');
      if (t.status === 'Lost') add('Loan Closed as Lost', t.lostAt || t.dueDate + 'T12:00:00', f, 'Copy reported lost while on loan; loan closed.');
    });
    s.damageReports.forEach(r => {
      const f = { copyId: r.copyId, bookId: r.bookId || String(r.copyId).split('-')[0], reportId: r.id, txnId: r.loanTxnId || null };
      add(r.type === 'Lost' ? 'Lost Reported' : 'Damage Reported', r.reportedAt, f, r.description, r.reportedBy);
      if (r.repairStartedAt) add('Moved to Repair', r.repairStartedAt, f, r.repairNotes || 'Repair started.');
      if (r.resolvedAt) add(r.resolution === 'Repaired' ? 'Repair Completed' : r.resolution === 'Found' ? 'Copy Found' : 'Copy Written Off', r.resolvedAt, f, r.resolutionNotes);
      if (r.closedAt && r.resolution !== 'Written off') add('Report Closed', r.closedAt, f, 'Report closed.');
    });
    s.conditionLog.filter(l => l.event === 'Manual update').forEach(l => add('Copy Status Changed', l.at, { copyId: l.copyId, bookId: l.bookId }, `${l.fromStatus || '—'} → ${l.toStatus}. ${l.note || ''}`, l.by));
    s.reservations.forEach(r => add('Reservation Created', r.createdAt || DateUtil.stamp(), { bookId: r.bookId, memberId: r.memberId }, `Reservation ${r.id}.`));
    ev.sort((a, b) => a.at.localeCompare(b.at));
    return ev.map((e, i) => ({ id: 'EV-' + String(i + 1).padStart(4, '0'), ...e }));
  },

  load() {
    let raw = null;
    try { raw = localStorage.getItem(this.KEY); } catch (e) { this.saveFailed = true; }
    if (raw) {
      try { const s = JSON.parse(raw); if (this.isValid(s)) { const m = this.migrate(s); this.save(m); return m; } } catch (e) { /* invalid */ }
      this.recovered = true;
      try { localStorage.setItem(this.KEY + '_corrupt_backup', raw); } catch (e) { /* ignore */ }
    }
    const seed = this.migrate(SeedData.build());
    this.save(seed);
    return seed;
  },
  save(state) {
    try { localStorage.setItem(this.KEY, JSON.stringify(state)); this.saveFailed = false; }
    catch (e) { this.saveFailed = true; console.error('LocalStorage save failed', e); }
  },
  reset() { try { localStorage.removeItem(this.KEY); } catch (e) { /* ignore */ } return this.load(); }
};

const LibraryAPI = (() => {
  let state = Storage.load();
  const ok = data => ({ ok: true, data });
  const fail = error => ({ ok: false, error });
  const save = () => Storage.save(state);
  const pad = (n, l) => String(n).padStart(l, '0');
  const clone = o => JSON.parse(JSON.stringify(o));
  const str = v => String(v == null ? '' : v).trim();
  const now = () => DateUtil.stamp();
  const nextId = (list, prefix, len) => prefix + pad(Math.max(0, ...list.map(x => parseInt(String(x.id).slice(prefix.length), 10) || 0)) + 1, len);
  const isOpen = r => r.status === 'Reported' || r.status === 'Under Repair';
  // Name of the (simulated) acting user, stored with every history event.
  const actor = () => {
    const r = state.demoRole;
    if (r === 'Student' || r === 'Faculty') { const m = state.members.find(x => x.id === state.demoMemberId); return `${m ? m.name : 'Unknown member'} (${r})`; }
    return `${r === 'Librarian' ? 'Demo Librarian' : 'Demo Administrator'} (${r})`;
  };
  // Append-only history log: entries are never edited or removed when other records change.
  function logEvent(type, f, description) {
    state.eventLog.push({ id: nextId(state.eventLog, 'EV-', 4), type, at: now(), txnId: null, copyId: null, bookId: null, memberId: null, reportId: null, ...f, actor: actor(), description: description || '' });
  }

  const DEFAULT_CATEGORIES = ['Information Technology', 'Computer Science', 'Business', 'Science', 'Mathematics', 'History', 'Humanities', 'Language', 'Education', 'Fiction', 'Reference'];
  const COPY_STATUSES = Storage.COPY_STATUSES;
  const MANUAL_COPY_STATUSES = ['Available', 'Reserved'];
  const WORKFLOW_STATUSES = ['Damaged', 'Under Repair', 'Lost', 'Withdrawn'];
  const CONDITIONS = ['New', 'Good', 'Fair', 'Worn'];
  const REPORT_STATUSES = ['Reported', 'Under Repair', 'Resolved', 'Closed'];
  const MEMBER_TYPES = ['Student', 'Faculty'];
  const MEMBER_STATUSES = ['Active', 'Suspended', 'Inactive'];
  const ROLES = ['Student', 'Faculty', 'Librarian', 'System Administrator'];
  const STAFF_PERMS = ['books', 'copies', 'members', 'circulation', 'damage', 'renewal', 'reservations'];
  const PERMS = { Student: ['renewal'], Faculty: ['renewal'], Librarian: STAFF_PERMS, 'System Administrator': [...STAFF_PERMS, 'settings', 'reset'] };

  const can = p => (PERMS[state.demoRole] || []).includes(p);
  const deny = p => can(p) ? null : fail(`Permission denied: the demo role "${state.demoRole}" cannot perform this action.`);
  const isMemberRole = () => state.demoRole === 'Student' || state.demoRole === 'Faculty';
  const scopedMemberId = () => isMemberRole() ? (state.demoMemberId || '__none__') : null;

  const book = id => state.books.find(b => b.id === id);
  const copy = id => state.copies.find(c => c.id === id);
  const member = id => state.members.find(m => m.id === id);
  const txn = id => state.transactions.find(t => t.id === id);
  const report = id => state.damageReports.find(r => r.id === id);
  const openReportOf = copyId => state.damageReports.find(r => r.copyId === copyId && isOpen(r));
  const loanDays = m => m.type === 'Faculty' ? state.settings.facultyLoanDays : state.settings.studentLoanDays;
  const limitOf = m => m.type === 'Faculty' ? state.settings.facultyLimit : state.settings.studentLimit;
  const activeLoans = () => state.transactions.filter(t => t.status === 'Borrowed');
  const loansOf = id => activeLoans().filter(t => t.memberId === id);
  const isOverdue = t => t.status === 'Borrowed' && t.dueDate < DateUtil.today();
  const daysOverdue = t => isOverdue(t) ? DateUtil.diff(DateUtil.today(), t.dueDate) : 0;
  const projectedFine = t => t.status === 'Borrowed' ? ((t.priorOverdueDays || 0) + daysOverdue(t)) * state.settings.finePerDay : t.fine;

  function logCondition(c, event, fromStatus, toStatus, fromCond, toCond, note) {
    state.conditionLog.push({ id: nextId(state.conditionLog, 'CL-', 4), copyId: c.id, bookId: c.bookId, at: now(), event, fromStatus, toStatus, fromCondition: fromCond, toCondition: toCond, note: note || '', by: state.demoRole });
  }

  /* ---------- Demo session / roles ---------- */
  function setRole(role) {
    if (!ROLES.includes(role)) return fail('Unknown demo role.');
    state.demoRole = role;
    if (role === 'Student' || role === 'Faculty') {
      const cur = member(state.demoMemberId);
      if (!cur || cur.type !== role || cur.status !== 'Active') {
        const first = state.members.find(m => m.type === role && m.status === 'Active');
        state.demoMemberId = first ? first.id : '';
      }
    }
    save(); return ok(role);
  }
  function setSessionMember(id) {
    const m = member(id);
    if (!m || m.type !== state.demoRole) return fail('Choose a member that matches the selected role.');
    state.demoMemberId = id; save(); return ok(id);
  }

  /* ---------- Settings ---------- */
  function updateSettings(d) {
    const x = deny('settings'); if (x) return x;
    const name = str(d.libraryName);
    if (!name || name.length > 60) return fail('Library name is required (maximum 60 characters).');
    const specs = [['studentLoanDays', 'Student loan period (days)', 1, 90], ['facultyLoanDays', 'Faculty loan period (days)', 1, 180],
      ['studentLimit', 'Student borrowing limit', 1, 20], ['facultyLimit', 'Faculty borrowing limit', 1, 30],
      ['renewalDays', 'Renewal duration (days)', 1, 60], ['maxRenewals', 'Maximum renewals per loan', 0, 10]];
    for (const [k, label, mn, mx] of specs) {
      const raw = str(d[k]), v = Number(raw);
      if (raw === '' || !Number.isInteger(v) || v < mn || v > mx) return fail(`${label} must be a whole number from ${mn} to ${mx}.`);
    }
    const fineRaw = str(d.finePerDay), fine = Number(fineRaw);
    if (fineRaw === '' || !Number.isFinite(fine) || fine < 0 || fine > 1000) return fail('Fine per day must be a number from 0 to 1000.');
    if (!['Yes', 'No'].includes(d.allowOverdueRenewal)) return fail('Select Yes or No for the overdue renewal policy.');
    specs.forEach(([k]) => { state.settings[k] = Number(d[k]); });
    Object.assign(state.settings, { libraryName: name, finePerDay: Math.round(fine * 100) / 100, allowOverdueRenewal: d.allowOverdueRenewal === 'Yes' });
    save(); return ok(clone(state.settings));
  }

  /* ---------- Books ---------- */
  const normIsbn = v => str(v).replace(/[-\s]/g, '').toUpperCase();
  function cleanBook(d, excludeId) {
    const t = { title: str(d.title), author: str(d.author), isbn: normIsbn(d.isbn), category: str(d.category), publisher: str(d.publisher), year: Number(d.year), description: str(d.description) };
    if (!t.title) return fail('Title is required.');
    if (!t.author) return fail('Author is required.');
    if (!t.isbn) return fail('ISBN is required.');
    if (!/^(\d{9}[\dX]|\d{13})$/.test(t.isbn)) return fail('ISBN must be 10 or 13 digits (hyphens and spaces are allowed).');
    if (!t.category) return fail('Category is required.');
    const maxY = new Date().getFullYear() + 1;
    if (!Number.isInteger(t.year) || t.year < 1900 || t.year > maxY) return fail(`Publication year must be a whole number between 1900 and ${maxY}.`);
    const dup = state.books.find(b => b.isbn === t.isbn && b.id !== excludeId);
    if (dup) return fail(`Duplicate ISBN: ${t.isbn} is already used by "${dup.title}" (${dup.id}).`);
    return ok(t);
  }
  function addBook(d) {
    const x = deny('books'); if (x) return x;
    const r = cleanBook(d, null); if (!r.ok) return r;
    const rec = { id: nextId(state.books, 'B', 3), ...r.data, createdAt: DateUtil.today() };
    state.books.push(rec); save(); return ok(clone(rec));
  }
  function updateBook(id, d) {
    const x = deny('books'); if (x) return x;
    const b = book(id); if (!b) return fail('Book not found.');
    const r = cleanBook(d, id); if (!r.ok) return r;
    Object.assign(b, r.data); save(); return ok(clone(b));
  }

  /* ---------- Copies ---------- */
  function addCopy(bookId, d) {
    const x = deny('copies'); if (x) return x;
    if (!book(bookId)) return fail('Select a valid book for this copy.');
    const status = str(d.status) || 'Available';
    if (!MANUAL_COPY_STATUSES.includes(status)) return fail('A new copy must be Available or Reserved. Use Damage and Lost Books to report problems.');
    const condition = str(d.condition);
    if (!CONDITIONS.includes(condition)) return fail('Select the physical condition of the copy.');
    const location = str(d.location);
    if (!location) return fail('Shelf location is required.');
    const nums = state.copies.filter(c => c.bookId === bookId).map(c => parseInt(c.id.split('-C')[1], 10) || 0);
    const id = `${bookId}-C${pad(Math.max(0, ...nums) + 1, 2)}`;
    if (copy(id)) return fail('Generated copy ID already exists.');
    const rec = { id, bookId, condition, location, status, acquiredAt: DateUtil.today() };
    state.copies.push(rec); logCondition(rec, 'Copy added', '', status, '', condition, `Added at ${location}.`); save(); return ok(clone(rec));
  }
  function updateCopy(copyId, d) {
    const x = deny('copies'); if (x) return x;
    const c = copy(copyId); if (!c) return fail('Copy not found.');
    const condition = str(d.condition), location = str(d.location), status = str(d.status) || c.status;
    if (!CONDITIONS.includes(condition)) return fail('Select the physical condition of the copy.');
    if (!location) return fail('Shelf location is required.');
    if (c.status === 'Borrowed' && status !== 'Borrowed') return fail('This copy is currently on loan. Record its return before changing its status.');
    if (WORKFLOW_STATUSES.includes(c.status) && status !== c.status) return fail(`This copy is "${c.status}". Resolve it under Damage and Lost Books to change its status.`);
    if (!['Borrowed', ...WORKFLOW_STATUSES].includes(c.status) && !MANUAL_COPY_STATUSES.includes(status)) return fail('Status can only be set to Available or Reserved here. Use Damage and Lost Books to report damage or loss.');
    const before = { s: c.status, c: c.condition };
    c.status = status; c.condition = condition; c.location = location;
    if (before.s !== status || before.c !== condition) logCondition(c, 'Manual update', before.s, status, before.c, condition, 'Edited in Book Copies.');
    if (before.s !== status) logEvent('Copy Status Changed', { copyId: c.id, bookId: c.bookId }, `${before.s} → ${status} (edited in Book Copies).`);
    save(); return ok(clone(c));
  }
  function deleteCopy(copyId) {
    const x = deny('copies'); if (x) return x;
    const c = copy(copyId); if (!c) return fail('Copy not found.');
    if (c.status === 'Borrowed') return fail('Cannot delete a copy that is currently on loan.');
    if (state.transactions.some(t => t.copyId === copyId) || state.damageReports.some(r => r.copyId === copyId)) return fail('Cannot delete a copy that has transaction or damage history. Withdraw it through Damage and Lost Books instead.');
    state.copies = state.copies.filter(y => y.id !== copyId);
    logEvent('Copy Status Changed', { copyId, bookId: c.bookId }, 'Copy record deleted (it had no loan or damage history).'); save(); return ok(true);
  }

  /* ---------- Members ---------- */
  function cleanMember(d, excludeId) {
    const t = { name: str(d.name), type: str(d.type), email: str(d.email).toLowerCase(), program: str(d.program), status: str(d.status) || 'Active' };
    if (!t.name) return fail('Full name is required.');
    if (!MEMBER_TYPES.includes(t.type)) return fail('Member type must be Student or Faculty.');
    if (!t.email) return fail('Email is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t.email)) return fail('Enter a valid email address.');
    if (!t.program) return fail('Program / department is required.');
    if (!MEMBER_STATUSES.includes(t.status)) return fail('Invalid member status.');
    const dup = state.members.find(m => m.email === t.email && m.id !== excludeId);
    if (dup) return fail(`Email already registered to ${dup.name} (${dup.id}).`);
    return ok(t);
  }
  function addMember(d) {
    const x = deny('members'); if (x) return x;
    const r = cleanMember(d, null); if (!r.ok) return r;
    const n = Math.max(0, ...state.members.map(m => parseInt(m.id.split('-')[2], 10) || 0)) + 1;
    const rec = { id: `M-${new Date().getFullYear()}-${pad(n, 3)}`, ...r.data, joinedAt: DateUtil.today() };
    state.members.push(rec); save(); return ok(clone(rec));
  }
  function updateMember(id, d) {
    const x = deny('members'); if (x) return x;
    const m = member(id); if (!m) return fail('Member not found.');
    const r = cleanMember(d, id); if (!r.ok) return r;
    Object.assign(m, r.data); save(); return ok(clone(m));
  }

  /* ---------- Borrowing / Returning ---------- */
  function eligibility(memberId) {
    const m = member(memberId); if (!m) return fail('Member not found.');
    if (m.status !== 'Active') return fail(`Member account is ${m.status}; only Active members may borrow.`);
    const loans = loansOf(m.id), limit = limitOf(m);
    if (loans.length >= limit) return fail(`Borrowing limit reached (${loans.length} of ${limit} books on loan).`);
    const od = loans.filter(isOverdue).length;
    if (od) return fail(`Member has ${od} overdue book(s). Return them before borrowing again.`);
    return ok({ count: loans.length, limit, days: loanDays(m), dueDate: DateUtil.addDays(DateUtil.today(), loanDays(m)) });
  }

  function borrow(memberId, copyId) {
    const x = deny('circulation'); if (x) return x;
    if (!str(memberId)) return fail('Select a member.');
    if (!str(copyId)) return fail('Select a book copy.');
    const m = member(memberId); if (!m) return fail('Member not found.');
    const c = copy(copyId); if (!c) return fail(`Copy "${copyId}" does not exist.`);
    const el = eligibility(m.id); if (!el.ok) return el;
    if (c.status !== 'Available') {
      const rep = openReportOf(c.id);
      return fail(`Copy ${c.id} cannot be borrowed (status: ${c.status}${rep ? `, open report ${rep.id}` : ''}).`);
    }
    if (loansOf(m.id).some(t => t.bookId === c.bookId)) return fail('Duplicate borrowing: this member already has a copy of this title on loan.');
    const today = DateUtil.today();
    const due = DateUtil.addDays(today, loanDays(m));
    const t = { id: nextId(state.transactions, 'T-', 4), copyId: c.id, bookId: c.bookId, memberId: m.id, borrowDate: today, borrowAt: now(), dueDate: due, originalDueDate: due,
      returnDate: null, returnAt: null, status: 'Borrowed', renewalCount: 0, renewals: [], priorOverdueDays: 0, daysLate: 0, fine: 0 };
    state.transactions.push(t); c.status = 'Borrowed';
    state.reservations.filter(r => r.status === 'Active' && r.memberId === m.id && r.bookId === c.bookId).forEach(r => { r.status = 'Fulfilled'; r.fulfilledAt = now(); });
    logEvent('Book Borrowed', { txnId: t.id, copyId: c.id, bookId: c.bookId, memberId: m.id }, `${c.id} borrowed by ${m.name}; due ${t.dueDate}.`);
    save(); return ok(clone(t));
  }

  function returnBook(copyId) {
    const x = deny('circulation'); if (x) return x;
    const id = str(copyId).toUpperCase();
    if (!id) return fail('Enter or select a copy ID.');
    const c = copy(id); if (!c) return fail(`Copy "${id}" does not exist.`);
    const t = activeLoans().find(a => a.copyId === c.id);
    if (!t) return fail(`Copy ${c.id} is not currently on loan (it may already have been returned).`);
    const today = DateUtil.today();
    t.returnDate = today; t.returnAt = now(); t.status = 'Returned';
    t.daysLate = (t.priorOverdueDays || 0) + (today > t.dueDate ? DateUtil.diff(today, t.dueDate) : 0);
    t.fine = t.daysLate * state.settings.finePerDay;
    c.status = 'Available';
    logEvent('Book Returned', { txnId: t.id, copyId: c.id, bookId: c.bookId, memberId: t.memberId }, t.daysLate ? `${t.daysLate} day(s) late; fine ₱${t.fine.toFixed(2)}.` : 'Returned on time.');
    save();
    return ok(clone(t));
  }

  /* ---------- Renewals & reservations ---------- */
  function renewalCheck(txnId) {
    const t = txn(str(txnId)); if (!t) return fail('Transaction not found.');
    if (t.status !== 'Borrowed') return fail(`Transaction ${t.id} is already ${t.status.toLowerCase()}; only active loans can be renewed.`);
    const m = member(t.memberId);
    if (!m || m.status !== 'Active') return fail(`Member account is ${m ? m.status : 'missing'}; renewal not allowed.`);
    const c = copy(t.copyId), rep = c && openReportOf(c.id);
    if (!c || c.status !== 'Borrowed' || rep) return fail(`Copy ${t.copyId} is not eligible for renewal${rep ? ` (open report ${rep.id})` : ` (status: ${c ? c.status : 'missing'})`}.`);
    const s = state.settings;
    if ((t.renewalCount || 0) >= s.maxRenewals) return fail(`Renewal limit reached (${t.renewalCount || 0} of ${s.maxRenewals}).`);
    const od = isOverdue(t);
    if (od && !s.allowOverdueRenewal) return fail(`Loan is ${daysOverdue(t)} day(s) overdue and library policy does not allow renewing overdue loans.`);
    const res = state.reservations.find(r => r.status === 'Active' && r.bookId === t.bookId && r.memberId !== t.memberId);
    if (res) { const rm = member(res.memberId); return fail(`Another member (${rm ? rm.name : res.memberId}) has an active reservation for this title.`); }
    return ok({ newDueDate: DateUtil.addDays(od ? DateUtil.today() : t.dueDate, s.renewalDays), overdue: od });
  }
  function renew(txnId) {
    const x = deny('renewal'); if (x) return x;
    const own = txn(str(txnId));
    if (isMemberRole() && own && own.memberId !== state.demoMemberId) return fail('Permission denied: members can only renew their own loans.');
    const chk = renewalCheck(txnId); if (!chk.ok) return chk;
    const t = own;
    if (chk.data.overdue) t.priorOverdueDays = (t.priorOverdueDays || 0) + daysOverdue(t); // overdue days already incurred are kept for the fine
    t.renewals.push({ at: now(), previousDueDate: t.dueDate, newDueDate: chk.data.newDueDate, days: state.settings.renewalDays, by: state.demoRole });
    const prevDue = t.renewals[t.renewals.length - 1].previousDueDate;
    t.dueDate = chk.data.newDueDate; t.renewalCount = t.renewals.length;
    logEvent('Loan Renewed', { txnId: t.id, copyId: t.copyId, bookId: t.bookId, memberId: t.memberId }, `Renewal #${t.renewalCount}: due date ${prevDue} → ${t.dueDate} (+${state.settings.renewalDays} days).`);
    save(); return ok(clone(t));
  }
  function createReservation(memberId, bookId) {
    const x = deny('reservations'); if (x) return x;
    const m = member(str(memberId)); if (!m) return fail('Select a member.');
    const b = book(str(bookId)); if (!b) return fail('Select a book.');
    if (m.status !== 'Active') return fail(`Member account is ${m.status}; only Active members may reserve.`);
    if (loansOf(m.id).some(t => t.bookId === b.id)) return fail('This member already has this title on loan.');
    if (state.reservations.some(r => r.status === 'Active' && r.memberId === m.id && r.bookId === b.id)) return fail('This member already has an active reservation for this title.');
    const r = { id: nextId(state.reservations, 'R-', 4), bookId: b.id, memberId: m.id, createdAt: now(), status: 'Active' };
    state.reservations.push(r); logEvent('Reservation Created', { bookId: b.id, memberId: m.id }, `Reservation ${r.id} for "${b.title}".`); save(); return ok(clone(r));
  }
  function cancelReservation(id) {
    const x = deny('reservations'); if (x) return x;
    const r = state.reservations.find(y => y.id === id); if (!r) return fail('Reservation not found.');
    if (r.status !== 'Active') return fail(`Reservation is already ${r.status.toLowerCase()}.`);
    r.status = 'Cancelled'; r.cancelledAt = now(); logEvent('Reservation Cancelled', { bookId: r.bookId, memberId: r.memberId }, `Reservation ${r.id} cancelled.`); save(); return ok(clone(r));
  }

  /* ---------- Damage & lost copies ---------- */
  // Report status flow:  Reported -> Under Repair (damage only) -> Resolved (Repaired / Found) -> Closed.
  // "Written off" closes the report directly and withdraws the copy. Closed is final. History is never deleted.
  function reportCopy(copyId, type, description, reporter) {
    const x = deny('damage'); if (x) return x;
    if (!['Damaged', 'Lost'].includes(type)) return fail('Report type must be Damaged or Lost.');
    const desc = str(description);
    if (desc.length < 5) return fail('Enter a description of at least 5 characters.');
    const who = str(reporter) || actor().replace(/ \(.*\)$/, '');
    if (who.length < 2) return fail('Enter the name of the reporting librarian.');
    const c = copy(str(copyId)); if (!c) return fail('Select a valid copy.');
    const open = openReportOf(c.id);
    if (open) return fail(`Copy ${c.id} already has an open report (${open.id}). Resolve it first.`);
    if (c.status === 'Withdrawn') return fail('This copy has been withdrawn from the collection.');
    let loanTxnId = null, loanMember = null;
    if (c.status === 'Borrowed') {
      if (type === 'Damaged') return fail('This copy is on loan. Record its return first, then report the damage.');
      const t = activeLoans().find(a => a.copyId === c.id);
      if (t) { t.status = 'Lost'; t.lostAt = now(); loanTxnId = t.id; loanMember = t.memberId; } // loan closed as Lost; history kept
    }
    const prev = c.status;
    const r = { id: nextId(state.damageReports, 'DR-', 4), copyId: c.id, bookId: c.bookId, type, description: desc, reportedAt: now(), reportedBy: who, reportedByRole: state.demoRole,
      status: 'Reported', previousStatus: prev, repairStartedAt: null, repairNotes: '', resolvedAt: null, resolution: null, resolutionNotes: '', loanTxnId };
    state.damageReports.push(r); c.status = type;
    logCondition(c, `Reported ${type}`, prev, type, c.condition, c.condition, desc + (loanTxnId ? ` (closed loan ${loanTxnId})` : ''));
    logEvent(type === 'Lost' ? 'Lost Reported' : 'Damage Reported', { copyId: c.id, bookId: c.bookId, reportId: r.id, txnId: loanTxnId }, `${desc} (reported by ${who}).`);
    if (loanTxnId) logEvent('Loan Closed as Lost', { txnId: loanTxnId, copyId: c.id, bookId: c.bookId, memberId: loanMember, reportId: r.id }, `Loan ${loanTxnId} closed because the copy was reported lost.`);
    save(); return ok(clone(r));
  }
  function startRepair(reportId, notes) {
    const x = deny('damage'); if (x) return x;
    const r = report(reportId); if (!r) return fail('Report not found.');
    if (r.type !== 'Damaged') return fail('Only damaged copies can be sent for repair.');
    if (r.status !== 'Reported') return fail(`Report is already "${r.status}"; repair can only start from "Reported".`);
    const c = copy(r.copyId); if (!c) return fail('Copy not found.');
    r.status = 'Under Repair'; r.repairStartedAt = now(); r.repairNotes = str(notes);
    const from = c.status; c.status = 'Under Repair';
    logCondition(c, 'Repair started', from, 'Under Repair', c.condition, c.condition, str(notes));
    logEvent('Moved to Repair', { copyId: c.id, bookId: c.bookId, reportId: r.id }, str(notes) || 'Repair started.');
    save(); return ok(clone(r));
  }
  function resolveReport(reportId, d) {
    const x = deny('damage'); if (x) return x;
    const r = report(reportId); if (!r) return fail('Report not found.');
    if (!isOpen(r)) return fail(`Report ${r.id} is already ${r.status.toLowerCase()}; it cannot be changed.`);
    const allowed = r.type === 'Lost' ? ['Found', 'Written off'] : ['Repaired', 'Written off'];
    if (!allowed.includes(d.resolution)) return fail(`Resolution must be one of: ${allowed.join(', ')}.`);
    if (d.resolution === 'Repaired' && r.status !== 'Under Repair') return fail('Start the repair first (status must be Under Repair) before marking the copy Repaired.');
    const notes = str(d.notes); if (notes.length < 3) return fail('Enter resolution notes (at least 3 characters).');
    const c = copy(r.copyId); if (!c) return fail('Copy not found.');
    const restore = d.resolution !== 'Written off';
    let cond = c.condition;
    if (restore) {
      cond = str(d.conditionAfter);
      if (!CONDITIONS.includes(cond)) return fail('Select the condition of the copy after resolution.');
      if (cond === 'Worn') return fail('A copy in Worn condition cannot go back into circulation. Choose its real condition if it is usable, or write it off.');
      if (activeLoans().some(a => a.copyId === c.id)) return fail('This copy still has an active loan, so it cannot be restored to Available.');
    }
    const fromS = c.status, fromC = c.condition;
    c.status = restore ? 'Available' : 'Withdrawn'; c.condition = cond; // availability is restored ONLY for Repaired / Found
    Object.assign(r, { status: restore ? 'Resolved' : 'Closed', resolvedAt: now(), resolution: d.resolution, resolutionNotes: notes, resolvedBy: actor() });
    if (!restore) r.closedAt = r.resolvedAt;
    logCondition(c, `Resolved: ${d.resolution}`, fromS, c.status, fromC, cond, notes);
    logEvent(d.resolution === 'Repaired' ? 'Repair Completed' : d.resolution === 'Found' ? 'Copy Found' : 'Copy Written Off', { copyId: c.id, bookId: c.bookId, reportId: r.id }, notes);
    save(); return ok(clone(r));
  }
  function closeReport(reportId, notes) {
    const x = deny('damage'); if (x) return x;
    const r = report(reportId); if (!r) return fail('Report not found.');
    if (r.status !== 'Resolved') return fail(`Only Resolved reports can be closed (this report is ${r.status}).`);
    const c = copy(r.copyId);
    r.status = 'Closed'; r.closedAt = now(); r.closedBy = actor();
    if (c) logCondition(c, 'Report closed', c.status, c.status, c.condition, c.condition, str(notes) || `Report ${r.id} closed.`);
    logEvent('Report Closed', { copyId: r.copyId, bookId: r.bookId, reportId: r.id }, str(notes) || `Report ${r.id} closed.`);
    save(); return ok(clone(r));
  }

  /* ---------- Read helpers ---------- */
  function eventsScoped() {
    const sc = scopedMemberId();
    return clone(state.eventLog.filter(e => !sc || e.memberId === sc)).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }

  function stats() {
    const today = DateUtil.today(), soon = DateUtil.addDays(today, 3), loans = activeLoans();
    const byStatus = {}; COPY_STATUSES.forEach(s => { byStatus[s] = state.copies.filter(c => c.status === s).length; });
    return {
      titles: state.books.length, copies: state.copies.length, available: byStatus.Available, borrowed: byStatus.Borrowed,
      overdue: loans.filter(isOverdue).length, dueSoon: loans.filter(t => t.dueDate >= today && t.dueDate <= soon).length, dueToday: loans.filter(t => t.dueDate === today).length,
      activeMembers: state.members.filter(m => m.status === 'Active').length, totalMembers: state.members.length,
      damagedLost: byStatus.Damaged + byStatus['Under Repair'] + byStatus.Lost, byStatus,
      openReports: state.damageReports.filter(isOpen).length,
      borrowedToday: state.transactions.filter(t => t.borrowDate === today).length,
      returnedToday: state.transactions.filter(t => t.returnDate === today).length,
      renewedToday: state.transactions.reduce((n, t) => n + (t.renewals || []).filter(r => r.at.slice(0, 10) === today).length, 0)
    };
  }

  function reportData(from, to) {
    const inRange = d => (!from || d >= from) && (!to || d <= to);
    const T = state.transactions, ret = T.filter(t => t.status === 'Returned'), od = activeLoans().filter(isOverdue);
    const top = (key, nameFn) => { const m = {}; T.forEach(t => { m[t[key]] = (m[t[key]] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ name: nameFn(id), loans: n })); };
    const byStatus = {}; COPY_STATUSES.forEach(s => { byStatus[s] = state.copies.filter(c => c.status === s).length; });
    const categories = [...new Set(state.books.map(b => b.category))].sort().map(cat => {
      const ids = state.books.filter(b => b.category === cat).map(b => b.id), cs = state.copies.filter(c => ids.includes(c.bookId));
      return { category: cat, titles: ids.length, copies: cs.length, available: cs.filter(c => c.status === 'Available').length, onLoan: cs.filter(c => c.status === 'Borrowed').length,
        unavailable: cs.filter(c => WORKFLOW_STATUSES.includes(c.status)).length, loans: T.filter(t => ids.includes(t.bookId)).length };
    });
    const ev = state.eventLog.filter(e => inRange(e.at.slice(0, 10))), of = t => ev.filter(e => e.type === t);
    const R = state.damageReports;
    return {
      inventory: { titles: state.books.length, copies: state.copies.length, byStatus, categories },
      overdue: od.map(t => ({ id: t.id, copyId: t.copyId, title: (book(t.bookId) || {}).title || t.bookId, memberId: t.memberId, member: (member(t.memberId) || {}).name || t.memberId, dueDate: t.dueDate, days: daysOverdue(t), fine: projectedFine(t) })).sort((a, b) => b.days - a.days),
      problemCopies: state.copies.filter(c => WORKFLOW_STATUSES.includes(c.status)).map(c => {
        const r = R.filter(y => y.copyId === c.id).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))[0];
        return { copyId: c.id, title: (book(c.bookId) || {}).title || c.bookId, status: c.status, reportId: r ? r.id : '', reportStatus: r ? r.status : '', since: r ? r.reportedAt : '', description: r ? r.description : '' };
      }),
      activity: { borrowed: of('Book Borrowed').length, returned: of('Book Returned').length, renewed: of('Loan Renewed').length,
        events: ev.filter(e => ['Book Borrowed', 'Book Returned', 'Loan Closed as Lost'].includes(e.type)).sort((a, b) => b.at.localeCompare(a.at)), renewals: of('Loan Renewed').sort((a, b) => b.at.localeCompare(a.at)) },
      circulation: {
        total: T.length, active: activeLoans().length, returned: ret.length, lost: T.filter(t => t.status === 'Lost').length,
        renewals: T.reduce((n, t) => n + (t.renewals || []).length, 0),
        avgLoanDays: ret.length ? Math.round(ret.reduce((n, t) => n + DateUtil.diff(t.returnDate, t.borrowDate), 0) / ret.length * 10) / 10 : 0,
        onTimeRate: ret.length ? Math.round(ret.filter(t => !t.daysLate).length / ret.length * 100) : 0,
        finesAssessed: ret.reduce((n, t) => n + (t.fine || 0), 0), finesProjected: od.reduce((n, t) => n + projectedFine(t), 0), overdue: od.length
      },
      topTitles: top('bookId', id => (book(id) || {}).title || id),
      topBorrowers: top('memberId', id => (member(id) || {}).name || id),
      damage: { open: R.filter(isOpen).length, underRepair: R.filter(r => r.status === 'Under Repair').length, resolved: R.filter(r => r.status === 'Resolved').length,
        closed: R.filter(r => r.status === 'Closed').length, damaged: R.filter(r => r.type === 'Damaged').length, lost: R.filter(r => r.type === 'Lost').length,
        writtenOff: R.filter(r => r.resolution === 'Written off').length }
    };
  }

  function resetDemoData() {
    const x = deny('reset'); if (x) return x;
    const role = state.demoRole, mid = state.demoMemberId;
    state = Storage.reset(); state.demoRole = role; state.demoMemberId = member(mid) ? mid : ''; save(); return ok(true);
  }

  return {
    constants: { COPY_STATUSES, MANUAL_COPY_STATUSES, WORKFLOW_STATUSES, REPORT_STATUSES, CONDITIONS, MEMBER_TYPES, MEMBER_STATUSES, ROLES },
    can, health: () => ({ recovered: Storage.recovered, saveFailed: Storage.saveFailed }),
    getSession: () => ({ role: state.demoRole, memberId: state.demoMemberId, member: member(state.demoMemberId) ? clone(member(state.demoMemberId)) : null }),
    setRole, setSessionMember,
    getBooks: () => clone(state.books), getCopies: () => clone(state.copies), getMembers: () => clone(state.members),
    getTransactions: () => { const sc = scopedMemberId(); return clone(state.transactions.filter(t => !sc || t.memberId === sc)); },
    getSettings: () => clone(state.settings), updateSettings,
    getBook: id => { const b = book(id); return b ? clone(b) : null; },
    getCopy: id => { const c = copy(id); return c ? clone(c) : null; },
    getMember: id => { const m = member(id); return m ? clone(m) : null; },
    categories: () => [...new Set([...DEFAULT_CATEGORIES, ...state.books.map(b => b.category)])].sort(),
    bookCounts: bookId => { const cs = state.copies.filter(c => c.bookId === bookId); return { total: cs.length, available: cs.filter(c => c.status === 'Available').length }; },
    activeLoans: () => { const sc = scopedMemberId(); return clone(activeLoans().filter(t => !sc || t.memberId === sc)); },
    activeLoanOfCopy: copyId => { const t = activeLoans().find(x => x.copyId === copyId); return t ? clone(t) : null; },
    memberLoanInfo: id => { const m = member(id); if (!m) return null; const l = loansOf(id); return { count: l.length, limit: limitOf(m), overdue: l.filter(isOverdue).length }; },
    getReservations: () => clone(state.reservations), getReports: () => clone(state.damageReports),
    getConditionLog: () => isMemberRole() ? [] : clone(state.conditionLog).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)),
    getTransactionEvents: () => eventsScoped(), getOpenReportOf: id => { const r = openReportOf(id); return r ? clone(r) : null; },
    isOverdue, daysOverdue, projectedFine,
    addBook, updateBook, addCopy, updateCopy, deleteCopy, addMember, updateMember,
    eligibility, borrow, returnBook, renewalCheck, renew, createReservation, cancelReservation,
    reportCopy, startRepair, resolveReport, closeReport, stats, reportData, resetDemoData
  };
})();