import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startRealtime, stopRealtime } from './services/realtime.js';

const app = createApp();

startRealtime();

const server = app.listen(config.PORT, () => {
  console.log(`API listening on port ${config.PORT}`);
});

function shutdown() {
  stopRealtime();
  server.closeAllConnections();
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
