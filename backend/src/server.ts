import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { attachGameRealtime } from "./realtime.js";
const { app, pool, sessionMiddleware, currentUser, gameEvents } = createApp();
const http = createServer(app);
const realtime = attachGameRealtime(
  http,
  sessionMiddleware,
  currentUser,
  pool,
  gameEvents,
);
http.listen(config.port, "127.0.0.1", () =>
  console.log(`CodeLine API: http://127.0.0.1:${config.port}`),
);
async function shutdown() {
  realtime.stop();
  http.close();
  await pool?.end();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
