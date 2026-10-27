/* Run with:  node tests/run-tests.js
   Tests the data layer (storage.js) and renders every page view (ui.js) in Node with a fake LocalStorage.
   This is NOT a browser test: clicks, layout, modals and CSV downloads still need manual checking (see README). */
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');

function makeLS(init) {
  const d = Object.assign({}, init || {});
  return { _d: d, getItem: k => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, removeItem: k => { delete d[k]; } };
}
function boot(ls, withUI) {
  const ctx = { localStorage: ls || makeLS(), console };
  vm.createContext(ctx);
  const code = ['data.js', 'storage.js'].concat(withUI ? ['ui.js'] : []).map(read).join('\n') +
    '\n;this.API=LibraryAPI;this.Storage=Storage;this.DateUtil=DateUtil;this.SeedData=SeedData;' + (withUI ? 'this.UI=UI;' : '');
  vm.runInContext(code, ctx);
  return ctx;
}

let pass = 0, failN = 0;
const results = [];
function test(name, fn) {
  try { fn(); pass++; results.push(['PASS', name]); } catch (e) { failN++; results.push(['FAIL', name + '  →  ' + e.message]); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'expected'}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); };
const yes = (v, m) => { if (!v) throw new Error(m || 'expected truthy'); };
const rejected = (r, re, m) => { yes(r && r.ok === false, (m || '') + ' should be rejected but ok=' + (r && r.ok)); if (re) yes(re.test(r.error), `error "${r.error}" should match ${re}`); };
const fresh = (role) => { const c = boot(); c.API.setRole(role || 'Librarian'); return c; };

/* ---------- Data layer ---------- */
test('Seed data loads with expected counts', () => {
  const { API } = fresh(); const s = API.stats();
  eq(s.titles, 12); eq(s.copies, 27); eq(s.overdue, 3); eq(s.byStatus['Under Repair'], 1); eq(s.byStatus.Damaged, 1); eq(s.byStatus.Lost, 1);
});

test('[S2] F1: damaged / lost / under-repair seed copies cannot be borrowed', () => {
  const { API } = fresh();
  ['B011-C02', 'B009-C02', 'B005-C02'].forEach(id => rejected(API.borrow('M-2026-003', id), /cannot be borrowed/, id));
});

test('[S1][S2] F1: report damage on available copy -> Damaged, report + condition log recorded, not borrowable', () => {
  const { API } = fresh();
  const logBefore = API.getConditionLog().length;
  const r = API.reportCopy('B001-C03', 'Damaged', 'Spine cracked badly'); yes(r.ok, r.error);
  eq(API.getCopy('B001-C03').status, 'Damaged'); yes(/^\d{4}-\d{2}-\d{2}T/.test(r.data.reportedAt), 'timestamp');
  eq(API.getConditionLog().length, logBefore + 1);
  rejected(API.borrow('M-2026-003', 'B001-C03'), /cannot be borrowed/);
  eq(API.bookCounts('B001').available, 0 + 0 + API.getCopies().filter(c => c.bookId === 'B001' && c.status === 'Available').length);
});

test('F1: duplicate open report, short description, and unknown copy are rejected', () => {
  const { API } = fresh();
  rejected(API.reportCopy('B011-C02', 'Lost', 'Cannot find it anywhere'), /already has an open report/);
  rejected(API.reportCopy('B001-C03', 'Damaged', 'x'), /at least 5/);
  rejected(API.reportCopy('NOPE', 'Damaged', 'valid description'), /valid copy/);
  rejected(API.reportCopy('B001-C03', 'Broken', 'valid description'), /Damaged or Lost/);
});

test('[S3] F1: damage on a borrowed copy rejected; Lost on borrowed copy closes loan but keeps history', () => {
  const { API } = fresh();
  rejected(API.reportCopy('B001-C01', 'Damaged', 'Water spill on cover'), /Record its return first/);
  const before = API.getTransactions().length;
  const r = API.reportCopy('B001-C01', 'Lost', 'Member says the book was stolen'); yes(r.ok, r.error);
  eq(API.getCopy('B001-C01').status, 'Lost'); eq(API.getTransactions().length, before);
  eq(API.getTransactions().find(t => t.id === 'T-0011').status, 'Lost');
  eq(API.memberLoanInfo('M-2026-001').count, 1); // only B012 loan remains active
  yes(API.getTransactionEvents().some(e => e.txnId === 'T-0011' && e.type === 'Loan Closed as Lost'), 'history event');
});

