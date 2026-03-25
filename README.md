# Payment Engine — Idempotent Transaction Processor

A production-grade idempotent transaction processing engine built with Node.js + PostgreSQL.

---

## What This System Guarantees

- **Exactly-once execution** — same request never processed twice
- **Race condition safety** — DB UNIQUE constraint, not application locks
- **Payload fingerprinting** — same key + different payload = rejected
- **Stuck transaction recovery** — background job cleans up crashed workers
- **Full audit trail** — every state transition recorded

---

## Project Structure

```
payment-engine/
├── src/
│   ├── app.js                  ← Entry point
│   ├── db/
│   │   ├── pool.js             ← DB connection pool
│   │   └── schema.sql          ← Run this once to set up DB
│   ├── engine/
│   │   ├── idempotency.js      ← Core idempotency logic
│   │   └── recovery.js         ← Stuck transaction recovery job
│   ├── middleware/
│   │   └── validate.js         ← Request validation
│   └── routes/
│       └── payment.js          ← HTTP route handlers
├── .env                        ← Your config (edit this)
├── package.json
└── README.md
```

---

## Prerequisites

- Node.js v18 or higher
- PostgreSQL v14 or higher

### Install Node.js (if not installed)
```bash
# macOS
brew install node

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Install PostgreSQL (if not installed)
```bash
# macOS
brew install postgresql@14
brew services start postgresql@14

# Ubuntu/Debian
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
```

---

## Step-by-Step Setup

### 1. Install dependencies
```bash
cd payment-engine
npm install
```

### 2. Create the database
```bash
# Connect to PostgreSQL
psql -U postgres

# Inside psql, run:
CREATE DATABASE payment_engine;
\q
```

### 3. Run the schema
```bash
psql -U postgres -d payment_engine -f src/db/schema.sql
```

You should see output like:
```
CREATE TYPE
CREATE TABLE
CREATE INDEX
CREATE INDEX
CREATE INDEX
CREATE FUNCTION
CREATE TRIGGER
```

### 4. Configure environment
Edit `.env` and set your PostgreSQL credentials:
```env
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/payment_engine
PORT=3000
PROCESSING_TIMEOUT_SECONDS=30
WORKER_ID=worker-1
```

> Common DATABASE_URL formats:
> - No password: `postgresql://postgres@localhost:5432/payment_engine`
> - With password: `postgresql://postgres:mypassword@localhost:5432/payment_engine`

### 5. Start the server
```bash
npm start
```

You should see:
```
[DB] Connected successfully
[RECOVERY] Starting recovery job...
[APP] Payment engine running on http://localhost:3000
```

---

## Testing the API

### Check health
```bash
curl http://localhost:3000/health
```

---

### Make a payment (first time)
```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-001" \
  -d '{
    "amount": 500.00,
    "currency": "INR",
    "sender_account": "ACC-1001",
    "receiver_account": "ACC-2002"
  }'
```

Expected response:
```json
{
  "transactionId": "a3f9c2d1-...",
  "status": "SUCCESS",
  "amount": 500,
  "currency": "INR",
  "sender": "ACC-1001",
  "receiver": "ACC-2002",
  "processedAt": "2024-01-15T10:30:00.000Z"
}
```

---

### Retry the SAME request (idempotency test)
```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-001" \
  -d '{
    "amount": 500.00,
    "currency": "INR",
    "sender_account": "ACC-1001",
    "receiver_account": "ACC-2002"
  }'
```

Expected: **Exact same response as above** + header `Idempotent-Replayed: true`
The payment is NOT processed again.

---

### Same key, different payload (should be rejected)
```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-001" \
  -d '{
    "amount": 9999.00,
    "currency": "INR",
    "sender_account": "ACC-1001",
    "receiver_account": "ACC-2002"
  }'
```

Expected: HTTP 422
```json
{
  "error": "PAYLOAD_MISMATCH",
  "message": "Idempotency key reused with different payload."
}
```

---

### Missing idempotency key (should be rejected)
```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 500,
    "currency": "INR",
    "sender_account": "ACC-1001",
    "receiver_account": "ACC-2002"
  }'
```

Expected: HTTP 400
```json
{
  "error": "MISSING_IDEMPOTENCY_KEY",
  "message": "Header \"Idempotency-Key\" is required."
}
```

---

### Look up a transaction
```bash
curl http://localhost:3000/payments/order-001
```

---

### List all transactions
```bash
curl http://localhost:3000/payments
curl http://localhost:3000/payments?limit=5
```

---

## Simulate Concurrent Requests (Race Condition Test)

Run this in your terminal to fire 5 simultaneous requests with the same key:

```bash
for i in {1..5}; do
  curl -s -X POST http://localhost:3000/payments \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: race-test-001" \
    -d '{"amount": 100, "currency": "INR", "sender_account": "ACC-A", "receiver_account": "ACC-B"}' &
done
wait
```

**Expected:** Only ONE unique transaction in the DB. All 5 responses return the same transactionId.

Check with:
```bash
curl http://localhost:3000/payments/race-test-001
```

---

## State Machine

```
INIT ──────────────────────────► PROCESSING ──────► SUCCESS
                                      │
                                      └────────────► FAILED
```

| Status | Meaning |
|---|---|
| INIT | Row created, not yet claimed |
| PROCESSING | Worker is actively running |
| SUCCESS | Completed, response stored |
| FAILED | Permanently failed |

---

## Troubleshooting

**"Connection refused" on startup**
→ PostgreSQL is not running. Start it: `brew services start postgresql@14` (macOS) or `sudo systemctl start postgresql` (Linux)

**"password authentication failed"**
→ Update DATABASE_URL in `.env` with correct credentials

**"database does not exist"**
→ Run `psql -U postgres -c "CREATE DATABASE payment_engine;"`

**"relation does not exist"**
→ Run the schema: `psql -U postgres -d payment_engine -f src/db/schema.sql`
