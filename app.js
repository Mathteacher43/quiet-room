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
function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Crypto ─────────────────────────────────────────────────────────────────

async function deriveKey(secret, roomId) {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(roomId), iterations: 200000, hash: "SHA-256" },
    raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

async function encryptPayload(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, state.key,
    new TextEncoder().encode(JSON.stringify(obj))
  );
  return { roomId: state.roomId, sender: state.clientId, iv: toBase64(iv), ct: toBase64(ct) };
}

async function decryptPayload(packet) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(packet.iv) },
    state.key, fromBase64(packet.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── State ──────────────────────────────────────────────────────────────────

var state = {
  roomId: null, nickname: null, key: null,
  clientId: randomToken(8), channel: null, socket: null,
};

// ── DOM ────────────────────────────────────────────────────────────────────

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
  fileInput:        document.getElementById("fileInput"),
  fileButton:       document.getElementById("fileButton"),
  messages:         document.getElementById("messages"),
  cryptoStatus:     document.getElementById("cryptoStatus"),
  relayStatus:      document.getElementById("relayStatus"),
  roomStatus:       document.getElementById("roomStatus"),
  onlineStatus:     document.getElementById("onlineStatus"),
};

// ── UI ─────────────────────────────────────────────────────────────────────

function setStatus(el, text, cls) {
  el.textContent = text;
  el.className = "status" + (cls ? " " + cls : "");
}

function clearMessages() {
  els.messages.innerHTML = '<p class="empty" id="emptyMsg">아직 메시지가 없습니다.<br/>방에 입장하면 대화가 시작됩니다.</p>';
}

function appendSystem(text) {
  var div = document.createElement("div");
  div.className = "system-msg";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function appendMessage(message, isMine) {
  var empty = document.getElementById("emptyMsg");
  if (empty) empty.remove();

  var time = new Date(message.createdAt).toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" });
  var div = document.createElement("div");
  div.className = "message" + (isMine ? " mine" : "");

  var body = "";
  if (message.type === "image" && message.dataUrl) {
    body = '<img class="msg-image" src="' + escapeHtml(message.dataUrl) + '" alt="이미지" onclick="openImage(this.src)" />';
  } else if (message.type === "file" && message.dataUrl) {
    body = '<a class="msg-file" href="' + escapeHtml(message.dataUrl) + '" download="' + escapeHtml(message.fileName||"file") + '">📎 ' + escapeHtml(message.fileName||"파일") + '</a>';
  } else {
    body = '<p>' + escapeHtml(message.text) + '</p>';
  }

  div.innerHTML =
    '<div class="message-meta"><span class="sender">' + escapeHtml(message.nickname) +
    '</span><span>' + time + '</span></div>' + body;

  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function openImage(src) {
  var w = window.open();
  w.document.write('<img src="' + src + '" style="max-width:100%;cursor:pointer" onclick="window.close()" />');
}

// ── 비밀키 핸드셰이크 ──────────────────────────────────────────────────────
// 입장 시 암호화된 "hello" 패킷을 브로드캐스트.
// 상대방이 이걸 복호화하지 못하면 → 비밀키가 다른 것 → 즉시 퇴장.

var HELLO_TEXT = "__qr_hello__";
var helloTimer = null;

async function sendHello() {
  if (!state.key) return;
  var packet = await encryptPayload({ type: "hello", text: HELLO_TEXT, nickname: state.nickname, createdAt: Date.now() });
  broadcastPacket(packet);
}

// ── Network ────────────────────────────────────────────────────────────────

function closeConnections() {
  if (state.channel) { state.channel.close(); state.channel = null; }
  if (state.socket)  { state.socket.close();  state.socket = null;  }
  if (helloTimer)    { clearTimeout(helloTimer); helloTimer = null; }
}

function connectLocalChannel() {
  state.channel = new BroadcastChannel("quiet-room:" + state.roomId);
  state.channel.addEventListener("message", function(e) { handleRelayMessage(e.data); });
}

function connectRelay(url) {
  if (!url) { setStatus(els.relayStatus, "로컬 모드"); return; }
  try {
    var wsUrl = url.replace(/\/+$/, "") + "/room/" + encodeURIComponent(state.roomId)
      + "?clientId=" + encodeURIComponent(state.clientId)
      + "&nickname=" + encodeURIComponent(state.nickname);

    var socket = new WebSocket(wsUrl);
    state.socket = socket;

    socket.addEventListener("open", function() {
      setStatus(els.relayStatus, "중계 연결됨", "good");
      // 입장 직후 hello 브로드캐스트 (100ms 딜레이로 연결 안정화)
      helloTimer = setTimeout(sendHello, 100);
    });

    socket.addEventListener("message", function(e) {
      var parsed;
      try { parsed = JSON.parse(e.data); } catch { return; }
      handleRelayMessage(parsed);
    });

    socket.addEventListener("close", function(e) {
      // 1008 = 비밀키 불일치로 서버가 내린 코드 (미래 확장용)
      setStatus(els.relayStatus, "중계 끊김", "warn");
      setStatus(els.onlineStatus, "오프라인");
    });

    socket.addEventListener("error", function() {
      setStatus(els.relayStatus, "중계 오류", "warn");
      setStatus(els.onlineStatus, "오프라인");
    });

  } catch(e) { setStatus(els.relayStatus, "URL 오류", "warn"); }
}

function handleRelayMessage(parsed) {
  if (!parsed) return;

  // 시스템 메시지 (입장/퇴장/접속자 수)
  if (parsed.type === "system") {
    if (parsed.event === "join") appendSystem("✦ " + parsed.nickname + " 님이 입장했습니다");
    if (parsed.event === "leave") appendSystem("✧ " + parsed.nickname + " 님이 퇴장했습니다");
    setStatus(els.onlineStatus, "접속 중 " + parsed.online + "명", "good");
    return;
  }

  if (parsed.type === "online") {
    setStatus(els.onlineStatus, "접속 중 " + parsed.count + "명", "good");
    return;
  }

  // 암호화 패킷
  if (parsed.type === "packet" && parsed.roomId === state.roomId && parsed.sender !== state.clientId) {
    receivePacket(parsed);
  }
}

function receivePacket(packet) {
  decryptPayload(packet).then(function(msg) {
    // hello 패킷: 복호화 성공 = 같은 키. 아무것도 안 해도 됨.
    if (msg.type === "hello") return;
    appendMessage(msg, false);
  }).catch(function() {
    // 복호화 실패 = 비밀키가 다른 사람이 같은 방에 있음
    appendSystem("⚠ 비밀키가 다른 사용자가 접속을 시도했습니다. 방을 나갑니다.");
    setStatus(els.relayStatus, "비밀키 불일치 — 퇴장", "warn");
    closeConnections();
    els.messageInput.disabled = true;
    els.sendButton.disabled = true;
    els.fileButton.disabled = true;
  });
}

function broadcastPacket(packet) {
  if (state.channel) state.channel.postMessage(packet);
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: "packet", roomId: state.roomId, body: packet }));
  }
}

