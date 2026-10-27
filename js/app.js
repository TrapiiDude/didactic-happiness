/* app.js — routing, demo role selector, event wiring, and form definitions.
   Demo roles only simulate permissions in this browser; they are NOT authentication. */
(function () {
  const $ = UI.$;
  const PAGES = [
    ['dashboard', 'Dashboard', '📊'], ['catalog', 'Book Catalog', '📖'], ['copies', 'Book Copies', '🔖'], ['members', 'Members', '👥'],
    ['circulation', 'Borrowing and Returns', '🔄'], ['renewals', 'Due Dates and Renewals', '📅'], ['damage', 'Damage and Lost Books', '⚠️'],
    ['overdue', 'Overdue Books', '⏰'], ['history', 'Transaction History', '🧾'], ['reports', 'Reports', '📈'], ['settings', 'Settings', '⚙️']
  ];
  const MEMBER_PAGES = ['catalog', 'renewals', 'history'];
  const isMemberRole = () => ['Student', 'Faculty'].includes(LibraryAPI.getSession().role);
  const allowedPages = () => PAGES.filter(p => p[0] === 'settings' ? LibraryAPI.can('settings') : (!isMemberRole() || MEMBER_PAGES.includes(p[0])));
  const homePage = () => isMemberRole() ? 'catalog' : 'dashboard';
  const current = () => location.hash.replace(/^#\//, '') || homePage();
  const labelFor = id => {
    if (isMemberRole() && id === 'renewals') return 'My Loans and Renewals';
    if (isMemberRole() && id === 'history') return 'My Borrowing History';
    return PAGES.find(p => p[0] === id)[1];
  };

  function buildNav(id) {
    $('#nav').innerHTML = allowedPages().map(([pid, , icon]) =>
      `<a href="#/${pid}" data-page="${pid}"${pid === id ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${labelFor(pid)}</a>`).join('');
  }

  function renderRoleBar() {
    const s = LibraryAPI.getSession();
    $('#roleSelect').innerHTML = LibraryAPI.constants.ROLES.map(r => `<option${r === s.role ? ' selected' : ''}>${r}</option>`).join('');
    const ms = $('#memberSelect');
    if (isMemberRole()) {
      const list = LibraryAPI.getMembers().filter(m => m.type === s.role && m.status === 'Active');
      ms.innerHTML = list.map(m => `<option value="${m.id}"${m.id === s.memberId ? ' selected' : ''}>${UI.esc(m.name)} (${m.id})</option>`).join('');
      ms.classList.remove('hidden');
    } else ms.classList.add('hidden');
  }

  function labelControls() { // accessible names for search/filter controls that have no visible label
    document.querySelectorAll('#view input:not([aria-label]), #view select:not([aria-label]), #view textarea:not([aria-label])').forEach(el => {
      if (el.closest('label')) return;
      el.setAttribute('aria-label', el.placeholder || ('Filter: ' + (el.dataset.filter || 'field').replace('.', ' ')));
    });
  }

  function render() {
    try {
      let id = current();
      if (!allowedPages().some(p => p[0] === id)) { id = homePage(); if (location.hash !== '#/' + id) { location.hash = '#/' + id; return; } }
      const name = LibraryAPI.getSettings().libraryName;
      buildNav(id); renderRoleBar();
      document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === id));
      $('#brandName').textContent = name;
      $('#pageTitle').textContent = labelFor(id);
      document.title = `${labelFor(id)} · ${name}`;
      $('#view').innerHTML = UI.views[id].render();
      $('#todayLabel').textContent = new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      labelControls(); closeNav();
    } catch (err) {
      console.error(err);
      $('#view').innerHTML = `<div class="card" role="alert"><h3>Something went wrong showing this page</h3><p>${UI.esc(err.message)}</p>
        <p class="muted">Try another page or reload. If it keeps happening, switch to the System Administrator demo role and use Settings → Reset Demo Data. Details are in the browser console.</p></div>`;
    }
  }

  function refreshTable() {
    const t = $('#tableArea'), v = UI.views[current()];
    if (t && v && v.table) t.innerHTML = v.table();
  }
  const closeNav = () => { $('#sidebar').classList.remove('open'); $('#backdrop').classList.remove('show'); };
  const toggleNav = () => { $('#sidebar').classList.toggle('open'); $('#backdrop').classList.toggle('show'); };
  const go = page => { if (location.hash === '#/' + page) render(); else location.hash = '#/' + page; };
  const run = (r, okMsg) => { if (!r.ok) { UI.toast(r.error, 'error'); return false; } if (okMsg) UI.toast(typeof okMsg === 'function' ? okMsg(r.data) : okMsg); render(); return true; };
  const demoName = () => LibraryAPI.getSession().role === 'System Administrator' ? 'Demo Administrator' : 'Demo Librarian';

  /* ---------- Forms ---------- */
  function bookForm(id) {
    const b = id ? LibraryAPI.getBook(id) : {};
    UI.openForm({
      title: id ? 'Edit Book' : 'Add Book', values: b,
      fields: [
        { name: 'title', label: 'Title', required: true, full: true }, { name: 'author', label: 'Author', required: true },
        { name: 'isbn', label: 'ISBN (10 or 13 digits)', required: true, placeholder: '978-971-0000-000' },
        { name: 'category', label: 'Category', required: true, list: LibraryAPI.categories() }, { name: 'publisher', label: 'Publisher' },
        { name: 'year', label: 'Publication Year', type: 'number', required: true }, { name: 'description', label: 'Description', type: 'textarea', full: true }
      ],
      onSubmit: v => id ? LibraryAPI.updateBook(id, v) : LibraryAPI.addBook(v),
      success: id ? 'Book updated.' : 'Book added. Add physical copies under Book Copies.', after: render
    });
  }

  function copyForm(copyId, presetBookId) {
    const c = copyId ? LibraryAPI.getCopy(copyId) : { bookId: presetBookId || '', condition: 'New', status: 'Available' };
    const K = LibraryAPI.constants, locked = c.status === 'Borrowed' || K.WORKFLOW_STATUSES.includes(c.status);
    const bookOpts = LibraryAPI.getBooks().sort((a, b) => a.title.localeCompare(b.title)).map(b => [b.id, `${b.title} (${b.id})`]);
    UI.openForm({
      title: copyId ? `Edit Copy ${copyId}` : 'Add Book Copy', values: c,
      fields: [
        { name: 'bookId', label: 'Book', type: 'select', options: [['', 'Select book…'], ...bookOpts], required: true, full: true, disabled: !!copyId },
        { name: 'condition', label: 'Condition', type: 'select', options: K.CONDITIONS, required: true },
        { name: 'status', label: 'Status' + (locked ? ' (managed by loans / damage reports)' : ''), type: 'select', options: locked ? [c.status] : K.MANUAL_COPY_STATUSES, disabled: locked },
        { name: 'location', label: 'Shelf Location', required: true, full: true, placeholder: 'e.g. Shelf IT-A1' }
      ],
      onSubmit: v => copyId ? LibraryAPI.updateCopy(copyId, v) : LibraryAPI.addCopy(v.bookId, v),
      success: copyId ? 'Copy updated.' : 'Copy added with a new unique copy ID.', after: render
    });
  }

  function memberForm(id) {
    const m = id ? LibraryAPI.getMember(id) : { type: 'Student', status: 'Active' }, K = LibraryAPI.constants;
    UI.openForm({
      title: id ? `Edit Member ${id}` : 'Add Member', values: m,
      fields: [
        { name: 'name', label: 'Full Name', required: true, full: true }, { name: 'type', label: 'Member Type', type: 'select', options: K.MEMBER_TYPES, required: true },
        { name: 'status', label: 'Status', type: 'select', options: K.MEMBER_STATUSES, required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'program', label: 'Program / Department', required: true, placeholder: 'e.g. BSIT-3A' }
      ],
      onSubmit: v => id ? LibraryAPI.updateMember(id, v) : LibraryAPI.addMember(v),
      success: id ? 'Member updated.' : 'Member added.', after: render
    });
  }

  function reportForm() {
    const copies = LibraryAPI.getCopies().filter(c => c.status !== 'Withdrawn' && !LibraryAPI.getOpenReportOf(c.id)).sort((a, b) => a.id.localeCompare(b.id))
      .map(c => [c.id, `${c.id} — ${(LibraryAPI.getBook(c.bookId) || {}).title} [${c.status}]`]);
    UI.openForm({
      title: 'Report Damaged or Lost Copy', values: { type: 'Damaged', reporter: demoName() }, submitLabel: 'Submit Report',
      fields: [
        { name: 'copyId', label: 'Affected copy', type: 'select', options: [['', 'Select copy…'], ...copies], required: true, full: true },
        { name: 'type', label: 'Report type', type: 'select', options: ['Damaged', 'Lost'], required: true },
        { name: 'reporter', label: 'Reporting librarian', required: true },
        { name: 'description', label: 'Description', type: 'textarea', required: true, full: true },
        { type: 'note', html: 'The report date and time are recorded automatically. A copy on loan can only be reported <b>Lost</b> (the loan is closed as Lost and kept in history). For damage, record the return first.' }
      ],
      confirm: v => v.type === 'Lost' ? `Report ${v.copyId} as LOST? It will be removed from circulation until the report is resolved.` : `Report ${v.copyId} as DAMAGED? It cannot be borrowed until the report is resolved.`,
      onSubmit: v => LibraryAPI.reportCopy(v.copyId, v.type, v.description, v.reporter), success: 'Report recorded. The copy can no longer be borrowed.', after: render
    });
  }
  function repairForm(id) {
    UI.openForm({
      title: `Start Repair — ${id}`, submitLabel: 'Start Repair', fields: [{ name: 'notes', label: 'Repair notes (optional)', type: 'textarea', full: true }],
      confirm: () => `Move the copy for report ${id} into repair? It stays unavailable until the repair is completed.`,
      onSubmit: v => LibraryAPI.startRepair(id, v.notes), success: 'Repair started. Copy is now Under Repair.', after: render
    });
  }
  function resolveForm(id) {
    const r = LibraryAPI.getReports().find(x => x.id === id); if (!r) return;
    const resOpts = r.type === 'Lost' ? ['Found', 'Written off'] : ['Repaired', 'Written off'];
    UI.openForm({
      title: `Resolve Report ${id} (${r.type})`, values: { resolution: resOpts[0], conditionAfter: 'Good' }, submitLabel: 'Resolve',
      fields: [
        { name: 'resolution', label: 'Resolution', type: 'select', options: resOpts, required: true },
        { name: 'conditionAfter', label: 'Condition after (if restored)', type: 'select', options: LibraryAPI.constants.CONDITIONS },
        { name: 'notes', label: 'Resolution notes', type: 'textarea', required: true, full: true },
        { type: 'note', html: `${r.type === 'Damaged' ? '<b>Repaired</b> requires the report to be Under Repair first. ' : ''}<b>${resOpts[0]}</b> returns the copy to Available (not allowed for a Worn copy). <b>Written off</b> withdraws it and closes the report.` }
      ],
      confirm: v => v.resolution === 'Written off' ? `Write off copy ${r.copyId}? It is withdrawn permanently and the report is closed.` : `Mark report ${id} as ${v.resolution}? Copy ${r.copyId} will become Available again.`,
      onSubmit: v => LibraryAPI.resolveReport(id, v), success: 'Report resolved.', after: render
    });
  }
  function reservationForm() {
    const members = LibraryAPI.getMembers().filter(m => m.status === 'Active').map(m => [m.id, `${m.name} (${m.id})`]);
    const books = LibraryAPI.getBooks().sort((a, b) => a.title.localeCompare(b.title)).map(b => [b.id, b.title]);
    UI.openForm({
      title: 'New Reservation', submitLabel: 'Reserve',
      fields: [{ name: 'memberId', label: 'Member', type: 'select', options: [['', 'Select member…'], ...members], required: true, full: true },
        { name: 'bookId', label: 'Book title', type: 'select', options: [['', 'Select book…'], ...books], required: true, full: true }],
      onSubmit: v => LibraryAPI.createReservation(v.memberId, v.bookId), success: 'Reservation created.', after: render
    });
  }

  function doReturn(copyId) {
    const id = String(copyId || '').trim().toUpperCase();
    if (id && !UI.once('return:' + id)) return; // ignore rapid repeated clicks
    const r = LibraryAPI.returnBook(copyId);
    if (!r.ok) return UI.toast(r.error, 'error');
    if (r.data.fine) UI.toast(`Returned ${r.data.copyId}, ${r.data.daysLate} day(s) late. Fine: ₱${r.data.fine.toFixed(2)}.`, 'warn');
    else UI.toast(`Returned ${r.data.copyId} on time.`);
    render();
  }

  function doRenew(txnId) {
    if (!UI.once('renew:' + txnId)) return;                       // ignore duplicate clicks within 1.5 s
    const chk = LibraryAPI.renewalCheck(txnId);
    if (!chk.ok) return UI.toast(`Renewal rejected: ${chk.error}`, 'error'); // nothing is changed when validation fails
    if (!confirm(`Renew ${txnId}? The new due date will be ${UI.fmtDate(chk.data.newDueDate)}.`)) return;
    run(LibraryAPI.renew(txnId), t => `Renewed ${t.id}. New due date ${UI.fmtDate(t.dueDate)} (renewal ${t.renewalCount}).`);
  }

  /* ---------- Events ---------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]'); if (!el) return;
    const d = el.dataset, stamp = DateUtil.today();
    switch (d.action) {
      case 'toggle-nav': toggleNav(); break;
      case 'close-modal': UI.closeModal(); break;
      case 'add-book': bookForm(); break;
      case 'edit-book': bookForm(d.id); break;
      case 'book-details': UI.openInfo('Book Details', UI.views.catalog.details(d.id)); break;
      case 'add-copy': copyForm(null, d.book); break;
      case 'edit-copy': copyForm(d.id); break;
      case 'delete-copy': if (confirm(`Delete copy ${d.id}? This cannot be undone.`)) run(LibraryAPI.deleteCopy(d.id), 'Copy deleted.'); break;
      case 'view-copies': Object.assign(UI.filters.copies, { q: '', status: '', book: d.book }); go('copies'); break;
      case 'copy-history': Object.assign(UI.filters.history, { tab: 'condition', q: d.id, type: '', from: '', to: '', sort: 'desc' }); go('history'); break;
      case 'view-txn': Object.assign(UI.filters.history, { tab: 'activity', q: d.id, type: '', from: '', to: '', sort: 'desc' }); go('history'); break;
      case 'history-tab': Object.assign(UI.filters.history, { tab: d.tab, type: '' }); render(); break;
      case 'add-member': memberForm(); break;
      case 'edit-member': memberForm(d.id); break;
      case 'return': doReturn(d.copy); break;
      case 'renew': doRenew(d.txn); break;
      case 'add-reservation': reservationForm(); break;
      case 'cancel-reservation': if (confirm(`Cancel reservation ${d.id}?`)) run(LibraryAPI.cancelReservation(d.id), 'Reservation cancelled.'); break;
      case 'add-report': reportForm(); break;
      case 'start-repair': repairForm(d.id); break;
      case 'resolve-report': resolveForm(d.id); break;
      case 'close-report': if (confirm(`Close report ${d.id}? A closed report is final and cannot be reopened.`)) run(LibraryAPI.closeReport(d.id, ''), 'Report closed.'); break;
      case 'export-overdue': {
        const list = d.scope === 'filtered' ? UI.views.overdue.list() : UI.views.overdue.all();
        if (!list.length) return UI.toast('No overdue records to export.', 'warn');
        const [h, rows] = UI.views.overdue.csv(list); UI.downloadCSV(`overdue_books_${stamp}.csv`, h, rows); UI.toast(`Exported ${rows.length} row(s).`); break;
      }
      case 'export-history': {
        const list = d.scope === 'filtered' ? UI.views.history.events() : LibraryAPI.getTransactionEvents();
        if (!list.length) return UI.toast('No history records to export.', 'warn');
        const [h, rows] = UI.views.history.csv(list); UI.downloadCSV(`transaction_history_${stamp}.csv`, h, rows); UI.toast(`Exported ${rows.length} row(s).`); break;
      }
      case 'print': window.print(); break;
      case 'reset-data':
        if (confirm('Reset ALL demo data and settings to the original sample data? Your changes will be lost. This cannot be undone.')) {
          const r = LibraryAPI.resetDemoData();
          if (r.ok) UI.resetFilters();
          run(r, 'Demo data and settings have been reset.');
        }
        break;
    }
  });

  document.addEventListener('input', e => {
    const f = e.target.dataset && e.target.dataset.filter; if (!f) return;
    const [view, key] = f.split('.');
    UI.filters[view][key] = e.target.value;
    refreshTable();
  });

  document.addEventListener('change', e => {
    const t = e.target;
    if (t.id === 'borrowMember') { const h = UI.views.circulation.borrowHint(t.value), box = $('#borrowHint'); box.className = 'hint ' + h.cls; box.innerHTML = h.html; }
    else if (t.id === 'roleSelect') { LibraryAPI.setRole(t.value); UI.toast(`Demo role: ${t.value} (simulation only, not a real login).`, 'warn'); render(); }
    else if (t.id === 'memberSelect') { run(LibraryAPI.setSessionMember(t.value)); }
  });

  document.addEventListener('submit', e => {
    const f = e.target;
    if (f.id === 'borrowForm') {
      e.preventDefault();
      if (!UI.once('borrow')) return;
      run(LibraryAPI.borrow(f.elements.memberId.value, f.elements.copyId.value), t => `Issued ${t.copyId} to ${t.memberId}. Due ${UI.fmtDate(t.dueDate)}.`);
    } else if (f.id === 'returnForm') { e.preventDefault(); doReturn(f.elements.copyId.value); }
    else if (f.id === 'settingsForm') {
      e.preventDefault();
      const v = {}; Array.from(f.elements).forEach(x => { if (x.name) v[x.name] = x.value; });
      run(LibraryAPI.updateSettings(v), 'Settings saved. They apply to subsequent operations.');
    }
  });

  window.addEventListener('hashchange', render);
  document.addEventListener('DOMContentLoaded', () => {
    UI.init(); render();
    const h = LibraryAPI.health();
    if (h.recovered) UI.toast('Saved demo data was invalid and could not be loaded. Sample data was restored (a backup of the bad data was kept in LocalStorage).', 'error');
    if (h.saveFailed) UI.toast('Browser storage is unavailable; changes will not persist after refresh.', 'error');
  });
})();