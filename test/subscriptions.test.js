import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';

function createTestApp(t) {
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  return createApp({ database });
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
