-- =============================================================================
-- Library Management System (LMS) - Layer 2
-- File   : database/seed.sql
-- Run    : LAST (after schema.sql, procedures.sql and policies.sql)
--
-- STATUS : written carefully but NOT yet executed against a real database.
--
-- ALL DATA IS FICTIONAL (invented titles, authors, people and example.edu e-mails).
--
-- CAN IT RUN MORE THAN ONCE?  Yes, safely: if any book or member already exists the script prints a
-- NOTICE and does nothing.  To start over on a DEVELOPMENT database, run this first (destroys data):
--   TRUNCATE audit_logs, renewal_history, book_condition_reports, reservations, transactions,
--            book_copies, books, members RESTART IDENTITY CASCADE;
--   UPDATE library_settings SET library_name = 'College Library', student_loan_days = 7, faculty_loan_days = 14,
--          student_borrow_limit = 3, faculty_borrow_limit = 5, renewal_days = 7, max_renewals = 2,
--          allow_overdue_renewal = false, fine_per_day = 5.00 WHERE id = 1;
--
-- Dates are RELATIVE to the day you run the script (in the library time zone), so the demo always has
-- some overdue loans, like the Layer 1 sample data.  Because the audit trigger is active, the inserts
-- below also appear in audit_logs with no user (changed_by is NULL).
-- profiles are NOT seeded: real logins must come from Supabase Auth (see database/README.md).
-- =============================================================================
DO $seed$
DECLARE
    v_today date := fn_library_today();
    v_tz    text;
