// ── Utilities ──────────────────────────────────────────────────────────────

function randomToken(len) {
  const arr = crypto.getRandomValues(new Uint8Array(Math.ceil(len * 3 / 4)));
  return btoa(String.fromCharCode(...arr))
    .replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]))
    .slice(0, len);
}

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// ── Crypto ─────────────────────────────────────────────────────────────────

/**
 * PBKDF2(SHA-256, 200 000 iterations) → AES-GCM-256 key
 * Salt = UTF-8(roomId) so same secret in different rooms → different keys
 */
async function deriveKey(secret, roomId) {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey(
    "raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(roomId), iterations: 200_000, hash: "SHA-256" },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts { text, nickname, createdAt } → packet object
 * Fresh 12-byte IV per message (AES-GCM requirement)
 */
async function encryptMessage(message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(message));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    state.key,
    plaintext
  );
  return {
    roomId:   state.roomId,
    sender:   state.clientId,
    iv:       toBase64(iv),
    ct:       toBase64(ciphertext),
  };
}

async function decryptPacket(packet) {
  const iv         = fromBase64(packet.iv);
  const ciphertext = fromBase64(packet.ct);
  const plaintext  = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    state.key,
    ciphertext
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ── State ──────────────────────────────────────────────────────────────────

let state = {
  roomId:   null,
  nickname: null,
  key:      null,
  clientId: randomToken(8),
  channel:  null,
  socket:   null,
};

// ── DOM refs ───────────────────────────────────────────────────────────────

const els = {
  roomId:           document.getElementById("roomId"),
  roomSecret:       document.getElementById("roomSecret"),
  nickname:         document.getElementById("nickname"),
  relayUrl:         document.getElementById("relayUrl"),
  newRoomButton:    document.getElementById("newRoomButton"),
  showSecretButton: document.getElementById("showSecretButton"),
  joinButton:       document.getElementById("joinButton"),
  copyInviteButton: document.getElementById("copyInviteButton"),
  clearButton:      document.getElementById("clearButton"),
  form:             document.getElementById("form"),
  messageInput:     document.getElementById("messageInput"),
  sendButton:       document.getElementById("sendButton"),
  messages:         document.getElementById("messages"),
  emptyMsg:         document.getElementById("emptyMsg"),
  cryptoStatus:     document.getElementById("cryptoStatus"),
  relayStatus:      document.getElementById("relayStatus"),
};

// ── UI helpers ─────────────────────────────────────────────────────────────

function updateRelayStatus(text, cls = "") {
  els.relayStatus.textContent = text;
  els.relayStatus.className   = "status" + (cls ? " " + cls : "");
}

function setEmptyMessage() {
  const msgs = els.messages.querySelectorAll(".message");
  msgs.forEach(m => m.remove());
  if (!els.emptyMsg) {
    const p = document.createElement("p");
    p.className = "empty";
    p.id = "emptyMsg";
    p.innerHTML = "아직 메시지가 없습니다.<br />방에 입장하면 대화가 시작됩니다.";
    els.messages.appendChild(p);
  }
}

function appendMessage(message, isMine) {
  // Remove empty-state placeholder
  document.getElementById("emptyMsg")?.remove();

  const time = new Date(message.createdAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit"
  });

  const div = document.createElement("div");
  div.className = "message" + (isMine ? " mine" : "");
  div.innerHTML = `
    <div class="message-meta">
      <span class="sender">${escapeHtml(message.nickname)}</span>
      <span>${time}</span>
    </div>
    <p>${escapeHtml(message.text)}</p>
  `;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Network ────────────────────────────────────────────────────────────────

function closeConnections() {
  state.channel?.close();
  state.socket?.close();
  state.channel = null;
  state.socket  = null;
}

function connectLocalChannel() {
  state.channel = new BroadcastChannel(`quiet-room:${state.roomId}`);
  state.channel.addEventListener("message", async (event) => receivePacket(event.data));
}

function connectRelay(url) {
  if (!url) { updateRelayStatus("로컬 모드 (같은 브라우저 탭만)"); return; }
  try {
    const socket  = new WebSocket(url);
    state.socket  = socket;
    socket.addEventListener("open", () => {
      updateRelayStatus("중계 연결됨", "good");
      socket.send(JSON.stringify({ type: "join", roomId: state.roomId }));
    });
    socket.addEventListener("message", async (event) => {
      let parsed;
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (parsed.type === "packet" && parsed.roomId === state.roomId) {
        await receivePacket(parsed.body);
      }
    });
    socket.addEventListener("close", () => updateRelayStatus("중계 끊김", "warn"));
    socket.addEventListener("error", () => updateRelayStatus("중계 오류", "warn"));
  } catch {
    updateRelayStatus("중계 URL 확인 필요", "warn");
  }
}

async function receivePacket(packet) {
  if (!packet || packet.roomId !== state.roomId || packet.sender === state.clientId) return;
  try {
    appendMessage(await decryptPacket(packet), false);
  } catch {
    updateRelayStatus("복호화 실패 — 비밀키를 확인하세요", "warn");
  }
}

function broadcastPacket(packet) {
  state.channel?.postMessage(packet);
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "packet", roomId: state.roomId, body: packet }));
  }
}

