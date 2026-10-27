-- =============================================================================
-- Library Management System (LMS) - Layer 2
-- File   : database/schema.sql
-- Target : Supabase PostgreSQL (PostgreSQL 14 or newer)
-- Order  : schema.sql -> procedures.sql -> policies.sql -> seed.sql
--
-- STATUS : written carefully but NOT yet executed against a real database.
--          Run it on a fresh Supabase project and report any error message.
--
-- TABLE RELATIONSHIPS (1 = one, N = many)
--   profiles 1---N audit-style "who did it" columns (issued_by, reported_by, ...)
--   profiles 1---1 members            (members.profile_id, optional link to a login)
--   books    1---N book_copies        (a title has many physical copies)
--   book_copies 1---N transactions    (a copy is borrowed many times over its life)
--   members  1---N transactions       (a member borrows many times)
--   transactions 1---N renewal_history
--   book_copies 1---N book_condition_reports
--   transactions 1---N book_condition_reports (loan closed as Lost, optional)
--   books    1---N reservations ; members 1---N reservations
--   library_settings : single row (id = 1) read by the stored procedures
--   audit_logs : append-only change log written by triggers
--
-- DELETE RULES: every foreign key that points at history uses ON DELETE RESTRICT,
-- and triggers block deleting transactions / condition reports and any change to
-- renewal_history and audit_logs, so borrowing history cannot be destroyed by accident.
--
-- DEV ONLY reset (uncomment to rebuild from scratch; this destroys all LMS data):
--   DROP VIEW  IF EXISTS v_copy_status_history, v_activity_log, v_active_loans;
--   DROP TABLE IF EXISTS audit_logs, renewal_history, book_condition_reports, reservations,
--                        transactions, library_settings, members, book_copies, books, profiles CASCADE;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. GENERAL TRIGGER FUNCTIONS
-- -----------------------------------------------------------------------------

-- Keeps updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION fn_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- Who is performing the current action?  The backend (or a stored procedure) sets
--   SELECT set_config('app.current_user_id', '<profile uuid>', true);
-- inside the transaction.  Requests made directly through Supabase's client API
-- carry the user's id in the JWT claims, which is read as a fallback.
CREATE OR REPLACE FUNCTION fn_current_actor() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v text;
BEGIN
    v := NULLIF(current_setting('app.current_user_id', true), '');
    IF v IS NULL THEN
        v := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
    END IF;
    RETURN v::uuid;                       -- NULL when nobody is identified
EXCEPTION WHEN others THEN
    RETURN NULL;                          -- never let a bad setting block an operation
END $$;

-- Generic audit trigger: stores the old/new row as JSON.  SECURITY DEFINER so it can
-- write to audit_logs even when the caller has no direct privileges on that table.
CREATE OR REPLACE FUNCTION fn_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_logs (table_name, record_id, action, new_data, changed_by)
        VALUES (TG_TABLE_NAME, to_jsonb(NEW) ->> 'id', 'INSERT', to_jsonb(NEW), fn_current_actor());
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        -- ignore updates that change nothing except updated_at
        IF (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
            RETURN NEW;
        END IF;
        INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data, changed_by)
        VALUES (TG_TABLE_NAME, to_jsonb(NEW) ->> 'id', 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), fn_current_actor());
        RETURN NEW;
    ELSE
        INSERT INTO audit_logs (table_name, record_id, action, old_data, changed_by)
        VALUES (TG_TABLE_NAME, to_jsonb(OLD) ->> 'id', 'DELETE', to_jsonb(OLD), fn_current_actor());
        RETURN OLD;
    END IF;
END $$;

-- Used on tables whose rows must never be deleted / rewritten.
CREATE OR REPLACE FUNCTION fn_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed: history records are never deleted or rewritten.', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'LM409';
END $$;

-- -----------------------------------------------------------------------------
-- 2. TABLES
-- -----------------------------------------------------------------------------

