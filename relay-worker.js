export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.roomId = null;
  }

  broadcast(data, excludeId = null) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    for (const [id, { socket }] of this.sessions) {
      if (id !== excludeId && socket.readyState === WebSocket.OPEN) socket.send(msg);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 강제 종료
    if (url.pathname.endsWith("/kill") && request.method === "POST") {
      for (const [, { socket }] of this.sessions) { try { socket.close(1001, "killed"); } catch {} }
      this.sessions.clear();
      if (this.roomId && this.env.BLOCKLIST) {
        await this.env.BLOCKLIST.delete("room:" + this.roomId).catch(() => {});
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // 상태 조회 (HTTP)
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(JSON.stringify({ online: this.sessions.size }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const nickname = decodeURIComponent(url.searchParams.get("nickname") || "익명");

    // roomId 추출 및 KV에 활성 방 기록
    if (!this.roomId) {
      this.roomId = decodeURIComponent(url.pathname.replace(/^\/room\//, "").split("?")[0]) || "default";
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.sessions.set(clientId, { socket: server, nickname });

    // 활성 방 KV에 기록
    if (this.env.BLOCKLIST) {
      await this.env.BLOCKLIST.put("room:" + this.roomId, JSON.stringify({
        roomId: this.roomId, online: this.sessions.size, updatedAt: Date.now()
      }), { expirationTtl: 3600 }).catch(() => {});
    }

    this.broadcast({ type: "system", event: "join", nickname, online: this.sessions.size }, clientId);
    server.send(JSON.stringify({ type: "online", count: this.sessions.size }));

    server.addEventListener("message", (event) => { this.broadcast(event.data, clientId); });

    const cleanup = async () => {
      this.sessions.delete(clientId);
      this.broadcast({ type: "system", event: "leave", nickname, online: this.sessions.size });
      if (this.env.BLOCKLIST) {
        if (this.sessions.size === 0) {
          await this.env.BLOCKLIST.delete("room:" + this.roomId).catch(() => {});
        } else {
          await this.env.BLOCKLIST.put("room:" + this.roomId, JSON.stringify({
            roomId: this.roomId, online: this.sessions.size, updatedAt: Date.now()
          }), { expirationTtl: 3600 }).catch(() => {});
        }
      }
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

function authCheck(request, env) {
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  return !env.ADMIN_PASSWORD || token === env.ADMIN_PASSWORD;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }});
    }

    // IP 차단
    const clientIP = request.headers.get("CF-Connecting-IP") || "";
    if (env.BLOCKLIST && clientIP) {
      const blocked = await env.BLOCKLIST.get("ip:" + clientIP);
      if (blocked) return new Response("IP blocked", { status: 403 });
    }

    // ── 어드민: 방 목록 ──
    if (url.pathname === "/admin/rooms") {
      if (!authCheck(request, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      if (!env.BLOCKLIST) return new Response(JSON.stringify({ totalRooms: 0, totalConnections: 0, rooms: [] }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      const list = await env.BLOCKLIST.list({ prefix: "room:" });
      const rooms = await Promise.all(list.keys.map(async k => {
        const val = await env.BLOCKLIST.get(k.name);
        try { return JSON.parse(val); } catch { return null; }
      }));
      const valid = rooms.filter(Boolean);
      return new Response(JSON.stringify({
        totalRooms: valid.length,
        totalConnections: valid.reduce((s, r) => s + (r.online || 0), 0),
        rooms: valid
      }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }

    // ── 어드민: 방 강제 종료 ──
    if (url.pathname.startsWith("/admin/rooms/") && url.pathname.endsWith("/kill") && request.method === "POST") {
      if (!authCheck(request, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      const roomId = decodeURIComponent(url.pathname.replace("/admin/rooms/", "").replace("/kill", ""));
      const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return room.fetch(new Request(url.origin + "/room/" + encodeURIComponent(roomId) + "/kill", { method: "POST", headers: request.headers }));
    }

    // ── 어드민: 차단 목록 조회 ──
    if (url.pathname === "/admin/blocklist" && request.method === "GET") {
      if (!authCheck(request, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      if (!env.BLOCKLIST) return new Response(JSON.stringify({ blocklist: [] }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      const list = await env.BLOCKLIST.list({ prefix: "ip:" });
      return new Response(JSON.stringify({ blocklist: list.keys.map(k => k.name.replace("ip:", "")) }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ── 어드민: IP 차단 추가 ──
    if (url.pathname === "/admin/blocklist" && request.method === "POST") {
      if (!authCheck(request, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      const { ip } = await request.json();
      if (!ip) return new Response(JSON.stringify({ error: "IP required" }), { status: 400 });
      await env.BLOCKLIST.put("ip:" + ip, "1");
      return new Response(JSON.stringify({ ok: true }), { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // ── 어드민: IP 차단 해제 ──
    if (url.pathname.startsWith("/admin/blocklist/") && request.method === "DELETE") {
      if (!authCheck(request, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      const ip = decodeURIComponent(url.pathname.replace("/admin/blocklist/", ""));
      await env.BLOCKLIST.delete("ip:" + ip);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Quiet Room relay is running.", { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    const roomId = url.pathname.replace(/^\/room\//, "").trim() || "default";
    const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return room.fetch(request);
  }
};
