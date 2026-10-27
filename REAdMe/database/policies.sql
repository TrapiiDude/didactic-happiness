-- =============================================================================
-- Library Management System (LMS) - Layer 2
-- File   : database/policies.sql
-- Target : Supabase PostgreSQL (uses Supabase's auth.uid() and the anon / authenticated roles)
-- Run    : AFTER schema.sql and procedures.sql, BEFORE seed.sql
--
-- STATUS : written carefully but NOT yet executed against a real Supabase project.
--
-- WHAT THIS FILE PROTECTS
--   Row Level Security (RLS) applies ONLY to requests that arrive through Supabase's client API
--   (PostgREST / supabase-js) as the roles `anon` or `authenticated`.
--
--   RLS does NOT protect requests made by our Express server over a direct PostgreSQL connection
--   (DATABASE_URL).  That connection normally uses the `postgres` role, which bypasses RLS.
--   Therefore the Express middleware must itself:
--     1. verify the Supabase JWT on every protected request,
--     2. load the caller's role from the `profiles` table (never trust a role sent by the browser),
--     3. check the role before calling a stored procedure,
--     4. pass the caller's profile id to the procedure (p_processed_by / p_reported_by / ...).
--
--   The stored procedures are NOT callable by `anon` / `authenticated` (EXECUTE is revoked below), so
--   borrowing, returning, renewing and condition changes can only happen through the backend.
--   The service-role key and the database password must never appear in frontend code.
--
-- INTENDED PERMISSIONS (enforced by the backend; RLS mirrors the read side)
--   Student / Faculty : view the catalog and copy availability; view own member record, own loans,
--                       own renewal history and own reservations; renew OWN eligible loans.
--   Librarian         : everything operational (books, copies, members, borrowing, returning,
--                       renewals, reservations, condition reports, reports); read audit-free data.
--   System Administrator : all of the above + library_settings, role changes, audit_logs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Helper functions used by the policies
--    SECURITY DEFINER lets a policy look up the caller's profile without recursing into profiles' own RLS.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT role FROM profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION app_member_id() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT id FROM members WHERE profile_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT role IN ('Librarian', 'System Administrator') FROM profiles WHERE id = auth.uid()), false)
$$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT role = 'System Administrator' FROM profiles WHERE id = auth.uid()), false)
$$;

-- -----------------------------------------------------------------------------
-- 2. Least-privilege GRANTs: start from nothing, then grant only what the policies below need
-- -----------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, anon, authenticated;   -- procedures + functions: backend only
GRANT  EXECUTE ON FUNCTION app_role(), app_member_id(), app_is_staff(), app_is_admin() TO authenticated;

-- Views (v_active_loans, v_activity_log, v_copy_status_history) get NO grants: they run with the owner's
-- rights and would bypass RLS, so they are for the backend only.

GRANT SELECT                                   ON profiles               TO authenticated;
GRANT UPDATE (full_name, role)                 ON profiles               TO authenticated;   -- row policies decide who may change what
GRANT SELECT, INSERT, UPDATE                   ON books                  TO authenticated;
GRANT SELECT, INSERT                           ON book_copies            TO authenticated;
GRANT UPDATE (copy_condition, location)       ON book_copies            TO authenticated;   -- status changes only via procedures
GRANT SELECT, INSERT, UPDATE                   ON members                TO authenticated;
GRANT SELECT                                   ON transactions           TO authenticated;   -- written only by procedures
GRANT SELECT                                   ON renewal_history        TO authenticated;
GRANT SELECT                                   ON reservations           TO authenticated;
GRANT SELECT                                   ON book_condition_reports TO authenticated;
GRANT SELECT, UPDATE                           ON library_settings       TO authenticated;
GRANT SELECT                                   ON audit_logs             TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Turn RLS on (a table with RLS on and no matching policy returns / allows nothing)
-- -----------------------------------------------------------------------------
ALTER TABLE profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE books                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_copies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE members                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewal_history         ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_condition_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs              ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 4. Policies
-- -----------------------------------------------------------------------------

-- profiles ---------------------------------------------------------------------
CREATE POLICY profiles_select_own_or_staff ON profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR app_is_staff());

-- A user may edit their own name but NOT their own role (the new role must equal the current one).
CREATE POLICY profiles_update_self ON profiles FOR UPDATE TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid() AND role = app_role());

-- Only a System Administrator may change anyone's role.
CREATE POLICY profiles_update_admin ON profiles FOR UPDATE TO authenticated
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- books (public catalog for signed-in users) -------------------------------------
CREATE POLICY books_select_all   ON books FOR SELECT TO authenticated USING (true);
CREATE POLICY books_insert_staff ON books FOR INSERT TO authenticated WITH CHECK (app_is_staff());
CREATE POLICY books_update_staff ON books FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

-- book_copies (availability is visible to everyone signed in) ---------------------
CREATE POLICY copies_select_all   ON book_copies FOR SELECT TO authenticated USING (true);
CREATE POLICY copies_insert_staff ON book_copies FOR INSERT TO authenticated
    WITH CHECK (app_is_staff() AND status = 'Available');
CREATE POLICY copies_update_staff ON book_copies FOR UPDATE TO authenticated
    USING (app_is_staff()) WITH CHECK (app_is_staff());

-- members --------------------------------------------------------------------------
CREATE POLICY members_select_own_or_staff ON members FOR SELECT TO authenticated
    USING (profile_id = auth.uid() OR app_is_staff());
CREATE POLICY members_insert_staff ON members FOR INSERT TO authenticated WITH CHECK (app_is_staff());
CREATE POLICY members_update_staff ON members FOR UPDATE TO authenticated USING (app_is_staff()) WITH CHECK (app_is_staff());

-- transactions / renewals / reservations: members see only their own ---------------
CREATE POLICY transactions_select_own_or_staff ON transactions FOR SELECT TO authenticated
    USING (member_id = app_member_id() OR app_is_staff());

CREATE POLICY renewal_history_select_own_or_staff ON renewal_history FOR SELECT TO authenticated
    USING (app_is_staff()
           OR EXISTS (SELECT 1 FROM transactions t WHERE t.id = renewal_history.transaction_id AND t.member_id = app_member_id()));

CREATE POLICY reservations_select_own_or_staff ON reservations FOR SELECT TO authenticated
    USING (member_id = app_member_id() OR app_is_staff());

-- condition reports: staff only ------------------------------------------------------
CREATE POLICY reports_select_staff ON book_condition_reports FOR SELECT TO authenticated USING (app_is_staff());

-- library_settings: everyone signed in may read the rules; only an administrator edits them ---
CREATE POLICY settings_select_all   ON library_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY settings_update_admin ON library_settings FOR UPDATE TO authenticated
    USING (app_is_admin()) WITH CHECK (app_is_admin());

-- audit_logs: administrators read; nobody writes through the client API ----------------
CREATE POLICY audit_select_admin ON audit_logs FOR SELECT TO authenticated USING (app_is_admin());

-- -----------------------------------------------------------------------------
-- 5. Making someone staff (run manually, as the database owner, after they have signed up)
--    Their profile row is created automatically with role 'Student'.
--
--    UPDATE profiles SET role = 'Librarian' WHERE email = 'your.librarian@example.edu';
--    UPDATE profiles SET role = 'System Administrator' WHERE email = 'your.admin@example.edu';
--
--    Link a login to a library member record (so a student sees their own loans):
--    UPDATE members SET profile_id = (SELECT id FROM profiles WHERE email = 'angela.reyes@example.edu')
--     WHERE member_code = 'M-2026-001';
-- -----------------------------------------------------------------------------