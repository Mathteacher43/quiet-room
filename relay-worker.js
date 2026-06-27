/**
 * Quiet Room relay — Cloudflare Workers + Durable Objects
 * 방 ID별로 Durable Object 인스턴스가 분리되어 인스턴스 분산 문제 없음
 */

export class Room {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Set();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Room is running.", { status: 200 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.sessions.add(server);

    server.addEventListener("message", (event) => {
      // 보낸 사람 제외하고 같은 방 전체에 브로드캐스트
      for (const session of this.sessions) {
        if (session !== server && session.readyState === WebSocket.OPEN) {
          session.send(event.data);
        }
      }
    });

    const cleanup = () => {
      this.sessions.delete(server);
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Quiet Room relay is running.", {
        headers: { "Content-Type": "text/plain" }
      });
    }

    // URL path에서 방 ID 추출: /room/<roomId>
    const url = new URL(request.url);
    const roomId = url.pathname.replace(/^\/room\//, "").trim() || "default";

    // 방 ID별로 고정된 Durable Object 인스턴스로 라우팅
    const id = env.ROOMS.idFromName(roomId);
    const room = env.ROOMS.get(id);

    return room.fetch(request);
  }
};
