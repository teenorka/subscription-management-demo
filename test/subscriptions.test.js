import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';

test('creates, retrieves, and cancels a subscription', async (t) => {
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  const app = createApp({ database });

  const created = await request(app)
    .post('/api/subscriptions')
    .send({ customerId: 'customer-001', plan: 'basic' })
    .expect(201);

  assert.equal(created.body.data.status, 'active');
  assert.equal(created.body.data.plan, 'basic');

  const id = created.body.data.id;
  const fetched = await request(app).get(`/api/subscriptions/${id}`).expect(200);
  assert.equal(fetched.body.data.customerId, 'customer-001');

  const cancelled = await request(app)
    .post(`/api/subscriptions/${id}/cancel`)
    .expect(200);
  assert.equal(cancelled.body.data.status, 'cancelled');
});

test('rejects an unsupported plan', async (t) => {
  const database = createDatabase(':memory:');
  t.after(() => database.close());
  const app = createApp({ database });

  const response = await request(app)
    .post('/api/subscriptions')
    .send({ customerId: 'customer-001', plan: 'enterprise' })
    .expect(400);

  assert.equal(response.body.error.code, 'INVALID_REQUEST');
});
