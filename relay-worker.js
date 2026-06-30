/**
 * quiet-room-relay v4
 * - 공개방 3개 고정 (광장1, 광장2, 광장3)
 * - 개인방: E2EE (기존)
 * - Rate Limit: 채팅 초당 5회, 관리자 분당 20회
 * - 보안 헤더 추가
 * - CORS 제한
 * - 입력값 검증
 */

const ALLOWED_ORIGINS = [
  "https://pjhnode.github.io",
  "https://pjh-hub.pages.dev",
];

const PUBLIC_ROOMS = [
  { id: "public-1", name: "광장 1", description: "자유롭게 대화하는 공개 채팅방" },
  { id: "public-2", name: "광장 2", description: "자유롭게 대화하는 공개 채팅방" },
  { id: "public-3", name: "광장 3", description: "자유롭게 대화하는 공개 채팅방" },
];

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'",
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(request), ...SECURITY_HEADERS }
  });
}

// ── Durable Object: Room ────────────────────────────────────────────────────
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // clientId -> { socket, nickname, userId, msgCount, msgWindowStart }
    this.roomId = null;
    this.isPublic = false;
  }

  broadcast(data, excludeId) {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    for (const [id, { socket }] of this.sessions) {
      if (id !== excludeId && socket.readyState === WebSocket.OPEN) socket.send(msg);
    }
  }

  // Rate limit: 초당 5메시지
  checkMsgRate(clientId) {
    const sess = this.sessions.get(clientId);
    if (!sess) return false;
    const now = Date.now();
    // 1.5초 윈도우에 최대 3개 — 너무 빡빡하면 정상 대화도 막히므로
    // 체감상 "도배 방지"가 확실히 느껴지는 선에서 절충
    if (!sess.msgWindowStart || now - sess.msgWindowStart >= 1500) {
      sess.msgCount = 1; sess.msgWindowStart = now; return true;
    }
    if (sess.msgCount >= 3) return false;
    sess.msgCount++; return true;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 강제 종료
    if (url.pathname.endsWith("/kill") && request.method === "POST") {
      for (const [, { socket }] of this.sessions) { try { socket.close(1001, "killed"); } catch {} }
      this.sessions.clear();
      if (this.roomId && this.env.BLOCKLIST) await this.env.BLOCKLIST.delete("room:" + this.roomId).catch(() => {});
      return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders(request) });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(JSON.stringify({ online: this.sessions.size }), {
        headers: { "Content-Type": "application/json", ...corsHeaders(request) }
      });
    }

    const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
    const rawNick = decodeURIComponent(url.searchParams.get("nickname") || "익명");
    const nickname = rawNick.slice(0, 20); // 닉네임 20자 제한
    const isPublic = url.searchParams.get("public") === "1";
    this.isPublic = isPublic;

    if (!this.roomId) {
      this.roomId = decodeURIComponent(url.pathname.replace(/^\/room\//, "").split("?")[0]) || "default";
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.sessions.set(clientId, { socket: server, nickname, msgCount: 0, msgWindowStart: 0 });

    // 활성 방 KV 기록
    if (this.env.BLOCKLIST) {
      await this.env.BLOCKLIST.put("room:" + this.roomId, JSON.stringify({
        roomId: this.roomId, online: this.sessions.size, isPublic, updatedAt: Date.now()
      }), { expirationTtl: 3600 }).catch(() => {});
    }

    this.broadcast({ type: "system", event: "join", nickname, online: this.sessions.size }, clientId);
    server.send(JSON.stringify({ type: "online", count: this.sessions.size }));

    server.addEventListener("message", (event) => {
      // Rate limit 체크
      if (!this.checkMsgRate(clientId)) {
        server.send(JSON.stringify({ type: "system", event: "rateLimit", message: "메시지를 너무 빠르게 보내고 있습니다." }));
        return;
      }

      // 메시지 크기 제한 (5KB)
      if (event.data.length > 5 * 1024) {
        server.send(JSON.stringify({ type: "system", event: "error", message: "메시지가 너무 큽니다." }));
        return;
      }

      // 공개방: 평문 그대로 브로드캐스트
      // 개인방: 암호화 패킷 그대로 브로드캐스트
      this.broadcast(event.data, clientId);
    });

    const cleanup = async () => {
      this.sessions.delete(clientId);
      this.broadcast({ type: "system", event: "leave", nickname, online: this.sessions.size });
      if (this.env.BLOCKLIST) {
        if (this.sessions.size === 0) {
          await this.env.BLOCKLIST.delete("room:" + this.roomId).catch(() => {});
        } else {
          await this.env.BLOCKLIST.put("room:" + this.roomId, JSON.stringify({
            roomId: this.roomId, online: this.sessions.size, isPublic, updatedAt: Date.now()
          }), { expirationTtl: 3600 }).catch(() => {});
        }
      }
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ── KV Rate Limiter ─────────────────────────────────────────────────────────
async function kvRateLimit(env, key, max, windowSec) {
  if (!env.BLOCKLIST) return true;
  const k = "rl:" + key;
  const now = Math.floor(Date.now() / 1000);
  const val = await env.BLOCKLIST.get(k);
  let data = val ? JSON.parse(val) : { count: 0, window: now };
  if (now - data.window >= windowSec) data = { count: 0, window: now };
  if (data.count >= max) return false;
  data.count++;
  await env.BLOCKLIST.put(k, JSON.stringify(data), { expirationTtl: windowSec * 2 });
  return true;
}

function authCheck(request, env) {
  const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  return !env.ADMIN_PASSWORD || token === env.ADMIN_PASSWORD;
}

// ── Main fetch ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...corsHeaders(request), ...SECURITY_HEADERS } });
    }

    // IP 차단
    if (env.BLOCKLIST) {
      const blocked = await env.BLOCKLIST.get("ip:" + ip);
      if (blocked) return new Response("IP blocked", { status: 403, headers: SECURITY_HEADERS });
    }

    // ── GET /public-rooms ─────────────────────────────────────────
    if (url.pathname === "/public-rooms") {
      return json(PUBLIC_ROOMS, 200, request);
    }

    // ── 어드민 API: Rate Limit 분당 20회 ──────────────────────────
    if (url.pathname.startsWith("/admin/")) {
      if (!await kvRateLimit(env, "admin:" + ip, 20, 60)) return json({ error: "Too many requests" }, 429, request);
      if (!authCheck(request, env)) return json({ error: "Unauthorized" }, 401, request);
    }

    if (url.pathname === "/admin/rooms") {
      if (!env.BLOCKLIST) return json({ totalRooms: 0, totalConnections: 0, rooms: [] }, 200, request);
      const list = await env.BLOCKLIST.list({ prefix: "room:" });
      const rooms = await Promise.all(list.keys.map(async k => {
        const v = await env.BLOCKLIST.get(k.name);
        try { return JSON.parse(v); } catch { return null; }
      }));
      const valid = rooms.filter(Boolean);
      return json({ totalRooms: valid.length, totalConnections: valid.reduce((s,r) => s+(r.online||0),0), rooms: valid }, 200, request);
    }

    if (url.pathname.startsWith("/admin/rooms/") && url.pathname.endsWith("/kill") && request.method === "POST") {
      const roomId = decodeURIComponent(url.pathname.replace("/admin/rooms/","").replace("/kill",""));
      const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return room.fetch(new Request(url.origin + "/room/" + encodeURIComponent(roomId) + "/kill", { method: "POST", headers: request.headers }));
    }

    if (url.pathname === "/admin/blocklist" && request.method === "GET") {
      if (!env.BLOCKLIST) return json({ blocklist: [] }, 200, request);
      const list = await env.BLOCKLIST.list({ prefix: "ip:" });
      return json({ blocklist: list.keys.map(k => k.name.replace("ip:","")) }, 200, request);
    }

    if (url.pathname === "/admin/blocklist" && request.method === "POST") {
      const { ip: blockIp } = await request.json();
      if (!blockIp) return json({ error: "IP required" }, 400, request);
      await env.BLOCKLIST.put("ip:" + blockIp, "1");
      return json({ ok: true }, 200, request);
    }

    if (url.pathname.startsWith("/admin/blocklist/") && request.method === "DELETE") {
      const blockIp = decodeURIComponent(url.pathname.replace("/admin/blocklist/",""));
      await env.BLOCKLIST.delete("ip:" + blockIp);
      return json({ ok: true }, 200, request);
    }

    // ── WebSocket 연결 ─────────────────────────────────────────────
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Chat Room relay is running.", {
        headers: { "Content-Type": "text/plain", ...corsHeaders(request), ...SECURITY_HEADERS }
      });
    }

    const roomId = url.pathname.replace(/^\/room\//, "").trim() || "default";
    if (!roomId || roomId.length > 100) return new Response("Invalid room ID", { status: 400 });

    const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return room.fetch(request);
  }
};
