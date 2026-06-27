/**
 * Quiet Room — Cloudflare Workers WebSocket relay
 * Durable Objects 없이 단일 인스턴스에서 동작하는 버전
 */

// 전역 방 맵 (Workers 단일 인스턴스 기준)
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function leaveAll(ws) {
  for (const [roomId, sockets] of rooms.entries()) {
    sockets.delete(ws);
    if (sockets.size === 0) rooms.delete(roomId);
  }
}

export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get("Upgrade");

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Upgrade, Connection",
        },
      });
    }

    // WebSocket 업그레이드 요청이 아니면 상태 페이지 반환
    if (upgradeHeader !== "websocket") {
      return new Response(JSON.stringify({ status: "ok", rooms: rooms.size }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // WebSocket 페어 생성
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    server.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      // 방 입장
      if (payload.type === "join" && typeof payload.roomId === "string") {
        getRoom(payload.roomId).add(server);
        // 입장 확인 메시지
        server.send(JSON.stringify({ type: "joined", roomId: payload.roomId }));
        return;
      }

      // 패킷 중계
      if (
        payload.type === "packet" &&
        typeof payload.roomId === "string" &&
        payload.body
      ) {
        const out = JSON.stringify({
          type: "packet",
          roomId: payload.roomId,
          body: payload.body,
        });
        const room = getRoom(payload.roomId);
        for (const socket of room) {
          if (socket !== server && socket.readyState === WebSocket.OPEN) {
            socket.send(out);
          }
        }
      }
    });

    server.addEventListener("close", () => leaveAll(server));
    server.addEventListener("error", () => leaveAll(server));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};
