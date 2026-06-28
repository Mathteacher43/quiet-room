export class Room {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map(); // clientId -> { socket, nickname }
  }

  broadcast(data, excludeId = null) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    for (const [id, { socket }] of this.sessions) {
      if (id !== excludeId && socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── 어드민: 방 상태 조회 ──
    if (url.pathname.endsWith("/info")) {
      const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
      const adminPw = this.state.env?.ADMIN_PASSWORD || "";
      if (adminPw && token !== adminPw) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      const rooms = [...this.sessions.entries()].map(([id, s]) => ({
        clientId: id, nickname: s.nickname
      }));
      return new Response(JSON.stringify({ online: this.sessions.size, sessions: rooms }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // ── 어드민: 방 강제 종료 ──
    if (url.pathname.endsWith("/kill") && request.method === "POST") {
      for (const [, { socket }] of this.sessions) {
        try { socket.close(1001, "Room killed by admin"); } catch {}
      }
      this.sessions.clear();
      return new Response(JSON.stringify({ ok: true }));
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(JSON.stringify({ online: this.sessions.size }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const nickname = decodeURIComponent(url.searchParams.get("nickname") || "익명");

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    this.sessions.set(clientId, { socket: server, nickname });

    // 입장 알림
    this.broadcast({ type: "system", event: "join", nickname, online: this.sessions.size }, clientId);
    // 본인에게 현재 접속자 수
    server.send(JSON.stringify({ type: "online", count: this.sessions.size }));

    server.addEventListener("message", (event) => {
      // 그대로 브로드캐스트 (암호화된 패킷)
      this.broadcast(event.data, clientId);
    });

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

    // ── IP 차단: WebSocket 연결 자체를 거부 ──
    const clientIP = request.headers.get("CF-Connecting-IP") || "";
    if (env.BLOCKLIST) {
      const blocked = await env.BLOCKLIST.get(clientIP);
      if (blocked) {
        // WebSocket이면 101 대신 403 반환
        if (request.headers.get("Upgrade") === "websocket") {
          return new Response("IP blocked", { status: 403 });
        }
        return new Response(JSON.stringify({ error: "IP blocked" }), { status: 403 });
      }
    }

    // ── 어드민 API ──
    const adminToken = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    const adminPw = env.ADMIN_PASSWORD || "";

    if (url.pathname === "/admin/rooms") {
      if (adminPw && adminToken !== adminPw) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      // Durable Objects 목록은 직접 조회 불가 — 별도 KV로 추적해야 하므로 간단 응답
      return new Response(JSON.stringify({ totalRooms: 0, totalConnections: 0, rooms: [] }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname.startsWith("/admin/rooms/") && url.pathname.endsWith("/kill")) {
      if (adminPw && adminToken !== adminPw) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      const roomId = decodeURIComponent(url.pathname.replace("/admin/rooms/", "").replace("/kill", ""));
      const id = env.ROOMS.idFromName(roomId);
      const room = env.ROOMS.get(id);
      return room.fetch(new Request(`${url.origin}/kill`, { method: "POST", headers: request.headers }));
    }

    if (url.pathname === "/admin/blocklist") {
      if (adminPw && adminToken !== adminPw) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      if (request.method === "POST") {
        const { ip } = await request.json();
        if (!ip) return new Response(JSON.stringify({ error: "IP required" }), { status: 400 });
        await env.BLOCKLIST.put(ip, "1");
        return new Response(JSON.stringify({ ok: true }), { headers: { "Access-Control-Allow-Origin": "*" } });
      }
      const list = await env.BLOCKLIST.list();
      return new Response(JSON.stringify({ blocklist: list.keys.map(k => k.name) }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname.startsWith("/admin/blocklist/") && request.method === "DELETE") {
      if (adminPw && adminToken !== adminPw) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      const ip = decodeURIComponent(url.pathname.replace("/admin/blocklist/", ""));
      await env.BLOCKLIST.delete(ip);
      return new Response(JSON.stringify({ ok: true }), { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Quiet Room relay is running.", {
        headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }
      });
    }

    // ── 방별 Durable Object 라우팅 ──
    const roomId = url.pathname.replace(/^\/room\//, "").trim() || "default";
    const id = env.ROOMS.idFromName(roomId);
    const room = env.ROOMS.get(id);
    return room.fetch(request);
  }
};
