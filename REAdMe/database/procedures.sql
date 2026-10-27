-- =============================================================================
-- Library Management System (LMS) - Layer 2
-- File   : database/procedures.sql
-- Target : Supabase PostgreSQL (PostgreSQL 14+; only INOUT parameters are used, which need 11+)
-- Run    : AFTER schema.sql
--
-- STATUS : written carefully but NOT yet executed against a real database.
--
-- REAL PostgreSQL PROCEDURES (CREATE PROCEDURE) run with CALL.  Examples:
--   CALL sp_BorrowBook(<member_id>, <copy_id>, NULL, NULL::bigint);
--   CALL sp_ReturnBook(<transaction_id>, NULL, NULL::integer, NULL::numeric);
--   CALL sp_RenewBook(<transaction_id>, NULL, NULL::date);
--   CALL sp_ReportBookCondition(<copy_id>, 'Damaged', 'Cover torn', 'Ana Cruz', NULL, NULL::bigint);
--   CALL sp_ResolveBookCondition(<report_id>, 'Repaired', 'Good', 'Rebound', NULL);
--
-- HOW RESULTS COME BACK: each procedure has an INOUT parameter that carries its result
-- (new transaction id, days late / fine, new due date, new report id).  With the `pg`
-- package, `CALL` returns one row containing those values.  Pass NULL (with a cast) for it.
-- (PostgreSQL unquoted names are folded to lower case: sp_BorrowBook is stored as sp_borrowbook.)
--
-- TRANSACTIONS: procedures contain NO COMMIT / ROLLBACK.  Everything a procedure does runs inside
-- the caller's transaction, so if any statement or RAISE EXCEPTION fails, ALL of its changes are
-- rolled back (all-or-nothing).  A plain `CALL` sent by the backend is its own transaction.
--
-- CONCURRENCY: rows are locked with SELECT ... FOR UPDATE.  Locks are always taken in the same order
-- (member -> copy -> transaction/report) so concurrent calls wait for each other instead of
-- deadlocking.  The unique indexes in schema.sql are a final safety net.
--
-- ERROR CODES (SQLSTATE) raised by these procedures; the backend maps them to HTTP statuses:
--   LM404  record not found            -> 404
--   LM409  business rule / state conflict -> 409
--   LM403  not allowed for this user   -> 403
--   LM422  invalid input               -> 422
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: record who is acting (used by the audit trigger and *_by columns)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_actor(p_actor uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_actor IS NULL THEN
        RETURN;                                           -- development use: no user identified
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor) THEN
        RAISE EXCEPTION 'User profile % does not exist.', p_actor USING ERRCODE = 'LM404';
    END IF;
    PERFORM set_config('app.current_user_id', p_actor::text, true);   -- true = only for this transaction
END $$;

-- -----------------------------------------------------------------------------
-- Helper: only staff may run staff operations.  (NULL actor = development shortcut, same as fn_set_actor.)
-- Students and faculty are refused with LM403; sp_RenewBook has its own owner check instead.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_require_staff(p_actor uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_actor IS NULL THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor AND role IN ('Librarian', 'System Administrator')) THEN
        RAISE EXCEPTION 'Only a librarian or administrator may do this.' USING ERRCODE = 'LM403';
    END IF;
END $$;