test('[S4] F1: repair workflow Reported -> Under Repair -> Repaired restores Available only at the end', () => {
  const { API } = fresh();
  rejected(API.resolveReport('DR-0001', { resolution: 'Repaired', conditionAfter: 'Good', notes: 'fixed' }), /Start the repair first/);
  yes(API.startRepair('DR-0001', 'Taping and rebinding').ok);
  eq(API.getCopy('B011-C02').status, 'Under Repair'); rejected(API.borrow('M-2026-003', 'B011-C02'), /cannot be borrowed/);
  rejected(API.startRepair('DR-0001', ''), /already/);
  rejected(API.resolveReport('DR-0001', { resolution: 'Repaired', conditionAfter: 'Good', notes: '' }), /notes/);
  yes(API.resolveReport('DR-0001', { resolution: 'Repaired', conditionAfter: 'Fair', notes: 'Rebound' }).ok);
  eq(API.getCopy('B011-C02').status, 'Available'); eq(API.getCopy('B011-C02').condition, 'Fair');
  rejected(API.resolveReport('DR-0001', { resolution: 'Repaired', conditionAfter: 'Good', notes: 'again' }), /already resolved/);
  yes(API.borrow('M-2026-003', 'B011-C02').ok);
});

test('F1: Lost -> Found restores; Lost cannot be "Repaired"; Written off withdraws copy permanently', () => {
  const { API } = fresh();
  rejected(API.resolveReport('DR-0002', { resolution: 'Repaired', conditionAfter: 'Good', notes: 'xx yy' }), /must be one of/);
  yes(API.resolveReport('DR-0002', { resolution: 'Found', conditionAfter: 'Good', notes: 'Found behind shelf' }).ok);
  eq(API.getCopy('B009-C02').status, 'Available');
  yes(API.resolveReport('DR-0001', { resolution: 'Written off', notes: 'Beyond repair' }).ok);
  eq(API.getCopy('B011-C02').status, 'Withdrawn');
  rejected(API.borrow('M-2026-003', 'B011-C02'), /cannot be borrowed/);
  rejected(API.updateCopy('B011-C02', { condition: 'Good', location: 'Shelf X', status: 'Available' }), /Resolve it under Damage/);
  rejected(API.reportCopy('B011-C02', 'Lost', 'Trying again on withdrawn'), /withdrawn/i);
});

test('F1: borrowing history is preserved after damage/lost handling; manual status edits cannot bypass workflow', () => {
  const { API } = fresh(); const n = API.getTransactions().length;
  API.reportCopy('B001-C03', 'Damaged', 'Torn cover page'); eq(API.getTransactions().length, n);
  rejected(API.updateCopy('B001-C03', { condition: 'Good', location: 'Shelf IT-A1', status: 'Available' }), /Damage and Lost/);
  rejected(API.updateCopy('B001-C02', { condition: 'Good', location: 'Shelf IT-A1', status: 'Damaged' }), /only be set to Available or Reserved/);
});

test('[S6] F2: renew succeeds, records previous/new due dates, renewal count and history event', () => {
  const { API } = fresh(); const before = API.getTransactions().find(t => t.id === 'T-0011');
  const r = API.renew('T-0011'); yes(r.ok, r.error);
  const exp = boot().DateUtil.addDays(before.dueDate, 7); eq(r.data.dueDate, exp, 'new due date');
  eq(r.data.renewals[0].previousDueDate, before.dueDate); eq(r.data.renewals[0].newDueDate, exp); eq(r.data.renewalCount, 1);
  yes(API.getTransactionEvents().some(e => e.txnId === 'T-0011' && e.type === 'Loan Renewed' && e.description.includes(exp)), 'history event');
});

test('[S7] F2: renewal limit enforced (T-0010 already renewed once, max 2)', () => {
  const { API } = fresh();
  yes(API.renew('T-0010').ok); rejected(API.renew('T-0010'), /Renewal limit reached \(2 of 2\)/);
});

test('[S9] F2: returned transaction cannot be renewed', () => { rejected(fresh().API.renew('T-0001'), /only active loans/); });

test('F2: unknown transaction rejected', () => { rejected(fresh().API.renew('T-9999'), /not found/); });

test('F2: non-Active member cannot renew', () => {
  const { API } = fresh(); const m = API.getMember('M-2026-006');
  yes(API.updateMember('M-2026-006', { ...m, status: 'Suspended' }).ok);
  rejected(API.renew('T-0009'), /Suspended/);
});

test('F2: ineligible copy (open report on a borrowed copy) cannot be renewed', () => {
  const ls = makeLS(); const c0 = boot(ls); const raw = JSON.parse(ls.getItem('lms_demo_data_v1'));
  raw.copies.find(c => c.id === 'B001-C01').status = 'Damaged'; ls.setItem('lms_demo_data_v1', JSON.stringify(raw));
  const c = boot(ls); c.API.setRole('Librarian'); rejected(c.API.renew('T-0011'), /not eligible/);
});

