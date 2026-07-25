import { randomUUID } from 'node:crypto';

const durations = { basic: 30, pro: 90 };

export class IdempotencyConflictError extends Error {}
export class SubscriptionStateError extends Error {}

export class SubscriptionService {
  constructor(database, clock = () => new Date()) {
    this.database = database;
    this.clock = clock;
    this.insert = database.transaction((input) => this.#createOnce(input));
    this.renewOnce = database.transaction((input) => this.#renewOnce(input));
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

  renew(id, idempotencyKey) {
    return this.renewOnce({ id, idempotencyKey });
  }

  #renewOnce({ id, idempotencyKey }) {
    const replay = this.database.prepare(`
      SELECT subscription_id FROM subscription_renewals WHERE idempotency_key = ?
    `).get(idempotencyKey);

    if (replay) {
      if (replay.subscription_id !== id) {
        throw new IdempotencyConflictError(
          'Idempotency key was already used for a different subscription',
        );
      }
      return { subscription: this.findById(id), renewed: false };
    }

    const subscription = this.findById(id);
    if (!subscription) return null;
    if (subscription.status === 'cancelled') {
      throw new SubscriptionStateError('Cancelled subscriptions cannot be renewed');
    }

    const now = this.clock();
    const previousEndsAt = subscription.endsAt;
    const base = new Date(Math.max(now.getTime(), new Date(previousEndsAt).getTime()));
    base.setUTCDate(base.getUTCDate() + durations[subscription.plan]);
    const renewedEndsAt = base.toISOString();
    const updatedAt = now.toISOString();

    this.database.prepare(`
      UPDATE subscriptions
      SET status = 'active', ends_at = ?, updated_at = ?
      WHERE id = ?
    `).run(renewedEndsAt, updatedAt, id);
    this.database.prepare(`
      INSERT INTO subscription_renewals
        (idempotency_key, subscription_id, previous_ends_at, renewed_ends_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(idempotencyKey, id, previousEndsAt, renewedEndsAt, updatedAt);

    return { subscription: this.findById(id), renewed: true };
  }

  expireDue() {
    const now = this.clock().toISOString();
    const result = this.database.prepare(`
      UPDATE subscriptions
      SET status = 'expired', updated_at = ?
      WHERE status = 'active' AND ends_at <= ?
    `).run(now, now);
    return { expired: result.changes };
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
