# Subscription Management Demo

[![CI](https://github.com/teenorka/subscription-management-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/teenorka/subscription-management-demo/actions/workflows/ci.yml)

A production-inspired Node.js backend that demonstrates the core lifecycle of a subscription service without exposing commercial source code, credentials, or user data.

The project is based on operational problems found in real subscription products: creating time-limited access, persisting state, validating input, cancelling subscriptions, and running the service predictably in a container.

## Features

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

The HTTP layer owns transport concerns, while `SubscriptionService` owns lifecycle rules. Database initialization is isolated so tests can use an in-memory database without changing application code.

## Design decisions

- **SQLite** keeps the example runnable while still demonstrating durable storage, constraints, indexes, and transactions-ready persistence.
- **UTC ISO 8601 timestamps** avoid dependence on the server's local timezone.
- **Dependency injection** for the database and service clock makes business behavior testable.
- **Private production code stays private.** This repository recreates the domain independently and contains no copied commercial logic.

## Roadmap

- [ ] Idempotency keys for subscription creation
- [ ] Renewal and expiration workflows
- [ ] Payment webhook verification
- [ ] Structured logging and request correlation IDs
- [ ] OpenAPI specification
- [x] CI checks for linting and tests

## License

[MIT](LICENSE)
