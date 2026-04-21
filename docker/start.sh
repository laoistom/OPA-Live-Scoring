#!/bin/sh
set -e

echo "Waiting for PostgreSQL..."
until node -e "require('./src/db').query('SELECT 1').then(()=>process.exit(0)).catch(()=>process.exit(1))"; do
  sleep 2
  echo "PostgreSQL not ready yet, retrying..."
done

echo "Database is ready. Seeding admin account..."
node scripts/seedAdmin.js

echo "Starting web server..."
node src/server.js
