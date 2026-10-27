// Library Management System - backend (Express + PostgreSQL + Supabase Auth)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

// Make PostgreSQL numbers and dates easy to use in JSON.
pg.types.setTypeParser(20, Number);       // bigint  -> number
pg.types.setTypeParser(1700, Number);     // numeric -> number
pg.types.setTypeParser(1082, v => v);     // date    -> 'YYYY-MM-DD' text

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }      // Supabase requires an encrypted connection
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const app = express();
app.use(cors()); // ALLOWS YOUR BROWSER TO CONNECT
app.use(express.json());

/* ---------- 1. Who is calling? ---------- */
async function requireLogin(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Please sign in.' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });

    const { rows } = await pool.query(
      `SELECT p.id, p.full_name, p.role, m.id AS member_id, m.member_code, m.member_type,
            m.program_department, m.status AS member_status
         FROM profiles p LEFT JOIN members m ON m.profile_id = p.id
        WHERE p.id = $1`, [data.user.id]);
    if (!rows[0]) return res.status(403).json({ error: 'This account has no library profile yet.' });

    req.user = rows[0];
    next();
  } catch (err) { next(err); }
}

/* ---------- 2. Is their role allowed? ---------- */
const allow = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You are not allowed to do that.' });
const staffOnly = allow('Librarian', 'System Administrator');
const isStaff = u => ['Librarian', 'System Administrator'].includes(u.role);

/* ---------- 3. Turn database errors into clear messages ---------- */
const STATUS = { LM404: 404, LM409: 409, LM403: 403, LM422: 422 };
const wrap = fn => (req, res, next) => fn(req, res).catch(err => {
  if (STATUS[err.code]) return res.status(STATUS[err.code]).json({ error: err.message });
  next(err);
});
const whole = v => Number.isInteger(Number(v)) && Number(v) > 0;