test('[S8] F2: another member\'s active reservation blocks renewal; cancelling it allows renewal', () => {
  const { API } = fresh();
  rejected(API.renew('T-0012'), /active reservation/);            // B012 reserved by M-2026-003
  yes(API.cancelReservation('R-0002').ok); yes(API.renew('T-0012').ok);
  yes(API.createReservation('M-2026-002', 'B004').ok); rejected(API.renew('T-0009'), /active reservation/);
});

test('F2: reservation validation (duplicate, holder reserving own loan, inactive member)', () => {
  const { API } = fresh();
  rejected(API.createReservation('M-2026-005', 'B003'), /already has an active reservation/);
  rejected(API.createReservation('M-2026-001', 'B001'), /already has this title on loan/);
  rejected(API.createReservation('M-2026-010', 'B001'), /Inactive/);
});

test('[S10] F2: overdue renewal rejected by default, allowed by setting; new due counts from today; overdue days still fined', () => {
  const { API, DateUtil } = fresh('System Administrator');
  rejected(API.renew('T-0008'), /does not allow renewing overdue/);
  const s = API.getSettings(); yes(API.updateSettings({ ...s, allowOverdueRenewal: 'Yes' }).ok);
  const r = API.renew('T-0008'); yes(r.ok, r.error);
  eq(r.data.dueDate, DateUtil.addDays(DateUtil.today(), 7)); eq(r.data.priorOverdueDays, 3);
  const ret = API.returnBook('B002-C01'); yes(ret.ok); eq(ret.data.daysLate, 3); eq(ret.data.fine, 15);
});

test('[S11] F3: overdue calculation — seeded loans are 6, 5 and 3 days overdue; due today is NOT overdue', () => {
  const { API, DateUtil } = fresh();
  const od = API.activeLoans().filter(API.isOverdue).map(t => API.daysOverdue(t)).sort((a, b) => b - a);
  eq(JSON.stringify(od), '[6,5,3]');
  const t = { status: 'Borrowed', dueDate: DateUtil.today(), priorOverdueDays: 0 }; eq(API.isOverdue(t), false); eq(API.daysOverdue(t), 0);
  eq(API.projectedFine(API.activeLoans().find(x => x.id === 'T-0006')), 30);
});

test('F3: DateUtil handles month ends, leap years and DST-length days', () => {
  const { DateUtil: D } = boot();
  eq(D.diff('2026-03-01', '2026-02-28'), 1); eq(D.diff('2028-03-01', '2028-02-28'), 2); eq(D.addDays('2026-12-31', 1), '2027-01-01'); eq(D.diff('2026-11-02', '2026-10-25'), 8);
});

test('F4: transaction events include borrow, renew, return, filtered by role scope', () => {
  const { API } = fresh();
  const ev = API.getTransactionEvents(); yes(ev.some(e => e.type === 'Loan Renewed') && ev.some(e => e.type === 'Book Returned') && ev.some(e => e.type === 'Book Borrowed'));
  API.setRole('Student'); API.setSessionMember('M-2026-004');
  const mine = API.getTransactionEvents(); yes(mine.length > 0 && mine.every(e => e.memberId === 'M-2026-004'), 'scoped to own member');
  eq(API.getConditionLog().length, 0, 'members get no condition log');
});

test('F5: reportData reflects actual data (counts change after a borrow)', () => {
  const { API } = fresh(); const a = API.reportData().circulation.total;
  yes(API.borrow('M-2026-003', 'B006-C02').ok); eq(API.reportData().circulation.total, a + 1);
  yes(API.reportData().topTitles.length > 0 && API.reportData().inventory.categories.length > 0);
});

test('[S15] F6: settings validation, admin-only editing, and effect on new loans', () => {
  const { API } = fresh('Librarian'); const s = API.getSettings();
  rejected(API.updateSettings({ ...s }), /Permission denied/);
  API.setRole('System Administrator');
  rejected(API.updateSettings({ ...s, libraryName: ' ' }), /Library name/);
  rejected(API.updateSettings({ ...s, studentLimit: '-1' }), /Student borrowing limit/);
  rejected(API.updateSettings({ ...s, maxRenewals: '1.5' }), /Maximum renewals/);
  rejected(API.updateSettings({ ...s, allowOverdueRenewal: 'Maybe' }), /Yes or No/);
  yes(API.updateSettings({ ...s, libraryName: 'Test Library', studentLoanDays: '10', studentLimit: '1', allowOverdueRenewal: 'No' }).ok);
  eq(API.getSettings().libraryName, 'Test Library');
  const t = API.borrow('M-2026-003', 'B006-C02'); yes(t.ok); eq(boot().DateUtil.diff(t.data.dueDate, t.data.borrowDate), 10);
  rejected(API.borrow('M-2026-003', 'B007-C02'), /Borrowing limit reached/);
});

