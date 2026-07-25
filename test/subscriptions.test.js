import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';

const webhookSecret = 'test-webhook-secret';

function createTestApp(t, clock) {
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  return createApp({ database, clock, webhookSecret });
}

function createTestAppWithLogger(t) {
  const database = createDatabase(':memory:');
  const records = [];
  const logger = {
    info(fields, message) {
      records.push({ level: 'info', message, ...fields });
    },
    error(fields, message) {
      records.push({ level: 'error', message, ...fields });
    },
  };
  t.after(() => database.close());
  return {
    app: createApp({ database, logger, webhookSecret }),
    records,
  };
}

function signWebhook(payload, timestamp) {
  return `sha256=${createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest('hex')}`;
}

function sendWebhook(app, { eventId, event, timestamp = '1767225600', signature } = {}) {
  const payload = JSON.stringify(event);
  return request(app)
    .post('/webhooks/payments')
    .set('Content-Type', 'application/json')
    .set('X-Webhook-Id', eventId)
    .set('X-Webhook-Timestamp', timestamp)
    .set('X-Webhook-Signature', signature ?? signWebhook(payload, timestamp))
    .send(payload);
}

test('creates, retrieves, and cancels a subscription', async (t) => {
  const app = createTestApp(t);
  const created = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'create-customer-001-basic')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);

  assert.equal(created.body.data.status, 'active');
  assert.equal(created.headers['idempotency-replayed'], 'false');

  const id = created.body.data.id;
  const fetched = await request(app).get(`/api/subscriptions/${id}`).expect(200);
  assert.equal(fetched.body.data.customerId, 'customer-001');

  const cancelled = await request(app)
    .post(`/api/subscriptions/${id}/cancel`)
    .expect(200);
  assert.equal(cancelled.body.data.status, 'cancelled');
});

test('returns the original subscription when a request is retried', async (t) => {
  const app = createTestApp(t);
  const payload = { customerId: 'customer-001', plan: 'pro' };
  const first = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'retry-safe-request')
    .send(payload)
    .expect(201);
  const replay = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'retry-safe-request')
    .send(payload)
    .expect(200);

  assert.equal(replay.body.data.id, first.body.data.id);
  assert.equal(replay.headers['idempotency-replayed'], 'true');
});

test('rejects an idempotency key reused for a different request', async (t) => {
  const app = createTestApp(t);
  await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'conflicting-request')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);
  const conflict = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'conflicting-request')
    .send({ customerId: 'customer-001', plan: 'pro' })
    .expect(409);

  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('rejects a missing idempotency key and an unsupported plan', async (t) => {
  const app = createTestApp(t);
  await request(app)
    .post('/api/subscriptions')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(400);
  await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'invalid-plan-request')
    .send({ customerId: 'customer-001', plan: 'enterprise' })
    .expect(400);
});

test('renews an active subscription exactly once when a request is retried', async (t) => {
  const app = createTestApp(t, () => new Date('2026-01-01T00:00:00.000Z'));
  const created = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'create-before-renewal')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);
  const id = created.body.data.id;

  const renewed = await request(app)
    .post(`/api/subscriptions/${id}/renew`)
    .set('Idempotency-Key', 'renewal-payment-001')
    .expect(200);
  const replay = await request(app)
    .post(`/api/subscriptions/${id}/renew`)
    .set('Idempotency-Key', 'renewal-payment-001')
    .expect(200);

  assert.equal(renewed.body.data.endsAt, '2026-03-02T00:00:00.000Z');
  assert.equal(replay.body.data.endsAt, renewed.body.data.endsAt);
  assert.equal(renewed.headers['idempotency-replayed'], 'false');
  assert.equal(replay.headers['idempotency-replayed'], 'true');
});

test('expires due subscriptions and leaves future subscriptions active', async (t) => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const app = createTestApp(t, () => now);
  const created = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'create-expiring-subscription')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);

  let sweep = await request(app).post('/internal/subscriptions/expire').expect(200);
  assert.equal(sweep.body.data.expired, 0);

  now = new Date('2026-02-01T00:00:00.000Z');
  sweep = await request(app).post('/internal/subscriptions/expire').expect(200);
  assert.equal(sweep.body.data.expired, 1);

  const fetched = await request(app)
    .get(`/api/subscriptions/${created.body.data.id}`)
    .expect(200);
  assert.equal(fetched.body.data.status, 'expired');
});

test('renews an expired subscription from the current time', async (t) => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const app = createTestApp(t, () => now);
  const created = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'create-then-reactivate')
    .send({ customerId: 'customer-001', plan: 'pro' })
    .expect(201);
  const id = created.body.data.id;

  now = new Date('2026-04-15T00:00:00.000Z');
  await request(app).post('/internal/subscriptions/expire').expect(200);
  const renewed = await request(app)
    .post(`/api/subscriptions/${id}/renew`)
    .set('Idempotency-Key', 'reactivation-payment-001')
    .expect(200);

  assert.equal(renewed.body.data.status, 'active');
  assert.equal(renewed.body.data.endsAt, '2026-07-14T00:00:00.000Z');
});

