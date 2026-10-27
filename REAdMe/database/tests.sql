-- =============================================================================
-- Library Management System (LMS) - Layer 2
-- File   : database/tests.sql        (SQL test cases for the stored procedures)
-- Run    : AFTER schema.sql, procedures.sql and seed.sql, on a FRESH seed (do not run on real data).
--
-- STATUS : written carefully but NOT yet executed.  Expect to fix small typos on first run.
--
-- HOW IT WORKS
--   * The whole script is ONE DO block, i.e. one transaction.  At the end it deliberately raises an error
--     whose message is the PASS/FAIL report, which rolls EVERYTHING back, so your data is unchanged.
--     The "error" at the end is expected; read the message.  (In psql the lines are also shown as NOTICEs.)
--   * Expected failures are caught in sub-blocks; each one rolls back its own partial changes, which
--     demonstrates that a failed call leaves no half-finished records.
--   * It assumes the seed from seed.sql and the default settings.
--   * Concurrency cannot be shown in one session: see "T13 - concurrent borrowing" in database/README.md.
-- =============================================================================

-- Small lookup helpers that live only for this session (pg_temp schema).
CREATE FUNCTION pg_temp.mid(p text)  RETURNS bigint LANGUAGE sql AS $f$ SELECT id FROM members     WHERE member_code = p $f$;
CREATE FUNCTION pg_temp.cid(p text)  RETURNS bigint LANGUAGE sql AS $f$ SELECT id FROM book_copies WHERE copy_code   = p $f$;
CREATE FUNCTION pg_temp.txid(p text) RETURNS bigint LANGUAGE sql AS $f$   -- active loan of a copy code
    SELECT t.id FROM transactions t JOIN book_copies c ON c.id = t.copy_id WHERE c.copy_code = p AND t.status = 'Borrowed' $f$;
CREATE FUNCTION pg_temp.rid(p text)  RETURNS bigint LANGUAGE sql AS $f$   -- open report of a copy code
    SELECT r.id FROM book_condition_reports r JOIN book_copies c ON c.id = r.copy_id
     WHERE c.copy_code = p AND r.status IN ('Reported', 'Under Repair') $f$;

