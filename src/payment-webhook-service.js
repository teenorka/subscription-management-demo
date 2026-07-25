import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

const signaturePrefix = 'sha256=';
const toleranceSeconds = 300;

export class InvalidWebhookSignatureError extends Error {}
export class WebhookConflictError extends Error {}

export class PaymentWebhookService {
  constructor({ database, subscriptions, secret, clock = () => new Date() }) {
    this.database = database;
    this.subscriptions = subscriptions;
    this.secret = secret;
    this.clock = clock;
    this.processOnce = database.transaction((input) => this.#processOnce(input));
  }

  process(input) {
    this.#verify(input);
    return this.processOnce(input);
  }

  #verify({ eventId, timestamp, signature, rawBody }) {
    if (!eventId || !timestamp || !signature || !rawBody) {
      throw new InvalidWebhookSignatureError('Required webhook headers are missing');
    }

    const issuedAt = Number(timestamp);
    const now = Math.floor(this.clock().getTime() / 1000);
    if (!Number.isInteger(issuedAt) || Math.abs(now - issuedAt) > toleranceSeconds) {
      throw new InvalidWebhookSignatureError('Webhook timestamp is outside the allowed window');
    }

    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    const supplied = signature.startsWith(signaturePrefix)
      ? signature.slice(signaturePrefix.length)
      : '';
    const expectedBuffer = Buffer.from(expected, 'hex');
    const suppliedBuffer = Buffer.from(supplied, 'hex');

    if (
      expectedBuffer.length !== suppliedBuffer.length
      || !timingSafeEqual(expectedBuffer, suppliedBuffer)
    ) {
      throw new InvalidWebhookSignatureError('Webhook signature is invalid');
    }
  }

  #processOnce({ eventId, rawBody, event }) {
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const existing = this.database.prepare(`
      SELECT payload_hash, subscription_id
      FROM payment_webhook_events
      WHERE event_id = ?
    `).get(eventId);

    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new WebhookConflictError(
          'Webhook event ID was already used with a different payload',
        );
      }
      return {
        subscription: this.subscriptions.findById(existing.subscription_id),
        replayed: true,
      };
    }

    const subscriptionId = event.data.subscriptionId;
    const renewal = this.subscriptions.renew(subscriptionId, `webhook:${eventId}`);
    if (!renewal) {
      throw new WebhookConflictError('Webhook references an unknown subscription');
    }

    this.database.prepare(`
      INSERT INTO payment_webhook_events
        (event_id, payload_hash, subscription_id, processed_at)
      VALUES (?, ?, ?, ?)
    `).run(eventId, payloadHash, subscriptionId, this.clock().toISOString());

    return { subscription: renewal.subscription, replayed: false };
  }
}
