// src/middleware/validate.js
// ─────────────────────────────────────────────────────────────
// Validates all incoming payment requests BEFORE they hit the engine.
// Fail fast with clear error messages.
// ─────────────────────────────────────────────────────────────

function validatePaymentRequest(req, res, next) {
    const errors = [];

    // ── Check idempotency key header ──────────────────────────
    const idempotencyKey = req.headers['idempotency-key'];

    if (!idempotencyKey) {
        return res.status(400).json({
            error: 'MISSING_IDEMPOTENCY_KEY',
            message: 'Header "Idempotency-Key" is required.'
        });
    }

    if (idempotencyKey.length > 255) {
        return res.status(400).json({
            error: 'INVALID_IDEMPOTENCY_KEY',
            message: 'Idempotency-Key must be 255 characters or fewer.'
        });
    }

    // ── Check body fields ─────────────────────────────────────
    const { amount, currency, sender_account, receiver_account } = req.body;

    if (amount === undefined || amount === null) {
        errors.push('amount is required');
    } else if (typeof amount !== 'number' || amount <= 0) {
        errors.push('amount must be a positive number');
    } else if (!/^\d+(\.\d{1,2})?$/.test(String(amount))) {
        errors.push('amount must have at most 2 decimal places');
    }

    if (!currency) {
        errors.push('currency is required');
    } else if (!/^[A-Z]{3}$/.test(currency)) {
        errors.push('currency must be a 3-letter ISO code (e.g. INR, USD)');
    }

    if (!sender_account) {
        errors.push('sender_account is required');
    } else if (sender_account.length > 50) {
        errors.push('sender_account must be 50 characters or fewer');
    }

    if (!receiver_account) {
        errors.push('receiver_account is required');
    } else if (receiver_account.length > 50) {
        errors.push('receiver_account must be 50 characters or fewer');
    }

    if (sender_account && receiver_account && sender_account === receiver_account) {
        errors.push('sender_account and receiver_account must be different');
    }

    if (errors.length > 0) {
        return res.status(400).json({
            error: 'VALIDATION_FAILED',
            message: 'Request validation failed.',
            details: errors
        });
    }

    // Attach the key to req for easy access in route handler
    req.idempotencyKey = idempotencyKey;
    next();
}

module.exports = { validatePaymentRequest };