test('F7: role permissions are enforced by the API (demo only)', () => {
  const { API } = fresh('Student');
  rejected(API.borrow('M-2026-003', 'B006-C02'), /Permission denied/); rejected(API.addBook({}), /Permission denied/);
  rejected(API.renew('T-0008'), /only renew their own/); rejected(API.resetDemoData(), /Permission denied/); yes(API.renew('T-0011').ok, 'member renews own loan');
  API.setRole('Librarian'); yes(API.borrow('M-2026-003', 'B006-C02').ok); rejected(API.resetDemoData(), /Permission denied/);
  API.setRole('System Administrator'); yes(API.resetDemoData().ok); eq(API.getSession().role, 'System Administrator', 'role kept after reset');
});

test('F7: setRole picks a matching member for member roles', () => {
  const { API } = fresh(); API.setRole('Faculty'); eq(API.getMember(API.getSession().memberId).type, 'Faculty');
  rejected(API.setSessionMember('M-2026-001'), /matches the selected role/);
});

/* ---------- Part 1 regression ---------- */
test('[S17] Part 1: borrowing rules still enforced (overdue, suspended, unavailable, duplicate title, limit, double return)', () => {
  const { API } = fresh();
  rejected(API.borrow('M-2026-004', 'B009-C01'), /overdue/); rejected(API.borrow('M-2026-008', 'B009-C01'), /Suspended/);
  rejected(API.borrow('M-2026-003', 'B001-C01'), /cannot be borrowed/); rejected(API.borrow('M-2026-001', 'B001-C03'), /Duplicate borrowing/);
  yes(API.borrow('M-2026-003', 'B006-C02').ok); yes(API.returnBook('B006-C02').ok); rejected(API.returnBook('B006-C02'), /not currently on loan/);
});
test('[S17] Part 1: duplicate ISBN rejected on add and edit', () => {
  const { API } = fresh(); const b = { title: 'T', author: 'A', isbn: '978-971-0000-011', category: 'Business', year: 2020 };
  rejected(API.addBook(b), /Duplicate ISBN/); yes(API.addBook({ ...b, isbn: '9789719999999' }).ok); rejected(API.updateBook('B002', { ...b, isbn: '9789710000011' }), /Duplicate ISBN/);
});
test('[S17] Part 1: copy IDs are unique and sequential', () => {
  const { API } = fresh(); const a = API.addCopy('B001', { condition: 'New', location: 'Shelf IT-A1' }), b = API.addCopy('B001', { condition: 'New', location: 'Shelf IT-A1' });
  eq(a.data.id, 'B001-C04'); eq(b.data.id, 'B001-C05');
});

/* ---------- Persistence & invalid data ---------- */
test('[S13] Persistence: changes survive a reload (new context, same LocalStorage)', () => {
  const ls = makeLS(); const a = boot(ls); a.API.setRole('Librarian');
  yes(a.API.borrow('M-2026-003', 'B006-C02').ok); yes(a.API.renew('T-0011').ok); yes(a.API.reportCopy('B001-C03', 'Damaged', 'Torn cover page').ok);
  const b = boot(ls); eq(b.API.getTransactions().length, 13); eq(b.API.getCopy('B001-C03').status, 'Damaged'); eq(b.API.getTransactions().find(t => t.id === 'T-0011').renewalCount, 1);
  eq(b.API.getSession().role, 'Librarian');
});
test('Invalid LocalStorage: garbage JSON -> sample data restored, flagged, backup kept', () => {
  const ls = makeLS({ lms_demo_data_v1: '{not json' }); const c = boot(ls);
  eq(c.API.stats().titles, 12); yes(c.API.health().recovered); eq(ls.getItem('lms_demo_data_v1_corrupt_backup'), '{not json');
});
test('Invalid LocalStorage: valid JSON with wrong shape / broken references is rejected', () => {
  [JSON.stringify({ books: 'x' }), JSON.stringify({}), 'null', '[]'].forEach(raw => { const c = boot(makeLS({ lms_demo_data_v1: raw })); yes(c.API.health().recovered, raw); eq(c.API.stats().titles, 12); });
  const ls = makeLS(); const base = boot(ls); const raw = JSON.parse(ls.getItem('lms_demo_data_v1')); raw.transactions[0].memberId = 'M-GHOST'; ls.setItem('lms_demo_data_v1', JSON.stringify(raw));
  yes(boot(ls).API.health().recovered, 'dangling reference');
});
test('Migration: Part 1 data (no new fields) upgrades in place and keeps user records', () => {
  const ls = makeLS(); const base = boot(ls); const raw = JSON.parse(ls.getItem('lms_demo_data_v1'));
  ['reservations', 'damageReports', 'conditionLog', 'demoRole', 'demoMemberId'].forEach(k => delete raw[k]); raw.version = 1;
  raw.settings = { studentLoanDays: 9, facultyLoanDays: 14, studentLimit: 3, facultyLimit: 5, finePerDay: 5 };
  raw.transactions.forEach(t => { delete t.renewals; delete t.renewalCount; delete t.originalDueDate; delete t.priorOverdueDays; });
  raw.members.push({ id: 'M-2026-011', name: 'Part One User', type: 'Student', email: 'p1@example.edu', program: 'BSIT-1A', status: 'Active', joinedAt: '2026-01-01' });
  ls.setItem('lms_demo_data_v1', JSON.stringify(raw));
  const c = boot(ls); c.API.setRole('Librarian');
  yes(!c.API.health().recovered, 'should migrate, not reset'); eq(c.API.getMembers().length, 11); eq(c.API.getSettings().studentLoanDays, 9); eq(c.API.getSettings().maxRenewals, 2);
  yes(c.API.getReports().some(r => r.copyId === 'B011-C02' && r.status !== 'Resolved'), 'report created for Damaged copy');
  yes(c.API.renew('T-0011').ok, 'renewal works on migrated txn');
});


