// src/engine/recovery.js
// ─────────────────────────────────────────────────────────────
// Step 4: Failure Recovery
// Finds PROCESSING rows stuck beyond timeout and marks them FAILED.
// Runs every 10 seconds. Handles its own errors — never crashes app.
// ─────────────────────────────────────────────────────────────
const pool = require('../db/pool');

const TIMEOUT_SECONDS = parseInt(process.env.PROCESSING_TIMEOUT_SECONDS || '30');
const RECOVERY_INTERVAL_MS = 10000;

// Tracks recovery run stats for observability
const stats = {
    totalRuns: 0,
    totalRecovered: 0,
    lastRunAt: null,
    lastError: null,
};

async function recoverStuckTransactions() {
    stats.totalRuns++;
    stats.lastRunAt = new Date().toISOString();

    const client = await pool.connect();

    try {
        // Step 1: Find stuck rows
        // Uses the partial index on (status, locked_at) — fast even at millions of rows
        const stuck = await client.query(
            `SELECT id, idempotency_key, locked_by, locked_at, attempt_count
             FROM   idempotent_transactions
             WHERE  status = 'PROCESSING'
               AND  locked_at < NOW() - INTERVAL '${TIMEOUT_SECONDS} seconds'
             FOR UPDATE SKIP LOCKED`
            // FOR UPDATE SKIP LOCKED:
            // If two recovery workers run simultaneously (multiple servers),
            // each grabs different rows. No double-recovery.
        );

        if (stuck.rows.length === 0) return;

        console.log(`[RECOVERY] Found ${stuck.rows.length} stuck transaction(s)`);

        // Step 2: Mark each stuck row as FAILED
        for (const row of stuck.rows) {
            const stuckDuration = Math.round(
                (Date.now() - new Date(row.locked_at).getTime()) / 1000
            );

            console.log(
                `[RECOVERY] Recovering: ${row.idempotency_key} | ` +
                `locked by: ${row.locked_by} | ` +
                `stuck for: ${stuckDuration}s | ` +
                `attempts: ${row.attempt_count}`
            );

            // Only update if still PROCESSING — another recovery worker
            // might have just handled it (race-safe)
            const result = await client.query(
                `UPDATE idempotent_transactions
                 SET    status         = 'FAILED',
                        failure_reason = $1,
                        locked_by      = NULL,
                        locked_at      = NULL
                 WHERE  idempotency_key = $2
                   AND  status = 'PROCESSING'
                 RETURNING idempotency_key`,
                [
                    `Auto-failed after ${stuckDuration}s timeout. Was locked by: ${row.locked_by}. Attempt: ${row.attempt_count}`,
                    row.idempotency_key
                ]
            );

            if (result.rows.length > 0) {
                stats.totalRecovered++;
                console.log(`[RECOVERY] ✅ Recovered: ${row.idempotency_key}`);
            } else {
                console.log(`[RECOVERY] ⚠️  Skipped (already handled): ${row.idempotency_key}`);
            }
        }

    } catch (err) {
        // Recovery job must NEVER crash the app
        stats.lastError = err.message;
        console.error('[RECOVERY] Error during recovery run:', err.message);
    } finally {
        client.release();
    }
}

function startRecoveryJob() {
    console.log(`[RECOVERY] Starting (interval: ${RECOVERY_INTERVAL_MS}ms, timeout: ${TIMEOUT_SECONDS}s)`);

    // Run immediately on startup — catch anything stuck from last crash
    recoverStuckTransactions();

    // Then run on interval
    setInterval(recoverStuckTransactions, RECOVERY_INTERVAL_MS);
}

// Expose stats for health check endpoint
function getRecoveryStats() {
    return { ...stats };
}

module.exports = { startRecoveryJob, getRecoveryStats };
