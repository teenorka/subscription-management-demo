import express from 'express';
import { z } from 'zod';
import {
  IdempotencyConflictError,
  SubscriptionStateError,
  SubscriptionService,
} from './subscription-service.js';

const createSchema = z.object({
  customerId: z.string().min(1).max(100),
  plan: z.enum(['basic', 'pro']),
});
const idempotencyKeySchema = z.string().min(8).max(255);

export function createApp({ database, clock }) {
  const app = express();
  const subscriptions = new SubscriptionService(database, clock);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  app.post('/api/subscriptions', (request, response) => {
    const parsedBody = createSchema.safeParse(request.body);
    const parsedKey = idempotencyKeySchema.safeParse(request.get('Idempotency-Key'));
    if (!parsedBody.success || !parsedKey.success) {
      return response.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'A valid request body and Idempotency-Key header are required',
        },
      });
    }

    try {
      const result = subscriptions.create({
        ...parsedBody.data,
        idempotencyKey: parsedKey.data,
      });
      response.set('Idempotency-Replayed', String(!result.created));
      return response.status(result.created ? 201 : 200).json({ data: result.subscription });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return response.status(409).json({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: error.message },
        });
      }
      throw error;
    }
  });

  app.get('/api/subscriptions/:id', (request, response) => {
    const subscription = subscriptions.findById(request.params.id);
    if (!subscription) {
      return response.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Subscription not found' },
      });
    }
    return response.json({ data: subscription });
  });

  app.post('/api/subscriptions/:id/cancel', (request, response) => {
    const subscription = subscriptions.cancel(request.params.id);
    if (!subscription) {
      return response.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Subscription not found' },
      });
    }
    return response.json({ data: subscription });
  });

  app.post('/api/subscriptions/:id/renew', (request, response) => {
    const parsedKey = idempotencyKeySchema.safeParse(request.get('Idempotency-Key'));
    if (!parsedKey.success) {
      return response.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'A valid Idempotency-Key header is required',
        },
      });
    }

    try {
      const result = subscriptions.renew(request.params.id, parsedKey.data);
      if (!result) {
        return response.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Subscription not found' },
        });
      }
      response.set('Idempotency-Replayed', String(!result.renewed));
      return response.json({ data: result.subscription });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return response.status(409).json({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: error.message },
        });
      }
      if (error instanceof SubscriptionStateError) {
        return response.status(409).json({
          error: { code: 'INVALID_SUBSCRIPTION_STATE', message: error.message },
        });
      }
      throw error;
    }
  });

  app.post('/internal/subscriptions/expire', (_request, response) => {
    return response.json({ data: subscriptions.expireDue() });
  });

  app.use((_request, response) => response.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' },
  }));

  return app;
}