// ── Actions ────────────────────────────────────────────────────────────────

async function joinRoom() {
  const roomId   = els.roomId.value.trim();
  const secret   = els.roomSecret.value;
  const nickname = els.nickname.value.trim() || "익명";

  if (!roomId || !secret) { alert("방 ID와 비밀키가 필요합니다."); return; }

  els.joinButton.disabled    = true;
  els.joinButton.textContent = "키 생성 중…";
  els.cryptoStatus.textContent = "키 유도 중 (잠시 걸릴 수 있습니다)";
  els.cryptoStatus.className   = "status";

  try {
    closeConnections();
    const key = await deriveKey(secret, roomId);
    state = { ...state, roomId, nickname, key };

    connectLocalChannel();
    connectRelay(els.relayUrl.value.trim());

    els.messageInput.disabled    = false;
    els.sendButton.disabled      = false;
    els.messageInput.placeholder = "메시지를 입력하세요…";
    els.messageInput.focus();

    els.cryptoStatus.textContent = "AES-GCM 256 암호화 활성화";
    els.cryptoStatus.className   = "status good";

    setEmptyMessage();
    history.replaceState(null, "", `#room=${encodeURIComponent(roomId)}`);
  } catch (err) {
    els.cryptoStatus.textContent = "키 생성 실패";
    els.cryptoStatus.className   = "status warn";
    console.error(err);
  } finally {
    els.joinButton.disabled    = false;
    els.joinButton.textContent = "방 입장";
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || !state.key) return;

  const message = { text, nickname: state.nickname, createdAt: Date.now() };
  const packet  = await encryptMessage(message);

  appendMessage(message, true);
  broadcastPacket(packet);
  els.messageInput.value = "";
}

async function copyInvite() {
  // Relay URL omitted from invite by default for better opsec;
  // recipient sets their own relay or uses local-only mode.
  const params = new URLSearchParams();
  if (els.roomId.value.trim())  params.set("room",  els.roomId.value.trim());
  if (els.relayUrl.value.trim()) params.set("relay", els.relayUrl.value.trim());

  const link = `${location.origin}${location.pathname}#${params.toString()}`;
  await navigator.clipboard.writeText(link);

  els.copyInviteButton.textContent = "복사됨 ✓";
  setTimeout(() => { els.copyInviteButton.textContent = "초대 링크 복사"; }, 1400);
}

function hydrateFromUrl() {
  const hash = new URLSearchParams(location.hash.slice(1));
  els.roomId.value   = hash.get("room")  || randomToken(12);
  els.relayUrl.value = hash.get("relay") || "wss://quiet-room-relay.chaostatix.workers.dev";
  els.nickname.value = `guest-${randomToken(3)}`;
}

// ── Event listeners ────────────────────────────────────────────────────────

els.newRoomButton.addEventListener("click", () => {
  els.roomId.value     = randomToken(12);
  els.roomSecret.value = randomToken(24);
});

els.showSecretButton.addEventListener("click", () => {
  els.roomSecret.type = els.roomSecret.type === "password" ? "text" : "password";
});

els.joinButton.addEventListener("click",       joinRoom);
els.copyInviteButton.addEventListener("click", copyInvite);
els.clearButton.addEventListener("click",      setEmptyMessage);
els.form.addEventListener("submit",            sendMessage);

// ── Init ───────────────────────────────────────────────────────────────────

hydrateFromUrl();
setEmptyMessage();

if (!window.crypto?.subtle) {
  els.cryptoStatus.textContent = "HTTPS 환경 필요 (crypto.subtle 없음)";
  els.cryptoStatus.className   = "status warn";
  els.joinButton.disabled = true;
}