-- =============================================================================
-- A. sp_BorrowBook
--    IN  p_member_id, p_copy_id, p_processed_by (profile uuid or NULL)
--    INOUT p_transaction_id  -> id of the new transaction
-- =============================================================================
CREATE OR REPLACE PROCEDURE sp_BorrowBook(
    IN    p_member_id       bigint,
    IN    p_copy_id         bigint,
    IN    p_processed_by    uuid,
    INOUT p_transaction_id  bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_settings      library_settings%ROWTYPE;
    v_member        members%ROWTYPE;
    v_copy          book_copies%ROWTYPE;
    v_today         date;
    v_active_loans  integer;
    v_overdue_loans integer;
    v_limit         integer;
    v_loan_days     integer;
BEGIN
    IF p_member_id IS NULL OR p_copy_id IS NULL THEN
        RAISE EXCEPTION 'Member ID and copy ID are required.' USING ERRCODE = 'LM422';
    END IF;
    PERFORM fn_set_actor(p_processed_by);
    PERFORM fn_require_staff(p_processed_by);

    SELECT * INTO v_settings FROM library_settings WHERE id = 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Library settings row (id = 1) is missing.' USING ERRCODE = 'LM404';
    END IF;
    v_today := fn_library_today();                        -- "today" in the library's time zone

    -- 1) Lock the MEMBER row so two simultaneous borrows by the same member are checked one at a time
    --    (prevents exceeding the borrowing limit).
    SELECT * INTO v_member FROM members WHERE id = p_member_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member % does not exist.', p_member_id USING ERRCODE = 'LM404';
    END IF;
    IF v_member.status <> 'Active' THEN
        RAISE EXCEPTION 'Member % is % and cannot borrow (only Active members may borrow).', v_member.member_code, v_member.status
            USING ERRCODE = 'LM409';
    END IF;

    -- 2) Lock the COPY row.  A second borrower of the same copy waits here, then sees the new status.
    SELECT * INTO v_copy FROM book_copies WHERE id = p_copy_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Book copy % does not exist.', p_copy_id USING ERRCODE = 'LM404';
    END IF;
    IF v_copy.status <> 'Available' THEN
        RAISE EXCEPTION 'Copy % cannot be borrowed (status: %).', v_copy.copy_code, v_copy.status USING ERRCODE = 'LM409';
    END IF;

    -- 3) Borrowing limit (depends on member type) and overdue rule.
    IF v_member.member_type = 'Faculty' THEN
        v_limit := v_settings.faculty_borrow_limit;  v_loan_days := v_settings.faculty_loan_days;
    ELSE
        v_limit := v_settings.student_borrow_limit;  v_loan_days := v_settings.student_loan_days;
    END IF;

    SELECT count(*) INTO v_active_loans FROM transactions
     WHERE member_id = p_member_id AND status = 'Borrowed';
    IF v_active_loans >= v_limit THEN
        RAISE EXCEPTION 'Borrowing limit reached (% of % books on loan).', v_active_loans, v_limit USING ERRCODE = 'LM409';
    END IF;

    SELECT count(*) INTO v_overdue_loans FROM transactions
     WHERE member_id = p_member_id AND status = 'Borrowed' AND due_date < v_today;
    IF v_overdue_loans > 0 THEN
        RAISE EXCEPTION 'Member has % overdue book(s). Return them before borrowing again.', v_overdue_loans USING ERRCODE = 'LM409';
    END IF;

    -- 4) A member may not hold two copies of the same title.
    IF EXISTS (SELECT 1 FROM transactions t JOIN book_copies c ON c.id = t.copy_id
                WHERE t.member_id = p_member_id AND t.status = 'Borrowed' AND c.book_id = v_copy.book_id) THEN
        RAISE EXCEPTION 'Duplicate borrowing: member already has a copy of this title on loan.' USING ERRCODE = 'LM409';
    END IF;

    -- 5) Create the loan, mark the copy Borrowed, and fulfil this member's reservation for the title (if any).
    INSERT INTO transactions (copy_id, member_id, borrowed_at, due_date, original_due_date, issued_by)
    VALUES (v_copy.id, v_member.id, now(), v_today + v_loan_days, v_today + v_loan_days, p_processed_by)
    RETURNING id INTO p_transaction_id;

    UPDATE book_copies SET status = 'Borrowed' WHERE id = v_copy.id;

    UPDATE reservations SET status = 'Fulfilled', fulfilled_at = now()
     WHERE status = 'Active' AND member_id = v_member.id AND book_id = v_copy.book_id;
END $$;

