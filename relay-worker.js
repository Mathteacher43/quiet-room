/**
 * Quiet Room — Cloudflare Workers WebSocket relay
 *
 * 배포 방법:
 *   1. wrangler.toml 생성 후 `wrangler deploy` 실행
 *   2. 배포된 wss:// URL을 앱의 "중계 서버 URL" 칸에 입력
 *
 * ⚠️  한계: Workers 인스턴스가 여러 개 뜰 경우 방이 분산될 수 있습니다.
 *     트래픽이 많아지면 Durable Objects 기반으로 전환을 권장합니다.
 *     소규모 / 단일 인스턴스 사용에는 이 구현으로 충분합니다.
 *
 * 이 서버는 암호화된 패킷만 중계합니다.
 * 메시지 내용은 볼 수 없으며, 저장하지 않습니다.
 */

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function leaveAll(socket) {
  for (const [roomId, sockets] of rooms.entries()) {
    sockets.delete(socket);
    if (sockets.size === 0) rooms.delete(roomId);
  }
}

export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(
        "Quiet Room relay is running. Connect via WebSocket.",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    server.addEventListener("message", (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }

      // Join a room
      if (payload.type === "join" && typeof payload.roomId === "string") {
        getRoom(payload.roomId).add(server);
        return;
      }

      // Relay an encrypted packet to all other members of the room
      if (
        payload.type === "packet" &&
        typeof payload.roomId === "string" &&
        payload.body
      ) {
        const out = JSON.stringify({ type: "packet", roomId: payload.roomId, body: payload.body });
        for (const socket of getRoom(payload.roomId)) {
          if (socket !== server && socket.readyState === WebSocket.OPEN) {
            socket.send(out);
          }
        }
      }
    });

    server.addEventListener("close", () => leaveAll(server));
    server.addEventListener("error", () => leaveAll(server));

    return new Response(null, { status: 101, webSocket: client });
  },
};
