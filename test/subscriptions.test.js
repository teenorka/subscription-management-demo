import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';

function createTestApp(t, clock) {
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  return createApp({ database, clock });
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
