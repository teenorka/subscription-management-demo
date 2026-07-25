import { randomUUID } from 'node:crypto';

const durations = { basic: 30, pro: 90 };

export class IdempotencyConflictError extends Error {}

export class SubscriptionService {
  constructor(database, clock = () => new Date()) {
    this.database = database;
    this.clock = clock;
    this.insert = database.transaction((input) => this.#createOnce(input));
  }

  create({ customerId, plan, idempotencyKey }) {
    return this.insert({ customerId, plan, idempotencyKey });
  }

  #createOnce({ customerId, plan, idempotencyKey }) {
    const existing = this.database.prepare(
      'SELECT * FROM subscriptions WHERE idempotency_key = ?',
    ).get(idempotencyKey);

    if (existing) {
      if (existing.customer_id !== customerId || existing.plan !== plan) {
        throw new IdempotencyConflictError(
          'Idempotency key was already used with a different request',
        );
      }
      return { subscription: mapRow(existing), created: false };
    }

    const now = this.clock();
    const endsAt = new Date(now);
    endsAt.setUTCDate(endsAt.getUTCDate() + durations[plan]);

    const subscription = {
      id: randomUUID(),
      customerId,
      plan,
      status: 'active',
      startsAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.database.prepare(`
      INSERT INTO subscriptions
        (id, customer_id, plan, status, starts_at, ends_at, created_at, updated_at,
         idempotency_key)
      VALUES
        (@id, @customerId, @plan, @status, @startsAt, @endsAt, @createdAt, @updatedAt,
         @idempotencyKey)
    `).run({ ...subscription, idempotencyKey });

    return { subscription, created: true };
  }

  findById(id) {
    const row = this.database.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    return row ? mapRow(row) : null;
  }

  cancel(id) {
    const subscription = this.findById(id);
    if (!subscription) return null;
    if (subscription.status !== 'active') return subscription;

    const updatedAt = this.clock().toISOString();
    this.database.prepare(`
      UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE id = ?
    `).run(updatedAt, id);

    return this.findById(id);
  }
}

function mapRow(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    plan: row.plan,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
