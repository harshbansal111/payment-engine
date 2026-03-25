-- =============================================================
-- payment-engine: schema.sql
-- Run this ONCE to set up your database before starting the app
-- =============================================================

-- Clean slate (for development resets)
DROP TABLE IF EXISTS idempotent_transactions;
DROP TYPE IF EXISTS transaction_status;

-- ── State machine enum ────────────────────────────────────────
-- Only these 4 values are valid. DB rejects anything else.
-- INIT       → row created, no worker has touched it yet
-- PROCESSING → a worker claimed it and is actively running
-- SUCCESS    → completed successfully, response stored
-- FAILED     → permanently failed, do not retry
CREATE TYPE transaction_status AS ENUM (
    'INIT',
    'PROCESSING',
    'SUCCESS',
    'FAILED'
);

-- ── Core table ────────────────────────────────────────────────
CREATE TABLE idempotent_transactions (

    -- Server-generated UUID. Never expose sequential IDs.
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Client-provided key. The UNIQUE constraint is the race condition fix.
    idempotency_key     VARCHAR(255) NOT NULL UNIQUE,

    -- State machine position
    status              transaction_status NOT NULL DEFAULT 'INIT',

    -- SHA-256 of (amount + currency + sender + receiver)
    -- Detects same key sent with different payload (bug or attack)
    request_hash        VARCHAR(64) NOT NULL,

    -- Business fields (denormalized for audit — never join for history)
    amount              NUMERIC(12, 2) NOT NULL,
    currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
    sender_account      VARCHAR(50) NOT NULL,
    receiver_account    VARCHAR(50) NOT NULL,

    -- Stored on SUCCESS. Retries return THIS — not a recomputed result.
    response_payload    JSONB,

    -- Stored on FAILED. Always record why.
    failure_reason      TEXT,

    -- Soft lock: which worker is processing this right now?
    locked_by           VARCHAR(100),

    -- Soft lock: when did processing start?
    -- Recovery job uses this to find stuck transactions.
    locked_at           TIMESTAMPTZ,

    -- Retry tracking
    attempt_count       INTEGER NOT NULL DEFAULT 0,

    -- Audit trail
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────

-- Primary lookup: every request does this query
CREATE UNIQUE INDEX idx_idempotency_key
    ON idempotent_transactions(idempotency_key);

-- Recovery job: find stuck PROCESSING rows efficiently
-- Partial index: only indexes PROCESSING rows (tiny, fast)
CREATE INDEX idx_status_locked_at
    ON idempotent_transactions(status, locked_at)
    WHERE status = 'PROCESSING';

-- Audit: all transactions for a sender account
CREATE INDEX idx_sender_account
    ON idempotent_transactions(sender_account, created_at DESC);

-- ── Auto-update trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_updated_at
    BEFORE UPDATE ON idempotent_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
