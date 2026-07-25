# Subscription Management Demo

[![CI](https://github.com/teenorka/subscription-management-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/teenorka/subscription-management-demo/actions/workflows/ci.yml)

A production-inspired Node.js backend that demonstrates the core lifecycle of a subscription service without exposing commercial source code, credentials, or user data.

The project is based on operational problems found in real subscription products: creating time-limited access, persisting state, validating input, cancelling subscriptions, and running the service predictably in a container.

## Features

- Idempotent subscription creation with safe request replay
- Idempotent renewals that safely handle duplicate payment events
- Automatic expiration of due subscriptions
- Create and retrieve subscriptions through a REST API
- Basic and Pro plans with server-controlled durations
- Explicit lifecycle states: `active`, `cancelled`, and `expired`
- SQLite persistence with WAL mode and foreign-key enforcement
- Request validation and consistent error responses
- Graceful shutdown for container and Linux deployments
- Automated API lifecycle tests
- Docker image and Compose setup with persistent storage

## Technology

- Node.js 22 and ECMAScript modules
- Express 5
- SQLite with `better-sqlite3`
- Zod validation
- Node.js test runner and Supertest
- Docker and Docker Compose

## Getting started

### Requirements

- Node.js 22 or later
- npm

### Installation

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

## API

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

### Retrieve a subscription

```http
GET /api/subscriptions/:id
```

### Cancel a subscription

```http
POST /api/subscriptions/:id/cancel
```

### Renew a subscription

```http
POST /api/subscriptions/:id/renew
Idempotency-Key: payment-event-001
```

Active subscriptions are extended from their current end date. Expired subscriptions
are reactivated from the current time. Cancelled subscriptions cannot be renewed.

### Run the expiration sweep

```http
POST /internal/subscriptions/expire
```

This endpoint is designed to be invoked by a trusted scheduler. It atomically marks
all due active subscriptions as `expired`.

### Health check

```http
GET /health
```

## Architecture

```text
HTTP request
    │
    ▼
Express application ── validation and response mapping
    │
    ▼
Subscription service ── lifecycle rules
    │
    ▼
SQLite database ─────── durable state
```

The HTTP layer owns transport concerns, while `SubscriptionService` owns lifecycle and idempotency rules. Database initialization is isolated so tests can use an in-memory database without changing application code.

## Design decisions

- **SQLite** keeps the example runnable while still demonstrating durable storage, constraints, indexes, and transactions-ready persistence.
- **Idempotency keys** make client retries safe. Replaying the same request returns the original subscription; reusing a key with a different payload returns `409 Conflict`.
- **Renewal records** ensure a duplicate payment event never extends access twice.
- **Expiration is a set-based update** so one scheduler invocation can process all due subscriptions atomically.
- **UTC ISO 8601 timestamps** avoid dependence on the server's local timezone.
- **Dependency injection** for the database and service clock makes business behavior testable.
- **Private production code stays private.** This repository recreates the domain independently and contains no copied commercial logic.

## Roadmap

- [x] Idempotency keys for subscription creation
- [x] Renewal and expiration workflows
- [ ] Payment webhook verification
- [ ] Structured logging and request correlation IDs
- [ ] OpenAPI specification
- [x] CI checks for linting and tests

## License

[MIT](LICENSE)