/* ---------- Part 2b additions ---------- */
test('[S5] Invalid report status transitions are rejected (Closed is final; no repair after resolve; no close before resolve)', () => {
  const { API } = fresh();
  rejected(API.closeReport('DR-0001', ''), /Only Resolved reports/);          // Reported -> Closed not allowed
  rejected(API.startRepair('DR-0002', ''), /Only damaged copies/);             // lost copies cannot be repaired
  rejected(API.startRepair('DR-0003', ''), /already/);                         // already Under Repair
  rejected(API.startRepair('DR-0004', ''), /already/);                         // already Resolved
  rejected(API.resolveReport('DR-0001', { resolution: 'Found', conditionAfter: 'Good', notes: 'nope nope' }), /must be one of/);
  rejected(API.resolveReport('DR-9999', {}), /not found/);
  yes(API.closeReport('DR-0004', 'Archived').ok); eq(API.getReports().find(r => r.id === 'DR-0004').status, 'Closed');
  rejected(API.closeReport('DR-0004', ''), /Only Resolved/);                   // closed is final
  rejected(API.resolveReport('DR-0004', { resolution: 'Repaired', conditionAfter: 'Good', notes: 'again' }), /already closed/);
  rejected(API.startRepair('DR-0004', ''), /already/);
});

test('[S4] Restoring to Available needs a usable condition; Written off closes the report and withdraws the copy', () => {
  const { API } = fresh();
  rejected(API.resolveReport('DR-0003', { resolution: 'Repaired', conditionAfter: 'Worn', notes: 'Rebound' }), /Worn/);
  eq(API.getCopy('B005-C02').status, 'Under Repair', 'not restored after rejection');
  yes(API.resolveReport('DR-0003', { resolution: 'Repaired', conditionAfter: 'Fair', notes: 'Rebound' }).ok); eq(API.getCopy('B005-C02').status, 'Available');
  yes(API.resolveReport('DR-0001', { resolution: 'Written off', notes: 'Beyond repair' }).ok);
  eq(API.getReports().find(r => r.id === 'DR-0001').status, 'Closed'); eq(API.getCopy('B011-C02').status, 'Withdrawn');
});

