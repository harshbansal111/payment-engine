// src/db/pool.js
// ─────────────────────────────────────────────────────────────
// Single shared connection pool for the entire app.
// Never create a new Pool per request — that kills your DB.
// ─────────────────────────────────────────────────────────────
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    // Max simultaneous DB connections.
    // Rule of thumb: (2 × CPU cores) + disk spindles
    // For dev: 10 is fine
    max: 10,

    // Kill idle connections after 30s
    idleTimeoutMillis: 30000,

    // Fail fast if DB is unreachable (2s timeout)
    connectionTimeoutMillis: 2000,
});

// Crash immediately if DB pool has an unexpected error.
// Better to restart than silently serve broken responses.
pool.on('error', (err) => {
    console.error('[DB POOL] Unexpected error:', err.message);
    process.exit(1);
});

module.exports = pool;
