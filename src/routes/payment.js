// src/routes/payment.js
// ─────────────────────────────────────────────────────────────
// HTTP layer. Thin — all real logic lives in the engine.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { validatePaymentRequest } = require('../middleware/validate');
const { processIdempotentRequest } = require('../engine/idempotency');
const pool = require('../db/pool');

// ── POST /payments ────────────────────────────────────────────
// Create or replay a payment transaction.
router.post('/', validatePaymentRequest, async (req, res) => {
    const { idempotencyKey } = req;
    const { amount, currency, sender_account, receiver_account } = req.body;

    try {
        const result = await processIdempotentRequest(idempotencyKey, {
            amount,
            currency,
            sender_account,
            receiver_account
        });

        // Add header to tell client if this was a replayed response
        if (result.idempotent) {
            res.setHeader('Idempotent-Replayed', 'true');
        }

        return res.status(result.status).json(result.body);

    } catch (err) {
        console.error('[ROUTE] Unhandled error in POST /payments:', err.message);
        return res.status(500).json({
            error: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred. Please retry.'
        });
    }
});

// ── GET /payments/:key ────────────────────────────────────────
// Look up a transaction by its idempotency key.
// Useful for clients to poll status.
router.get('/:key', async (req, res) => {
    const key = req.params.key;

    try {
        const result = await pool.query(
            `SELECT id, idempotency_key, status, amount, currency,
                    sender_account, receiver_account,
                    response_payload, failure_reason,
                    attempt_count, created_at, updated_at
             FROM   idempotent_transactions
             WHERE  idempotency_key = $1`,
            [key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: 'NOT_FOUND',
                message: `No transaction found for key: ${key}`
            });
        }

        return res.status(200).json(result.rows[0]);

    } catch (err) {
        console.error('[ROUTE] Error in GET /payments/:key:', err.message);
        return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
});

// ── GET /payments ─────────────────────────────────────────────
// List recent transactions. For debugging and admin.
router.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);

    try {
        const result = await pool.query(
            `SELECT id, idempotency_key, status, amount, currency,
                    sender_account, receiver_account,
                    attempt_count, created_at, updated_at
             FROM   idempotent_transactions
             ORDER  BY created_at DESC
             LIMIT  $1`,
            [limit]
        );

        return res.status(200).json({
            count: result.rows.length,
            transactions: result.rows
        });

    } catch (err) {
        console.error('[ROUTE] Error in GET /payments:', err.message);
        return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
});

module.exports = router;