-- 2.1 profiles : one row per application user (login) and that user's ROLE.
--     id matches Supabase Auth's auth.users.id (the foreign key is added in section 7).
CREATE TABLE profiles (
    id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    email       text         NOT NULL,
    full_name   text         NOT NULL,
    role        text         NOT NULL DEFAULT 'Student',
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_profiles_email UNIQUE (email),
    CONSTRAINT ck_profiles_role  CHECK (role IN ('Student', 'Faculty', 'Librarian', 'System Administrator')),
    CONSTRAINT ck_profiles_email CHECK (email = lower(email) AND position('@' in email) > 1),
    CONSTRAINT ck_profiles_name  CHECK (length(btrim(full_name)) > 0)
);

-- 2.2 books : bibliographic information for one TITLE (not a physical item).
CREATE TABLE books (
    id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    isbn              varchar(13)  NOT NULL,
    title             text         NOT NULL,
    author            text         NOT NULL,
    category          text         NOT NULL,
    publisher         text,
    publication_year  smallint     NOT NULL,
    description       text,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_books_isbn   UNIQUE (isbn),                                   -- no duplicate ISBNs
    CONSTRAINT ck_books_isbn   CHECK (isbn ~ '^([0-9]{9}[0-9X]|[0-9]{13})$'),   -- 10 or 13 digits, no hyphens
    CONSTRAINT ck_books_title  CHECK (length(btrim(title)) > 0),
    CONSTRAINT ck_books_author CHECK (length(btrim(author)) > 0),
    CONSTRAINT ck_books_cat    CHECK (length(btrim(category)) > 0),
    CONSTRAINT ck_books_year   CHECK (publication_year BETWEEN 1900 AND 2100)
);

-- 2.3 book_copies : individual physical copies of a title.
--     status         = availability ; copy_condition = physical condition.
CREATE TABLE book_copies (
    id              bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    copy_code       text         NOT NULL,                 -- readable ID such as B001-C01
    book_id         bigint       NOT NULL REFERENCES books (id) ON DELETE RESTRICT,
    copy_condition  text         NOT NULL DEFAULT 'Good',
    location        text         NOT NULL,
    status          text         NOT NULL DEFAULT 'Available',
    acquired_at     date         NOT NULL DEFAULT current_date,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_copies_code      UNIQUE (copy_code),
    CONSTRAINT ck_copies_condition CHECK (copy_condition IN ('New', 'Good', 'Fair', 'Worn')),
    CONSTRAINT ck_copies_status    CHECK (status IN ('Available', 'Borrowed', 'Reserved', 'Damaged', 'Under Repair', 'Lost', 'Withdrawn')),
    CONSTRAINT ck_copies_location  CHECK (length(btrim(location)) > 0)
);

