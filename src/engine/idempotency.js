// src/engine/idempotency.js
const crypto = require('crypto');
const pool = require('../db/pool');
const { assertValidTransition } = require('./stateMachine');

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`;
const TIMEOUT_SECONDS = parseInt(process.env.PROCESSING_TIMEOUT_SECONDS || '30');

function computeRequestHash({ amount, currency, sender_account, receiver_account }) {
    const raw = `${amount}|${currency}|${sender_account}|${receiver_account}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
}

async function acquireIdempotencySlot(client, idempotencyKey, requestHash, payload) {
    const { amount, currency, sender_account, receiver_account } = payload;

    const insertResult = await client.query(
        `INSERT INTO idempotent_transactions
            (idempotency_key, request_hash, amount, currency, sender_account, receiver_account)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [idempotencyKey, requestHash, amount, currency, sender_account, receiver_account]
    );

    if (insertResult.rows.length > 0) {
        return { created: true, row: insertResult.rows[0] };
    }

    const existingResult = await client.query(
        `SELECT * FROM idempotent_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
    );

    return { created: false, row: existingResult.rows[0] };
}

function validateRequestHash(existingRow, incomingHash) {
    return existingRow.request_hash === incomingHash;
}

async function claimForProcessing(client, idempotencyKey) {
    const current = await client.query(
        `SELECT status FROM idempotent_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
    );

    if (current.rows.length === 0) throw new Error(`Row not found: ${idempotencyKey}`);
    assertValidTransition(current.rows[0].status, 'PROCESSING');

    const result = await client.query(
        `UPDATE idempotent_transactions
         SET    status        = 'PROCESSING',
                locked_by     = $1,
                locked_at     = NOW(),
                attempt_count = attempt_count + 1
         WHERE  idempotency_key = $2
           AND  status = 'INIT'
         RETURNING *`,
        [WORKER_ID, idempotencyKey]
    );

    return result.rows[0] || null;
}

async function markSuccess(client, idempotencyKey, responsePayload) {
    const current = await client.query(
        `SELECT status FROM idempotent_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
    );
    assertValidTransition(current.rows[0].status, 'SUCCESS');

    await client.query(
        `UPDATE idempotent_transactions
         SET    status           = 'SUCCESS',
                response_payload = $1,
                locked_by        = NULL,
                locked_at        = NULL
         WHERE  idempotency_key  = $2
           AND  status = 'PROCESSING'`,
        [JSON.stringify(responsePayload), idempotencyKey]
    );
}

async function markFailed(client, idempotencyKey, reason) {
    const current = await client.query(
        `SELECT status FROM idempotent_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
    );
    assertValidTransition(current.rows[0].status, 'FAILED');

    await client.query(
        `UPDATE idempotent_transactions
         SET    status         = 'FAILED',
                failure_reason = $1,
                locked_by      = NULL,
                locked_at      = NULL
         WHERE  idempotency_key = $2
           AND  status = 'PROCESSING'`,
        [reason, idempotencyKey]
    );
}

function isStuck(row) {
    if (!row.locked_at) return false;
    const elapsedSeconds = (Date.now() - new Date(row.locked_at).getTime()) / 1000;
    return elapsedSeconds > TIMEOUT_SECONDS;
}

async function processIdempotentRequest(idempotencyKey, payload) {
    const requestHash = computeRequestHash(payload);
    const client = await pool.connect();

    try {
        const { created, row } = await acquireIdempotencySlot(
            client, idempotencyKey, requestHash, payload
        );

        if (!created) {
            if (!validateRequestHash(row, requestHash)) {
                return { status: 422, body: { error: 'PAYLOAD_MISMATCH', message: 'Idempotency key reused with different payload.' } };
            }
            if (row.status === 'SUCCESS') {
                return { status: 200, body: row.response_payload, idempotent: true };
            }
            if (row.status === 'FAILED') {
                return { status: 422, body: { error: 'TRANSACTION_FAILED', message: row.failure_reason } };
            }
            if (row.status === 'PROCESSING') {
                if (isStuck(row)) {
                    return { status: 503, body: { error: 'PROCESSING_STUCK', message: 'Transaction stuck. Recovery in progress. Retry in 60s.' } };
                }
                return { status: 409, body: { error: 'PROCESSING_IN_PROGRESS', message: 'Being processed. Retry in a few seconds.' } };
            }
        }

        const claimed = await claimForProcessing(client, idempotencyKey);
        if (!claimed) {
            return { status: 409, body: { error: 'PROCESSING_IN_PROGRESS', message: 'Claimed by another worker. Retry shortly.' } };
        }

        try {
            const response = await executePayment(claimed);
            await markSuccess(client, idempotencyKey, response);
            return { status: 200, body: response };
        } catch (paymentError) {
            await markFailed(client, idempotencyKey, paymentError.message);
            return { status: 422, body: { error: 'PAYMENT_FAILED', message: paymentError.message } };
        }

    } finally {
        client.release();
    }
}

async function executePayment(row) {
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));

    if (Math.random() < 0.1) {
        throw new Error('Bank API rejected: insufficient funds');
    }

    return {
        transactionId: row.id,
        status: 'SUCCESS',
        amount: row.amount,
        currency: row.currency,
        sender: row.sender_account,
        receiver: row.receiver_account,
        processedAt: new Date().toISOString(),
        processedBy: WORKER_ID
    };
}

module.exports = { processIdempotentRequest, computeRequestHash };
