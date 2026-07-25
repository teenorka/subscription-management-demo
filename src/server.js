import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './database.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const database = createDatabase(config.DATABASE_PATH);
const logger = createLogger({ level: config.LOG_LEVEL });
const app = createApp({
  database,
  logger,
  webhookSecret: config.PAYMENT_WEBHOOK_SECRET,
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'server started');
});

function shutdown(signal) {
  logger.info({ signal }, 'server shutting down');
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
