import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import type { Request, RequestHandler } from "express";
import type { Pool } from "pg";
import type { EventEmitter } from "node:events";
import type { Actor } from "./exercises.js";
import { positiveId as positiveIdForSocket } from "./exercises.js";
import { canWatchGame, expireGames } from "./games.js";
import { config } from "./config.js";
export function attachGameRealtime(
  http: HttpServer,
  sessionMiddleware: RequestHandler,
  currentUser: (req: Request) => Promise<Actor | null>,
  pool: Pool | null,
  gameEvents: EventEmitter,
) {
  const io = new Server(http, {
    cors: { origin: config.origin, credentials: true },
    maxHttpBufferSize: 16_384,
    allowRequest: (req, done) => {
      const expected = new URL(config.origin);
      done(
        null,
        req.headers.origin === expected.origin ||
          (!req.headers.origin &&
            req.headers["sec-fetch-site"] === "same-origin" &&
            req.headers.host === expected.host),
      );
    },
  });
  type Presence = {
    key: string;
    name: string;
    x: number;
    y: number;
    color: number;
    emote: string;
    emoteUntil: number;
    owner: string;
  };
  const playgrounds = new Map<number, Map<string, Presence>>();
  const dirtyRooms = new Set<number>();
  const broadcast = (id: number) => dirtyRooms.add(id);
  // Batch cosmetic movement per room instead of broadcasting on every player's packet.
  const presenceTimer = setInterval(() => {
    for (const id of dirtyRooms) {
      io.to(`game:${id}`).emit("playground:state", {
        players: [...(playgrounds.get(id)?.values() || [])].map(
          ({ owner, ...p }) => p,
        ),
      });
    }
    dirtyRooms.clear();
  }, 150);
  io.engine.use(sessionMiddleware);
  io.use(async (socket, next) => {
    try {
      const actor = await currentUser(socket.request as Request);
      if (!actor) return next(new Error("Sign in required"));
      next();
    } catch {
      next(new Error("Could not authorize connection"));
    }
  });
  io.on("connection", (socket) => {
    let watching: string | null = null,
      watchCount = 0,
      player: { id: number; actor: string; lease: number } | null = null,
      lastMove = 0,
      lastEmote = 0;
    const removePlayer = () => {
      if (player) {
        const state = playgrounds.get(player.id);
        if (state?.get(player.actor)?.owner === socket.id) {
          state.delete(player.actor);
          if (!state.size) playgrounds.delete(player.id);
          broadcast(player.id);
        }
        player = null;
      }
    };
    const getIdentity = async (id: number, actor: Actor) => {
      if (actor.role !== "student" || !pool) return null;
      return (
        (
          await pool.query(
            'SELECT s."displayName" FROM "students" s JOIN "gameParticipants" p ON p."studentId"=s."userId" JOIN "gameSessions" g ON g."id"=p."sessionId" WHERE g."id"=$1 AND s."userId"=$2 AND p."attendance"=\'joined\' AND g."startedAt" IS NULL',
            [id, actor.id],
          )
        ).rows[0] || null
      );
    };
    socket.on(
      "watch",
      async (
        value: unknown,
        reply?: (result: { ok: boolean; error?: string }) => void,
      ) => {
        const acknowledge = typeof reply === "function" ? reply : undefined;
        try {
          if (++watchCount > 100) throw new Error("Too many room requests");
          const req = socket.request as Request;
          await new Promise<void>((resolve, reject) =>
            req.session.reload((error) => (error ? reject(error) : resolve())),
          );
          const actor = await currentUser(req);
          if (!actor || !pool) throw new Error("Sign in required");
          const id = positiveIdForSocket(value);
          await canWatchGame(pool, id, actor);
          removePlayer();
          if (watching) await socket.leave(watching);
          watching = `game:${id}`;
          await socket.join(watching);
          const identity = await getIdentity(id, actor);
          if (identity) {
            const state = playgrounds.get(id) || new Map<string, Presence>();
            const prior = state.get(actor.id);
            const p: Presence = prior
              ? { ...prior, owner: socket.id }
              : {
                  key: randomUUID(),
                  name: identity.displayName,
                  x: 20 + ((state.size * 13) % 65),
                  y: 40 + ((state.size * 11) % 40),
                  color: state.size % 6,
                  emote: "",
                  emoteUntil: 0,
                  owner: socket.id,
                };
            state.set(actor.id, p);
            playgrounds.set(id, state);
            player = { id, actor: actor.id, lease: Date.now() + 15000 };
            socket.emit("playground:identity", { key: p.key });
            broadcast(id);
          }
          acknowledge?.({ ok: true });
          socket.emit("game:changed", { id });
        } catch {
          removePlayer();
          if (watching) {
            await socket.leave(watching);
            watching = null;
          }
          acknowledge?.({ ok: false, error: "Room access denied" });
        }
      },
    );
    socket.on("playground:move", async (value: unknown) => {
      if (!player) return;
      const v = value as {
        x?: unknown;
        y?: unknown;
        color?: unknown;
        emote?: unknown;
      };
      if (
        !v ||
        typeof v.x !== "number" ||
        typeof v.y !== "number" ||
        !Number.isFinite(v.x) ||
        !Number.isFinite(v.y) ||
        v.x < 3 ||
        v.x > 97 ||
        v.y < 24 ||
        v.y > 88 ||
        !Number.isInteger(v.color) ||
        Number(v.color) < 0 ||
        Number(v.color) > 5 ||
        !(
          v.emote === undefined ||
          (typeof v.emote === "string" &&
            ["hi!", "GG", "?", "!!"].includes(v.emote))
        )
      )
        return;
      if (v.emote) {
        if (Date.now() - lastEmote < 750) return;
        lastEmote = Date.now();
      } else {
        if (Date.now() - lastMove < 90) return;
        lastMove = Date.now();
      }
      try {
        if (player.lease < Date.now()) {
          const req = socket.request as Request;
          await new Promise<void>((resolve, reject) =>
            req.session.reload((e) => (e ? reject(e) : resolve())),
          );
          const actor = await currentUser(req);
          if (!actor || !(await getIdentity(player.id, actor))) {
            removePlayer();
            return;
          }
          player.lease = Date.now() + 15000;
        }
        const p = playgrounds.get(player.id)?.get(player.actor);
        if (!p || p.owner !== socket.id) return;
        p.x = v.x;
        p.y = v.y;
        p.color = Number(v.color);
        if (v.emote) {
          p.emote = String(v.emote);
          p.emoteUntil = Date.now() + 3000;
        }
        broadcast(player.id);
      } catch {
        removePlayer();
      }
    });
    socket.on("disconnect", removePlayer);
  });
  const changed = (id: number) => {
    io.to(`game:${id}`).emit("game:changed", { id });
    if (playgrounds.has(id) && pool)
      void pool
        .query('SELECT \"startedAt\" FROM \"gameSessions\" WHERE \"id\"=$1', [
          id,
        ])
        .then((r) => {
          if (!r.rowCount || r.rows[0].startedAt) {
            playgrounds.delete(id);
            broadcast(id);
          }
        })
        .catch(() => {});
  };
  gameEvents.on("changed", changed);
  let expiring = false;
  const timer = setInterval(async () => {
    if (!pool || expiring) return;
    expiring = true;
    try {
      await expireGames(pool, changed);
    } catch {
      console.error("Game deadline update failed");
    } finally {
      expiring = false;
    }
  }, 1000);
  return {
    io,
    stop() {
      clearInterval(timer);
      clearInterval(presenceTimer);
      gameEvents.removeListener("changed", changed);
      io.close();
    },
  };
}
