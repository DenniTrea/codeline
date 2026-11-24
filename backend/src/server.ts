import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { config } from './config.js';
const { app, pool, sessionMiddleware } = createApp();
const http = createServer(app);
const io = new Server(http, { cors: { origin: config.origin, credentials: true }, maxHttpBufferSize: 16_384 });
io.engine.use(sessionMiddleware);
io.use((_socket, next) => {
  // Gameplay requires database-backed identity, role and course checks first.
  next(new Error('Live gameplay is not configured yet'));
});
http.listen(config.port, '127.0.0.1', () => console.log(`CodeLine API: http://127.0.0.1:${config.port}`));
async function shutdown() { io.close(); http.close(); await pool?.end(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
