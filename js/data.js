/* data.js — fictional sample data (data model version 2). Dates are relative to "today" so the demo always looks current. */
const SeedData = (() => {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const off = n => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() + n); return iso(t); };
  const stamp = (n, time = '09:00:00') => `${off(n)}T${time}`;
  const diff = (a, b) => Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);

  const defaultSettings = () => ({
    libraryName: 'College Library', studentLoanDays: 7, facultyLoanDays: 14, studentLimit: 3, facultyLimit: 5,
    renewalDays: 7, maxRenewals: 2, allowOverdueRenewal: false, finePerDay: 5
  });

  // [id, isbn, title, author, category, publisher, year, copies, shelf]
  const bookRows = [
    ['B001', '9789710000011', 'Fundamentals of Database Systems', 'Elena Cruz', 'Information Technology', 'Mabini Press', 2021, 3, 'IT-A1'],
    ['B002', '9789710000028', 'Practical Web Development with JavaScript', 'Marco Villanueva', 'Information Technology', 'Luzon Academic', 2022, 3, 'IT-A2'],
    ['B003', '9789710000035', 'Data Structures and Algorithms in Action', 'Ramon Dela Peña', 'Computer Science', 'Mabini Press', 2019, 2, 'CS-B1'],
    ['B004', '9789710000042', 'Networking Essentials for Beginners', 'Liza Santiago', 'Information Technology', 'Visayas Books', 2020, 2, 'IT-A3'],
    ['B005', '9789710000059', 'Principles of Software Engineering', 'Jose Ramirez', 'Computer Science', 'Luzon Academic', 2018, 2, 'CS-B2'],
    ['B006', '9789710000066', 'Introduction to Business Analytics', 'Carla Mendoza', 'Business', 'Pearl Publishing', 2021, 2, 'BU-C1'],
    ['B007', '9789710000073', 'Philippine History: A Modern Survey', 'Antonio Reyes', 'History', 'Pearl Publishing', 2017, 2, 'HI-D1'],
    ['B008', '9789710000080', 'College Physics Made Simple', 'Rosa Aquino', 'Science', 'Visayas Books', 2016, 2, 'SC-E1'],
    ['B009', '9789710000097', 'Technical Writing for Professionals', 'Nina Bautista', 'Language', 'Mabini Press', 2020, 2, 'LA-F1'],
    ['B010', '9789710000103', 'Ethics in the Digital Age', 'Paolo Garcia', 'Humanities', 'Pearl Publishing', 2023, 2, 'HU-G1'],
    ['B011', '9789710000110', 'Calculus for Engineers', 'Eduardo Lim', 'Mathematics', 'Luzon Academic', 2015, 2, 'MA-H1'],
    ['B012', '9789710000127', 'Introduction to Cybersecurity', 'Mika Tan', 'Information Technology', 'Visayas Books', 2022, 3, 'IT-A4']
  ];

  // [id, name, type, email, program/department, status]
  const memberRows = [
    ['M-2026-001', 'Angela Reyes', 'Student', 'angela.reyes@example.edu', 'BSIT-3A', 'Active'],
    ['M-2026-002', 'Paolo Dizon', 'Student', 'paolo.dizon@example.edu', 'BSIT-2B', 'Active'],
    ['M-2026-003', 'Maria Clarisse Ong', 'Student', 'clarisse.ong@example.edu', 'BSCS-1A', 'Active'],
    ['M-2026-004', 'Joshua Lim', 'Student', 'joshua.lim@example.edu', 'BSBA-4A', 'Active'],
    ['M-2026-005', 'Kristine Navarro', 'Student', 'kristine.navarro@example.edu', 'BSED-2A', 'Active'],
    ['M-2026-006', 'Teresita Ramos', 'Faculty', 'teresita.ramos@example.edu', 'College of Computing', 'Active'],
    ['M-2026-007', 'Daniel Soriano', 'Faculty', 'daniel.soriano@example.edu', 'College of Business', 'Active'],
    ['M-2026-008', 'Bianca Flores', 'Student', 'bianca.flores@example.edu', 'BSIT-3A', 'Suspended'],
    ['M-2026-009', 'Carlo Mercado', 'Student', 'carlo.mercado@example.edu', 'BSCS-3B', 'Active'],
    ['M-2026-010', 'Hannah Villareal', 'Student', 'hannah.villareal@example.edu', 'BSIT-1C', 'Inactive']
  ];

  // [copyId, memberId, borrowOffset, dueOffset, returnOffset|null, renewals?: [[renewedAtOffset, prevDueOffset, newDueOffset]]]
  const txnRows = [
    ['B001-C02', 'M-2026-003', -20, -13, -14],
    ['B002-C02', 'M-2026-005', -15, -8, -9],
    ['B007-C01', 'M-2026-002', -25, -18, -19],
    ['B008-C01', 'M-2026-009', -18, -11, -8],
    ['B010-C01', 'M-2026-004', -16, -2, -4, [[-10, -9, -2]]],
    ['B006-C01', 'M-2026-007', -20, -6, null],
    ['B003-C01', 'M-2026-004', -12, -5, null],
    ['B002-C01', 'M-2026-002', -10, -3, null],
    ['B004-C01', 'M-2026-006', -5, 9, null],
    ['B005-C01', 'M-2026-009', -9, 5, null, [[-3, -2, 5]]],
    ['B001-C01', 'M-2026-001', -3, 4, null],
    ['B012-C01', 'M-2026-001', -1, 6, null]
  ];

  // [id, bookId, memberId, createdOffset]
  const reservationRows = [['R-0001', 'B003', 'M-2026-005', -2], ['R-0002', 'B012', 'M-2026-003', -1]];

  function build() {
    const books = [], copies = [];
    bookRows.forEach(([id, isbn, title, author, category, publisher, year, n, shelf]) => {
      books.push({ id, isbn, title, author, category, publisher, year, description: `${title} by ${author}.`, createdAt: off(-120) });
      for (let i = 1; i <= n; i++) {
        copies.push({
          id: `${id}-C${String(i).padStart(2, '0')}`, bookId: id,
          condition: i === 1 ? 'Good' : (i === 2 ? 'Fair' : 'New'),
          location: `Shelf ${shelf}`, status: 'Available', acquiredAt: off(-100)
        });
      }
    });
    const members = memberRows.map(([id, name, type, email, program, status]) =>
      ({ id, name, type, email, program, status, joinedAt: off(-200) }));
    const settings = defaultSettings();

    const transactions = txnRows.map(([copyId, memberId, b, d, r, rn], i) => {
      const dueDate = off(d), returnDate = r === null ? null : off(r);
      const renewals = (rn || []).map(([at, prev, nw]) => ({ at: stamp(at, '10:15:00'), previousDueDate: off(prev), newDueDate: off(nw), days: settings.renewalDays, by: 'Librarian' }));
      const daysLate = returnDate && returnDate > dueDate ? diff(returnDate, dueDate) : 0;
      return {
        id: `T-${String(i + 1).padStart(4, '0')}`, copyId, bookId: copyId.split('-')[0], memberId,
        borrowDate: off(b), borrowAt: stamp(b), dueDate, originalDueDate: renewals.length ? renewals[0].previousDueDate : dueDate,
        returnDate, returnAt: returnDate ? stamp(r, '15:30:00') : null, status: returnDate ? 'Returned' : 'Borrowed',
        renewalCount: renewals.length, renewals, priorOverdueDays: 0, daysLate, fine: daysLate * settings.finePerDay
      };
    });

    const reservations = reservationRows.map(([id, bookId, memberId, c]) => ({ id, bookId, memberId, createdAt: stamp(c, '13:00:00'), status: 'Active' }));
    const find = id => copies.find(c => c.id === id);
    transactions.filter(t => t.status === 'Borrowed').forEach(t => { find(t.copyId).status = 'Borrowed'; });
    find('B008-C02').status = 'Reserved';
    find('B011-C02').status = 'Damaged';
    find('B009-C02').status = 'Lost';
    find('B005-C02').status = 'Under Repair';

    const mkReport = (id, copyId, type, description, rep, status, extra = {}) => ({
      id, copyId, bookId: copyId.split('-')[0], type, description, reportedAt: stamp(rep, '11:00:00'), reportedBy: 'Demo Librarian', status,
      previousStatus: 'Available', repairStartedAt: null, repairNotes: '', resolvedAt: null, resolution: null, resolutionNotes: '', loanTxnId: null, ...extra
    });
    const damageReports = [
      mkReport('DR-0001', 'B011-C02', 'Damaged', 'Cover torn and several pages detached near chapter 4.', -6, 'Reported'),
      mkReport('DR-0002', 'B009-C02', 'Lost', 'Could not be located during the shelf inventory.', -9, 'Reported'),
      mkReport('DR-0003', 'B005-C02', 'Damaged', 'Water damage on the lower pages.', -12, 'Under Repair', { repairStartedAt: stamp(-10, '09:30:00'), repairNotes: 'Sent to the bindery for rebinding.' }),
      mkReport('DR-0004', 'B004-C02', 'Damaged', 'Loose binding; pages falling out.', -30, 'Resolved', { repairStartedAt: stamp(-28, '09:30:00'), repairNotes: 'Rebound in-house.', resolvedAt: stamp(-24, '14:00:00'), resolution: 'Repaired', resolutionNotes: 'Rebound and tested; back on the shelf.' })
    ];

    let n = 0;
    const log = (copyId, offset, time, event, fromStatus, toStatus, note, fromCondition, toCondition) => conditionLog.push({
      id: `CL-${String(++n).padStart(4, '0')}`, copyId, bookId: copyId.split('-')[0], at: stamp(offset, time), event, fromStatus, toStatus,
      fromCondition: fromCondition || find(copyId).condition, toCondition: toCondition || find(copyId).condition, note, by: 'Librarian'
    });
    const conditionLog = [];
    log('B004-C02', -30, '11:00:00', 'Reported Damaged', 'Available', 'Damaged', 'Loose binding; pages falling out.');
    log('B004-C02', -28, '09:30:00', 'Repair started', 'Damaged', 'Under Repair', 'Rebound in-house.');
    log('B004-C02', -24, '14:00:00', 'Resolved: Repaired', 'Under Repair', 'Available', 'Rebound and tested; back on the shelf.');
    log('B005-C02', -12, '11:00:00', 'Reported Damaged', 'Available', 'Damaged', 'Water damage on the lower pages.');
    log('B005-C02', -10, '09:30:00', 'Repair started', 'Damaged', 'Under Repair', 'Sent to the bindery for rebinding.');
    log('B009-C02', -9, '11:00:00', 'Reported Lost', 'Available', 'Lost', 'Could not be located during the shelf inventory.');
    log('B011-C02', -6, '11:00:00', 'Reported Damaged', 'Available', 'Damaged', 'Cover torn and several pages detached near chapter 4.');

    return { version: 2, books, copies, members, transactions, reservations, damageReports, conditionLog, settings, demoRole: 'Librarian', demoMemberId: '' };
  }

  return { build, defaultSettings };
})();