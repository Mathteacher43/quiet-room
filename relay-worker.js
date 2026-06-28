export class Room {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
  }
  broadcast(data, excludeId = null) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    for (const [id, { socket }] of this.sessions) {
      if (id !== excludeId && socket.readyState === WebSocket.OPEN) socket.send(msg);
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/kill") && request.method === "POST") {
      for (const [, { socket }] of this.sessions) { try { socket.close(1001, "killed"); } catch {} }
      this.sessions.clear();
      return new Response(JSON.stringify({ ok: true }));
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(JSON.stringify({ online: this.sessions.size }), { headers: { "Content-Type": "application/json" } });
    }
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const nickname = decodeURIComponent(url.searchParams.get("nickname") || "익명");
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.sessions.set(clientId, { socket: server, nickname });
    this.broadcast({ type: "system", event: "join", nickname, online: this.sessions.size }, clientId);
    server.send(JSON.stringify({ type: "online", count: this.sessions.size }));
    server.addEventListener("message", (event) => { this.broadcast(event.data, clientId); });
    const cleanup = () => {
      this.sessions.delete(clientId);
      this.broadcast({ type: "system", event: "leave", nickname, online: this.sessions.size });
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const clientIP = request.headers.get("CF-Connecting-IP") || "";
    if (env.BLOCKLIST) {
      const blocked = await env.BLOCKLIST.get(clientIP);
      if (blocked) return new Response("IP blocked", { status: 403 });
    }
    if (url.pathname === "/admin/rooms") {
      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
      if (env.ADMIN_PASSWORD && token !== env.ADMIN_PASSWORD) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      return new Response(JSON.stringify({ totalRooms: 0, totalConnections: 0, rooms: [] }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    if (url.pathname.startsWith("/admin/rooms/") && url.pathname.endsWith("/kill") && request.method === "POST") {
      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
      if (env.ADMIN_PASSWORD && token !== env.ADMIN_PASSWORD) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      const roomId = decodeURIComponent(url.pathname.replace("/admin/rooms/", "").replace("/kill", ""));
      const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return room.fetch(new Request(url.origin + "/kill", { method: "POST", headers: request.headers }));
    }
    if (url.pathname === "/admin/blocklist") {
      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
      if (env.ADMIN_PASSWORD && token !== env.ADMIN_PASSWORD) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      if (request.method === "POST") {
        const { ip } = await request.json();
        await env.BLOCKLIST.put(ip, "1");
        return new Response(JSON.stringify({ ok: true }), { headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const list = await env.BLOCKLIST.list();
      return new Response(JSON.stringify({ blocklist: list.keys.map(k => k.name) }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
    }
    if (url.pathname.startsWith("/admin/blocklist/") && request.method === "DELETE") {
      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
      if (env.ADMIN_PASSWORD && token !== env.ADMIN_PASSWORD) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      const ip = decodeURIComponent(url.pathname.replace("/admin/blocklist/", ""));
      await env.BLOCKLIST.delete(ip);
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