test('[S13] Event log: real actions are recorded with stable IDs, actor, related IDs, reporter; everything persists after reload', () => {
  const ls = makeLS(); const a = boot(ls); a.API.setRole('Librarian'); const API = a.API;
  const n = API.getTransactionEvents().length, c0 = API.getConditionLog().length;
  const t = API.borrow('M-2026-003', 'B006-C02'); yes(t.ok, t.error);
  yes(API.renew(t.data.id).ok);
  const rep = API.reportCopy('B001-C03', 'Damaged', 'Cracked spine badly', 'Ana Cruz'); yes(rep.ok, rep.error);
  eq(rep.data.reportedBy, 'Ana Cruz'); eq(rep.data.reportedByRole, 'Librarian'); eq(rep.data.id, 'DR-0005');
  yes(API.startRepair(rep.data.id, 'Rebinding').ok);
  yes(API.resolveReport(rep.data.id, { resolution: 'Repaired', conditionAfter: 'Good', notes: 'Rebound' }).ok);
  yes(API.closeReport(rep.data.id, 'Done').ok);
  yes(API.updateCopy('B002-C03', { condition: 'New', location: 'Shelf IT-A2', status: 'Reserved' }).ok);
  eq(API.getTransactionEvents().length, n + 7); // borrow, renew, report, repair, resolve, close, status change
  const b = boot(ls); b.API.setRole('Librarian'); const ev = b.API.getTransactionEvents();
  ['Book Borrowed', 'Loan Renewed', 'Damage Reported', 'Moved to Repair', 'Repair Completed', 'Report Closed', 'Copy Status Changed']
    .forEach(type => yes(ev.some(e => e.type === type && !e.backfilled && e.actor.includes('Demo Librarian')), 'persisted event: ' + type));
  eq(new Set(ev.map(e => e.id)).size, ev.length, 'event IDs unique');
  const dmg = ev.find(e => e.type === 'Damage Reported' && !e.backfilled); eq(dmg.reportId, 'DR-0005'); eq(dmg.copyId, 'B001-C03');
  yes(b.API.getConditionLog().filter(l => l.copyId === 'B001-C03').length >= 4, 'condition history kept');
  eq(b.API.getConditionLog().length, c0 + 5); // report, repair, resolve, close, manual update
  eq(b.API.getTransactions().find(x => x.id === t.data.id).renewalCount, 1, 'renewal persisted');
});

test('Event log is append-only: updating records never removes earlier history', () => {
  const { API } = fresh(); const before = API.getTransactionEvents().map(e => e.id);
  API.renew('T-0011'); API.reportCopy('B001-C03', 'Lost', 'Missing from shelf'); API.returnBook('B004-C01');
  const after = API.getTransactionEvents().map(e => e.id); yes(before.every(id => after.includes(id)), 'old events still present'); yes(after.length > before.length);
});

test('[S6] Members see only their own loans and may request renewal only for their own eligible loans', () => {
  const { API } = fresh('Student'); eq(API.getSession().memberId, 'M-2026-001');
  yes(API.activeLoans().length === 2 && API.activeLoans().every(t => t.memberId === 'M-2026-001'), 'scoped loans');
  rejected(API.renew('T-0012'), /active reservation/); rejected(API.renew('T-0008'), /only renew their own/);
  rejected(API.reportCopy('B001-C03', 'Damaged', 'Not allowed here'), /Permission denied/);
  const r = API.renew('T-0011'); yes(r.ok, r.error); eq(r.data.renewalCount, 1);
  yes(API.getTransactionEvents().some(e => e.type === 'Loan Renewed' && !e.backfilled && e.actor.includes('Angela Reyes')), 'actor is the member');
});

test('[S12] Returned loans leave the overdue list; renewing an overdue loan (when allowed) also removes it', () => {
  const { API } = fresh(); const ids = () => API.activeLoans().filter(API.isOverdue).map(t => t.id);
  yes(ids().includes('T-0008')); yes(API.returnBook('B002-C01').ok); yes(!ids().includes('T-0008')); eq(ids().length, 2);
  API.setRole('System Administrator'); yes(API.updateSettings({ ...API.getSettings(), allowOverdueRenewal: 'Yes' }).ok); API.setRole('Librarian');
  yes(API.renew('T-0006').ok); yes(!ids().includes('T-0006')); eq(ids().length, 1);
});

test('Duplicate-click guard: UI.once blocks a repeat within the window, not afterwards or for other keys', () => {
  const c = boot(makeLS(), true); const U = c.UI;
  eq(U.once('renew:T-1', 50), true); eq(U.once('renew:T-1', 50), false); eq(U.once('renew:T-2', 50), true);
  const t0 = Date.now(); while (Date.now() - t0 < 60) { /* wait */ } eq(U.once('renew:T-1', 50), true);
});

test('[S14] CSV escaping: commas, quotes, newlines, formula characters, BOM and CRLF rows', () => {
  const c = boot(makeLS(), true);
  const txt = c.UI.csvText(['A', 'B'], [['x,y', 'say "hi"'], ['line1\nline2', '=SUM(A1)'], [null, 5]]);
  yes(txt.startsWith('\ufeffA,B\r\n'), 'BOM + header'); yes(txt.includes('"x,y","say ""hi"""'), 'comma+quote');
  yes(txt.includes('"line1\nline2",\'=SUM(A1)'), 'newline + formula guard'); yes(txt.endsWith(',5'), 'null/number');
});