-- 2.4 members : library borrowers.  Optional link to a login (profiles).
CREATE TABLE members (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    member_code        text         NOT NULL,              -- readable ID such as M-2026-001
    profile_id         uuid         UNIQUE REFERENCES profiles (id) ON DELETE SET NULL,
    full_name          text         NOT NULL,
    member_type        text         NOT NULL,
    email              text         NOT NULL,
    program_department text         NOT NULL,
    status             text         NOT NULL DEFAULT 'Active',
    joined_at          date         NOT NULL DEFAULT current_date,
    created_at         timestamptz  NOT NULL DEFAULT now(),
    updated_at         timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_members_code   UNIQUE (member_code),
    CONSTRAINT uq_members_email  UNIQUE (email),
    CONSTRAINT ck_members_type   CHECK (member_type IN ('Student', 'Faculty')),
    CONSTRAINT ck_members_status CHECK (status IN ('Active', 'Suspended', 'Inactive')),
    CONSTRAINT ck_members_email  CHECK (email = lower(email) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
    CONSTRAINT ck_members_name   CHECK (length(btrim(full_name)) > 0)
);

-- 2.5 library_settings : ONE row (id = 1) holding the configurable rules.
CREATE TABLE library_settings (
    id                     smallint      PRIMARY KEY DEFAULT 1,
    library_name           text          NOT NULL DEFAULT 'College Library',
    timezone               text          NOT NULL DEFAULT 'Asia/Manila',   -- decides what "today" means
    student_loan_days      integer       NOT NULL DEFAULT 7,
    faculty_loan_days      integer       NOT NULL DEFAULT 14,
    student_borrow_limit   integer       NOT NULL DEFAULT 3,
    faculty_borrow_limit   integer       NOT NULL DEFAULT 5,
    renewal_days           integer       NOT NULL DEFAULT 7,
    max_renewals           integer       NOT NULL DEFAULT 2,
    allow_overdue_renewal  boolean       NOT NULL DEFAULT false,
    fine_per_day           numeric(8,2)  NOT NULL DEFAULT 5.00,
    updated_at             timestamptz   NOT NULL DEFAULT now(),
    updated_by             uuid          REFERENCES profiles (id) ON DELETE RESTRICT,
    CONSTRAINT ck_settings_singleton CHECK (id = 1),
    CONSTRAINT ck_settings_name      CHECK (length(btrim(library_name)) BETWEEN 1 AND 60),
    CONSTRAINT ck_settings_student_days  CHECK (student_loan_days  BETWEEN 1 AND 90),
    CONSTRAINT ck_settings_faculty_days  CHECK (faculty_loan_days  BETWEEN 1 AND 180),
    CONSTRAINT ck_settings_student_limit CHECK (student_borrow_limit BETWEEN 1 AND 20),
    CONSTRAINT ck_settings_faculty_limit CHECK (faculty_borrow_limit BETWEEN 1 AND 30),
    CONSTRAINT ck_settings_renewal_days  CHECK (renewal_days BETWEEN 1 AND 60),
    CONSTRAINT ck_settings_max_renewals  CHECK (max_renewals BETWEEN 0 AND 10),
    CONSTRAINT ck_settings_fine          CHECK (fine_per_day BETWEEN 0 AND 1000)
);
INSERT INTO library_settings (id) VALUES (1);

-- "Today" in the library's own time zone, so due dates do not shift with the server clock.
CREATE OR REPLACE FUNCTION fn_library_today() RETURNS date
LANGUAGE sql STABLE AS $$
    SELECT (now() AT TIME ZONE (SELECT timezone FROM library_settings WHERE id = 1))::date
$$;

-- 2.6 transactions : one row per loan.  Never deleted.
CREATE TABLE transactions (
    id                 bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    copy_id            bigint        NOT NULL REFERENCES book_copies (id) ON DELETE RESTRICT,
    member_id          bigint        NOT NULL REFERENCES members (id)     ON DELETE RESTRICT,
    borrowed_at        timestamptz   NOT NULL DEFAULT now(),
    due_date           date          NOT NULL,                 -- current due date (moves on renewal)
    original_due_date  date          NOT NULL,                 -- due date when the loan started
    returned_at        timestamptz,
    lost_at            timestamptz,
    status             text          NOT NULL DEFAULT 'Borrowed',
    renewal_count      smallint      NOT NULL DEFAULT 0,
    prior_overdue_days integer       NOT NULL DEFAULT 0,       -- overdue days already incurred before an overdue renewal
    days_late          integer       NOT NULL DEFAULT 0,       -- final, set on return
    fine_amount        numeric(10,2) NOT NULL DEFAULT 0,       -- final, set on return
    issued_by          uuid          REFERENCES profiles (id) ON DELETE RESTRICT,
    returned_by        uuid          REFERENCES profiles (id) ON DELETE RESTRICT,
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT ck_tx_status  CHECK (status IN ('Borrowed', 'Returned', 'Lost')),
    CONSTRAINT ck_tx_due     CHECK (due_date >= original_due_date),
    CONSTRAINT ck_tx_state   CHECK (
           (status = 'Borrowed' AND returned_at IS NULL     AND lost_at IS NULL)
        OR (status = 'Returned' AND returned_at IS NOT NULL AND lost_at IS NULL)
        OR (status = 'Lost'     AND lost_at IS NOT NULL     AND returned_at IS NULL)),
    CONSTRAINT ck_tx_nonneg  CHECK (renewal_count >= 0 AND prior_overdue_days >= 0 AND days_late >= 0 AND fine_amount >= 0),
    CONSTRAINT ck_tx_order   CHECK (returned_at IS NULL OR returned_at >= borrowed_at)
);

-- 2.7 renewal_history : one row for every successful renewal (append-only).
CREATE TABLE renewal_history (
    id                bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id    bigint       NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
    renewal_number    smallint     NOT NULL,
    renewed_at        timestamptz  NOT NULL DEFAULT now(),
    previous_due_date date         NOT NULL,
    new_due_date      date         NOT NULL,
    renewal_days      integer      NOT NULL,
    renewed_by        uuid         REFERENCES profiles (id) ON DELETE RESTRICT,
    CONSTRAINT uq_renewal_number UNIQUE (transaction_id, renewal_number),
    CONSTRAINT ck_renewal_number CHECK (renewal_number >= 1),
    CONSTRAINT ck_renewal_dates  CHECK (new_due_date > previous_due_date),
    CONSTRAINT ck_renewal_days   CHECK (renewal_days > 0)
);

-- 2.8 reservations : a member waiting for a title (used by the renewal rule).
CREATE TABLE reservations (
    id            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id       bigint       NOT NULL REFERENCES books (id)   ON DELETE RESTRICT,
    member_id     bigint       NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
    status        text         NOT NULL DEFAULT 'Active',
    created_at    timestamptz  NOT NULL DEFAULT now(),
    fulfilled_at  timestamptz,
    cancelled_at  timestamptz,
    CONSTRAINT ck_reservations_status CHECK (status IN ('Active', 'Fulfilled', 'Cancelled')),
    CONSTRAINT ck_reservations_state  CHECK (
           (status = 'Active'    AND fulfilled_at IS NULL AND cancelled_at IS NULL)
        OR (status = 'Fulfilled' AND fulfilled_at IS NOT NULL)
        OR (status = 'Cancelled' AND cancelled_at IS NOT NULL))
);

-- 2.9 book_condition_reports : damaged / lost reports and how they were resolved.
--     Flow: Reported -> Under Repair (damage only) -> Resolved (Repaired / Found) -> Closed.
--           "Written off" closes the report directly and withdraws the copy.
CREATE TABLE book_condition_reports (
    id                   bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    copy_id              bigint       NOT NULL REFERENCES book_copies (id) ON DELETE RESTRICT,
    report_type          text         NOT NULL,
    description          text         NOT NULL,
    status               text         NOT NULL DEFAULT 'Reported',
    previous_copy_status text         NOT NULL,                 -- copy status before the report
    loan_transaction_id  bigint       REFERENCES transactions (id) ON DELETE RESTRICT,   -- loan closed as Lost, if any
    reporter_name        text         NOT NULL,                 -- reporting librarian (display name)
    reported_by          uuid         REFERENCES profiles (id) ON DELETE RESTRICT,
    reported_at          timestamptz  NOT NULL DEFAULT now(),
    repair_started_at    timestamptz,
    repair_started_by    uuid         REFERENCES profiles (id) ON DELETE RESTRICT,
    repair_notes         text,
    resolution           text,
    resolution_notes     text,
    condition_after      text,
    resolved_at          timestamptz,
    resolved_by          uuid         REFERENCES profiles (id) ON DELETE RESTRICT,
    closed_at            timestamptz,
    closed_by            uuid         REFERENCES profiles (id) ON DELETE RESTRICT,
    created_at           timestamptz  NOT NULL DEFAULT now(),
    updated_at           timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_report_type        CHECK (report_type IN ('Damaged', 'Lost')),
    CONSTRAINT ck_report_status      CHECK (status IN ('Reported', 'Under Repair', 'Resolved', 'Closed')),
    CONSTRAINT ck_report_desc        CHECK (length(btrim(description)) >= 5),
    CONSTRAINT ck_report_reporter    CHECK (length(btrim(reporter_name)) >= 2),
    CONSTRAINT ck_report_prev_status CHECK (previous_copy_status IN ('Available', 'Borrowed', 'Reserved', 'Damaged', 'Under Repair', 'Lost', 'Withdrawn')),
    CONSTRAINT ck_report_resolution  CHECK (resolution IS NULL OR resolution IN ('Repaired', 'Found', 'Written off')),
    CONSTRAINT ck_report_res_type    CHECK (resolution IS NULL OR resolution = 'Written off'
                                            OR (resolution = 'Repaired' AND report_type = 'Damaged')
                                            OR (resolution = 'Found'    AND report_type = 'Lost')),
    CONSTRAINT ck_report_cond_after  CHECK (condition_after IS NULL OR condition_after IN ('New', 'Good', 'Fair', 'Worn')),
    CONSTRAINT ck_report_state       CHECK (
           (status IN ('Reported', 'Under Repair') AND resolution IS NULL AND resolved_at IS NULL)
        OR (status IN ('Resolved', 'Closed') AND resolution IS NOT NULL AND resolved_at IS NOT NULL)),
    CONSTRAINT ck_report_repair      CHECK (status <> 'Under Repair' OR (report_type = 'Damaged' AND repair_started_at IS NOT NULL)),
    CONSTRAINT ck_report_closed      CHECK (status <> 'Closed' OR closed_at IS NOT NULL)
);

-- 2.10 audit_logs : append-only record of changes, filled by fn_audit().
--      changed_by deliberately has NO foreign key: an audit row must never block an operation.
CREATE TABLE audit_logs (
    id          bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name  text         NOT NULL,
    record_id   text         NOT NULL,
    action      text         NOT NULL,
    old_data    jsonb,
    new_data    jsonb,
    changed_by  uuid,
    changed_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_audit_action CHECK (action IN ('INSERT', 'UPDATE', 'DELETE'))
);

-- -----------------------------------------------------------------------------
-- 3. INDEXES (the UNIQUE / PRIMARY KEY constraints above already create their own)
-- -----------------------------------------------------------------------------
CREATE INDEX idx_books_title          ON books (lower(title));
CREATE INDEX idx_books_author         ON books (lower(author));
CREATE INDEX idx_books_category       ON books (category);
CREATE INDEX idx_copies_book          ON book_copies (book_id);
CREATE INDEX idx_copies_status        ON book_copies (status);
CREATE INDEX idx_members_name         ON members (lower(full_name));
CREATE INDEX idx_members_status       ON members (status);
CREATE INDEX idx_tx_member            ON transactions (member_id);
CREATE INDEX idx_tx_copy              ON transactions (copy_id);
CREATE INDEX idx_tx_active_due        ON transactions (due_date) WHERE status = 'Borrowed';   -- overdue lookups
CREATE INDEX idx_renewal_tx           ON renewal_history (transaction_id);
CREATE INDEX idx_reservations_book    ON reservations (book_id) WHERE status = 'Active';
CREATE INDEX idx_reports_copy         ON book_condition_reports (copy_id);
CREATE INDEX idx_reports_status       ON book_condition_reports (status);
CREATE INDEX idx_audit_record         ON audit_logs (table_name, record_id);
CREATE INDEX idx_audit_changed_at     ON audit_logs (changed_at);

-- Business rules enforced by the database itself (a second line of defence behind the procedures):
CREATE UNIQUE INDEX uq_tx_one_active_loan_per_copy  ON transactions (copy_id)  WHERE status = 'Borrowed';
CREATE UNIQUE INDEX uq_reservation_one_active       ON reservations (book_id, member_id) WHERE status = 'Active';
CREATE UNIQUE INDEX uq_report_one_open_per_copy     ON book_condition_reports (copy_id)  WHERE status IN ('Reported', 'Under Repair');

-- -----------------------------------------------------------------------------
-- 4. TRIGGERS
-- -----------------------------------------------------------------------------

-- Auto-generate copy_code (e.g. B001-C04) when it is not supplied.
CREATE OR REPLACE FUNCTION fn_set_copy_code() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_prefix text;
    v_next   integer;
BEGIN
    IF NEW.copy_code IS NOT NULL AND btrim(NEW.copy_code) <> '' THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM books WHERE id = NEW.book_id FOR UPDATE;      -- serialise code generation per title
    SELECT COALESCE(MAX(NULLIF(substring(copy_code FROM '-C([0-9]+)$'), '')::integer), 0) + 1
      INTO v_next FROM book_copies WHERE book_id = NEW.book_id;
    SELECT regexp_replace(copy_code, '-C[0-9]+$', '')
      INTO v_prefix FROM book_copies WHERE book_id = NEW.book_id LIMIT 1;
    IF v_prefix IS NULL THEN
        v_prefix := 'B' || lpad(NEW.book_id::text, 3, '0');
    END IF;
    NEW.copy_code := v_prefix || '-C' || lpad(v_next::text, 2, '0');
    RETURN NEW;
END $$;

CREATE TRIGGER trg_book_copies_10_code BEFORE INSERT ON book_copies
    FOR EACH ROW EXECUTE FUNCTION fn_set_copy_code();

DO $$
DECLARE
    t text;
BEGIN
    -- updated_at maintenance
    FOREACH t IN ARRAY ARRAY['profiles', 'books', 'book_copies', 'members', 'library_settings', 'transactions', 'book_condition_reports'] LOOP
        EXECUTE format('CREATE TRIGGER trg_%1$s_00_touch BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION fn_touch_updated_at()', t);
    END LOOP;
    -- audit trail
    FOREACH t IN ARRAY ARRAY['profiles', 'books', 'book_copies', 'members', 'library_settings', 'transactions', 'renewal_history', 'reservations', 'book_condition_reports'] LOOP
        EXECUTE format('CREATE TRIGGER trg_%1$s_90_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION fn_audit()', t);
    END LOOP;
END $$;

-- Protect history from deletion / rewriting.
CREATE TRIGGER trg_audit_logs_append_only     BEFORE UPDATE OR DELETE ON audit_logs             FOR EACH ROW EXECUTE FUNCTION fn_block_changes();
CREATE TRIGGER trg_renewal_history_append_only BEFORE UPDATE OR DELETE ON renewal_history       FOR EACH ROW EXECUTE FUNCTION fn_block_changes();
CREATE TRIGGER trg_transactions_no_delete     BEFORE DELETE ON transactions                     FOR EACH ROW EXECUTE FUNCTION fn_block_changes();
CREATE TRIGGER trg_condition_reports_no_delete BEFORE DELETE ON book_condition_reports          FOR EACH ROW EXECUTE FUNCTION fn_block_changes();

-- -----------------------------------------------------------------------------
-- 5. VIEWS (read-only helpers for the backend; history is derived, not stored twice)
-- -----------------------------------------------------------------------------

-- Current loans with overdue information calculated from the library's "today".
CREATE VIEW v_active_loans AS
SELECT t.id                  AS transaction_id,
       t.copy_id,
       c.copy_code,
       c.book_id,
       b.title,
       b.isbn,
       t.member_id,
       m.member_code,
       m.full_name           AS member_name,
       m.member_type,
       t.borrowed_at,
       t.due_date,
       t.original_due_date,
       t.renewal_count,
       t.prior_overdue_days,
       (fn_library_today() > t.due_date)                                   AS is_overdue,
       GREATEST(fn_library_today() - t.due_date, 0)                        AS days_overdue_now,
       (t.prior_overdue_days + GREATEST(fn_library_today() - t.due_date, 0)) * s.fine_per_day AS projected_fine
FROM transactions t
JOIN book_copies c ON c.id = t.copy_id
JOIN books b       ON b.id = c.book_id
JOIN members m     ON m.id = t.member_id
CROSS JOIN library_settings s
WHERE t.status = 'Borrowed' AND s.id = 1;

-- One chronological activity log built from the history tables.
CREATE VIEW v_activity_log AS
SELECT 'T' || t.id::text || '-B' AS event_key, t.borrowed_at AS event_at, 'Book Borrowed'::text AS event_type,
       t.id AS transaction_id, t.copy_id, NULL::bigint AS report_id, t.member_id, t.issued_by AS actor_id,
       ('Due ' || t.original_due_date::text) AS description
FROM transactions t
UNION ALL
SELECT 'T' || t.id::text || '-X', t.returned_at, 'Book Returned',
       t.id, t.copy_id, NULL::bigint, t.member_id, t.returned_by,
       CASE WHEN t.days_late > 0 THEN t.days_late::text || ' day(s) late; fine ' || t.fine_amount::text ELSE 'Returned on time' END
FROM transactions t WHERE t.status = 'Returned'
UNION ALL
SELECT 'T' || t.id::text || '-L', t.lost_at, 'Loan Closed as Lost',
       t.id, t.copy_id, NULL::bigint, t.member_id, NULL::uuid,
       'Copy reported lost while on loan; loan closed'
FROM transactions t WHERE t.status = 'Lost'
UNION ALL
SELECT 'R' || r.id::text, r.renewed_at, 'Loan Renewed',
       r.transaction_id, t.copy_id, NULL::bigint, t.member_id, r.renewed_by,
       'Renewal #' || r.renewal_number::text || ': due date ' || r.previous_due_date::text || ' -> ' || r.new_due_date::text
FROM renewal_history r JOIN transactions t ON t.id = r.transaction_id
UNION ALL
SELECT 'C' || x.id::text || '-R', x.reported_at, CASE WHEN x.report_type = 'Lost' THEN 'Lost Reported' ELSE 'Damage Reported' END,
       x.loan_transaction_id, x.copy_id, x.id, NULL::bigint, x.reported_by, x.description
FROM book_condition_reports x
UNION ALL
SELECT 'C' || x.id::text || '-P', x.repair_started_at, 'Moved to Repair',
       NULL::bigint, x.copy_id, x.id, NULL::bigint, x.repair_started_by, COALESCE(x.repair_notes, 'Repair started')
FROM book_condition_reports x WHERE x.repair_started_at IS NOT NULL
UNION ALL
SELECT 'C' || x.id::text || '-S', x.resolved_at,
       CASE x.resolution WHEN 'Repaired' THEN 'Repair Completed' WHEN 'Found' THEN 'Copy Found' ELSE 'Copy Written Off' END,
       NULL::bigint, x.copy_id, x.id, NULL::bigint, x.resolved_by, COALESCE(x.resolution_notes, '')
FROM book_condition_reports x WHERE x.resolved_at IS NOT NULL
UNION ALL
SELECT 'C' || x.id::text || '-C', x.closed_at, 'Report Closed',
       NULL::bigint, x.copy_id, x.id, NULL::bigint, x.closed_by, 'Report closed'
FROM book_condition_reports x WHERE x.status = 'Closed' AND x.resolution <> 'Written off';

-- Status / condition changes of each copy, taken from the audit trail.
CREATE VIEW v_copy_status_history AS
SELECT a.id                                AS audit_id,
       a.changed_at,
       (a.new_data ->> 'id')::bigint       AS copy_id,
       a.new_data ->> 'copy_code'          AS copy_code,
       a.old_data ->> 'status'             AS from_status,
       a.new_data ->> 'status'             AS to_status,
       a.old_data ->> 'copy_condition'     AS from_condition,
       a.new_data ->> 'copy_condition'     AS to_condition,
       a.changed_by
FROM audit_logs a
WHERE a.table_name = 'book_copies'
  AND a.action IN ('INSERT', 'UPDATE')
  AND (a.action = 'INSERT'
       OR (a.old_data ->> 'status')         IS DISTINCT FROM (a.new_data ->> 'status')
       OR (a.old_data ->> 'copy_condition') IS DISTINCT FROM (a.new_data ->> 'copy_condition'));

-- -----------------------------------------------------------------------------
-- 6. NEW SUPABASE USERS -> profiles (role is ALWAYS 'Student'; staff roles are granted by an admin)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO profiles (id, email, full_name, role)
    VALUES (NEW.id,
            COALESCE(lower(NEW.email), NEW.id::text || '@no-email.invalid'),
            COALESCE(NULLIF(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), split_part(lower(COALESCE(NEW.email, 'user')), '@', 1)),
            'Student')                                   -- never trust a role sent from the browser
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- 7. LINK TO SUPABASE AUTH (only when the auth schema exists, i.e. on Supabase)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('auth.users') IS NOT NULL THEN
        ALTER TABLE profiles
            ADD CONSTRAINT fk_profiles_auth_user FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE;
        EXECUTE 'CREATE TRIGGER trg_auth_user_created AFTER INSERT ON auth.users
                 FOR EACH ROW EXECUTE FUNCTION fn_handle_new_user()';
    ELSE
        RAISE NOTICE 'auth.users was not found: profiles.id is NOT linked to Supabase Auth (fine outside Supabase).';
    END IF;
END $$;