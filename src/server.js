require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    store: new pgSession({
      pool: db.pool,
      tableName: 'session',
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || 'insecure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

function ensureAdmin(req, res, next) {
  if (req.session?.adminId) return next();
  return res.redirect('/admin/login');
}

app.get('/', async (_req, res, next) => {
  try {
    const tournaments = await db.query(
      `SELECT t.*, 
        (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id) AS match_count,
        (SELECT COUNT(*) FROM matches m WHERE m.tournament_id = t.id AND m.status = 'in_progress') AS live_count
      FROM tournaments t
      ORDER BY t.starts_at NULLS LAST, t.created_at DESC`
    );
    res.render('live-home', { tournaments: tournaments.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/tournaments/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const tournamentResult = await db.query('SELECT * FROM tournaments WHERE id = $1', [id]);
    if (!tournamentResult.rows.length) return res.status(404).send('Tournament not found');

    const matchesResult = await db.query(
      `SELECT m.*, pa.display_name AS player_a_name, pb.display_name AS player_b_name
       FROM matches m
       LEFT JOIN players pa ON m.player_a_id = pa.id
       LEFT JOIN players pb ON m.player_b_id = pb.id
       WHERE m.tournament_id = $1
       ORDER BY
         CASE m.status WHEN 'in_progress' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END,
         m.table_number ASC NULLS LAST,
         m.updated_at DESC`,
      [id]
    );

    res.render('live-tournament', {
      tournament: tournamentResult.rows[0],
      matches: matchesResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/login', (_req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', async (req, res, next) => {
  const { email, password } = req.body;
  try {
    const result = await db.query('SELECT * FROM admins WHERE email = $1', [email]);
    const admin = result.rows[0];
    if (!admin) return res.status(401).render('admin/login', { error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).render('admin/login', { error: 'Invalid credentials' });

    req.session.adminId = admin.id;
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/logout', ensureAdmin, (req, res) => {
  req.session.destroy(() => {
    res.redirect('/admin/login');
  });
});

app.get('/admin', ensureAdmin, async (_req, res, next) => {
  try {
    const tournaments = await db.query('SELECT * FROM tournaments ORDER BY created_at DESC');
    res.render('admin/dashboard', { tournaments: tournaments.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments', ensureAdmin, async (req, res, next) => {
  const { name, location, starts_at, status } = req.body;
  try {
    await db.query(
      'INSERT INTO tournaments (name, location, starts_at, status) VALUES ($1, $2, $3, $4)',
      [name, location || null, starts_at || null, status || 'upcoming']
    );
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.get('/admin/tournaments/:id', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  try {
    const tournamentResult = await db.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tournamentResult.rows.length) return res.status(404).send('Tournament not found');

    const playersResult = await db.query(
      'SELECT * FROM players WHERE tournament_id = $1 ORDER BY display_name ASC',
      [tournamentId]
    );

    const matchesResult = await db.query(
      `SELECT m.*, pa.display_name AS player_a_name, pb.display_name AS player_b_name
       FROM matches m
       LEFT JOIN players pa ON m.player_a_id = pa.id
       LEFT JOIN players pb ON m.player_b_id = pb.id
       WHERE m.tournament_id = $1
       ORDER BY m.created_at DESC`,
      [tournamentId]
    );

    res.render('admin/tournament-detail', {
      tournament: tournamentResult.rows[0],
      players: playersResult.rows,
      matches: matchesResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments/:id/players', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  const { display_name } = req.body;
  try {
    await db.query('INSERT INTO players (tournament_id, display_name) VALUES ($1, $2)', [
      tournamentId,
      display_name,
    ]);
    res.redirect(`/admin/tournaments/${tournamentId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments/:id/matches', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  const { table_number, round_label, player_a_id, player_b_id } = req.body;
  try {
    await db.query(
      `INSERT INTO matches (tournament_id, table_number, round_label, player_a_id, player_b_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tournamentId,
        table_number ? Number(table_number) : null,
        round_label || null,
        player_a_id ? Number(player_a_id) : null,
        player_b_id ? Number(player_b_id) : null,
      ]
    );
    res.redirect(`/admin/tournaments/${tournamentId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments/:id/matches/:matchId', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  const matchId = Number(req.params.matchId);
  const { score_a, score_b, status } = req.body;

  try {
    await db.query(
      `UPDATE matches
       SET score_a = $1, score_b = $2, status = $3, updated_at = NOW()
       WHERE id = $4 AND tournament_id = $5`,
      [Number(score_a) || 0, Number(score_b) || 0, status, matchId, tournamentId]
    );
    res.redirect(`/admin/tournaments/${tournamentId}`);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Internal server error');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
