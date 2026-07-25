# Subscription Management Demo

[![CI](https://github.com/teenorka/subscription-management-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/teenorka/subscription-management-demo/actions/workflows/ci.yml)
[![OpenAPI 3.1](https://img.shields.io/badge/OpenAPI-3.1-6BA539.svg)](openapi.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A production-inspired Node.js backend demonstrating subscription lifecycle
management, reliable payment processing, and operational practices without
exposing commercial source code, credentials, or user data.

The project recreates problems encountered while operating a real subscription
service: safe request retries, duplicate webhook delivery, lifecycle state
transitions, scheduled expiration, request tracing, and reproducible deployment.

## What this project demonstrates

- Idempotent subscription creation and renewal
- HMAC-SHA256 payment webhook verification
- Replay-attack and duplicate-delivery protection
- Automatic expiration of due subscriptions
- Explicit lifecycle states: `active`, `cancelled`, and `expired`
- SQLite persistence with constraints, indexes, WAL mode, and foreign keys
- Input validation and consistent error responses
- Structured JSON logs with `X-Request-Id` correlation
- Graceful shutdown for container and Linux deployments
- Automated API tests and GitHub Actions CI
- Docker and Compose setup with persistent storage
- OpenAPI 3.1 contract covering every endpoint

## Technology

- Node.js 22 and ECMAScript modules
- Express 5
- SQLite with `better-sqlite3`
- Zod validation
- Node.js test runner and Supertest
- Docker and Docker Compose
- OpenAPI 3.1

## Run locally

### Requirements

- Node.js 22 or later
- npm

```bash
git clone https://github.com/teenorka/subscription-management-demo.git
cd subscription-management-demo
npm install
cp .env.example .env
npm test
npm run dev
```

The API is available at `http://localhost:3000`.

### Docker

```bash
docker compose up --build
```

SQLite data is stored in the named `subscription-data` volume.

## API documentation

The complete machine-readable contract is available in
[`openapi.yaml`](openapi.yaml). It can be opened directly in
[Swagger Editor](https://editor.swagger.io/) for interactive inspection.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/api/subscriptions` | Create an idempotent subscription |
| `GET` | `/api/subscriptions/:id` | Retrieve a subscription |
| `POST` | `/api/subscriptions/:id/cancel` | Cancel a subscription |
| `POST` | `/api/subscriptions/:id/renew` | Renew or reactivate a subscription |
| `POST` | `/internal/subscriptions/expire` | Expire all due subscriptions |
| `POST` | `/webhooks/payments` | Verify and process a payment event |

### Create a subscription

```http
POST /api/subscriptions
Content-Type: application/json
Idempotency-Key: create-customer-001-basic

{
  "customerId": "customer-001",
  "plan": "basic"
}
```

Replaying the same request returns the original subscription. Reusing the key
with a different customer or plan returns `409 IDEMPOTENCY_CONFLICT`.

### Process a payment webhook

```http
POST /webhooks/payments
Content-Type: application/json
X-Webhook-Id: payment-event-001
X-Webhook-Timestamp: 1767225600
X-Webhook-Signature: sha256=<hex-digest>

{
  "type": "payment.succeeded",
  "data": {
    "subscriptionId": "9c2b41b7-b4af-4a26-868f-2dc04d04d767"
  }
}
```

The signature is an HMAC-SHA256 digest of
`<timestamp>.<raw-request-body>`. Requests older than five minutes are rejected.
Re-delivering the same event returns the processed result without renewing the
subscription twice.

## Request tracing

Every response includes an `X-Request-Id` header. A client or gateway can provide
a safe correlation ID; otherwise the API generates a UUID. Each completed
request emits one structured log record:

```json
{"timestamp":"2026-01-01T00:00:00.000Z","level":"info","message":"request completed","requestId":"gateway-request-001","method":"GET","path":"/health","statusCode":200,"durationMs":1.42}
```

Request bodies, authorization headers, webhook signatures, and idempotency keys
are intentionally excluded from logs.

## Architecture

```text
HTTP request
    │
    ▼
Express application ── validation and response mapping
    │
    ▼
Subscription service ── lifecycle and idempotency rules
    │
    ▼
SQLite database ─────── durable state
```

The HTTP layer owns transport concerns. `SubscriptionService` owns lifecycle and
idempotency rules. Database initialization is isolated so tests can use an
in-memory database without changing application code.

## Design decisions

- **SQLite** keeps the example easy to run while still demonstrating durable
  storage, constraints, indexes, and transactional operations.
- **Idempotency keys** make client retries safe and expose conflicting reuse
  instead of silently accepting different input.
- **Renewal records** ensure duplicate payment events never extend access twice.
- **Signed webhooks** are verified against unmodified request bytes with a
  constant-time comparison and a five-minute timestamp tolerance.
- **Webhook event records** make delivery retries safe and reject an event ID
  reused with different content.
- **Set-based expiration** lets one scheduler invocation process all due
  subscriptions atomically.
- **UTC ISO 8601 timestamps** avoid dependence on the server's local timezone.
- **Dependency injection** for the database and clock keeps business behavior
  deterministic in tests.
- **Private production code stays private.** This repository independently
  recreates the domain and includes no commercial logic, secrets, or user data.

## Project status

Version `1.0.0` is feature-complete for its portfolio scope:

- [x] Idempotent subscription creation
- [x] Renewal and expiration workflows
- [x] Payment webhook verification
- [x] Structured logging and request correlation
- [x] OpenAPI 3.1 specification
- [x] CI checks for linting and tests

## License

[MIT](LICENSE)