test('[S14] Overdue and history CSV contain real data (headers, row counts, status, actor)', () => {
  const c = boot(makeLS(), true); c.API.setRole('Librarian');
  const [h, rows] = c.UI.views.overdue.csv(c.UI.views.overdue.all()); eq(rows.length, 3); eq(rows[0].length, h.length); eq(rows[0][10], 'Overdue');
  const [h2, rows2] = c.UI.views.history.csv(c.API.getTransactionEvents()); eq(rows2[0].length, h2.length); yes(h2.includes('Actor') && h2.includes('Event ID'));
});

test('Reports: computed from data and respect date filters; empty periods give zeros', () => {
  const { API, DateUtil } = fresh(); const d0 = API.reportData();
  eq(d0.inventory.copies, 27); eq(d0.overdue.length, 3); eq(d0.problemCopies.length, 3); yes(d0.activity.borrowed >= 12);
  const future = API.reportData('2999-01-01', '2999-12-31'); eq(future.activity.borrowed, 0); eq(future.activity.renewed, 0); eq(future.activity.events.length, 0);
  const today = DateUtil.today(); eq(API.reportData(today, today).activity.renewed, 0);
  yes(API.renew('T-0011').ok); eq(API.reportData(today, today).activity.renewed, 1); eq(API.reportData(today, today).activity.borrowed, 0);
  yes(API.borrow('M-2026-003', 'B006-C02').ok); eq(API.reportData(today, today).activity.borrowed, 1);
});

test('[S15] Library name shows on the dashboard; settings persist after reload and change later operations', () => {
  const ls = makeLS(); const a = boot(ls, true); a.API.setRole('System Administrator');
  yes(a.API.updateSettings({ ...a.API.getSettings(), libraryName: 'Mabini College Library', renewalDays: '10', maxRenewals: '3', allowOverdueRenewal: 'No' }).ok);
  const b = boot(ls, true); yes(b.UI.views.dashboard.render().includes('Mabini College Library')); eq(b.API.getSettings().renewalDays, 10);
  b.API.setRole('Librarian'); const before = b.API.getTransactions().find(t => t.id === 'T-0011').dueDate; const r = b.API.renew('T-0011'); yes(r.ok);
  eq(b.DateUtil.diff(r.data.dueDate, before), 10, 'renewal uses new duration');
});

test('[S16] Reset restores sample data AND default settings (role kept); non-admin cannot reset', () => {
  const { API } = fresh('System Administrator'); const seedEvents = boot().API.getTransactionEvents().length;
  yes(API.updateSettings({ ...API.getSettings(), libraryName: 'Changed', maxRenewals: '5', studentLimit: '9', allowOverdueRenewal: 'No' }).ok);
  yes(API.borrow('M-2026-003', 'B006-C02').ok); yes(API.reportCopy('B001-C03', 'Damaged', 'Cracked spine').ok);
  yes(API.resetDemoData().ok);
  eq(API.getSettings().libraryName, 'College Library'); eq(API.getSettings().maxRenewals, 2); eq(API.getSettings().studentLimit, 3);
  eq(API.getTransactions().length, 12); eq(API.getCopy('B001-C03').status, 'Available'); eq(API.getReports().length, 4); eq(API.getTransactionEvents().length, seedEvents);
  eq(API.getSession().role, 'System Administrator'); API.setRole('Librarian'); rejected(API.resetDemoData(), /Permission denied/);
});

test('[S17] Member management still works (add, edit, duplicate email) and catalog add/edit still works', () => {
  const { API } = fresh(); const m = API.addMember({ name: 'New Person', type: 'Student', email: 'new.person@example.edu', program: 'BSIT-1A' }); yes(m.ok, m.error);
  rejected(API.addMember({ name: 'Dup', type: 'Student', email: 'new.person@example.edu', program: 'X' }), /already registered/);
  yes(API.updateMember(m.data.id, { ...m.data, status: 'Suspended' }).ok); rejected(API.borrow(m.data.id, 'B006-C02'), /Suspended/);
  const b = API.addBook({ title: 'New Book', author: 'A. Writer', isbn: '9789719999001', category: 'Business', year: 2024 }); yes(b.ok); yes(API.addCopy(b.data.id, { condition: 'New', location: 'Shelf X' }).ok);
});

