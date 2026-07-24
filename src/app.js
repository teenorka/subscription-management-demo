import express from 'express';
import { z } from 'zod';
import { SubscriptionService } from './subscription-service.js';

const createSchema = z.object({
  customerId: z.string().min(1).max(100),
  plan: z.enum(['basic', 'pro']),
});

export function createApp({ database }) {
  const app = express();
  const subscriptions = new SubscriptionService(database);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  app.post('/api/subscriptions', (request, response) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return response.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'Request body is invalid' },
      });
    }

    return response.status(201).json({ data: subscriptions.create(parsed.data) });
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

  app.use((_request, response) => response.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' },
  }));

  return app;
}