-- Runs a statement that MUST fail with the given SQLSTATE; returns one report line.
CREATE FUNCTION pg_temp.t_expect(p_name text, p_sql text, p_state text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = p_state THEN
            RETURN 'PASS  ' || p_name || '  [' || SQLSTATE || ': ' || SQLERRM || ']';
        END IF;
        RETURN 'FAIL  ' || p_name || '  [expected ' || p_state || ' but got ' || SQLSTATE || ': ' || SQLERRM || ']';
    END;
    RETURN 'FAIL  ' || p_name || '  [expected error ' || p_state || ' but the statement succeeded]';
END $f$;

CREATE FUNCTION pg_temp.t_check(p_name text, p_ok boolean, p_detail text) RETURNS text LANGUAGE sql AS $f$
    SELECT CASE WHEN COALESCE(p_ok, false) THEN 'PASS  ' ELSE 'FAIL  ' END || p_name || '  [' || COALESCE(p_detail, '') || ']'
$f$;

DO $test$
DECLARE
    v_log   text := '';
    v_today date := fn_library_today();
    v_tx    bigint;
    v_rep   bigint;
    v_s     text;
    v_due   date;
    v_n     integer;
    v_days  integer;
    v_fine  numeric;
    v_new   date;
    v_before integer;
BEGIN
    -- ---------------------------------------------------------------- BORROWING
    -- T01 Borrow an available copy: loan created, due in 7 days (student), copy becomes Borrowed.
    CALL sp_BorrowBook(pg_temp.mid('M-2026-003'), pg_temp.cid('B006-C02'), NULL, v_tx);
    SELECT status, due_date INTO v_s, v_due FROM transactions WHERE id = v_tx;
    v_log := v_log || pg_temp.t_check('T01 borrow an available copy -> loan Borrowed, due in 7 days', v_s = 'Borrowed' AND v_due = v_today + 7, v_s || ', due ' || v_due) || E'\n';
    SELECT status INTO v_s FROM book_copies WHERE copy_code = 'B006-C02';
    v_log := v_log || pg_temp.t_check('T01 copy status becomes Borrowed', v_s = 'Borrowed', v_s) || E'\n';

    -- T02 Borrow a copy that is already borrowed.
    v_log := v_log || pg_temp.t_expect('T02 borrow an already-borrowed copy is rejected',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-005'), pg_temp.cid('B001-C01')), 'LM409') || E'\n';

    -- T03 Ineligible members: suspended, inactive, and one with an overdue loan.
    v_log := v_log || pg_temp.t_expect('T03a suspended member cannot borrow',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-008'), pg_temp.cid('B007-C02')), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T03b inactive member cannot borrow',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-010'), pg_temp.cid('B007-C02')), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T03c member with an overdue loan cannot borrow',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-004'), pg_temp.cid('B007-C02')), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T03d unknown member / unknown copy',
        format('CALL sp_BorrowBook(999999, %s, NULL, NULL::bigint)', pg_temp.cid('B007-C02')), 'LM404') || E'\n';

    -- T04 Borrowing limit: M-2026-001 has 2 loans; a 3rd succeeds, a 4th is rejected (limit 3).
    v_log := v_log || pg_temp.t_expect('T04a same title twice by one member is rejected (checked while the member is under the limit)',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-001'), pg_temp.cid('B001-C03')), 'LM409') || E'\n';
    CALL sp_BorrowBook(pg_temp.mid('M-2026-001'), pg_temp.cid('B002-C03'), NULL, v_tx);
    v_log := v_log || pg_temp.t_check('T04b third loan is allowed (limit 3)', v_tx IS NOT NULL, 'transaction ' || v_tx) || E'\n';
    v_log := v_log || pg_temp.t_expect('T04c fourth loan exceeds the borrowing limit',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-001'), pg_temp.cid('B003-C02')), 'LM409') || E'\n';

    -- ---------------------------------------------------------------- RETURNING
    -- T05 Return on time: loan Returned, copy Available, no fine.
    v_tx := pg_temp.txid('B004-C01');
    CALL sp_ReturnBook(v_tx, NULL, v_days, v_fine);
    SELECT status INTO v_s FROM transactions WHERE id = v_tx;
    v_log := v_log || pg_temp.t_check('T05 return on time -> Returned, 0 days late, fine 0', v_s = 'Returned' AND v_days = 0 AND v_fine = 0, v_s || ', ' || v_days || ' days, fine ' || v_fine) || E'\n';
    SELECT status INTO v_s FROM book_copies WHERE copy_code = 'B004-C01';
    v_log := v_log || pg_temp.t_check('T05 copy is Available again', v_s = 'Available', v_s) || E'\n';

    -- T06 Return a loan that is 3 days overdue: fine = 3 x 5.00; then try to return it again.
    v_tx := pg_temp.txid('B002-C01');
    CALL sp_ReturnBook(v_tx, NULL, v_days, v_fine);
    v_log := v_log || pg_temp.t_check('T06a overdue return -> 3 days late, fine 15.00', v_days = 3 AND v_fine = 15.00, v_days || ' days, fine ' || v_fine) || E'\n';
    v_log := v_log || pg_temp.t_expect('T06b returning the same transaction twice is rejected',
        format('CALL sp_ReturnBook(%s, NULL, NULL::integer, NULL::numeric)', v_tx), 'LM409') || E'\n';

    -- ---------------------------------------------------------------- RENEWING
    -- T07 Renew within the limit: due date +7, renewal_count 1, one renewal_history row.
    v_tx := pg_temp.txid('B001-C01');
    SELECT due_date INTO v_due FROM transactions WHERE id = v_tx;
    CALL sp_RenewBook(v_tx, NULL, v_new);
    SELECT count(*) INTO v_n FROM renewal_history WHERE transaction_id = v_tx;
    v_log := v_log || pg_temp.t_check('T07 renewal adds 7 days and writes renewal_history', v_new = v_due + 7 AND v_n = 1, 'new due ' || v_new || ', history rows ' || v_n) || E'\n';

    -- T08 Renew after the maximum (2): B005-C01 was renewed once already.
    v_tx := pg_temp.txid('B005-C01');
    CALL sp_RenewBook(v_tx, NULL, v_new);                                   -- 2nd renewal is allowed
    v_log := v_log || pg_temp.t_expect('T08 third renewal exceeds the maximum',
        format('CALL sp_RenewBook(%s, NULL, NULL::date)', v_tx), 'LM409') || E'\n';

    -- T09 More renewal rules.
    v_log := v_log || pg_temp.t_expect('T09a title reserved by another member blocks renewal',
        format('CALL sp_RenewBook(%s, NULL, NULL::date)', pg_temp.txid('B012-C01')), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T09b returned transaction cannot be renewed',
        format('CALL sp_RenewBook(%s, NULL, NULL::date)', (SELECT id FROM transactions WHERE copy_id = pg_temp.cid('B002-C01') AND status = 'Returned' ORDER BY id DESC LIMIT 1)), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T09c overdue loan cannot be renewed while the policy forbids it',
        format('CALL sp_RenewBook(%s, NULL, NULL::date)', pg_temp.txid('B006-C01')), 'LM409') || E'\n';
    UPDATE library_settings SET allow_overdue_renewal = true WHERE id = 1;         -- rolled back at the end
    v_tx := pg_temp.txid('B006-C01');
    CALL sp_RenewBook(v_tx, NULL, v_new);
    SELECT prior_overdue_days INTO v_n FROM transactions WHERE id = v_tx;
    v_log := v_log || pg_temp.t_check('T09d overdue renewal allowed by policy: due = today + 7, 6 overdue days kept', v_new = v_today + 7 AND v_n = 6, 'new due ' || v_new || ', prior overdue days ' || v_n) || E'\n';
    UPDATE library_settings SET allow_overdue_renewal = false WHERE id = 1;

    -- ---------------------------------------------------------------- CONDITION REPORTS
    -- T10 Report a damaged copy; it cannot be borrowed; preserved history is untouched.
    SELECT count(*) INTO v_before FROM transactions;
    CALL sp_ReportBookCondition(pg_temp.cid('B007-C02'), 'Damaged', 'Spine cracked badly', 'Ana Cruz', NULL, v_rep);
    SELECT status INTO v_s FROM book_copies WHERE copy_code = 'B007-C02';
    v_log := v_log || pg_temp.t_check('T10a damaged report -> copy Damaged', v_s = 'Damaged' AND v_rep IS NOT NULL, v_s) || E'\n';
    v_log := v_log || pg_temp.t_expect('T10b a damaged copy cannot be borrowed',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-005'), pg_temp.cid('B007-C02')), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T10c a lost copy (seed) cannot be borrowed',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-005'), pg_temp.cid('B009-C02')), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T10d a copy under repair (seed) cannot be borrowed',
        format('CALL sp_BorrowBook(%s, %s, NULL, NULL::bigint)', pg_temp.mid('M-2026-005'), pg_temp.cid('B005-C02')), 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T10e a second open report on the same copy is rejected',
        format('CALL sp_ReportBookCondition(%s, ''Lost'', ''Cannot find it'', ''Ana Cruz'', NULL, NULL::bigint)', pg_temp.cid('B007-C02')), 'LM409') || E'\n';

    -- T11 Lost while on loan: the loan row is kept (status Lost); damage on a loaned copy is rejected.
    v_tx := pg_temp.txid('B003-C01');
    v_log := v_log || pg_temp.t_expect('T11a damage on a copy that is on loan is rejected',
        format('CALL sp_ReportBookCondition(%s, ''Damaged'', ''Torn pages'', ''Ana Cruz'', NULL, NULL::bigint)', pg_temp.cid('B003-C01')), 'LM409') || E'\n';
    CALL sp_ReportBookCondition(pg_temp.cid('B003-C01'), 'Lost', 'Member says it was stolen', 'Ana Cruz', NULL, v_rep);
    SELECT status INTO v_s FROM transactions WHERE id = v_tx;
    v_log := v_log || pg_temp.t_check('T11b lost on loan -> loan kept with status Lost; no transaction deleted', v_s = 'Lost' AND (SELECT count(*) FROM transactions) = v_before, v_s) || E'\n';

    -- T12 Resolve a repaired copy.
    v_rep := pg_temp.rid('B007-C02');
    v_log := v_log || pg_temp.t_expect('T12a cannot mark Repaired before the repair has started',
        format('CALL sp_ResolveBookCondition(%s, ''Repaired'', ''Good'', ''Rebound'', NULL)', v_rep), 'LM409') || E'\n';
    CALL sp_StartBookRepair(v_rep, 'Taping and rebinding', NULL);
    SELECT status INTO v_s FROM book_copies WHERE copy_code = 'B007-C02';
    v_log := v_log || pg_temp.t_check('T12b repair started -> copy Under Repair', v_s = 'Under Repair', v_s) || E'\n';
    v_log := v_log || pg_temp.t_expect('T12c a Worn copy cannot go back into circulation',
        format('CALL sp_ResolveBookCondition(%s, ''Repaired'', ''Worn'', ''Rebound'', NULL)', v_rep), 'LM409') || E'\n';
    SELECT status INTO v_s FROM book_copies WHERE copy_code = 'B007-C02';
    v_log := v_log || pg_temp.t_check('T12d failed resolve changed nothing (copy still Under Repair)', v_s = 'Under Repair', v_s) || E'\n';
    CALL sp_ResolveBookCondition(v_rep, 'Repaired', 'Good', 'Rebound and tested', NULL);
    SELECT status INTO v_s FROM book_copies WHERE copy_code = 'B007-C02';
    v_log := v_log || pg_temp.t_check('T12e resolved as Repaired -> copy Available again', v_s = 'Available', v_s) || E'\n';
    v_log := v_log || pg_temp.t_expect('T12f resolving the same report again is rejected',
        format('CALL sp_ResolveBookCondition(%s, ''Repaired'', ''Good'', ''again'', NULL)', v_rep), 'LM409') || E'\n';
    CALL sp_CloseBookConditionReport(v_rep, NULL);
    SELECT status INTO v_s FROM book_condition_reports WHERE id = v_rep;
    v_log := v_log || pg_temp.t_check('T12g Resolved -> Closed', v_s = 'Closed', v_s) || E'\n';

    -- A lost copy stays unavailable until formally resolved; "Written off" withdraws it.
    CALL sp_ResolveBookCondition(pg_temp.rid('B009-C02'), 'Written off', NULL, 'Not recovered after the inventory', NULL);
    SELECT status INTO v_s FROM book_copies WHERE copy_code = 'B009-C02';
    v_log := v_log || pg_temp.t_check('T12h lost copy written off -> Withdrawn (never lent again)', v_s = 'Withdrawn', v_s) || E'\n';

    -- ---------------------------------------------------------------- DATABASE-LEVEL SAFEGUARDS
    v_log := v_log || pg_temp.t_expect('T14a duplicate ISBN is rejected',
        $q$INSERT INTO books (isbn, title, author, category, publication_year) VALUES ('9789710000011', 'x', 'y', 'z', 2020)$q$, '23505') || E'\n';
    v_log := v_log || pg_temp.t_expect('T14b invalid copy status is rejected',
        $q$UPDATE book_copies SET status = 'Broken' WHERE copy_code = 'B001-C03'$q$, '23514') || E'\n';
    v_log := v_log || pg_temp.t_expect('T14c two active loans for one copy are rejected by the unique index',
        format('INSERT INTO transactions (copy_id, member_id, due_date, original_due_date) VALUES (%s, %s, current_date + 7, current_date + 7)', pg_temp.cid('B001-C01'), pg_temp.mid('M-2026-005')), '23505') || E'\n';
    v_log := v_log || pg_temp.t_expect('T14d transactions cannot be deleted',
        $q$DELETE FROM transactions WHERE id = (SELECT min(id) FROM transactions)$q$, 'LM409') || E'\n';
    v_log := v_log || pg_temp.t_expect('T14e audit_logs cannot be edited',
        $q$UPDATE audit_logs SET action = 'DELETE' WHERE id = (SELECT min(id) FROM audit_logs)$q$, 'LM409') || E'\n';
    SELECT count(*) INTO v_n FROM audit_logs WHERE table_name = 'transactions';
    v_log := v_log || pg_temp.t_check('T14f changes were recorded in audit_logs', v_n > 0, v_n || ' transaction audit rows') || E'\n';

    -- ---------------------------------------------------------------- SEARCH / OVERDUE / REPORT / HISTORY
    SELECT count(*) INTO v_n FROM sp_SearchBooks('database') WHERE title = 'Fundamentals of Database Systems';
    v_log := v_log || pg_temp.t_check('T15a search by keyword finds the title', v_n = 1, v_n || ' match') || E'\n';
    SELECT count(*) INTO v_n FROM sp_SearchBooks();
    v_log := v_log || pg_temp.t_check('T15b empty search lists every book', v_n = 12, v_n || ' books') || E'\n';
    SELECT count(*) INTO v_n FROM sp_SearchBooks(NULL, 'Business');
    v_log := v_log || pg_temp.t_check('T15c category filter works', v_n = 1, v_n || ' in Business') || E'\n';
    SELECT count(*) INTO v_n FROM sp_SearchBooks('%');
    v_log := v_log || pg_temp.t_check('T15d a % keyword is plain text, not a wildcard', v_n = 0, v_n || ' rows') || E'\n';
    SELECT count(*) INTO v_n FROM sp_SearchBooks() WHERE available_copies > total_copies;
    v_log := v_log || pg_temp.t_check('T15e available copies never exceed total copies', v_n = 0, v_n || ' bad rows') || E'\n';

    SELECT count(*) INTO v_n FROM sp_GetOverdueBooks();
    SELECT count(*) INTO v_before FROM v_active_loans WHERE is_overdue;
    v_log := v_log || pg_temp.t_check('T16a overdue list matches the active-loans view', v_n = v_before AND v_n > 0, v_n || ' vs ' || v_before) || E'\n';
    SELECT count(*) INTO v_n FROM sp_GetOverdueBooks() WHERE days_overdue < 1;
    v_log := v_log || pg_temp.t_check('T16b every overdue row is at least 1 day overdue', v_n = 0, v_n || ' bad rows') || E'\n';
    SELECT count(*) INTO v_n FROM sp_GetOverdueBooks(fn_library_today() - 365);
    v_log := v_log || pg_temp.t_check('T16c nothing is overdue as of a year ago', v_n = 0, v_n || ' rows') || E'\n';

    SELECT books_borrowed INTO v_n FROM sp_GenerateBorrowReport(fn_library_today() - 30, fn_library_today());
    v_log := v_log || pg_temp.t_check('T17a report counts the seeded loans', v_n >= 12, v_n || ' borrowed in 30 days') || E'\n';
    SELECT books_borrowed INTO v_n FROM sp_GenerateBorrowReport(fn_library_today() - 400, fn_library_today() - 300);
    v_log := v_log || pg_temp.t_check('T17b an empty period reports zero', v_n = 0, v_n || ' borrowed') || E'\n';
    v_log := v_log || pg_temp.t_expect('T17c end date before start date is rejected',
        $q$SELECT * FROM sp_GenerateBorrowReport(current_date, current_date - 1)$q$, 'LM422') || E'\n';
    SELECT count(*) INTO v_n FROM sp_GetBorrowingHistory(pg_temp.mid('M-2026-004'));
    v_log := v_log || pg_temp.t_check('T17d member history includes returned and open loans', v_n >= 2, v_n || ' loans') || E'\n';

    -- ---------------------------------------------------------------- REPORT (also rolls everything back)
    v_n := (length(v_log) - length(replace(v_log, 'PASS  ', ''))) / 6;
    v_before := (length(v_log) - length(replace(v_log, 'FAIL  ', ''))) / 6;
    RAISE NOTICE E'\n%', v_log;
    RAISE EXCEPTION E'\n%\n== % passed, % failed.  All test changes were rolled back on purpose (this error is expected). ==', v_log, v_n, v_before
        USING ERRCODE = 'LMT00';
END
$test$;