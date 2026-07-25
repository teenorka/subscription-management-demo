import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_PATH);
const app = createApp({ database, webhookSecret: config.PAYMENT_WEBHOOK_SECRET });

const server = app.listen(config.PORT, () => {
  console.info(`Subscription API listening on port ${config.PORT}`);
});

function shutdown(signal) {
  console.info(`${signal} received, shutting down`);
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