BEGIN
    IF EXISTS (SELECT 1 FROM books) OR EXISTS (SELECT 1 FROM members) THEN
        RAISE NOTICE 'Seed skipped: books or members already exist.';
        RETURN;
    END IF;
    SELECT timezone INTO v_tz FROM library_settings WHERE id = 1;

    -- 1) Books (12 titles).  n = number used to build readable copy codes (B001-C01 ...).
    CREATE TEMP TABLE seed_books ON COMMIT DROP AS
    SELECT * FROM (VALUES
        (1,  '9789710000011', 'Fundamentals of Database Systems',          'Elena Cruz',       'Information Technology', 'Mabini Press',     2021, 3, 'IT-A1'),
        (2,  '9789710000028', 'Practical Web Development with JavaScript', 'Marco Villanueva', 'Information Technology', 'Luzon Academic',   2022, 3, 'IT-A2'),
        (3,  '9789710000035', 'Data Structures and Algorithms in Action',  'Ramon Dela Pena',  'Computer Science',       'Mabini Press',     2019, 2, 'CS-B1'),
        (4,  '9789710000042', 'Networking Essentials for Beginners',       'Liza Santiago',    'Information Technology', 'Visayas Books',    2020, 2, 'IT-A3'),
        (5,  '9789710000059', 'Principles of Software Engineering',        'Jose Ramirez',     'Computer Science',       'Luzon Academic',   2018, 2, 'CS-B2'),
        (6,  '9789710000066', 'Introduction to Business Analytics',        'Carla Mendoza',    'Business',               'Pearl Publishing', 2021, 2, 'BU-C1'),
        (7,  '9789710000073', 'Philippine History: A Modern Survey',       'Antonio Reyes',    'History',                'Pearl Publishing', 2017, 2, 'HI-D1'),
        (8,  '9789710000080', 'College Physics Made Simple',               'Rosa Aquino',      'Science',                'Visayas Books',    2016, 2, 'SC-E1'),
        (9,  '9789710000097', 'Technical Writing for Professionals',       'Nina Bautista',    'Language',               'Mabini Press',     2020, 2, 'LA-F1'),
        (10, '9789710000103', 'Ethics in the Digital Age',                 'Paolo Garcia',     'Humanities',             'Pearl Publishing', 2023, 2, 'HU-G1'),
        (11, '9789710000110', 'Calculus for Engineers',                    'Eduardo Lim',      'Mathematics',            'Luzon Academic',   2015, 2, 'MA-H1'),
        (12, '9789710000127', 'Introduction to Cybersecurity',             'Mika Tan',         'Information Technology', 'Visayas Books',    2022, 3, 'IT-A4')
    ) AS v(n, isbn, title, author, category, publisher, publication_year, copies, shelf);

    INSERT INTO books (isbn, title, author, category, publisher, publication_year, description)
    SELECT isbn, title, author, category, publisher, publication_year, title || ' by ' || author || '.'
      FROM seed_books ORDER BY n;

    -- 2) Physical copies (27): copy 1 = Good, copy 2 = Fair, copy 3 = New.  Status defaults to Available.
    INSERT INTO book_copies (copy_code, book_id, copy_condition, location)
    SELECT 'B' || lpad(s.n::text, 3, '0') || '-C' || lpad(g.i::text, 2, '0'),
           b.id,
           CASE g.i WHEN 1 THEN 'Good' WHEN 2 THEN 'Fair' ELSE 'New' END,
           'Shelf ' || s.shelf
      FROM seed_books s
      JOIN books b ON b.isbn = s.isbn
      CROSS JOIN LATERAL generate_series(1, s.copies) AS g(i)
     ORDER BY s.n, g.i;

    -- 3) Members (10 fictional people, one Suspended, one Inactive).
    INSERT INTO members (member_code, full_name, member_type, email, program_department, status, joined_at)
    SELECT code, full_name, member_type, email, program, status, v_today - 200
      FROM (VALUES
        ('M-2026-001', 'Angela Reyes',       'Student', 'angela.reyes@example.edu',       'BSIT-3A',              'Active'),
        ('M-2026-002', 'Paolo Dizon',        'Student', 'paolo.dizon@example.edu',        'BSIT-2B',              'Active'),
        ('M-2026-003', 'Maria Clarisse Ong', 'Student', 'clarisse.ong@example.edu',       'BSCS-1A',              'Active'),
        ('M-2026-004', 'Joshua Lim',         'Student', 'joshua.lim@example.edu',         'BSBA-4A',              'Active'),
        ('M-2026-005', 'Kristine Navarro',   'Student', 'kristine.navarro@example.edu',   'BSED-2A',              'Active'),
        ('M-2026-006', 'Teresita Ramos',     'Faculty', 'teresita.ramos@example.edu',     'College of Computing', 'Active'),
        ('M-2026-007', 'Daniel Soriano',     'Faculty', 'daniel.soriano@example.edu',     'College of Business',  'Active'),
        ('M-2026-008', 'Bianca Flores',      'Student', 'bianca.flores@example.edu',      'BSIT-3A',              'Suspended'),
        ('M-2026-009', 'Carlo Mercado',      'Student', 'carlo.mercado@example.edu',      'BSCS-3B',              'Active'),
        ('M-2026-010', 'Hannah Villareal',   'Student', 'hannah.villareal@example.edu',   'BSIT-1C',              'Inactive')
      ) AS m(code, full_name, member_type, email, program, status);

    -- 4) Loans.  b = borrowed (days from today), d = due date, r = returned (NULL = still on loan),
    --    orig = original due date when the loan was renewed once, renewals = renewal count.
    INSERT INTO transactions (copy_id, member_id, borrowed_at, due_date, original_due_date, returned_at, status,
                              renewal_count, days_late, fine_amount)
    SELECT c.id, m.id,
           ((v_today + v.b) + time '09:00')::timestamp AT TIME ZONE v_tz,
           v_today + v.d,
           v_today + COALESCE(v.orig, v.d),
           CASE WHEN v.r IS NULL THEN NULL ELSE ((v_today + v.r) + time '15:30')::timestamp AT TIME ZONE v_tz END,
           CASE WHEN v.r IS NULL THEN 'Borrowed' ELSE 'Returned' END,
           v.renewals,
           CASE WHEN v.r IS NULL THEN 0 ELSE GREATEST(v.r - v.d, 0) END,
           CASE WHEN v.r IS NULL THEN 0 ELSE GREATEST(v.r - v.d, 0) * (SELECT fine_per_day FROM library_settings WHERE id = 1) END
      FROM (VALUES
        (1,  'B001-C02', 'M-2026-003', -20, -13, -14, NULL::int, 0),
        (2,  'B002-C02', 'M-2026-005', -15,  -8,  -9, NULL::int, 0),
        (3,  'B007-C01', 'M-2026-002', -25, -18, -19, NULL::int, 0),
        (4,  'B008-C01', 'M-2026-009', -18, -11,  -8, NULL::int, 0),   -- returned 3 days late
        (5,  'B010-C01', 'M-2026-004', -16,  -2,  -4,  -9,       1),   -- renewed once, then returned
        (6,  'B006-C01', 'M-2026-007', -20,  -6, NULL, NULL::int, 0),  -- overdue 6 days (faculty)
        (7,  'B003-C01', 'M-2026-004', -12,  -5, NULL, NULL::int, 0),  -- overdue 5 days, title reserved
        (8,  'B002-C01', 'M-2026-002', -10,  -3, NULL, NULL::int, 0),  -- overdue 3 days
        (9,  'B004-C01', 'M-2026-006',  -5,   9, NULL, NULL::int, 0),
        (10, 'B005-C01', 'M-2026-009',  -9,   5, NULL,  -2,       1),  -- renewed once, still on loan
        (11, 'B001-C01', 'M-2026-001',  -3,   4, NULL, NULL::int, 0),
        (12, 'B012-C01', 'M-2026-001',  -1,   6, NULL, NULL::int, 0)   -- title reserved by another member
      ) AS v(n, copy_code, member_code, b, d, r, orig, renewals)
      JOIN book_copies c ON c.copy_code = v.copy_code
      JOIN members m     ON m.member_code = v.member_code
     ORDER BY v.n;

    -- 5) Renewal history for the two renewed loans (previous due -> new due, 7 days).
    INSERT INTO renewal_history (transaction_id, renewal_number, renewed_at, previous_due_date, new_due_date, renewal_days)
    SELECT t.id, 1, ((v_today + v.at_off) + time '10:15')::timestamp AT TIME ZONE v_tz, v_today + v.prev_off, v_today + v.new_off, 7
      FROM (VALUES ('B010-C01', -10, -9, -2), ('B005-C01', -3, -2, 5)) AS v(copy_code, at_off, prev_off, new_off)
      JOIN book_copies c ON c.copy_code = v.copy_code
      JOIN transactions t ON t.copy_id = c.id AND t.renewal_count = 1;

    -- 6) Copy statuses that match the loans and reports above.
    UPDATE book_copies SET status = 'Borrowed' WHERE id IN (SELECT copy_id FROM transactions WHERE status = 'Borrowed');
    UPDATE book_copies SET status = 'Reserved'     WHERE copy_code = 'B008-C02';
    UPDATE book_copies SET status = 'Damaged'      WHERE copy_code = 'B011-C02';
    UPDATE book_copies SET status = 'Lost'         WHERE copy_code = 'B009-C02';
    UPDATE book_copies SET status = 'Under Repair' WHERE copy_code = 'B005-C02';

    -- 7) Condition reports: two open, one under repair, one resolved (all reported by a fictional librarian).
    INSERT INTO book_condition_reports
           (copy_id, report_type, description, status, previous_copy_status, reporter_name, reported_at,
            repair_started_at, repair_notes, resolution, resolution_notes, condition_after, resolved_at)
    SELECT c.id, v.rtype, v.descr, v.st, 'Available', 'Demo Librarian',
           ((v_today + v.rep) + time '11:00')::timestamp AT TIME ZONE v_tz,
           CASE WHEN v.rep_start IS NULL THEN NULL ELSE ((v_today + v.rep_start) + time '09:30')::timestamp AT TIME ZONE v_tz END,
           v.repair_notes, v.resolution, v.res_notes, v.cond_after,
           CASE WHEN v.res_off IS NULL THEN NULL ELSE ((v_today + v.res_off) + time '14:00')::timestamp AT TIME ZONE v_tz END
      FROM (VALUES
        (1, 'B011-C02', 'Damaged', 'Cover torn and several pages detached near chapter 4.', 'Reported',     -6, NULL::int, NULL::text, NULL::text, NULL::text, NULL::text, NULL::int),
        (2, 'B009-C02', 'Lost',    'Could not be located during the shelf inventory.',      'Reported',     -9, NULL::int, NULL::text, NULL::text, NULL::text, NULL::text, NULL::int),
        (3, 'B005-C02', 'Damaged', 'Water damage on the lower pages.',                      'Under Repair', -12, -10,      'Sent to the bindery for rebinding.', NULL::text, NULL::text, NULL::text, NULL::int),
        (4, 'B004-C02', 'Damaged', 'Loose binding; pages falling out.',                     'Resolved',     -30, -28,      'Rebound in-house.', 'Repaired', 'Rebound and tested; back on the shelf.', 'Fair', -24)
      ) AS v(n, copy_code, rtype, descr, st, rep, rep_start, repair_notes, resolution, res_notes, cond_after, res_off)
      JOIN book_copies c ON c.copy_code = v.copy_code
     ORDER BY v.n;

    -- 8) Reservations that block renewal of two loans (B003 held by M-2026-004, B012 held by M-2026-001).
    INSERT INTO reservations (book_id, member_id, status, created_at)
    SELECT b.id, m.id, 'Active', ((v_today + v.created) + time '13:00')::timestamp AT TIME ZONE v_tz
      FROM (VALUES ('9789710000035', 'M-2026-005', -2), ('9789710000127', 'M-2026-003', -1)) AS v(isbn, member_code, created)
      JOIN books b   ON b.isbn = v.isbn
      JOIN members m ON m.member_code = v.member_code;

    RAISE NOTICE 'Seed complete: % books, % copies, % members, % loans, % condition reports.',
        (SELECT count(*) FROM books), (SELECT count(*) FROM book_copies), (SELECT count(*) FROM members),
        (SELECT count(*) FROM transactions), (SELECT count(*) FROM book_condition_reports);
END
$seed$;