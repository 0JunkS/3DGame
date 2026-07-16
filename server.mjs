/**
 * 3D Escape – Multiplayer WebSocket Relay Server
 * Deploy this file to Render (Node.js Web Service).
 *
 * Start command : node server.mjs
 * Environment   : PORT (Render sets this automatically)
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 10000);

// ── Room state ──────────────────────────────────────────────────────────────
// code → { host: WebSocket, guest: WebSocket | null }
const rooms = new Map();

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getOpponent(room, ws) {
  if (room.host === ws) return room.guest;
  if (room.guest === ws) return room.host;
  return null;
}

function cleanupRoom(code, ws) {
  const room = rooms.get(code);
  if (!room) return;

  const opponent = getOpponent(room, ws);
  if (opponent) {
    safeSend(opponent, { type: "opponent_disconnected" });
  }

  rooms.delete(code);
  console.log(`[room:${code}] cleaned up — rooms total: ${rooms.size}`);
}

// ── HTTP server (Render health-check) ───────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// ── WebSocket relay ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  console.log(`[ws] client connected from ${ip}`);

  let assignedCode = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg?.type) return;

    // ── JOIN ──────────────────────────────────────────────────────────────
    if (msg.type === "join") {
      const code = String(msg.code ?? "").trim();
      if (!code || code.length !== 4) return;

      assignedCode = code;
      const existing = rooms.get(code);

      if (!existing) {
        rooms.set(code, { host: ws, guest: null });
        safeSend(ws, { type: "joined", role: "host" });
        console.log(`[room:${code}] created (host) — total: ${rooms.size}`);
      } else if (!existing.guest) {
        existing.guest = ws;
        safeSend(ws, { type: "joined", role: "guest" });
        safeSend(existing.host, { type: "opponent_joined" });
        console.log(`[room:${code}] guest joined`);
      } else {
        safeSend(ws, { type: "room_full" });
        assignedCode = null;
        ws.close();
      }
      return;
    }

    // ── RELAY all other messages to opponent ──────────────────────────────
    if (!assignedCode) return;
    const room = rooms.get(assignedCode);
    if (!room) return;
    const opponent = getOpponent(room, ws);
    if (opponent) safeSend(opponent, msg);
  });

  ws.on("close", () => {
    console.log(`[ws] disconnected (room: ${assignedCode ?? "none"})`);
    if (assignedCode) cleanupRoom(assignedCode, ws);
  });

  ws.on("error", (err) => {
    console.error(`[ws] error (room: ${assignedCode ?? "none"})`, err.message);
    if (assignedCode) cleanupRoom(assignedCode, ws);
  });
});

// Ping every 30 s to keep connections alive (Render has idle timeouts)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  });
}, 30_000);

httpServer.listen(PORT, () => {
  console.log(`3D Escape relay server running on port ${PORT}`);
});
