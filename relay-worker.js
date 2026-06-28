export class Room {
  constructor(state, env) {
    this.sessions = new Map(); // socketId -> { socket, nickname }
  }

  broadcast(data, excludeId = null) {
    const msg = JSON.stringify(data);
    for (const [id, { socket }] of this.sessions) {
      if (id !== excludeId && socket.readyState === WebSocket.OPEN) {
        socket.send(msg);
      }
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(JSON.stringify({ online: this.sessions.size }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const nickname = decodeURIComponent(url.searchParams.get("nickname") || "익명");

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    this.sessions.set(clientId, { socket: server, nickname });

    // 입장 알림 + 접속자 수 브로드캐스트
    this.broadcast({ type: "system", event: "join", nickname, online: this.sessions.size }, clientId);
    // 본인에게 현재 접속자 수 전송
    server.send(JSON.stringify({ type: "online", count: this.sessions.size }));

    server.addEventListener("message", (event) => {
      // 패킷 그대로 중계
      for (const [id, { socket }] of this.sessions) {
        if (id !== clientId && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      }
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
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Quiet Room relay is running.");
    }
    const url = new URL(request.url);
    const roomId = url.pathname.replace(/^\/room\//, "").trim() || "default";
    const id = env.ROOMS.idFromName(roomId);
    const room = env.ROOMS.get(id);
    return room.fetch(request);
  }
};
