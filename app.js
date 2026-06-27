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

async function deriveKey(secret, roomId) {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey(
    "raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(roomId), iterations: 200000, hash: "SHA-256" },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptMessage(message) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(message));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    state.key,
    plaintext
  );
  return {
    roomId: state.roomId,
    sender: state.clientId,
    iv: toBase64(iv),
    ct: toBase64(ciphertext),
  };
}

async function decryptPacket(packet) {
  const iv = fromBase64(packet.iv);
  const ciphertext = fromBase64(packet.ct);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    state.key,
    ciphertext
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ── State ──────────────────────────────────────────────────────────────────

var state = {
  roomId: null,
  nickname: null,
  key: null,
  clientId: randomToken(8),
  channel: null,
  socket: null,
};

// ── DOM refs ───────────────────────────────────────────────────────────────

var els = {
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
  cryptoStatus:     document.getElementById("cryptoStatus"),
  relayStatus:      document.getElementById("relayStatus"),
  roomStatus:       document.getElementById("roomStatus"),
};

// ── UI helpers ─────────────────────────────────────────────────────────────

function updateRelayStatus(text, cls) {
  els.relayStatus.textContent = text;
  els.relayStatus.className = "status" + (cls ? " " + cls : "");
}

function updateRoomStatus(text, cls) {
  els.roomStatus.textContent = text;
  els.roomStatus.className = "status" + (cls ? " " + cls : "");
}

function clearMessages() {
  els.messages.innerHTML = '<p class="empty" id="emptyMsg">아직 메시지가 없습니다.<br/>방에 입장하면 대화가 시작됩니다.</p>';
}

function appendMessage(message, isMine) {
  var empty = document.getElementById("emptyMsg");
  if (empty) empty.remove();

  var time = new Date(message.createdAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit"
  });

  var div = document.createElement("div");
  div.className = "message" + (isMine ? " mine" : "");
  div.innerHTML =
    '<div class="message-meta">' +
    '<span class="sender">' + escapeHtml(message.nickname) + '</span>' +
    '<span>' + time + '</span>' +
    '</div>' +
    '<p>' + escapeHtml(message.text) + '</p>';
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Network ────────────────────────────────────────────────────────────────

function closeConnections() {
  if (state.channel) { state.channel.close(); state.channel = null; }
  if (state.socket)  { state.socket.close();  state.socket = null;  }
}

function connectLocalChannel() {
  state.channel = new BroadcastChannel("quiet-room:" + state.roomId);
  state.channel.addEventListener("message", function(event) {
    receivePacket(event.data);
  });
}

function connectRelay(url) {
  if (!url) {
    updateRelayStatus("로컬 모드 (같은 브라우저 탭만)");
    return;
  }
  try {
    // 방 ID를 path에 포함해서 Durable Object가 방별로 고정 인스턴스 사용
    var base = url.replace(/\/+$/, "");
    var wsUrl = base + "/room/" + encodeURIComponent(state.roomId);
    console.log("[relay] connecting to:", wsUrl);

    var socket = new WebSocket(wsUrl);
    state.socket = socket;

    socket.addEventListener("open", function() {
      updateRelayStatus("중계 연결됨", "good");
      console.log("[relay] connected, room:", state.roomId);
    });

    socket.addEventListener("message", function(event) {
      var parsed;
      try { parsed = JSON.parse(event.data); } catch(e) { return; }
      console.log("[relay] received:", parsed.type);
      if (parsed.type === "packet" && parsed.roomId === state.roomId) {
        receivePacket(parsed.body);
      }
    });

    socket.addEventListener("close", function(e) {
      console.log("[relay] closed:", e.code, e.reason);
      updateRelayStatus("중계 끊김", "warn");
    });

    socket.addEventListener("error", function(e) {
      console.log("[relay] error:", e);
      updateRelayStatus("중계 오류", "warn");
    });

  } catch(e) {
    updateRelayStatus("중계 URL 확인 필요", "warn");
  }
}

function receivePacket(packet) {
  if (!packet || packet.roomId !== state.roomId || packet.sender === state.clientId) return;
  decryptPacket(packet).then(function(message) {
    appendMessage(message, false);
  }).catch(function() {
    updateRelayStatus("복호화 실패 — 비밀키를 확인하세요", "warn");
  });
}

function broadcastPacket(packet) {
  if (state.channel) state.channel.postMessage(packet);
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    var msg = JSON.stringify({ type: "packet", roomId: state.roomId, body: packet });
    state.socket.send(msg);
    console.log("[relay] sent packet to room:", state.roomId);
  }
}

