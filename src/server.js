require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

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
    cookie: { maxAge: 1000 * 60 * 60 * 12 },
  })
);

function ensureAdmin(req, res, next) {
  if (req.session?.adminId) return next();
  return res.redirect('/admin/login');
}

function nextPowerOfTwo(value) {
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

function seedPlayers(players) {
  return [...players].sort((a, b) => a.seed_rank - b.seed_rank || a.display_name.localeCompare(b.display_name));
}

async function fetchTournamentPlayers(tournamentId) {
  const result = await db.query(
    `SELECT p.id, p.display_name, p.seed_rank, tp.seed, tp.group_label
     FROM tournament_players tp
     JOIN players p ON p.id = tp.player_id
     WHERE tp.tournament_id = $1
     ORDER BY tp.seed ASC NULLS LAST, p.seed_rank ASC, p.display_name ASC`,
    [tournamentId]
  );
  return result.rows;
}

function createSingleEliminationMatches(players) {
  const seeded = seedPlayers(players);
  const size = nextPowerOfTwo(Math.max(2, seeded.length));
  const slots = Array.from({ length: size }, (_, i) => seeded[i] || null);
  const matches = [];
  let order = 1;

  for (let i = 0; i < size / 2; i += 1) {
    const playerA = slots[i];
    const playerB = slots[size - 1 - i];
    matches.push({
      play_order: order++,
      round_label: 'Round 1',
      bracket: 'main',
      player_a_id: playerA?.id || null,
      player_b_id: playerB?.id || null,
    });
  }

  let roundSize = size / 2;
  let roundNumber = 2;
  while (roundSize > 1) {
    for (let i = 0; i < roundSize / 2; i += 1) {
      matches.push({
        play_order: order++,
        round_label: `Round ${roundNumber}`,
        bracket: 'main',
        player_a_id: null,
        player_b_id: null,
      });
    }
    roundSize /= 2;
    roundNumber += 1;
  }

  return matches;
}

function createDoubleEliminationMatches(players) {
  const winners = createSingleEliminationMatches(players).map((m) => ({ ...m, bracket: 'winners' }));
  const lowerRoundCount = Math.max(1, Math.ceil(Math.log2(Math.max(players.length, 2))));
  let order = winners.length + 1;

  for (let i = 1; i <= lowerRoundCount; i += 1) {
    winners.push({
      play_order: order++,
      round_label: `Lower Round ${i}`,
      bracket: 'losers',
      player_a_id: null,
      player_b_id: null,
    });
  }

  winners.push({
    play_order: order,
    round_label: 'Grand Final',
    bracket: 'grand_final',
    player_a_id: null,
    player_b_id: null,
  });

  return winners;
}

function createRoundRobinGroupMatches(players, groupCount) {
  const seeded = seedPlayers(players);
  const groups = Array.from({ length: groupCount }, () => []);

  seeded.forEach((player, index) => {
    const groupIndex = index % groupCount;
    groups[groupIndex].push(player);
  });

  const matches = [];
  let order = 1;

  groups.forEach((groupPlayers, groupIndex) => {
    for (let i = 0; i < groupPlayers.length; i += 1) {
      for (let j = i + 1; j < groupPlayers.length; j += 1) {
        matches.push({
          play_order: order++,
          round_label: `Group ${String.fromCharCode(65 + groupIndex)} - Round Robin`,
          bracket: `group_${String.fromCharCode(65 + groupIndex)}`,
          player_a_id: groupPlayers[i].id,
          player_b_id: groupPlayers[j].id,
        });
      }
    }
  });

  return matches;
}

async function generateDraw(tournamentId) {
  const tournament = await db.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
  const selectedTournament = tournament.rows[0];
  if (!selectedTournament) throw new Error('Tournament not found');

  const players = await fetchTournamentPlayers(tournamentId);
  if (players.length < 2) throw new Error('At least two players are required for draw generation');

  let matches;
  if (selectedTournament.format === 'single_elimination') {
    matches = createSingleEliminationMatches(players);
  } else if (selectedTournament.format === 'double_elimination') {
    matches = createDoubleEliminationMatches(players);
  } else {
    matches = createRoundRobinGroupMatches(players, Number(selectedTournament.group_count) || 2);
  }

  await db.query('DELETE FROM matches WHERE tournament_id = $1', [tournamentId]);

  for (const match of matches) {
    await db.query(
      `INSERT INTO matches (tournament_id, play_order, round_label, bracket, player_a_id, player_b_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tournamentId, match.play_order, match.round_label, match.bracket, match.player_a_id, match.player_b_id]
    );
  }
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
       ORDER BY m.play_order ASC NULLS LAST, m.created_at ASC`,
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
    const players = await db.query('SELECT * FROM players ORDER BY seed_rank ASC, display_name ASC');
    res.render('admin/dashboard', { tournaments: tournaments.rows, players: players.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/players', ensureAdmin, async (req, res, next) => {
  const { display_name, seed_rank } = req.body;
  try {
    await db.query(
      `INSERT INTO players (display_name, seed_rank)
       VALUES ($1, $2)
       ON CONFLICT (display_name) DO UPDATE SET seed_rank = EXCLUDED.seed_rank`,
      [display_name, Number(seed_rank) || 1000]
    );
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments', ensureAdmin, async (req, res, next) => {
  const { name, location, starts_at, status, format, group_count, auto_draw } = req.body;
  const playerIds = Array.isArray(req.body.player_ids)
    ? req.body.player_ids.map(Number)
    : req.body.player_ids
      ? [Number(req.body.player_ids)]
      : [];

  try {
    const tournamentResult = await db.query(
      `INSERT INTO tournaments (name, location, starts_at, status, format, group_count)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [name, location || null, starts_at || null, status || 'upcoming', format, Number(group_count) || 2]
    );

    const tournamentId = tournamentResult.rows[0].id;

    if (playerIds.length) {
      const chosenPlayers = await db.query('SELECT * FROM players WHERE id = ANY($1::int[])', [playerIds]);
      const seeded = seedPlayers(chosenPlayers.rows);
      for (let i = 0; i < seeded.length; i += 1) {
        await db.query(
          'INSERT INTO tournament_players (tournament_id, player_id, seed) VALUES ($1, $2, $3)',
          [tournamentId, seeded[i].id, i + 1]
        );
      }
    }

    if (auto_draw === 'on' && playerIds.length >= 2) {
      await generateDraw(tournamentId);
    }

    res.redirect(`/admin/tournaments/${tournamentId}`);
  } catch (err) {
    next(err);
  }
});

app.get('/admin/tournaments/:id', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  try {
    const tournamentResult = await db.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    if (!tournamentResult.rows.length) return res.status(404).send('Tournament not found');

    const playersResult = await fetchTournamentPlayers(tournamentId);

    const allPlayersResult = await db.query('SELECT * FROM players ORDER BY seed_rank ASC, display_name ASC');

    const matchesResult = await db.query(
      `SELECT m.*, pa.display_name AS player_a_name, pb.display_name AS player_b_name
       FROM matches m
       LEFT JOIN players pa ON m.player_a_id = pa.id
       LEFT JOIN players pb ON m.player_b_id = pb.id
       WHERE m.tournament_id = $1
       ORDER BY m.play_order ASC NULLS LAST, m.created_at ASC`,
      [tournamentId]
    );

    res.render('admin/tournament-detail', {
      tournament: tournamentResult.rows[0],
      players: playersResult,
      allPlayers: allPlayersResult.rows,
      matches: matchesResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments/:id/players', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  const playerIds = Array.isArray(req.body.player_ids)
    ? req.body.player_ids.map(Number)
    : req.body.player_ids
      ? [Number(req.body.player_ids)]
      : [];

  try {
    for (const playerId of playerIds) {
      await db.query(
        `INSERT INTO tournament_players (tournament_id, player_id)
         VALUES ($1, $2)
         ON CONFLICT (tournament_id, player_id) DO NOTHING`,
        [tournamentId, playerId]
      );
    }

    const tournamentPlayers = await fetchTournamentPlayers(tournamentId);
    const seeded = seedPlayers(tournamentPlayers);
    for (let i = 0; i < seeded.length; i += 1) {
      await db.query(
        'UPDATE tournament_players SET seed = $1 WHERE tournament_id = $2 AND player_id = $3',
        [i + 1, tournamentId, seeded[i].id]
      );
    }

    res.redirect(`/admin/tournaments/${tournamentId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments/:id/draw', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  try {
    await generateDraw(tournamentId);
    res.redirect(`/admin/tournaments/${tournamentId}`);
  } catch (err) {
    next(err);
  }
});

app.post('/admin/tournaments/:id/matches/:matchId', ensureAdmin, async (req, res, next) => {
  const tournamentId = Number(req.params.id);
  const matchId = Number(req.params.matchId);
  const { score_a, score_b, status, table_number } = req.body;

  try {
    await db.query(
      `UPDATE matches
       SET score_a = $1, score_b = $2, status = $3, table_number = $4, updated_at = NOW()
       WHERE id = $5 AND tournament_id = $6`,
      [Number(score_a) || 0, Number(score_b) || 0, status, Number(table_number) || null, matchId, tournamentId]
    );
    res.redirect(`/admin/tournaments/${tournamentId}`);
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send(err.message || 'Internal server error');
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
