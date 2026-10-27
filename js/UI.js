/* ui.js — rendering helpers and page views. Reads/writes data only through LibraryAPI. */
const UI = (() => {
  const $ = s => document.querySelector(s);
  const can = p => LibraryAPI.can(p);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const fmtDateTime = s => s ? new Date(s).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const peso = n => '₱' + Number(n || 0).toFixed(2);
  const badge = (text, cls) => `<span class="badge b-${String(cls || text).toLowerCase().replace(/\s+/g, '-')}">${esc(text)}</span>`;
  const empty = msg => `<div class="empty">${esc(msg)}</div>`;
  const match = (q, ...f) => f.join(' ').toLowerCase().includes(String(q).trim().toLowerCase());
  const opts = (list, sel, allLabel) =>
    (allLabel ? `<option value="">${esc(allLabel)}</option>` : '') +
    list.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(l)}</option>`; }).join('');
  const table = (heads, rows, note, emptyMsg) => rows.length
    ? `${note ? `<p class="count-line">${note}</p>` : ''}<div class="table-wrap"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : empty(emptyMsg || 'No records match your search or filters.');
  const pageHead = (title, sub, actions = '') =>
    `<div class="page-head"><div><h2>${title}</h2><p>${sub}</p></div><div class="actions">${actions}</div></div>`;
  const statCards = list => `<div class="stats">${list.map(c => `<div class="stat ${c[2] || ''}"><div class="n">${c[1]}</div><div class="l">${c[0]}</div></div>`).join('')}</div>`;

  const defaults = () => ({
    catalog: { q: '', category: '', availability: '' }, copies: { q: '', status: '', book: '' }, members: { q: '', type: '', status: '' },
    circ: { q: '' }, renewals: { q: '', scope: '' }, damage: { q: '', status: '', type: '' },
    overdue: { q: '', type: '', bucket: '', scope: 'overdue' }, history: { tab: 'activity', q: '', type: '', from: '', to: '', sort: 'desc' }, reports: { from: '', to: '' }
  });
  const filters = defaults();
  function resetFilters() { const d = defaults(); Object.keys(d).forEach(k => Object.assign(filters[k], d[k])); }

  function toast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = 'toast ' + type; t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
  }

  /* ---------- Modals ---------- */
  let formCfg = null;
  function openForm(cfg) {
    formCfg = cfg;
    const values = cfg.values || {};
    $('#modalTitle').textContent = cfg.title;
    $('#modalError').classList.add('hidden');
    $('#modalSubmit').classList.remove('hidden');
    $('#modalSubmit').textContent = cfg.submitLabel || 'Save';
    $('#modalBody').innerHTML = '<div class="grid2">' + cfg.fields.map(f => {
      if (f.type === 'note') return `<div class="hint full">${f.html}</div>`;
      const v = values[f.name] == null ? '' : values[f.name];
      const req = f.required ? ' <span class="req">*</span>' : '';
      let input;
      if (f.type === 'select') input = `<select name="${f.name}"${f.disabled ? ' disabled' : ''}>${opts(f.options, v)}</select>`;
      else if (f.type === 'textarea') input = `<textarea name="${f.name}" rows="3">${esc(v)}</textarea>`;
      else input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}"${f.list ? ` list="dl_${f.name}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''} autocomplete="off">` +
        (f.list ? `<datalist id="dl_${f.name}">${f.list.map(x => `<option value="${esc(x)}">`).join('')}</datalist>` : '');
      return `<label class="${f.full ? 'full' : ''}">${esc(f.label)}${req}${input}</label>`;
    }).join('') + '</div>';
    $('#modal').classList.remove('hidden');
    const first = $('#modalBody input,#modalBody select:not([disabled]),#modalBody textarea');
    if (first) first.focus();
  }
  function openInfo(title, html) {
    formCfg = null;
    $('#modalTitle').textContent = title; $('#modalError').classList.add('hidden');
    $('#modalBody').innerHTML = html; $('#modalSubmit').classList.add('hidden');
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); formCfg = null; }
  function init() {
    $('#modalForm').addEventListener('submit', e => {
      e.preventDefault();
      if (!formCfg) return;
      const form = e.target, values = {};
      formCfg.fields.forEach(f => { if (f.type !== 'note') values[f.name] = form.elements[f.name].value; });
      if (formCfg.confirm && !window.confirm(formCfg.confirm(values))) return; // confirmation for consequential changes
      const r = formCfg.onSubmit(values);
      if (!r.ok) { const box = $('#modalError'); box.textContent = r.error; box.classList.remove('hidden'); return; }
      const cfg = formCfg; closeModal();
      toast(cfg.success || 'Saved.');
      if (cfg.after) cfg.after();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  }

  /* ---------- CSV export / double-click guard ---------- */
  function csvText(header, rows) {
    const cell = v => { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    return '\ufeff' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  }
  function downloadCSV(filename, header, rows) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csvText(header, rows)], { type: 'text/csv;charset=utf-8' })); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // Returns false if the same action key fired again within `ms` (prevents duplicate renewals/returns from rapid repeated clicks).
  const locks = {};
  function once(key, ms = 1500) { const t = Date.now(); if (locks[key] && t - locks[key] < ms) return false; locks[key] = t; return true; }
  const today = () => DateUtil.today();

  /* ---------- Shared renderers ---------- */
  const titleOf = bookId => { const b = LibraryAPI.getBook(bookId); return b ? b.title : bookId; };
  const nameOf = id => { const m = LibraryAPI.getMember(id); return m ? m.name : id; };
  const txnBadge = t => {
    if (t.status === 'Returned') return badge('Returned') + (t.daysLate ? ` <span class="muted">(${t.daysLate}d late)</span>` : '');
    if (t.status === 'Lost') return badge('Lost');
    const d = LibraryAPI.daysOverdue(t);
    return d ? badge(`Overdue ${d}d`, 'overdue') : badge('On Loan');
  };
  const dueLabel = t => { const left = DateUtil.diff(t.dueDate, today()); return left < 0 ? `${-left} day(s) overdue` : left === 0 ? 'Due today' : `${left} day(s) left`; };
  const txnHeads = ['ID', 'Book / Copy', 'Member', 'Borrowed', 'Due', 'Status'];
  const txnRows = list => list.map(t => `<tr><td class="mono">${t.id}</td><td>${esc(titleOf(t.bookId))}<div class="muted mono">${t.copyId}</div></td>
    <td>${esc(nameOf(t.memberId))}</td><td>${fmtDate(t.borrowDate)}</td><td>${fmtDate(t.dueDate)}${t.renewalCount ? ` <span class="muted">↻${t.renewalCount}</span>` : ''}</td><td>${txnBadge(t)}</td></tr>`);
  const derive = t => ({ ...t, od: LibraryAPI.daysOverdue(t), left: DateUtil.diff(t.dueDate, today()), fine: LibraryAPI.projectedFine(t), m: LibraryAPI.getMember(t.memberId) });
  const loanActions = t => (can('renewal') ? `<button class="btn sm" data-action="renew" data-txn="${t.id}">${can('circulation') ? 'Renew' : 'Request renewal'}</button>` : '') +
    (can('circulation') ? `<button class="btn sm" data-action="return" data-copy="${t.copyId}">Return</button>` : '');

  /* ---------- Views ---------- */
  const views = {};

  views.dashboard = {
    render() {
      const s = LibraryAPI.stats();
      const cards = [
        ['Book Titles', s.titles], ['Total Copies', s.copies], ['Available Copies', s.available, 'ok'], ['Currently On Loan', s.borrowed, 'info'],
        ['Overdue Loans', s.overdue, 'bad'], ['Due in 3 Days', s.dueSoon, 'warn'], ['Active Members', `${s.activeMembers}<small class="muted"> / ${s.totalMembers}</small>`],
        ['Damaged / Repair / Lost', s.damagedLost, 'warn'], ['Open Damage Reports', s.openReports, 'warn'], ['Borrowed Today', s.borrowedToday], ['Returned Today', s.returnedToday], ['Renewed Today', s.renewedToday, 'info']
      ];
      const recent = LibraryAPI.getTransactions().sort((a, b) => (b.borrowDate + b.id).localeCompare(a.borrowDate + a.id)).slice(0, 8);
      const overdue = LibraryAPI.activeLoans().filter(LibraryAPI.isOverdue).sort((a, b) => LibraryAPI.daysOverdue(b) - LibraryAPI.daysOverdue(a));
      const bars = LibraryAPI.constants.COPY_STATUSES.map(st => {
        const n = s.byStatus[st], pct = s.copies ? Math.round(n / s.copies * 100) : 0;
        return `<div class="bar-row"><span>${badge(st)}</span><div class="bar"><i style="width:${pct}%"></i></div><b>${n}</b></div>`;
      }).join('');
      return pageHead('Dashboard', `Live overview of ${esc(LibraryAPI.getSettings().libraryName)}: collection, members, and circulation.`) + statCards(cards) +
        `<div class="cols">
          <div class="card"><h3>Recent Transactions</h3>${table(txnHeads, txnRows(recent))}</div>
          <div>
            <div class="card"><h3>Copies by Status</h3>${bars}</div>
            <div class="card"><h3>Overdue Loans</h3>${overdue.length ? overdue.slice(0, 5).map(t =>
              `<p style="margin-bottom:8px"><b>${esc(titleOf(t.bookId))}</b><br><span class="muted">${esc(nameOf(t.memberId))} · ${badge(LibraryAPI.daysOverdue(t) + ' days', 'overdue')}</span></p>`).join('') : '<p class="muted">No overdue loans.</p>'}</div>
          </div>
        </div>`;
    }
  };

  views.catalog = {
    render() {
      const f = filters.catalog;
      return pageHead('Book Catalog', can('books') ? 'Titles in the collection. Physical copies are managed under Book Copies.' : 'Search the collection and check availability.',
        can('books') ? '<button class="btn primary" data-action="add-book">+ Add Book</button>' : '') +
        `<div class="toolbar">
          <input type="search" placeholder="Search title, author, ISBN, category…" value="${esc(f.q)}" data-filter="catalog.q">
          <select data-filter="catalog.category">${opts(LibraryAPI.categories(), f.category, 'All categories')}</select>
          <select data-filter="catalog.availability">${opts([['available', 'Has available copies'], ['unavailable', 'No available copies']], f.availability, 'Any availability')}</select>
        </div><div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const f = filters.catalog;
      const list = LibraryAPI.getBooks().filter(b => {
        const c = LibraryAPI.bookCounts(b.id);
        return (!f.q || match(f.q, b.title, b.author, b.isbn, b.category, b.publisher)) && (!f.category || b.category === f.category) &&
          (!f.availability || (f.availability === 'available' ? c.available > 0 : c.available === 0));
      }).sort((a, b) => a.title.localeCompare(b.title));
      return table(['ISBN', 'Title', 'Author', 'Category', 'Year', 'Copies (avail / total)', 'Actions'], list.map(b => {
        const c = LibraryAPI.bookCounts(b.id);
        return `<tr><td class="mono">${esc(b.isbn)}</td><td><b>${esc(b.title)}</b><div class="muted">${esc(b.publisher)} · ${b.id}</div></td><td>${esc(b.author)}</td>
          <td>${esc(b.category)}</td><td>${b.year}</td><td>${c.available > 0 ? badge(`${c.available} / ${c.total}`, 'available') : badge(`${c.available} / ${c.total}`, 'lost')}</td>
          <td><button class="btn sm" data-action="book-details" data-id="${b.id}">Details</button>${can('books') ? `<button class="btn sm" data-action="edit-book" data-id="${b.id}">Edit</button>` : ''}${can('copies') ? `<button class="btn sm" data-action="add-copy" data-book="${b.id}">+ Copy</button><button class="btn sm" data-action="view-copies" data-book="${b.id}">Copies</button>` : ''}</td></tr>`;
      }), `${list.length} title(s)`);
    },
    details(id) {
      const b = LibraryAPI.getBook(id); if (!b) return '';
      const copies = LibraryAPI.getCopies().filter(c => c.bookId === id), c = LibraryAPI.bookCounts(id);
      return `<p><b>${esc(b.title)}</b><br>${esc(b.author)} · ${esc(b.publisher)} · ${b.year}</p>
        <p class="muted" style="margin:6px 0">ISBN ${esc(b.isbn)} · ${esc(b.category)}</p><p style="margin-bottom:10px">${esc(b.description)}</p>
        <p style="margin-bottom:8px"><b>Availability:</b> ${c.available} of ${c.total} copies available</p>
        ${table(['Copy', 'Condition', 'Location', 'Status'], copies.map(x => `<tr><td class="mono">${x.id}</td><td>${esc(x.condition)}</td><td>${esc(x.location)}</td><td>${badge(x.status)}</td></tr>`))}`;
    }
  };

  views.copies = {
    render() {
      const f = filters.copies;
      const bookOpts = LibraryAPI.getBooks().sort((a, b) => a.title.localeCompare(b.title)).map(b => [b.id, `${b.title} (${b.id})`]);
      return pageHead('Book Copies', 'Each physical copy has a unique copy ID and its own status. Damage and loss are handled under Damage and Lost Books.',
        can('copies') ? '<button class="btn primary" data-action="add-copy">+ Add Copy</button>' : '') +
        `<div class="toolbar">
          <input type="search" placeholder="Search copy ID, title, location…" value="${esc(f.q)}" data-filter="copies.q">
          <select data-filter="copies.status">${opts(LibraryAPI.constants.COPY_STATUSES, f.status, 'All statuses')}</select>
          <select data-filter="copies.book">${opts(bookOpts, f.book, 'All books')}</select>
        </div><div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const f = filters.copies;
      const list = LibraryAPI.getCopies().filter(c => (!f.q || match(f.q, c.id, titleOf(c.bookId), c.location, c.condition)) && (!f.status || c.status === f.status) && (!f.book || c.bookId === f.book))
        .sort((a, b) => a.id.localeCompare(b.id));
      return table(['Copy ID', 'Book', 'Condition', 'Location', 'Status', 'Current Borrower', 'Actions'], list.map(c => {
        const loan = c.status === 'Borrowed' ? LibraryAPI.activeLoanOfCopy(c.id) : null;
        return `<tr><td class="mono"><b>${c.id}</b></td><td>${esc(titleOf(c.bookId))}</td><td>${esc(c.condition)}</td><td>${esc(c.location)}</td><td>${badge(c.status)}</td>
          <td>${loan ? `${esc(nameOf(loan.memberId))}<div class="muted">Due ${fmtDate(loan.dueDate)}</div>` : '<span class="muted">—</span>'}</td>
          <td><button class="btn sm" data-action="copy-history" data-id="${c.id}">History</button>${can('copies') ? `<button class="btn sm" data-action="edit-copy" data-id="${c.id}">Edit</button><button class="btn sm danger" data-action="delete-copy" data-id="${c.id}">Delete</button>` : ''}</td></tr>`;
      }), `${list.length} cop${list.length === 1 ? 'y' : 'ies'}`);
    }
  };

  views.members = {
    render() {
      const f = filters.members, K = LibraryAPI.constants;
      return pageHead('Members', 'Students and faculty who may borrow books (fictional sample records).',
        can('members') ? '<button class="btn primary" data-action="add-member">+ Add Member</button>' : '') +
        `<div class="toolbar">
          <input type="search" placeholder="Search name, ID, email, program…" value="${esc(f.q)}" data-filter="members.q">
          <select data-filter="members.type">${opts(K.MEMBER_TYPES, f.type, 'All types')}</select>
          <select data-filter="members.status">${opts(K.MEMBER_STATUSES, f.status, 'All statuses')}</select>
        </div><div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const f = filters.members;
      const list = LibraryAPI.getMembers().filter(m => (!f.q || match(f.q, m.id, m.name, m.email, m.program)) && (!f.type || m.type === f.type) && (!f.status || m.status === f.status))
        .sort((a, b) => a.id.localeCompare(b.id));
      return table(['Member ID', 'Name', 'Type', 'Program / Dept.', 'Email', 'Status', 'Loans', 'Actions'], list.map(m => {
        const i = LibraryAPI.memberLoanInfo(m.id);
        return `<tr><td class="mono">${m.id}</td><td><b>${esc(m.name)}</b></td><td>${badge(m.type)}</td><td>${esc(m.program)}</td><td>${esc(m.email)}</td><td>${badge(m.status)}</td>
          <td>${i.count} / ${i.limit}${i.overdue ? ` ${badge(i.overdue + ' overdue', 'overdue')}` : ''}</td>
          <td>${can('members') ? `<button class="btn sm" data-action="edit-member" data-id="${m.id}">Edit</button>` : ''}</td></tr>`;
      }), `${list.length} member(s)`);
    }
  };

  views.circulation = {
    render() {
      const members = LibraryAPI.getMembers().sort((a, b) => a.id.localeCompare(b.id)).map(m => [m.id, `${m.id} — ${m.name} (${m.type}, ${m.status})`]);
      const avail = LibraryAPI.getCopies().filter(c => c.status === 'Available').sort((a, b) => a.id.localeCompare(b.id)).map(c => [c.id, `${c.id} — ${titleOf(c.bookId)}`]);
      return pageHead('Borrowing and Returns', 'Issue available copies to eligible members and record returns. Damaged, lost, or under-repair copies are not listed.') +
        `<div class="two-panels">
          <form class="card stack" id="borrowForm" novalidate>
            <h3>Borrow a Book</h3>
            <label>Member<select name="memberId" id="borrowMember">${opts(members, '', 'Select member…')}</select></label>
            <div class="hint" id="borrowHint">Select a member to check eligibility.</div>
            <label>Available copy<select name="copyId" id="borrowCopy">${opts(avail, '', 'Select copy…')}</select></label>
            <button class="btn primary" type="submit">Issue Book</button>
          </form>
          <form class="card stack" id="returnForm" novalidate>
            <h3>Return a Book</h3>
            <label>Copy ID<input name="copyId" placeholder="e.g. B001-C01" autocomplete="off"></label>
            <p class="muted">Type a copy ID, or press Return on a row in the table below. If the copy came back damaged, record the return and then report it under Damage and Lost Books.</p>
            <button class="btn primary" type="submit">Record Return</button>
          </form>
        </div>
        <h3 style="margin:8px 0">Books Currently On Loan</h3>
        <div class="toolbar"><input type="search" placeholder="Search copy ID, title, member…" value="${esc(filters.circ.q)}" data-filter="circ.q"></div>
        <div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const q = filters.circ.q;
      const list = LibraryAPI.activeLoans().filter(t => !q || match(q, t.copyId, titleOf(t.bookId), nameOf(t.memberId), t.memberId)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      return table(['Copy', 'Book', 'Member', 'Borrowed', 'Due', 'Status', 'Action'], list.map(t =>
        `<tr><td class="mono">${t.copyId}</td><td>${esc(titleOf(t.bookId))}</td><td>${esc(nameOf(t.memberId))}</td><td>${fmtDate(t.borrowDate)}</td>
        <td>${fmtDate(t.dueDate)}</td><td>${txnBadge(t)}</td><td><button class="btn sm" data-action="return" data-copy="${t.copyId}">Return</button></td></tr>`), `${list.length} active loan(s)`);
    },
    borrowHint(memberId) {
      if (!memberId) return { cls: '', html: 'Select a member to check eligibility.' };
      const r = LibraryAPI.eligibility(memberId);
      return r.ok ? { cls: 'ok', html: `✔ Eligible — ${r.data.count} of ${r.data.limit} books on loan. Loan period ${r.data.days} days (due ${fmtDate(r.data.dueDate)}).` } : { cls: 'bad', html: '✖ ' + esc(r.error) };
    }
  };

  views.renewals = {
    own() { return !can('circulation'); },
    render() {
      const own = this.own(), s = LibraryAPI.getSettings(), f = filters.renewals, st = LibraryAPI.stats();
      const rules = `<div class="card"><h3>Renewal Rules${own ? '' : ' (change under Settings)'}</h3><p>Each renewal adds <b>${s.renewalDays} days</b>, up to <b>${s.maxRenewals}</b> renewal(s) per loan.
        Overdue loans <b>${s.allowOverdueRenewal ? 'may' : 'may not'}</b> be renewed${s.allowOverdueRenewal ? ' (the new due date counts from today; overdue days already incurred are still charged)' : ''}.
        Renewal is also refused for returned loans, non-Active members, ineligible copies, and titles reserved by another member.</p></div>`;
      const toolbar = `<div class="toolbar"><input type="search" placeholder="Search copy, title${own ? '' : ', member'}…" value="${esc(f.q)}" data-filter="renewals.q">
        <select data-filter="renewals.scope">${opts([['overdue', 'Overdue'], ['soon', 'Due within 3 days'], ['renewed', 'Already renewed']], f.scope, 'All active loans')}</select></div>`;
      if (own) return pageHead('My Loans and Renewals', 'Your active loans. Request a renewal when a loan is eligible; the reason is shown when it is not.') + rules + toolbar + `<div id="tableArea">${this.table()}</div>`;
      const renewed = LibraryAPI.activeLoans().filter(t => t.renewalCount > 0).length;
      const resvRows = LibraryAPI.getReservations().filter(r => r.status === 'Active').map(r => `<tr><td class="mono">${r.id}</td><td>${esc(titleOf(r.bookId))}</td><td>${esc(nameOf(r.memberId))}</td><td>${fmtDateTime(r.createdAt)}</td>
        <td>${can('reservations') ? `<button class="btn sm danger" data-action="cancel-reservation" data-id="${r.id}">Cancel</button>` : ''}</td></tr>`);
      return pageHead('Due Dates and Renewals', 'Review due dates and renew active loans according to the library rules.') +
        statCards([['Due Today', st.dueToday, 'warn'], ['Due in 3 Days', st.dueSoon, 'warn'], ['Overdue', st.overdue, 'bad'], ['Renewed Loans', renewed, 'info']]) + rules + toolbar +
        `<div id="tableArea">${this.table()}</div>
        <div class="page-head" style="margin-top:20px"><div><h2 style="font-size:17px">Title Reservations</h2><p>An active reservation by another member blocks renewal of that title.</p></div>
          <div class="actions">${can('reservations') ? '<button class="btn primary" data-action="add-reservation">+ New Reservation</button>' : ''}</div></div>
        ${table(['ID', 'Title', 'Reserved by', 'Created', 'Action'], resvRows, '', 'No active reservations.')}`;
    },
    table() {
      const f = filters.renewals, s = LibraryAPI.getSettings(), own = this.own();
      const list = LibraryAPI.activeLoans().map(derive).filter(t => {
        if (f.scope === 'overdue' && t.od < 1) return false;
        if (f.scope === 'soon' && !(t.left >= 0 && t.left <= 3)) return false;
        if (f.scope === 'renewed' && !t.renewalCount) return false;
        return !f.q || match(f.q, t.id, t.copyId, titleOf(t.bookId), nameOf(t.memberId), t.memberId);
      }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      return table(['Txn', 'Book / Copy', ...(own ? [] : ['Member']), 'Due', 'Renewals', 'Can renew?', 'Actions'], list.map(t => {
        const chk = LibraryAPI.renewalCheck(t.id);
        return `<tr><td class="mono">${t.id}</td><td>${esc(titleOf(t.bookId))}<div class="muted mono">${t.copyId}</div></td>${own ? '' : `<td>${esc(nameOf(t.memberId))}</td>`}
          <td>${fmtDate(t.dueDate)}<div class="muted">${dueLabel(t)}</div></td><td>${t.renewalCount} / ${s.maxRenewals}</td>
          <td>${chk.ok ? `<span class="ok-text">Yes — new due ${fmtDate(chk.data.newDueDate)}</span>` : `<span class="bad-text">${esc(chk.error)}</span>`}</td><td>${loanActions(t)}</td></tr>`;
      }), `${list.length} active loan(s)`, own ? 'You have no active loans.' : '');
    }
  };

  views.damage = {
    render() {
      const f = filters.damage, R = LibraryAPI.getReports(), open = R.filter(r => ['Reported', 'Under Repair'].includes(r.status));
      return pageHead('Damage and Lost Books', 'Report problem copies, track repairs, and resolve reports. Copies with open reports cannot be borrowed.',
        can('damage') ? '<button class="btn primary" data-action="add-report">+ Report Damage / Loss</button>' : '') +
        statCards([['Open Reports', open.length, 'warn'], ['Under Repair', R.filter(r => r.status === 'Under Repair').length, 'info'],
          ['Open Lost Reports', open.filter(r => r.type === 'Lost').length, 'bad'], ['Resolved', R.filter(r => r.status === 'Resolved').length, 'ok'], ['Closed', R.filter(r => r.status === 'Closed').length]]) +
        `<div class="toolbar"><input type="search" placeholder="Search report, copy, title, description, reporter…" value="${esc(f.q)}" data-filter="damage.q">
          <select data-filter="damage.status">${opts(LibraryAPI.constants.REPORT_STATUSES, f.status, 'All statuses')}</select>
          <select data-filter="damage.type">${opts(['Damaged', 'Lost'], f.type, 'Damaged and lost')}</select></div>
        <div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const f = filters.damage;
      const list = LibraryAPI.getReports().filter(r => (!f.status || r.status === f.status) && (!f.type || r.type === f.type) &&
        (!f.q || match(f.q, r.id, r.copyId, titleOf(r.bookId), r.description, r.resolutionNotes, r.reportedBy))).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
      return table(['Report', 'Copy / Book', 'Type', 'Description', 'Reported by / when', 'Status', 'Resolution', 'Actions'], list.map(r => {
        const isOpen = ['Reported', 'Under Repair'].includes(r.status), ed = can('damage');
        return `<tr><td class="mono">${r.id}</td><td><span class="mono">${r.copyId}</span><div>${esc(titleOf(r.bookId))}</div></td><td>${badge(r.type)}</td><td>${esc(r.description)}${r.repairNotes ? `<div class="muted">Repair: ${esc(r.repairNotes)}</div>` : ''}</td>
          <td>${esc(r.reportedBy)}<div class="muted">${fmtDateTime(r.reportedAt)}</div></td><td>${badge(r.status)}</td>
          <td>${r.resolution ? `${badge(r.resolution)}<div class="muted">${fmtDateTime(r.resolvedAt)}</div><div>${esc(r.resolutionNotes)}</div>` : '<span class="muted">—</span>'}</td>
          <td>${isOpen && ed && r.type === 'Damaged' && r.status === 'Reported' ? `<button class="btn sm" data-action="start-repair" data-id="${r.id}">Start Repair</button>` : ''}${isOpen && ed ? `<button class="btn sm primary" data-action="resolve-report" data-id="${r.id}">Resolve</button>` : ''}${r.status === 'Resolved' && ed ? `<button class="btn sm" data-action="close-report" data-id="${r.id}">Close Report</button>` : ''}<button class="btn sm" data-action="copy-history" data-id="${r.copyId}">History</button></td></tr>`;
      }), `${list.length} report(s)`);
    }
  };

  views.overdue = {
    list() {
      const f = filters.overdue;
      return LibraryAPI.activeLoans().map(derive).filter(t => {
        if (f.scope === 'overdue' && t.od < 1) return false;
        if (f.scope === 'today' && t.left !== 0) return false;
        if (f.scope === 'soon' && !(t.left >= 0 && t.left <= 3)) return false;
        if (f.type && (!t.m || t.m.type !== f.type)) return false;
        if (f.bucket) {
          if (t.od < 1) return false;
          if (f.bucket === '1-7' && t.od > 7) return false;
          if (f.bucket === '8-14' && (t.od < 8 || t.od > 14)) return false;
          if (f.bucket === '15+' && t.od < 15) return false;
        }
        return !f.q || match(f.q, t.id, t.copyId, titleOf(t.bookId), nameOf(t.memberId), t.memberId);
      }).sort((a, b) => b.od - a.od || a.dueDate.localeCompare(b.dueDate));
    },
    all() { return LibraryAPI.activeLoans().map(derive).filter(t => t.od > 0).sort((a, b) => b.od - a.od); },
    render() {
      const f = filters.overdue, all = this.all();
      return pageHead('Overdue Books', 'A loan is overdue when today is after its due date (a book due today is not yet overdue). Returned loans are never listed. Fines = overdue days × daily rate.',
        '<button class="btn" data-action="export-overdue" data-scope="filtered">⬇ Export CSV (filtered)</button>') +
        statCards([['Overdue Loans', all.length, 'bad'], ['Projected Fines', peso(all.reduce((n, t) => n + t.fine, 0)), 'warn'], ['Longest Overdue', all.length ? all[0].od + ' days' : '—', 'bad'],
          ['Due Today', LibraryAPI.stats().dueToday, 'info']]) +
        `<div class="toolbar"><input type="search" placeholder="Search transaction, copy, title, member…" value="${esc(f.q)}" data-filter="overdue.q">
          <select data-filter="overdue.scope">${opts([['overdue', 'Overdue only'], ['today', 'Due today'], ['soon', 'Due within 3 days'], ['all', 'All active loans']], f.scope)}</select>
          <select data-filter="overdue.type">${opts(['Student', 'Faculty'], f.type, 'All member types')}</select>
          <select data-filter="overdue.bucket">${opts([['1-7', '1–7 days overdue'], ['8-14', '8–14 days overdue'], ['15+', '15+ days overdue']], f.bucket, 'Any days overdue')}</select></div>
        <div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const list = this.list();
      return table(['Txn', 'Book / Copy', 'Member', 'Due', 'Days Overdue', 'Renewals', 'Status', 'Fine', 'Actions'], list.map(t =>
        `<tr><td class="mono">${t.id}</td><td>${esc(titleOf(t.bookId))}<div class="muted mono">${t.copyId}</div></td><td>${esc(nameOf(t.memberId))}<div class="muted mono">${t.memberId}</div></td>
        <td>${fmtDate(t.dueDate)}</td><td>${t.od ? `<b>${t.od}</b>` : `<span class="muted">${dueLabel(t)}</span>`}</td><td>${t.renewalCount}</td><td>${t.od ? badge('Overdue') : badge('On Loan')}</td><td>${peso(t.fine)}</td>
        <td><button class="btn sm" data-action="view-txn" data-id="${t.id}">View</button>${loanActions(t)}</td></tr>`), `${list.length} loan(s)`, 'No loans match. Great news if the scope is "Overdue only": nothing is overdue.');
    },
    csv(list) {
      return [['Transaction ID', 'Copy ID', 'Title', 'Member ID', 'Member', 'Member Type', 'Borrowed', 'Due Date', 'Days Overdue', 'Renewals', 'Status', 'Projected Fine (PHP)'],
        list.map(t => [t.id, t.copyId, titleOf(t.bookId), t.memberId, nameOf(t.memberId), t.m ? t.m.type : '', t.borrowDate, t.dueDate, t.od, t.renewalCount, t.od ? 'Overdue' : 'On Loan', t.fine.toFixed(2)])];
    }
  };

  const EVENT_TYPES = ['Book Borrowed', 'Book Returned', 'Loan Renewed', 'Loan Closed as Lost', 'Damage Reported', 'Lost Reported', 'Moved to Repair', 'Repair Completed',
    'Copy Found', 'Copy Written Off', 'Report Closed', 'Copy Status Changed', 'Reservation Created', 'Reservation Cancelled'];
  views.history = {
    events() {
      const f = filters.history;
      const list = LibraryAPI.getTransactionEvents().filter(e => (!f.type || e.type === f.type) && (!f.from || e.at.slice(0, 10) >= f.from) && (!f.to || e.at.slice(0, 10) <= f.to) &&
        (!f.q || match(f.q, e.id, e.txnId, e.copyId, e.reportId, e.bookId ? titleOf(e.bookId) : '', e.memberId ? nameOf(e.memberId) : '', e.memberId, e.actor, e.description)));
      return f.sort === 'asc' ? list.slice().reverse() : list;
    },
    cond() {
      const f = filters.history;
      const list = LibraryAPI.getConditionLog().filter(e => (!f.type || e.toStatus === f.type) && (!f.from || e.at.slice(0, 10) >= f.from) && (!f.to || e.at.slice(0, 10) <= f.to) &&
        (!f.q || match(f.q, e.copyId, titleOf(e.bookId), e.event, e.note, e.by)));
      return f.sort === 'asc' ? list.slice().reverse() : list;
    },
    render() {
      const f = filters.history, staff = can('copies'), isCond = f.tab === 'condition' && staff;
      const typeOpts = isCond ? opts(LibraryAPI.constants.COPY_STATUSES, f.type, 'Any resulting status') : opts(EVENT_TYPES, f.type, 'All event types');
      return pageHead(staff ? 'Transaction History' : 'My Borrowing History', staff ? 'Every recorded action: loans, returns, renewals, condition reports and status changes. Entries are never deleted.' : 'Your borrowing, renewal and return history (demo role view).',
        !isCond ? '<button class="btn" data-action="export-history" data-scope="filtered">⬇ Export CSV (filtered)</button>' : '') +
        (staff ? `<div class="tabs" role="tablist"><button class="tab ${isCond ? '' : 'active'}" role="tab" data-action="history-tab" data-tab="activity">Activity Log</button>
          <button class="tab ${isCond ? 'active' : ''}" role="tab" data-action="history-tab" data-tab="condition">Copy Condition</button></div>` : '') +
        `<div class="toolbar"><input type="search" placeholder="${isCond ? 'Search copy, title, event, notes…' : 'Search transaction, copy, book, member, event ID…'}" value="${esc(f.q)}" data-filter="history.q">
          <select data-filter="history.type">${typeOpts}</select>
          <select data-filter="history.sort">${opts([['desc', 'Newest first'], ['asc', 'Oldest first']], f.sort)}</select>
          <label class="inline">From <input type="date" value="${esc(f.from)}" data-filter="history.from"></label>
          <label class="inline">To <input type="date" value="${esc(f.to)}" data-filter="history.to"></label></div>
        <div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const f = filters.history;
      if (f.tab === 'condition' && can('copies')) {
        const list = this.cond();
        return table(['When', 'Copy / Book', 'Event', 'Status', 'Condition', 'Notes', 'By'], list.map(e =>
          `<tr><td>${fmtDateTime(e.at)}</td><td><span class="mono">${e.copyId}</span><div>${esc(titleOf(e.bookId))}</div></td><td>${esc(e.event)}</td>
          <td>${e.fromStatus ? badge(e.fromStatus) + ' → ' : ''}${badge(e.toStatus)}</td><td>${e.fromCondition === e.toCondition ? esc(e.toCondition) : `${esc(e.fromCondition)} → ${esc(e.toCondition)}`}</td><td>${esc(e.note)}</td><td>${esc(e.by)}</td></tr>`), `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`);
      }
      const list = this.events();
      return table(['When', 'Event', 'Related records', 'Book', 'Member', 'Actor', 'Details'], list.map(e =>
        `<tr><td>${fmtDateTime(e.at)}<div class="muted mono">${e.id}${e.backfilled ? ' · sample/earlier data' : ''}</div></td><td>${badge(e.type)}</td>
        <td class="mono">${[e.txnId, e.copyId, e.reportId].filter(Boolean).join('<br>')}</td><td>${e.bookId ? esc(titleOf(e.bookId)) : '—'}</td><td>${e.memberId ? esc(nameOf(e.memberId)) : '—'}</td><td>${esc(e.actor)}</td><td>${esc(e.description)}</td></tr>`),
        `${list.length} event(s)`, 'No history events match your search or date range.');
    },
    csv(list) {
      return [['Event ID', 'Timestamp', 'Event Type', 'Transaction ID', 'Copy ID', 'Report ID', 'Title', 'Member ID', 'Member', 'Actor', 'Description'],
        list.map(e => [e.id, e.at.replace('T', ' '), e.type, e.txnId || '', e.copyId || '', e.reportId || '', e.bookId ? titleOf(e.bookId) : '', e.memberId || '', e.memberId ? nameOf(e.memberId) : '', e.actor, e.description])];
    }
  };

  views.reports = {
    render() {
      const f = filters.reports;
      return pageHead('Reports', 'Calculated live from the current demo data. The date range applies to the loan, return and renewal activity sections.',
        '<button class="btn" data-action="print">🖨 Print</button><button class="btn" data-action="export-overdue" data-scope="all">⬇ Overdue Books CSV</button><button class="btn" data-action="export-history" data-scope="all">⬇ Transaction History CSV</button>') +
        `<div class="toolbar"><label class="inline">From <input type="date" value="${esc(f.from)}" data-filter="reports.from"></label>
          <label class="inline">To <input type="date" value="${esc(f.to)}" data-filter="reports.to"></label></div><div id="tableArea">${this.table()}</div>`;
    },
    table() {
      const f = filters.reports, d = LibraryAPI.reportData(f.from, f.to), inv = d.inventory, c = d.circulation, a = d.activity, g = d.damage;
      const range = (f.from || f.to) ? `${f.from ? 'from ' + fmtDate(f.from) : ''} ${f.to ? 'to ' + fmtDate(f.to) : ''}`.trim() : 'all dates';
      const T = (heads, rows, msg) => table(heads, rows.map(r => `<tr>${r.map(x => `<td>${x}</td>`).join('')}</tr>`), '', msg);
      const pct = n => inv.copies ? Math.round(n / inv.copies * 100) + '%' : '0%';
      return `<div class="card"><h3>Inventory Summary</h3>${statCards([['Book Titles', inv.titles], ['Physical Copies', inv.copies], ['Available', inv.byStatus.Available, 'ok'], ['Borrowed', inv.byStatus.Borrowed, 'info'],
          ['Damaged / Repair / Lost / Withdrawn', inv.byStatus.Damaged + inv.byStatus['Under Repair'] + inv.byStatus.Lost + inv.byStatus.Withdrawn, 'warn']])}
        ${T(['Category', 'Titles', 'Copies', 'Available', 'On Loan', 'Damaged / Lost / Withdrawn', 'Total Loans'], inv.categories.map(r => [esc(r.category), r.titles, r.copies, r.available, r.onLoan, r.unavailable, r.loans]), 'No books in the catalog yet.')}</div>
        <div class="card"><h3>Available vs Borrowed Copies</h3>${T(['Copy status', 'Copies', 'Share'], LibraryAPI.constants.COPY_STATUSES.map(st => [badge(st), inv.byStatus[st], pct(inv.byStatus[st])]), 'No copies recorded.')}</div>
        <div class="card"><h3>Overdue Transactions (now)</h3>${T(['Txn', 'Copy', 'Title', 'Member', 'Due', 'Days overdue', 'Projected fine'], d.overdue.map(r => [r.id, r.copyId, esc(r.title), `${esc(r.member)} <span class="muted mono">${r.memberId}</span>`, fmtDate(r.dueDate), r.days, peso(r.fine)]), 'No overdue transactions.')}</div>
        <div class="card"><h3>Damaged, Under Repair, Lost and Withdrawn Copies (now)</h3>${T(['Copy', 'Title', 'Copy status', 'Report', 'Report status', 'Since', 'Description'], d.problemCopies.map(r => [r.copyId, esc(r.title), badge(r.status), r.reportId || '—', r.reportStatus ? badge(r.reportStatus) : '—', r.since ? fmtDateTime(r.since) : '—', esc(r.description)]), 'No damaged or lost copies.')}
          <p class="muted" style="margin-top:8px">Reports: ${g.open} open · ${g.underRepair} under repair · ${g.resolved} resolved · ${g.closed} closed · ${g.writtenOff} written off.</p></div>
        <div class="card"><h3>Loan and Return Activity (${esc(range)})</h3>${statCards([['Loans', a.borrowed, 'info'], ['Returns', a.returned, 'ok']])}
          ${T(['When', 'Event', 'Txn', 'Copy', 'Member', 'Details'], a.events.map(e => [fmtDateTime(e.at), badge(e.type), e.txnId || '', e.copyId || '', e.memberId ? esc(nameOf(e.memberId)) : '—', esc(e.description)]), 'No loan or return activity in this period.')}</div>
        <div class="card"><h3>Renewal Activity (${esc(range)})</h3>${statCards([['Renewals', a.renewed, 'info']])}
          ${T(['When', 'Txn', 'Copy', 'Member', 'By', 'Details'], a.renewals.map(e => [fmtDateTime(e.at), e.txnId || '', e.copyId || '', e.memberId ? esc(nameOf(e.memberId)) : '—', esc(e.actor), esc(e.description)]), 'No renewals in this period.')}</div>
        <div class="card"><h3>All-time Circulation Summary</h3>${statCards([['Total Transactions', c.total], ['Active Loans', c.active, 'info'], ['Returned', c.returned, 'ok'], ['Lost Loans', c.lost, 'bad'], ['Renewals Recorded', c.renewals],
          ['Avg. Loan Length (returned)', c.avgLoanDays + ' days'], ['On-time Return Rate', c.onTimeRate + '%', 'ok'], ['Fines Assessed (returned)', peso(c.finesAssessed), 'warn'], ['Projected Overdue Fines', peso(c.finesProjected), 'bad']])}
          <div class="two-panels"><div>${T(['Most borrowed titles', 'Loans'], d.topTitles.map(r => [esc(r.name), r.loans]), 'No loans yet.')}</div><div>${T(['Most active borrowers', 'Loans'], d.topBorrowers.map(r => [esc(r.name), r.loans]), 'No loans yet.')}</div></div></div>`;
    }
  };

  views.settings = {
    render() {
      const s = LibraryAPI.getSettings(), edit = can('settings'), dis = edit ? '' : ' disabled';
      const num = (name, label, min, max, step = 1) => `<label>${label}<input type="number" name="${name}" min="${min}" max="${max}" step="${step}" value="${esc(s[name])}"${dis}></label>`;
      return pageHead('Settings', edit ? 'Library rules used by borrowing, renewals, and fines.' : 'Current library rules (read-only for this demo role; switch to System Administrator to edit).') +
        `<div class="two-panels">
          <form class="card stack" id="settingsForm" novalidate>
            <h3>Library Rules</h3>
            <label>Library name<input name="libraryName" maxlength="60" value="${esc(s.libraryName)}"${dis}></label>
            <div class="grid2">${num('studentLoanDays', 'Default borrowing duration — students (days)', 1, 90)}${num('facultyLoanDays', 'Borrowing duration — faculty (days)', 1, 180)}
              ${num('studentLimit', 'Maximum borrowing limit — students', 1, 20)}${num('facultyLimit', 'Maximum borrowing limit — faculty', 1, 30)}
              ${num('renewalDays', 'Renewal duration (days)', 1, 60)}${num('maxRenewals', 'Max renewals per loan', 0, 10)}
              ${num('finePerDay', 'Fine per overdue day (₱)', 0, 1000, 0.5)}
              <label>Renew overdue loans?<select name="allowOverdueRenewal"${dis}>${opts(['No', 'Yes'], s.allowOverdueRenewal ? 'Yes' : 'No')}</select></label></div>
            ${edit ? '<button class="btn primary" type="submit">Save Settings</button>' : ''}
            <p class="muted">Loan period changes apply to new loans only. Limits and renewal rules apply immediately.</p>
          </form>
          <div class="card"><h3>Demo Data</h3>
            <p class="muted" style="margin-bottom:12px">All data lives in this browser's LocalStorage and survives refreshes. Resetting restores the original fictional sample data and erases your changes (your demo role is kept).</p>
            ${can('reset') ? '<button class="btn danger" data-action="reset-data">Reset Demo Data</button>' : '<p class="muted">Only the System Administrator demo role can reset data.</p>'}
            <h3 style="margin-top:20px">About the demo roles</h3>
            <p class="muted">The role selector in the top bar only changes what this browser demo shows. It is <b>not authentication</b>: anyone can change it or edit LocalStorage. Real login and database-enforced permissions come in Layer 2.</p></div>
        </div>`;
    }
  };

  return { $, esc, fmtDate, fmtDateTime, toast, openForm, openInfo, closeModal, init, filters, resetFilters, views, pageHead, downloadCSV, csvText, once };
})();