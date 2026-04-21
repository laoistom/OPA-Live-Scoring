# OPA Live Scoring

A live-scoring web application inspired by Ultimate Pool's public scoring page, with an authenticated admin backend for tournament management.

## Features

- Public live-scoring pages for tournaments and matches.
- Admin authentication with email/password + session management.
- Admin dashboard to:
  - Create tournaments.
  - Add players to a tournament.
  - Create matches and assign players.
  - Update match scores and statuses in real-time.
- PostgreSQL as the backing store for users, tournaments, players, and match data.

## Tech Stack

- Node.js + Express
- EJS server-rendered views
- PostgreSQL (`pg`)
- Session auth with `express-session` + `connect-pg-simple`

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Copy env file:

```bash
cp .env.example .env
```

3. Create a PostgreSQL database and set `DATABASE_URL` in `.env`.

4. Apply schema:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

5. Seed an admin account:

```bash
npm run seed-admin
```

6. Start the app:

```bash
npm run dev
```

Open:

- Public live scoring: `http://localhost:3000`
- Admin login: `http://localhost:3000/admin/login`

## Run with Docker Compose

This repository includes a Docker setup for both the app and PostgreSQL.

1. Build and start containers:

```bash
docker compose up --build
```

2. Open:

- Public live scoring: `http://localhost:3000`
- Admin login: `http://localhost:3000/admin/login`

Notes:
- PostgreSQL is exposed on `localhost:5432`.
- Database schema is auto-applied on first startup from `db/schema.sql`.
- Admin account is auto-seeded at app startup from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Environment Variables

- `PORT` - App port (default: `3000`)
- `HOST` - Bind host for the Express server (default: `0.0.0.0`)
- `DATABASE_URL` - PostgreSQL connection string
- `SESSION_SECRET` - Secret for session signing
- `ADMIN_EMAIL` - Admin email used by `seed-admin`
- `ADMIN_PASSWORD` - Admin password used by `seed-admin`