test('rejects renewal of a cancelled subscription', async (t) => {
  const app = createTestApp(t);
  const created = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'create-before-cancellation')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);
  const id = created.body.data.id;

  await request(app).post(`/api/subscriptions/${id}/cancel`).expect(200);
  const renewal = await request(app)
    .post(`/api/subscriptions/${id}/renew`)
    .set('Idempotency-Key', 'invalid-renewal-request')
    .expect(409);

  assert.equal(renewal.body.error.code, 'INVALID_SUBSCRIPTION_STATE');
});

test('verifies a payment webhook and renews its subscription', async (t) => {
  const app = createTestApp(t, () => new Date('2026-01-01T00:00:00.000Z'));
  const created = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'create-before-webhook')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);
  const event = {
    type: 'payment.succeeded',
    data: { subscriptionId: created.body.data.id },
  };

  const processed = await sendWebhook(app, {
    eventId: 'payment-event-001',
    event,
  }).expect(200);

  assert.equal(processed.body.data.endsAt, '2026-03-02T00:00:00.000Z');
  assert.equal(processed.headers['webhook-replayed'], 'false');
});

test('handles a duplicate payment webhook without renewing twice', async (t) => {
  const app = createTestApp(t, () => new Date('2026-01-01T00:00:00.000Z'));
  const created = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'create-before-webhook-replay')
    .send({ customerId: 'customer-001', plan: 'pro' })
    .expect(201);
  const input = {
    eventId: 'payment-event-retried',
    event: {
      type: 'payment.succeeded',
      data: { subscriptionId: created.body.data.id },
    },
  };

  const first = await sendWebhook(app, input).expect(200);
  const replay = await sendWebhook(app, input).expect(200);

  assert.equal(replay.body.data.endsAt, first.body.data.endsAt);
  assert.equal(replay.headers['webhook-replayed'], 'true');
});

test('rejects an invalid or stale webhook signature', async (t) => {
  const app = createTestApp(t, () => new Date('2026-01-01T00:00:00.000Z'));
  const event = {
    type: 'payment.succeeded',
    data: { subscriptionId: '9c2b41b7-b4af-4a26-868f-2dc04d04d767' },
  };

  const invalid = await sendWebhook(app, {
    eventId: 'invalid-signature-event',
    event,
    signature: `sha256=${'0'.repeat(64)}`,
  }).expect(401);
  const stale = await sendWebhook(app, {
    eventId: 'stale-signature-event',
    event,
    timestamp: '1767225000',
  }).expect(401);

  assert.equal(invalid.body.error.code, 'INVALID_WEBHOOK_SIGNATURE');
  assert.equal(stale.body.error.code, 'INVALID_WEBHOOK_SIGNATURE');
});

test('rejects a webhook event ID reused with a changed payload', async (t) => {
  const app = createTestApp(t, () => new Date('2026-01-01T00:00:00.000Z'));
  const first = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'first-webhook-target')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);
  const second = await request(app)
    .post('/api/subscriptions')
    .set('Idempotency-Key', 'second-webhook-target')
    .send({ customerId: 'customer-002', plan: 'basic' })
    .expect(201);

  await sendWebhook(app, {
    eventId: 'reused-payment-event',
    event: {
      type: 'payment.succeeded',
      data: { subscriptionId: first.body.data.id },
    },
  }).expect(200);
  const conflict = await sendWebhook(app, {
    eventId: 'reused-payment-event',
    event: {
      type: 'payment.succeeded',
      data: { subscriptionId: second.body.data.id },
    },
  }).expect(409);

  assert.equal(conflict.body.error.code, 'WEBHOOK_CONFLICT');
});

test('preserves a valid request ID in the response and structured log', async (t) => {
  const { app, records } = createTestAppWithLogger(t);
  const response = await request(app)
    .get('/health')
    .set('X-Request-Id', 'gateway-request-001')
    .expect(200);

  assert.equal(response.headers['x-request-id'], 'gateway-request-001');
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'info');
  assert.equal(records[0].message, 'request completed');
  assert.equal(records[0].requestId, 'gateway-request-001');
  assert.equal(records[0].method, 'GET');
  assert.equal(records[0].path, '/health');
  assert.equal(records[0].statusCode, 200);
  assert.equal(typeof records[0].durationMs, 'number');
});

test('generates a request ID when the incoming value is unsafe', async (t) => {
  const { app, records } = createTestAppWithLogger(t);
  const response = await request(app)
    .get('/health')
    .set('X-Request-Id', 'unsafe value with spaces')
    .expect(200);

  assert.match(response.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  assert.equal(records[0].requestId, response.headers['x-request-id']);
});