test('Existing v2 data without an event log is upgraded (history backfilled) and malformed log entries are dropped', () => {
  const ls = makeLS(); boot(ls); const raw = JSON.parse(ls.getItem('lms_demo_data_v1')); delete raw.eventLog; ls.setItem('lms_demo_data_v1', JSON.stringify(raw));
  const c = boot(ls); c.API.setRole('Librarian'); const ev = c.API.getTransactionEvents();
  yes(!c.API.health().recovered); yes(ev.some(e => e.txnId === 'T-0005' && e.type === 'Loan Renewed') && ev.every(e => e.backfilled));
  raw.eventLog = [null, { id: 1 }, { id: 'EV-0001', at: '2026-01-01T00:00:00', type: 'Book Borrowed', description: 'x' }]; raw.conditionLog.push({ junk: true }); raw.damageReports.push({ id: 'DR-X', status: 'Weird' });
  ls.setItem('lms_demo_data_v1', JSON.stringify(raw)); const d = boot(ls); d.API.setRole('Librarian');
  eq(d.API.getTransactionEvents().length, 1); eq(d.API.getReports().length, 4); yes(d.API.getConditionLog().every(l => l.id));
});

test('Settings page is visible only to System Administrator; member roles get own-loans renewal page', () => {
  const c = boot(makeLS(), true); const html = r => { c.API.setRole(r); return c.UI.views.renewals.render(); };
  yes(html('Student').includes('My Loans and Renewals') && !html('Student').includes('Title Reservations'));
  yes(html('Librarian').includes('Title Reservations')); eq(c.API.can('settings'), false); c.API.setRole('System Administrator'); eq(c.API.can('settings'), true);
});

test('Time-zone safety: overdue / due-today decisions use calendar dates (suite is also run under several TZ values)', () => {
  const { API, DateUtil } = fresh(); const today = DateUtil.today();
  eq(API.isOverdue({ status: 'Borrowed', dueDate: today }), false); eq(API.isOverdue({ status: 'Borrowed', dueDate: DateUtil.addDays(today, -1) }), true);
  eq(API.daysOverdue({ status: 'Borrowed', dueDate: DateUtil.addDays(today, -7) }), 7); eq(API.isOverdue({ status: 'Returned', dueDate: DateUtil.addDays(today, -7) }), false);
  eq(JSON.stringify(API.activeLoans().filter(API.isOverdue).map(t => API.daysOverdue(t)).sort((a, b) => b - a)), '[6,5,3]');
});

/* ---------- View rendering smoke test (no DOM events, no browser) ---------- */
test('Every page renders without errors for every demo role (smoke test)', () => {
  const c = boot(makeLS(), true), pages = ['dashboard', 'catalog', 'copies', 'members', 'circulation', 'renewals', 'damage', 'overdue', 'history', 'reports', 'settings'];
  ['Student', 'Faculty', 'Librarian', 'System Administrator'].forEach(role => {
    c.API.setRole(role);
    pages.forEach(p => { const v = c.UI.views[p]; const html = v.render(); yes(typeof html === 'string' && html.length > 50, `${role}/${p} render`); if (v.table) yes(typeof v.table() === 'string', `${role}/${p} table`); });
  });
  c.API.setRole('Librarian'); c.UI.filters.history.tab = 'condition'; yes(c.UI.views.history.table().includes('Reported Damaged'), 'condition tab content');
});
test('Filters narrow results (overdue scope/bucket/type, history search/type/date)', () => {
  const c = boot(makeLS(), true); c.API.setRole('Librarian'); const U = c.UI;
  eq(U.views.overdue.list().length, 3); U.filters.overdue.bucket = '1-7'; eq(U.views.overdue.list().length, 3);
  U.filters.overdue.type = 'Faculty'; eq(U.views.overdue.list().length, 1); U.filters.overdue.type = ''; U.filters.overdue.bucket = '8-14'; eq(U.views.overdue.list().length, 0);
  U.filters.overdue.bucket = ''; U.filters.overdue.scope = 'all'; eq(U.views.overdue.list().length, 7);
  U.filters.history.q = 'T-0005'; eq(U.views.history.events().length, 3, 'borrow+renew+return events for T-0005');
  U.filters.history.type = 'Loan Renewed'; eq(U.views.history.events().length, 1);
  U.filters.history.from = '2999-01-01'; eq(U.views.history.events().length, 0);
});
test('[S14] CSV row builders produce expected shape', () => {
  const c = boot(makeLS(), true); c.API.setRole('Librarian'); const [h, rows] = c.UI.views.overdue.csv(c.UI.views.overdue.all());
  eq(rows.length, 3); eq(rows[0].length, h.length); eq(rows[0][8], 6);
  const [h2, rows2] = c.UI.views.history.csv(c.API.getTransactionEvents()); yes(rows2.length > 10); eq(rows2[0].length, h2.length);
});

console.log(results.map(r => `${r[0]}  ${r[1]}`).join('\n'));
console.log(`\n${pass} passed, ${failN} failed, ${pass + failN} total`);
process.exit(failN ? 1 : 0);
