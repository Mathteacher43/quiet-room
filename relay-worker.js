export class Room {
  constructor(state, env) {
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
      for (const session of this.sessions) {
        if (session !== server && session.readyState === WebSocket.OPEN) {
          session.send(event.data);
        }
      }
    });
    const cleanup = () => this.sessions.delete(server);
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