// ── Actions ────────────────────────────────────────────────────────────────

function joinRoom() {
  var roomId   = els.roomId.value.trim();
  var secret   = els.roomSecret.value;
  var nickname = els.nickname.value.trim() || "익명";
  if (!roomId || !secret) { alert("방 ID와 비밀키가 필요합니다."); return; }

  els.joinButton.disabled = true;
  els.joinButton.textContent = "입장 중…";
  setStatus(els.cryptoStatus, "키 유도 중…");
  setStatus(els.onlineStatus, "연결 중…");

  closeConnections();

  deriveKey(secret, roomId).then(function(key) {
    state.roomId = roomId; state.nickname = nickname; state.key = key;

    connectLocalChannel();
    connectRelay(els.relayUrl.value.trim());

    els.messageInput.disabled = false;
    els.sendButton.disabled   = false;
    els.fileButton.disabled   = false;
    els.messageInput.placeholder = "메시지를 입력하세요…";
    els.messageInput.focus();

    setStatus(els.cryptoStatus, "AES-GCM 256 활성화", "good");
    setStatus(els.roomStatus, "입장: " + roomId, "good");

    clearMessages();
    history.replaceState(null, "", "#room=" + encodeURIComponent(roomId));
  }).catch(function() {
    setStatus(els.cryptoStatus, "키 생성 실패", "warn");
  }).finally(function() {
    els.joinButton.disabled = false;
    els.joinButton.textContent = "방 입장";
  });
}

function sendMessage(event) {
  event.preventDefault();
  var text = els.messageInput.value.trim();
  if (!text || !state.key) return;
  var message = { type: "text", text: text, nickname: state.nickname, createdAt: Date.now() };
  encryptPayload(message).then(function(packet) {
    appendMessage(message, true);
    broadcastPacket(packet);
    els.messageInput.value = "";
  });
}

function sendFile(file) {
  if (!file || !state.key) return;
  if (file.size > 3 * 1024 * 1024) { alert("3MB 이하 파일만 전송 가능합니다."); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var isImage = file.type.startsWith("image/");
    var message = { type: isImage ? "image" : "file", dataUrl: e.target.result,
      fileName: file.name, nickname: state.nickname, createdAt: Date.now() };
    encryptPayload(message).then(function(packet) {
      appendMessage(message, true);
      broadcastPacket(packet);
    });
  };
  reader.readAsDataURL(file);
}

function copyInvite() {
  var params = new URLSearchParams();
  if (els.roomId.value.trim())   params.set("room",  els.roomId.value.trim());
  if (els.relayUrl.value.trim()) params.set("relay", els.relayUrl.value.trim());
  navigator.clipboard.writeText(location.origin + location.pathname + "#" + params.toString()).then(function() {
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

// ── Events ─────────────────────────────────────────────────────────────────

els.newRoomButton.addEventListener("click", function() {
  els.roomId.value = randomToken(12);
  els.roomSecret.value = randomToken(24);
  joinRoom();
});
els.showSecretButton.addEventListener("click", function() {
  els.roomSecret.type = els.roomSecret.type === "password" ? "text" : "password";
});
els.joinButton.addEventListener("click", joinRoom);
els.copyInviteButton.addEventListener("click", copyInvite);
els.clearButton.addEventListener("click", clearMessages);
els.form.addEventListener("submit", sendMessage);
els.fileButton.addEventListener("click", function() { els.fileInput.click(); });
els.fileInput.addEventListener("change", function() {
  if (els.fileInput.files[0]) { sendFile(els.fileInput.files[0]); els.fileInput.value = ""; }
});
els.messages.addEventListener("dragover", function(e) {
  e.preventDefault(); els.messages.classList.add("drag-over");
});
els.messages.addEventListener("dragleave", function() {
  els.messages.classList.remove("drag-over");
});
els.messages.addEventListener("drop", function(e) {
  e.preventDefault(); els.messages.classList.remove("drag-over");
  if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
});

// ── Init ───────────────────────────────────────────────────────────────────

hydrateFromUrl();
clearMessages();

if (!window.crypto || !window.crypto.subtle) {
  setStatus(els.cryptoStatus, "HTTPS 필요", "warn");
  els.joinButton.disabled = true;
  els.newRoomButton.disabled = true;
}
