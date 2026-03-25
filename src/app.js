// src/app.js
require('dotenv').config();
const express = require('express');
const pool = require('./db/pool');
const paymentRoutes = require('./routes/payment');
const { startRecoveryJob, getRecoveryStats } = require('./engine/recovery');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
});

app.use('/payments', paymentRoutes);

// Health check — includes recovery job stats
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            status: 'ok',
            db: 'connected',
            worker: process.env.WORKER_ID || `worker-${process.pid}`,
            recovery: getRecoveryStats()
        });
    } catch (err) {
        res.status(503).json({ status: 'error', db: 'disconnected' });
    }
});

// Admin: view all transactions
app.get('/admin/transactions', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, idempotency_key, status, amount, currency,
                    sender_account, receiver_account,
                    failure_reason, locked_by, locked_at,
                    attempt_count, created_at, updated_at
             FROM   idempotent_transactions
             ORDER  BY created_at DESC
             LIMIT  50`
        );
        res.json({ count: result.rows.length, transactions: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
});

app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.use((err, req, res, next) => res.status(500).json({ error: 'INTERNAL_ERROR' }));

async function start() {
    try {
        await pool.query('SELECT 1');
        console.log('[DB] Connected successfully');
    } catch (err) {
        console.error('[DB] Failed to connect:', err.message);
        process.exit(1);
    }

    startRecoveryJob();

    app.listen(PORT, () => {
        console.log(`[APP] Payment engine running on http://localhost:${PORT}`);
        console.log(`[APP] Worker ID: ${process.env.WORKER_ID || 'worker-' + process.pid}`);
        console.log('');
        console.log('Endpoints:');
        console.log(`  POST   http://localhost:${PORT}/payments`);
        console.log(`  GET    http://localhost:${PORT}/payments`);
        console.log(`  GET    http://localhost:${PORT}/payments/:key`);
        console.log(`  GET    http://localhost:${PORT}/health`);
        console.log(`  GET    http://localhost:${PORT}/admin/transactions`);
    });
}

start();