-- =============================================================================
-- B. sp_ReturnBook
--    IN  p_transaction_id, p_processed_by
--    INOUT p_days_late, p_fine_amount -> overdue information of the returned loan
-- =============================================================================
CREATE OR REPLACE PROCEDURE sp_ReturnBook(
    IN    p_transaction_id  bigint,
    IN    p_processed_by    uuid,
    INOUT p_days_late       integer,
    INOUT p_fine_amount     numeric
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_settings  library_settings%ROWTYPE;
    v_tx        transactions%ROWTYPE;
    v_copy      book_copies%ROWTYPE;
    v_copy_id   bigint;
    v_today     date;
BEGIN
    IF p_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Transaction ID is required.' USING ERRCODE = 'LM422';
    END IF;
    PERFORM fn_set_actor(p_processed_by);
    PERFORM fn_require_staff(p_processed_by);
    SELECT * INTO v_settings FROM library_settings WHERE id = 1;
    v_today := fn_library_today();

    -- Find the copy first (no lock) so locks are taken copy -> transaction, the same order as the other procedures.
    SELECT copy_id INTO v_copy_id FROM transactions WHERE id = p_transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transaction % does not exist.', p_transaction_id USING ERRCODE = 'LM404';
    END IF;
    SELECT * INTO v_copy FROM book_copies  WHERE id = v_copy_id        FOR UPDATE;
    SELECT * INTO v_tx   FROM transactions WHERE id = p_transaction_id FOR UPDATE;

    -- Re-check AFTER locking: a concurrent return may have finished first (prevents duplicate returns).
    IF v_tx.status = 'Returned' THEN
        RAISE EXCEPTION 'Transaction % has already been returned.', p_transaction_id USING ERRCODE = 'LM409';
    ELSIF v_tx.status = 'Lost' THEN
        RAISE EXCEPTION 'Transaction % was closed as Lost; resolve its condition report instead of returning it.', p_transaction_id USING ERRCODE = 'LM409';
    END IF;

    -- Overdue days = days already charged before an overdue renewal + days late since the current due date.
    p_days_late    := v_tx.prior_overdue_days + GREATEST(v_today - v_tx.due_date, 0);
    p_fine_amount  := p_days_late * v_settings.fine_per_day;

    UPDATE transactions
       SET returned_at = now(), status = 'Returned', days_late = p_days_late,
           fine_amount = p_fine_amount, returned_by = p_processed_by
     WHERE id = p_transaction_id;

    -- Only a copy that is still marked Borrowed goes back to Available.
    IF v_copy.status = 'Borrowed' THEN
        UPDATE book_copies SET status = 'Available' WHERE id = v_copy.id;
    END IF;
END $$;

-- =============================================================================
-- C. sp_RenewBook
--    IN  p_transaction_id, p_processed_by
--    INOUT p_new_due_date -> the new due date
-- =============================================================================
CREATE OR REPLACE PROCEDURE sp_RenewBook(
    IN    p_transaction_id  bigint,
    IN    p_processed_by    uuid,
    INOUT p_new_due_date    date
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_settings      library_settings%ROWTYPE;
    v_tx            transactions%ROWTYPE;
    v_copy          book_copies%ROWTYPE;
    v_member        members%ROWTYPE;
    v_copy_id       bigint;
    v_today         date;
    v_overdue_days  integer;
    v_actor_role    text;
    v_open_report   bigint;
    v_reserver      text;
BEGIN
    IF p_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Transaction ID is required.' USING ERRCODE = 'LM422';
    END IF;
    PERFORM fn_set_actor(p_processed_by);
    SELECT * INTO v_settings FROM library_settings WHERE id = 1;
    v_today := fn_library_today();

    SELECT copy_id INTO v_copy_id FROM transactions WHERE id = p_transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transaction % does not exist.', p_transaction_id USING ERRCODE = 'LM404';
    END IF;
    SELECT * INTO v_copy FROM book_copies  WHERE id = v_copy_id        FOR UPDATE;
    SELECT * INTO v_tx   FROM transactions WHERE id = p_transaction_id FOR UPDATE;

    IF v_tx.status <> 'Borrowed' THEN
        RAISE EXCEPTION 'Transaction % is already %; only active loans can be renewed.', p_transaction_id, lower(v_tx.status)
            USING ERRCODE = 'LM409';
    END IF;

    -- Member must be Active.
    SELECT * INTO v_member FROM members WHERE id = v_tx.member_id;
    IF v_member.status <> 'Active' THEN
        RAISE EXCEPTION 'Member account is %; renewal not allowed.', v_member.status USING ERRCODE = 'LM409';
    END IF;

    -- Database-level ownership rule: a Student/Faculty account may only renew its own loans.
    IF p_processed_by IS NOT NULL THEN
        SELECT role INTO v_actor_role FROM profiles WHERE id = p_processed_by;
        IF v_actor_role IN ('Student', 'Faculty') AND v_member.profile_id IS DISTINCT FROM p_processed_by THEN
            RAISE EXCEPTION 'Members can only renew their own loans.' USING ERRCODE = 'LM403';
        END IF;
    END IF;

    -- The physical copy must still be a normal borrowed copy with no open condition report.
    SELECT id INTO v_open_report FROM book_condition_reports
     WHERE copy_id = v_copy.id AND status IN ('Reported', 'Under Repair');
    IF v_copy.status <> 'Borrowed' OR v_open_report IS NOT NULL THEN
        RAISE EXCEPTION 'Copy % is not eligible for renewal (status: %).', v_copy.copy_code, v_copy.status USING ERRCODE = 'LM409';
    END IF;

    IF v_tx.renewal_count >= v_settings.max_renewals THEN
        RAISE EXCEPTION 'Renewal limit reached (% of %).', v_tx.renewal_count, v_settings.max_renewals USING ERRCODE = 'LM409';
    END IF;

    v_overdue_days := GREATEST(v_today - v_tx.due_date, 0);
    IF v_overdue_days > 0 AND NOT v_settings.allow_overdue_renewal THEN
        RAISE EXCEPTION 'Loan is % day(s) overdue and library policy does not allow renewing overdue loans.', v_overdue_days
            USING ERRCODE = 'LM409';
    END IF;

    -- Another member waiting for the same TITLE blocks the renewal.
    SELECT m.full_name INTO v_reserver
      FROM reservations r JOIN members m ON m.id = r.member_id
     WHERE r.status = 'Active' AND r.book_id = v_copy.book_id AND r.member_id <> v_tx.member_id
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Another member (%) has an active reservation for this title.', v_reserver USING ERRCODE = 'LM409';
    END IF;

    -- New due date: current due date + renewal days; an overdue loan (if allowed) counts from today.
    p_new_due_date := CASE WHEN v_overdue_days > 0 THEN v_today ELSE v_tx.due_date END + v_settings.renewal_days;

    UPDATE transactions
       SET due_date = p_new_due_date,
           renewal_count = renewal_count + 1,
           prior_overdue_days = prior_overdue_days + v_overdue_days      -- overdue days already incurred stay on the fine
     WHERE id = p_transaction_id;

    INSERT INTO renewal_history (transaction_id, renewal_number, previous_due_date, new_due_date, renewal_days, renewed_by)
    VALUES (p_transaction_id, v_tx.renewal_count + 1, v_tx.due_date, p_new_due_date, v_settings.renewal_days, p_processed_by);
END $$;

-- =============================================================================
-- D. sp_ReportBookCondition
--    IN  p_copy_id, p_report_type ('Damaged' | 'Lost'), p_description, p_reporter_name, p_reported_by
--    INOUT p_report_id -> id of the new report
-- =============================================================================
CREATE OR REPLACE PROCEDURE sp_ReportBookCondition(
    IN    p_copy_id        bigint,
    IN    p_report_type    text,
    IN    p_description    text,
    IN    p_reporter_name  text,
    IN    p_reported_by    uuid,
    INOUT p_report_id      bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_copy     book_copies%ROWTYPE;
    v_tx       transactions%ROWTYPE;
    v_desc     text;
    v_name     text;
    v_open     bigint;
    v_loan_id  bigint;
BEGIN
    v_desc := btrim(COALESCE(p_description, ''));
    v_name := btrim(COALESCE(p_reporter_name, ''));
    IF p_copy_id IS NULL THEN
        RAISE EXCEPTION 'Copy ID is required.' USING ERRCODE = 'LM422';
    END IF;
    IF p_report_type IS NULL OR p_report_type NOT IN ('Damaged', 'Lost') THEN
        RAISE EXCEPTION 'Report type must be Damaged or Lost.' USING ERRCODE = 'LM422';
    END IF;
    IF length(v_desc) < 5 THEN
        RAISE EXCEPTION 'Enter a description of at least 5 characters.' USING ERRCODE = 'LM422';
    END IF;
    IF length(v_name) < 2 THEN
        RAISE EXCEPTION 'Enter the name of the reporting librarian.' USING ERRCODE = 'LM422';
    END IF;
    PERFORM fn_set_actor(p_reported_by);
    PERFORM fn_require_staff(p_reported_by);

    SELECT * INTO v_copy FROM book_copies WHERE id = p_copy_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Book copy % does not exist.', p_copy_id USING ERRCODE = 'LM404';
    END IF;
    IF v_copy.status = 'Withdrawn' THEN
        RAISE EXCEPTION 'Copy % has been withdrawn from the collection.', v_copy.copy_code USING ERRCODE = 'LM409';
    END IF;

    SELECT id INTO v_open FROM book_condition_reports
     WHERE copy_id = p_copy_id AND status IN ('Reported', 'Under Repair');
    IF FOUND THEN
        RAISE EXCEPTION 'Copy % already has an open report (id %). Resolve it first.', v_copy.copy_code, v_open USING ERRCODE = 'LM409';
    END IF;

    -- A copy on loan: damage must wait for its return; "Lost" closes the loan as Lost (the loan row is kept).
    IF v_copy.status = 'Borrowed' THEN
        IF p_report_type = 'Damaged' THEN
            RAISE EXCEPTION 'Copy % is on loan. Record its return first, then report the damage.', v_copy.copy_code USING ERRCODE = 'LM409';
        END IF;
        SELECT * INTO v_tx FROM transactions WHERE copy_id = p_copy_id AND status = 'Borrowed' FOR UPDATE;
        IF FOUND THEN
            UPDATE transactions SET status = 'Lost', lost_at = now() WHERE id = v_tx.id;
            v_loan_id := v_tx.id;
        END IF;
    END IF;

    INSERT INTO book_condition_reports
           (copy_id, report_type, description, status, previous_copy_status, loan_transaction_id, reporter_name, reported_by)
    VALUES (p_copy_id, p_report_type, v_desc, 'Reported', v_copy.status, v_loan_id, v_name, p_reported_by)
    RETURNING id INTO p_report_id;

    -- The copy becomes unusable: sp_BorrowBook only lends copies whose status is 'Available'.
    UPDATE book_copies SET status = p_report_type WHERE id = p_copy_id;   -- 'Damaged' or 'Lost'
END $$;

-- =============================================================================
-- E. sp_ResolveBookCondition
--    IN  p_report_id, p_resolution ('Repaired' | 'Found' | 'Written off'), p_condition_after,
--        p_notes, p_resolved_by
--    Repaired / Found -> report Resolved, copy back to Available (only if repaired/found and usable)
--    Written off      -> report Closed, copy Withdrawn (never lent again)
-- =============================================================================
CREATE OR REPLACE PROCEDURE sp_ResolveBookCondition(
    IN p_report_id        bigint,
    IN p_resolution       text,
    IN p_condition_after  text,
    IN p_notes            text,
    IN p_resolved_by      uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_report   book_condition_reports%ROWTYPE;
    v_copy     book_copies%ROWTYPE;
    v_copy_id  bigint;
    v_notes    text;
    v_restore  boolean;
BEGIN
    IF p_report_id IS NULL THEN
        RAISE EXCEPTION 'Report ID is required.' USING ERRCODE = 'LM422';
    END IF;
    v_notes := btrim(COALESCE(p_notes, ''));
    PERFORM fn_set_actor(p_resolved_by);
    PERFORM fn_require_staff(p_resolved_by);

    SELECT copy_id INTO v_copy_id FROM book_condition_reports WHERE id = p_report_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Condition report % does not exist.', p_report_id USING ERRCODE = 'LM404';
    END IF;
    SELECT * INTO v_copy   FROM book_copies             WHERE id = v_copy_id   FOR UPDATE;
    SELECT * INTO v_report FROM book_condition_reports  WHERE id = p_report_id FOR UPDATE;

    IF v_report.status NOT IN ('Reported', 'Under Repair') THEN
        RAISE EXCEPTION 'Report % is already %; it cannot be changed.', p_report_id, lower(v_report.status) USING ERRCODE = 'LM409';
    END IF;
    IF p_resolution IS NULL OR p_resolution NOT IN (CASE v_report.report_type WHEN 'Lost' THEN 'Found' ELSE 'Repaired' END, 'Written off') THEN
        RAISE EXCEPTION 'Resolution must be % or Written off.', CASE v_report.report_type WHEN 'Lost' THEN 'Found' ELSE 'Repaired' END
            USING ERRCODE = 'LM409';
    END IF;
    IF p_resolution = 'Repaired' AND v_report.status <> 'Under Repair' THEN
        RAISE EXCEPTION 'Start the repair first (status must be Under Repair) before marking the copy Repaired.' USING ERRCODE = 'LM409';
    END IF;
    IF length(v_notes) < 3 THEN
        RAISE EXCEPTION 'Enter resolution notes (at least 3 characters).' USING ERRCODE = 'LM422';
    END IF;

    v_restore := (p_resolution <> 'Written off');
    IF v_restore THEN
        -- Availability is restored ONLY when the copy is confirmed repaired/found, usable, and not on loan.
        IF p_condition_after IS NULL OR p_condition_after NOT IN ('New', 'Good', 'Fair', 'Worn') THEN
            RAISE EXCEPTION 'Select the condition of the copy after resolution.' USING ERRCODE = 'LM422';
        END IF;
        IF p_condition_after = 'Worn' THEN
            RAISE EXCEPTION 'A copy in Worn condition cannot go back into circulation. Give its real condition if it is usable, or write it off.' USING ERRCODE = 'LM409';
        END IF;
        IF EXISTS (SELECT 1 FROM transactions WHERE copy_id = v_copy.id AND status = 'Borrowed') THEN
            RAISE EXCEPTION 'Copy % still has an active loan, so it cannot be restored to Available.', v_copy.copy_code USING ERRCODE = 'LM409';
        END IF;
    END IF;

    UPDATE book_condition_reports
       SET status           = CASE WHEN v_restore THEN 'Resolved' ELSE 'Closed' END,
           resolution       = p_resolution,
           resolution_notes = v_notes,
           condition_after  = CASE WHEN v_restore THEN p_condition_after END,
           resolved_at      = now(),
           resolved_by      = p_resolved_by,
           closed_at        = CASE WHEN v_restore THEN NULL ELSE now() END,
           closed_by        = CASE WHEN v_restore THEN NULL ELSE p_resolved_by END
     WHERE id = p_report_id;

    UPDATE book_copies
       SET status         = CASE WHEN v_restore THEN 'Available' ELSE 'Withdrawn' END,
           copy_condition = CASE WHEN v_restore THEN p_condition_after ELSE copy_condition END
     WHERE id = v_copy.id;
END $$;

-- =============================================================================
-- SUPPLEMENTARY procedures (needed to keep the Layer 1 "Under Repair" and "Closed" states)
-- =============================================================================

-- F. sp_StartBookRepair : Reported (damage) -> Under Repair
CREATE OR REPLACE PROCEDURE sp_StartBookRepair(
    IN p_report_id   bigint,
    IN p_notes       text,
    IN p_started_by  uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_report  book_condition_reports%ROWTYPE;
    v_copy_id bigint;
BEGIN
    IF p_report_id IS NULL THEN
        RAISE EXCEPTION 'Report ID is required.' USING ERRCODE = 'LM422';
    END IF;
    PERFORM fn_set_actor(p_started_by);
    PERFORM fn_require_staff(p_started_by);

    SELECT copy_id INTO v_copy_id FROM book_condition_reports WHERE id = p_report_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Condition report % does not exist.', p_report_id USING ERRCODE = 'LM404';
    END IF;
    PERFORM 1 FROM book_copies WHERE id = v_copy_id FOR UPDATE;
    SELECT * INTO v_report FROM book_condition_reports WHERE id = p_report_id FOR UPDATE;

    IF v_report.report_type <> 'Damaged' THEN
        RAISE EXCEPTION 'Only damaged copies can be sent for repair.' USING ERRCODE = 'LM409';
    END IF;
    IF v_report.status <> 'Reported' THEN
        RAISE EXCEPTION 'Report % is already %; repair can only start from Reported.', p_report_id, lower(v_report.status) USING ERRCODE = 'LM409';
    END IF;

    UPDATE book_condition_reports
       SET status = 'Under Repair', repair_started_at = now(), repair_started_by = p_started_by, repair_notes = btrim(COALESCE(p_notes, ''))
     WHERE id = p_report_id;
    UPDATE book_copies SET status = 'Under Repair' WHERE id = v_copy_id;
END $$;

-- G. sp_CloseBookConditionReport : Resolved -> Closed (final)
CREATE OR REPLACE PROCEDURE sp_CloseBookConditionReport(
    IN p_report_id  bigint,
    IN p_closed_by  uuid
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_report  book_condition_reports%ROWTYPE;
    v_copy_id bigint;
BEGIN
    IF p_report_id IS NULL THEN
        RAISE EXCEPTION 'Report ID is required.' USING ERRCODE = 'LM422';
    END IF;
    PERFORM fn_set_actor(p_closed_by);
    PERFORM fn_require_staff(p_closed_by);

    SELECT copy_id INTO v_copy_id FROM book_condition_reports WHERE id = p_report_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Condition report % does not exist.', p_report_id USING ERRCODE = 'LM404';
    END IF;
    PERFORM 1 FROM book_copies WHERE id = v_copy_id FOR UPDATE;
    SELECT * INTO v_report FROM book_condition_reports WHERE id = p_report_id FOR UPDATE;

    IF v_report.status <> 'Resolved' THEN
        RAISE EXCEPTION 'Only Resolved reports can be closed (this report is %).', v_report.status USING ERRCODE = 'LM409';
    END IF;

    UPDATE book_condition_reports SET status = 'Closed', closed_at = now(), closed_by = p_closed_by WHERE id = p_report_id;
END $$;


-- =============================================================================
-- READ-ONLY ROUTINES (search, overdue, report, history)
-- A PostgreSQL PROCEDURE cannot return rows, so these are set-returning FUNCTIONS.  They are the
-- "stored procedures" named in the project proposal (Table 1) and are used with SELECT:
--   SELECT * FROM sp_SearchBooks('database');
--   SELECT * FROM sp_GetOverdueBooks();
--   SELECT * FROM sp_GenerateBorrowReport(current_date - 30, current_date);
--   SELECT * FROM sp_GetBorrowingHistory(<member_id>);
-- They change nothing.  The backend decides who may call them (staff only for overdue, reports, history).
-- =============================================================================

-- Search Books: keyword (title, author or exact ISBN), optional category and author; shows copy availability.
CREATE OR REPLACE FUNCTION sp_SearchBooks(
    p_keyword  text DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_author   text DEFAULT NULL
) RETURNS TABLE (book_id bigint, isbn varchar, title text, author text, category text,
                 total_copies bigint, available_copies bigint)
LANGUAGE sql STABLE AS $$
    SELECT b.id, b.isbn::varchar, b.title, b.author, b.category,
           count(c.id) FILTER (WHERE c.status <> 'Withdrawn'),
           count(c.id) FILTER (WHERE c.status = 'Available')
      FROM books b
      LEFT JOIN book_copies c ON c.book_id = b.id
     WHERE (nullif(btrim(p_keyword), '') IS NULL
            OR position(lower(btrim(p_keyword)) IN lower(b.title))  > 0     -- position() = plain text match, so % and _ are not wildcards
            OR position(lower(btrim(p_keyword)) IN lower(b.author)) > 0
            OR b.isbn = btrim(p_keyword))
       AND (nullif(btrim(p_category), '') IS NULL OR b.category = btrim(p_category))
       AND (nullif(btrim(p_author), '')   IS NULL OR position(lower(btrim(p_author)) IN lower(b.author)) > 0)
     GROUP BY b.id
     ORDER BY b.title
$$;

-- Get Overdue Books: unreturned loans past their due date as of p_as_of (default: the library's today),
-- with borrower and days overdue.  Looks at loans that are still open now.
CREATE OR REPLACE FUNCTION sp_GetOverdueBooks(p_as_of date DEFAULT NULL)
RETURNS TABLE (transaction_id bigint, member_code text, member_name text, member_type text, copy_code text,
               title text, borrowed_at timestamptz, due_date date, days_overdue integer,
               renewal_count smallint, projected_fine numeric)
LANGUAGE sql STABLE AS $$
    WITH d AS (SELECT COALESCE(p_as_of, fn_library_today()) AS today,
                      (SELECT fine_per_day FROM library_settings WHERE id = 1) AS fine)
    SELECT t.id, m.member_code, m.full_name, m.member_type, c.copy_code, b.title, t.borrowed_at, t.due_date,
           (d.today - t.due_date)::integer, t.renewal_count,
           ((t.prior_overdue_days + (d.today - t.due_date)) * d.fine)::numeric
      FROM d
      CROSS JOIN transactions t
      JOIN book_copies c ON c.id = t.copy_id
      JOIN books b       ON b.id = c.book_id
      JOIN members m     ON m.id = t.member_id
     WHERE t.status = 'Borrowed' AND t.due_date < d.today
     ORDER BY (d.today - t.due_date) DESC, t.id
$$;

-- Generate Borrow Report: one summary row for the period (dates are in the library time zone).
CREATE OR REPLACE FUNCTION sp_GenerateBorrowReport(p_start date, p_end date)
RETURNS TABLE (period_start date, period_end date, books_borrowed bigint, books_returned bigint,
               renewals bigint, fines_charged numeric, active_loans bigint, overdue_now bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tz    text;
    v_today date := fn_library_today();
BEGIN
    IF p_start IS NULL OR p_end IS NULL THEN
        RAISE EXCEPTION 'A start date and an end date are required.' USING ERRCODE = 'LM422';
    END IF;
    IF p_end < p_start THEN
        RAISE EXCEPTION 'The end date cannot be before the start date.' USING ERRCODE = 'LM422';
    END IF;
    SELECT timezone INTO v_tz FROM library_settings WHERE id = 1;

    RETURN QUERY SELECT
        p_start, p_end,
        (SELECT count(*) FROM transactions t WHERE (t.borrowed_at AT TIME ZONE v_tz)::date BETWEEN p_start AND p_end),
        (SELECT count(*) FROM transactions t WHERE t.returned_at IS NOT NULL AND (t.returned_at AT TIME ZONE v_tz)::date BETWEEN p_start AND p_end),
        (SELECT count(*) FROM renewal_history r WHERE (r.renewed_at AT TIME ZONE v_tz)::date BETWEEN p_start AND p_end),
        COALESCE((SELECT sum(t.fine_amount) FROM transactions t WHERE t.returned_at IS NOT NULL AND (t.returned_at AT TIME ZONE v_tz)::date BETWEEN p_start AND p_end), 0),
        (SELECT count(*) FROM transactions t WHERE t.status = 'Borrowed'),
        (SELECT count(*) FROM transactions t WHERE t.status = 'Borrowed' AND t.due_date < v_today);
END $$;

-- Borrowing history: every loan (open or finished), newest first; NULL member = everyone.
CREATE OR REPLACE FUNCTION sp_GetBorrowingHistory(p_member_id bigint DEFAULT NULL)
RETURNS TABLE (transaction_id bigint, member_code text, member_name text, title text, copy_code text,
               borrowed_at timestamptz, due_date date, returned_at timestamptz, status text,
               days_late integer, fine_amount numeric)
LANGUAGE sql STABLE AS $$
    SELECT t.id, m.member_code, m.full_name, b.title, c.copy_code, t.borrowed_at, t.due_date,
           t.returned_at, t.status, t.days_late, t.fine_amount
      FROM transactions t
      JOIN book_copies c ON c.id = t.copy_id
      JOIN books b       ON b.id = c.book_id
      JOIN members m     ON m.id = t.member_id
     WHERE p_member_id IS NULL OR t.member_id = p_member_id
     ORDER BY t.borrowed_at DESC, t.id DESC
$$;
