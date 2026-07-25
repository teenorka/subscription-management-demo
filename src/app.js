import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  IdempotencyConflictError,
  SubscriptionStateError,
  SubscriptionService,
} from './subscription-service.js';
import {
  InvalidWebhookSignatureError,
  PaymentWebhookService,
  WebhookConflictError,
} from './payment-webhook-service.js';

const createSchema = z.object({
  customerId: z.string().min(1).max(100),
  plan: z.enum(['basic', 'pro']),
});
const idempotencyKeySchema = z.string().min(8).max(255);
const paymentEventSchema = z.object({
  type: z.literal('payment.succeeded'),
  data: z.object({ subscriptionId: z.string().uuid() }),
});
const requestIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/);

export function createApp({
  database,
  clock,
  logger = { info() {}, error() {} },
  webhookSecret = 'development-webhook-secret',
}) {
  const app = express();
  const subscriptions = new SubscriptionService(database, clock);
  const paymentWebhooks = new PaymentWebhookService({
    database,
    subscriptions,
    secret: webhookSecret,
    clock,
  });

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const suppliedRequestId = requestIdSchema.safeParse(request.get('X-Request-Id'));
    request.requestId = suppliedRequestId.success ? suppliedRequestId.data : randomUUID();
    response.set('X-Request-Id', request.requestId);

    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info({
        requestId: request.requestId,
        method: request.method,
        path: request.route?.path ?? request.path,
        statusCode: response.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      }, 'request completed');
    });

    next();
  });
  app.use(express.json({
    limit: '16kb',
    verify: (request, _response, buffer) => {
      request.rawBody = buffer;
    },
  }));

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

  app.post('/webhooks/payments', (request, response) => {
    const parsedEvent = paymentEventSchema.safeParse(request.body);
    if (!parsedEvent.success) {
      return response.status(400).json({
        error: { code: 'INVALID_EVENT', message: 'Unsupported payment event' },
      });
    }

    try {
      const result = paymentWebhooks.process({
        eventId: request.get('X-Webhook-Id'),
        timestamp: request.get('X-Webhook-Timestamp'),
        signature: request.get('X-Webhook-Signature'),
        rawBody: request.rawBody,
        event: parsedEvent.data,
      });
      response.set('Webhook-Replayed', String(result.replayed));
      return response.json({ data: result.subscription });
    } catch (error) {
      if (error instanceof InvalidWebhookSignatureError) {
        return response.status(401).json({
          error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: error.message },
        });
      }
      if (error instanceof WebhookConflictError) {
        return response.status(409).json({
          error: { code: 'WEBHOOK_CONFLICT', message: error.message },
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

  app.use((_request, response) => response.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' },
  }));

  app.use((error, request, response, _next) => {
    void _next;
    logger.error({
      requestId: request.requestId,
      errorName: error.name,
    }, 'request failed');
    return response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  return app;
}