/* ---------- Routes ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/me', requireLogin, (req, res) => res.json(req.user));

// Login endpoint for the frontend
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  
  res.json({ token: data.session.access_token });
});

// Catalog search
app.get('/api/books', requireLogin, wrap(async (req, res) => {
  const q = (req.query.q || '').trim() || null, category = req.query.category || null;
  const { rows } = await pool.query(
    `SELECT b.id, b.isbn, b.title, b.author, b.category, b.publisher, b.publication_year AS year,
            min(c.location) AS shelf,
            count(c.id) FILTER (WHERE c.status <> 'Withdrawn') AS copies,
            count(c.id) FILTER (WHERE c.status = 'Available')  AS available
       FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
      WHERE ($1::text IS NULL OR b.title ILIKE '%' || $1 || '%' OR b.author ILIKE '%' || $1 || '%' OR b.isbn = $1)
        AND ($2::text IS NULL OR b.category = $2)
      GROUP BY b.id ORDER BY b.title`, [q, category]);
  res.json(rows);
}));

// Add a new book title
app.post('/api/books', requireLogin, staffOnly, wrap(async (req, res) => {
  const { title, author, isbn, category, publisher, year } = req.body;
  if (!title || !author) return res.status(422).json({ error: 'Title and Author are required.' });

  const { rows } = await pool.query(
    `INSERT INTO books (title, author, isbn, category, publisher, publication_year)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [title, author, isbn, category, publisher, year]);

  res.status(201).json(rows[0]);
}));

// Add physical copies to a book
app.post('/api/book-copies', requireLogin, staffOnly, wrap(async (req, res) => {
  const { bookId, count, location } = req.body;
  if (!bookId || !count) return res.status(422).json({ error: 'Book ID and copy count are required.' });

  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO book_copies (book_id, location, status) VALUES ($1, $2, 'Available')`,
      [bookId, location || 'General']);
  }

  res.status(201).json({ message: `Added ${count} copies successfully.` });
}));

// Copies of one book
app.get('/api/books/:id/copies', requireLogin, staffOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, copy_code, copy_condition, location FROM book_copies
      WHERE book_id = $1 AND status = 'Available' ORDER BY copy_code`, [req.params.id]);
  res.json(rows);
}));

app.get('/api/members', requireLogin, staffOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.member_code, m.full_name, m.member_type, m.program_department, m.status, m.email,
            count(t.id) FILTER (WHERE t.status = 'Borrowed') AS active_loans
       FROM members m LEFT JOIN transactions t ON t.member_id = m.id
      GROUP BY m.id ORDER BY m.full_name`);
  res.json(rows);
}));

// Register a new member
app.post('/api/members', requireLogin, staffOnly, wrap(async (req, res) => {
  const { full_name, email, member_type, program_department } = req.body;
  if (!full_name || !email) return res.status(422).json({ error: 'Name and Email are required.' });

  // Generate a simple random member code (e.g., LIB-12345)
  const member_code = 'LIB-' + Math.floor(10000 + Math.random() * 90000);

  const { rows } = await pool.query(
    `INSERT INTO members (full_name, email, member_code, member_type, program_department, status)
     VALUES ($1, $2, $3, $4, $5, 'Active') RETURNING *`,
    [full_name, email, member_code, member_type, program_department]);

  res.status(201).json(rows[0]);
}));

// Active loans
app.get('/api/loans', requireLogin, wrap(async (req, res) => {
  if (!isStaff(req.user) && !req.user.member_id) return res.json([]);
  const { rows } = await pool.query(
    `SELECT * FROM v_active_loans WHERE ($1::bigint IS NULL OR member_id = $1) ORDER BY due_date`,
    [isStaff(req.user) ? null : req.user.member_id]);
  res.json(rows);
}));

// Borrowing history (staff see everyone, members see only their own)
app.get('/api/history', requireLogin, wrap(async (req, res) => {
  if (!isStaff(req.user) && !req.user.member_id) return res.json([]);
  const { rows } = await pool.query('SELECT * FROM sp_GetBorrowingHistory($1::bigint)',
    [isStaff(req.user) ? null : req.user.member_id]);
  res.json(rows);
}));

app.get('/api/overdue', requireLogin, staffOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM v_active_loans WHERE is_overdue ORDER BY days_overdue_now DESC`);
  res.json(rows);
}));

// Borrow
app.post('/api/loans', requireLogin, staffOnly, wrap(async (req, res) => {
  const { memberId, copyId } = req.body || {};
  if (!whole(memberId) || !whole(copyId)) return res.status(422).json({ error: 'Choose a member and a copy.' });
  const { rows } = await pool.query(
    'CALL sp_BorrowBook($1::bigint, $2::bigint, $3::uuid, NULL::bigint)', [memberId, copyId, req.user.id]);
  res.status(201).json({ transactionId: rows[0].p_transaction_id });
}));

// Return
app.post('/api/loans/:id/return', requireLogin, staffOnly, wrap(async (req, res) => {
  if (!whole(req.params.id)) return res.status(422).json({ error: 'Invalid loan number.' });
  const { rows } = await pool.query(
    'CALL sp_ReturnBook($1::bigint, $2::uuid, NULL::integer, NULL::numeric)', [req.params.id, req.user.id]);
  res.json({ daysLate: rows[0].p_days_late, fine: rows[0].p_fine_amount });
}));

// Renew
app.post('/api/loans/:id/renew', requireLogin, wrap(async (req, res) => {
  if (!whole(req.params.id)) return res.status(422).json({ error: 'Invalid loan number.' });
  const { rows } = await pool.query(
    'CALL sp_RenewBook($1::bigint, $2::uuid, NULL::date)', [req.params.id, req.user.id]);
  res.json({ newDueDate: rows[0].p_new_due_date });
}));

// Overdue Books -> sp_GetOverdueBooks
app.get('/api/overdue', requireLogin, staffOnly, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sp_GetOverdueBooks()');
  res.json(rows);
}));

// Generate Borrow Report -> sp_GenerateBorrowReport
app.get('/api/reports', requireLogin, staffOnly, wrap(async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(422).json({ error: 'Start and end dates required.' });
  const { rows } = await pool.query('SELECT * FROM sp_GenerateBorrowReport($1::date, $2::date)', [start, end]);
  res.json(rows[0]);
}));

/* ---------- Last-resort error handler ---------- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(process.env.PORT || 3000, () => console.log(`Library API running on port ${process.env.PORT || 3000}`));