// ── Actions ────────────────────────────────────────────────────────────────

function joinRoom() {
  var roomId   = els.roomId.value.trim();
  var secret   = els.roomSecret.value;
  var nickname = els.nickname.value.trim() || "익명";

  if (!roomId || !secret) {
    alert("방 ID와 비밀키가 필요합니다.");
    return;
  }

  els.joinButton.disabled    = true;
  els.joinButton.textContent = "입장 중…";
  els.cryptoStatus.textContent = "키 유도 중…";
  els.cryptoStatus.className   = "status";

  closeConnections();

  deriveKey(secret, roomId).then(function(key) {
    state.roomId   = roomId;
    state.nickname = nickname;
    state.key      = key;

    connectLocalChannel();
    connectRelay(els.relayUrl.value.trim());

    els.messageInput.disabled    = false;
    els.sendButton.disabled      = false;
    els.messageInput.placeholder = "메시지를 입력하세요…";
    els.messageInput.focus();

    els.cryptoStatus.textContent = "AES-GCM 256 활성화";
    els.cryptoStatus.className   = "status good";

    updateRoomStatus("입장 중: " + roomId, "good");

    clearMessages();
    history.replaceState(null, "", "#room=" + encodeURIComponent(roomId));

  }).catch(function(err) {
    els.cryptoStatus.textContent = "키 생성 실패";
    els.cryptoStatus.className   = "status warn";
    console.error(err);
  }).finally(function() {
    els.joinButton.disabled    = false;
    els.joinButton.textContent = "방 입장";
  });
}

function sendMessage(event) {
  event.preventDefault();
  var text = els.messageInput.value.trim();
  if (!text || !state.key) return;

  var message = { text: text, nickname: state.nickname, createdAt: Date.now() };

  encryptMessage(message).then(function(packet) {
    appendMessage(message, true);
    broadcastPacket(packet);
    els.messageInput.value = "";
  });
}

function copyInvite() {
  var params = new URLSearchParams();
  if (els.roomId.value.trim())   params.set("room",  els.roomId.value.trim());
  if (els.relayUrl.value.trim()) params.set("relay", els.relayUrl.value.trim());

  var link = location.origin + location.pathname + "#" + params.toString();
  navigator.clipboard.writeText(link).then(function() {
    els.copyInviteButton.textContent = "복사됨 ✓";
    setTimeout(function() { els.copyInviteButton.textContent = "초대 링크 복사"; }, 1400);
  });
}

function hydrateFromUrl() {
  var hash = new URLSearchParams(location.hash.slice(1));
  els.roomId.value   = hash.get("room")  || randomToken(12);
  els.relayUrl.value = hash.get("relay") || "wss://quiet-room-relay.chaostatix.workers.dev";
  els.nickname.value = "guest-" + randomToken(3);
}

// ── Event listeners ────────────────────────────────────────────────────────

els.newRoomButton.addEventListener("click", function() {
  els.roomId.value     = randomToken(12);
  els.roomSecret.value = randomToken(24);
  // 새 방은 자동으로 바로 입장
  joinRoom();
});

els.showSecretButton.addEventListener("click", function() {
  els.roomSecret.type = els.roomSecret.type === "password" ? "text" : "password";
});

els.joinButton.addEventListener("click", joinRoom);
els.copyInviteButton.addEventListener("click", copyInvite);
els.clearButton.addEventListener("click", clearMessages);
els.form.addEventListener("submit", sendMessage);

// ── Init ───────────────────────────────────────────────────────────────────

hydrateFromUrl();
clearMessages();

if (!window.crypto || !window.crypto.subtle) {
  els.cryptoStatus.textContent = "HTTPS 환경 필요";
  els.cryptoStatus.className   = "status warn";
  els.joinButton.disabled = true;
  els.newRoomButton.disabled = true;
}
