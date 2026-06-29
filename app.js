// ── 상수 ───────────────────────────────────────────────────────────────────
var AUTH_API = "https://pjh-auth.chaostatix.workers.dev";
var RELAY_URL_DEFAULT = "wss://quiet-room-relay.chaostatix.workers.dev";

// ── 유틸 ───────────────────────────────────────────────────────────────────
function randomToken(len) {
  var arr = crypto.getRandomValues(new Uint8Array(Math.ceil(len * 3 / 4)));
  return btoa(String.fromCharCode.apply(null, arr))
    .replace(/[+/=]/g, function(c) { return {'+':'-','/':'_','=':''}[c]; })
    .slice(0, len);
}
function toBase64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }
function fromBase64(str) { return Uint8Array.from(atob(str), function(c) { return c.charCodeAt(0); }); }
function escapeHtml(str) { return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// ── 암호화 (개인방 전용) ───────────────────────────────────────────────────
async function deriveKey(secret, roomId) {
  var enc = new TextEncoder();
  var raw = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name:"PBKDF2", salt:enc.encode(roomId), iterations:200000, hash:"SHA-256" },
    raw, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"]
  );
}
async function encryptPayload(obj) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, state.key, new TextEncoder().encode(JSON.stringify(obj)));
  return { roomId:state.roomId, sender:state.clientId, iv:toBase64(iv), ct:toBase64(ct) };
}
async function decryptPayload(packet) {
  var plain = await crypto.subtle.decrypt({ name:"AES-GCM", iv:fromBase64(packet.iv) }, state.key, fromBase64(packet.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── 상태 ───────────────────────────────────────────────────────────────────
var state = {
  roomId:null, nickname:null, key:null, isPublic:false,
  clientId:randomToken(8), channel:null, socket:null,
  user:null, // { userId, realName, token }
};

// ── DOM ────────────────────────────────────────────────────────────────────
var els = {
  // 탑바
  onlineStatus:     document.getElementById("onlineStatus"),
  roomStatus:       document.getElementById("roomStatus"),
  cryptoStatus:     document.getElementById("cryptoStatus"),
  relayStatus:      document.getElementById("relayStatus"),
  userStatus:       document.getElementById("userStatus"),
  logoutBtn:        document.getElementById("logoutBtn"),
  loginToggleBtn:   document.getElementById("loginToggleBtn"),
  // 탭
  tabPublic:        document.getElementById("tabPublic"),
  tabPrivate:       document.getElementById("tabPrivate"),
  // 인증
  authPanel:        document.getElementById("authPanel"),
  authTabLogin:     document.getElementById("authTabLogin"),
  authTabRegister:  document.getElementById("authTabRegister"),
  authLoginForm:    document.getElementById("authLoginForm"),
  authRegisterForm: document.getElementById("authRegisterForm"),
  loginId:          document.getElementById("loginId"),
  loginPw:          document.getElementById("loginPw"),
  loginErr:         document.getElementById("loginErr"),
  loginBtn:         document.getElementById("loginBtn"),
  regId:            document.getElementById("regId"),
  regName:          document.getElementById("regName"),
  regPw:            document.getElementById("regPw"),
  regErr:           document.getElementById("regErr"),
  registerBtn:      document.getElementById("registerBtn"),
  // 섹션
  publicSection:    document.getElementById("publicSection"),
  privateSection:   document.getElementById("privateSection"),
  // 개인방
  roomId:           document.getElementById("roomId"),
  roomSecret:       document.getElementById("roomSecret"),
  nickname:         document.getElementById("nickname"),
  relayUrl:         document.getElementById("relayUrl"),
  newRoomButton:    document.getElementById("newRoomButton"),
  showSecretButton: document.getElementById("showSecretButton"),
  joinButton:       document.getElementById("joinButton"),
  copyInviteButton: document.getElementById("copyInviteButton"),
  clearButton:      document.getElementById("clearButton"),
  // 채팅
  form:             document.getElementById("form"),
  messageInput:     document.getElementById("messageInput"),
  sendButton:       document.getElementById("sendButton"),
  fileInput:        document.getElementById("fileInput"),
  fileButton:       document.getElementById("fileButton"),
  messages:         document.getElementById("messages"),
};

// ── UI 헬퍼 ────────────────────────────────────────────────────────────────
function setStatus(el, text, cls) { el.textContent = text; el.className = "status" + (cls ? " "+cls : ""); }

function clearMessages() {
  els.messages.innerHTML = '<p class="empty" id="emptyMsg">방을 선택하거나 입장하면 채팅이 시작됩니다.</p>';
}

function appendSystem(text, cls) {
  var div = document.createElement("div");
  div.className = cls || "system-msg";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function appendMessage(message, isMine) {
  var empty = document.getElementById("emptyMsg");
  if (empty) empty.remove();
  var time = new Date(message.createdAt).toLocaleTimeString("ko-KR", { hour:"2-digit", minute:"2-digit" });
  var div = document.createElement("div");
  div.className = "message" + (isMine ? " mine" : "") + (state.isPublic ? " public" : "");
  var body = "";
  if (message.type === "image" && message.dataUrl) {
    body = '<img class="msg-image" src="' + escapeHtml(message.dataUrl) + '" alt="이미지" onclick="openImage(this.src)" />';
  } else if (message.type === "file" && message.dataUrl) {
    body = '<a class="msg-file" href="' + escapeHtml(message.dataUrl) + '" download="' + escapeHtml(message.fileName||"file") + '">📎 ' + escapeHtml(message.fileName||"파일") + '</a>';
  } else {
    body = '<p>' + escapeHtml(message.text) + '</p>';
  }
  div.innerHTML = '<div class="message-meta"><span class="sender">' + escapeHtml(message.nickname) + '</span><span>' + time + '</span></div>' + body;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function openImage(src) { var w = window.open(); w.document.write('<img src="' + src + '" style="max-width:100%;cursor:pointer" onclick="window.close()" />'); }

// ── 인증 ───────────────────────────────────────────────────────────────────
function updateUserUI() {
  if (state.user) {
    els.userStatus.textContent = state.user.realName + " (" + state.user.userId + ")";
    els.userStatus.style.display = "";
    els.logoutBtn.style.display = "";
    els.loginToggleBtn.style.display = "none";
    els.authPanel.style.display = "none";
  } else {
    els.userStatus.style.display = "none";
    els.logoutBtn.style.display = "none";
    els.loginToggleBtn.style.display = "";
  }
}

els.loginToggleBtn.addEventListener("click", function() {
  els.authPanel.style.display = els.authPanel.style.display === "none" ? "" : "none";
});

els.authTabLogin.addEventListener("click", function() {
  els.authTabLogin.classList.add("active"); els.authTabRegister.classList.remove("active");
  els.authLoginForm.style.display = ""; els.authRegisterForm.style.display = "none";
});
els.authTabRegister.addEventListener("click", function() {
  els.authTabRegister.classList.add("active"); els.authTabLogin.classList.remove("active");
  els.authRegisterForm.style.display = ""; els.authLoginForm.style.display = "none";
});

els.loginBtn.addEventListener("click", async function() {
  var userId = els.loginId.value.trim();
  var password = els.loginPw.value;
  els.loginErr.textContent = "";
  if (!userId || !password) { els.loginErr.textContent = "아이디와 비밀번호를 입력하세요."; return; }
  els.loginBtn.disabled = true; els.loginBtn.textContent = "로그인 중...";
  try {
    var res = await fetch(AUTH_API + "/login", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ userId, password }) });
    var data = await res.json();
    if (!res.ok) { els.loginErr.textContent = data.error; return; }
    state.user = { userId:data.userId, realName:data.realName, token:data.token };
    sessionStorage.setItem("chat_token", data.token);
    sessionStorage.setItem("chat_user", JSON.stringify({ userId:data.userId, realName:data.realName }));
    updateUserUI();
  } catch { els.loginErr.textContent = "네트워크 오류가 발생했습니다."; }
  finally { els.loginBtn.disabled = false; els.loginBtn.textContent = "로그인"; }
});

els.registerBtn.addEventListener("click", async function() {
  var userId = els.regId.value.trim();
  var realName = els.regName.value.trim();
  var password = els.regPw.value;
  els.regErr.textContent = "";
  if (!userId || !realName || !password) { els.regErr.textContent = "모든 항목을 입력하세요."; return; }
  els.registerBtn.disabled = true; els.registerBtn.textContent = "가입 중...";
  try {
    var res = await fetch(AUTH_API + "/register", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ userId, realName, password }) });
    var data = await res.json();
    if (!res.ok) { els.regErr.textContent = data.error; return; }
    els.regErr.style.color = "#4a4"; els.regErr.textContent = "가입 완료! 로그인하세요.";
    els.authTabLogin.click();
    els.loginId.value = userId;
  } catch { els.regErr.textContent = "네트워크 오류가 발생했습니다."; }
  finally { els.registerBtn.disabled = false; els.registerBtn.textContent = "가입하기"; }
});

els.logoutBtn.addEventListener("click", async function() {
  if (state.user) {
    await fetch(AUTH_API + "/logout", { method:"POST", headers:{"Authorization":"Bearer "+state.user.token} }).catch(()=>{});
  }
  state.user = null;
  sessionStorage.removeItem("chat_token");
  sessionStorage.removeItem("chat_user");
  closeConnections();
  clearMessages();
  updateUserUI();
  setStatus(els.roomStatus, "미입장");
  setStatus(els.onlineStatus, "오프라인");
});

// ── 탭 전환 ───────────────────────────────────────────────────────────────
els.tabPublic.addEventListener("click", function() {
  els.tabPublic.classList.add("active"); els.tabPrivate.classList.remove("active");
  els.publicSection.style.display = ""; els.privateSection.style.display = "none";
  closeConnections(); clearMessages();
});
els.tabPrivate.addEventListener("click", function() {
  els.tabPrivate.classList.add("active"); els.tabPublic.classList.remove("active");
  els.privateSection.style.display = ""; els.publicSection.style.display = "none";
  closeConnections(); clearMessages();
});

// ── 공개방 입장 ────────────────────────────────────────────────────────────
function joinPublicRoom(roomId, roomName) {
  if (!state.user) {
    els.authPanel.style.display = "";
    appendSystem("공개 채팅방은 로그인이 필요합니다.");
    return;
  }
  state.roomId = roomId;
  state.nickname = state.user.realName;
  state.isPublic = true;
  state.key = null;
  closeConnections();
  connectLocalChannel();
  connectRelay(RELAY_URL_DEFAULT, true);
  els.messageInput.disabled = false;
  els.sendButton.disabled = false;
  els.fileButton.disabled = true; // 공개방은 파일 전송 비활성
  els.messageInput.placeholder = roomName + "에서 대화 중...";
  els.messageInput.focus();
  setStatus(els.cryptoStatus, "평문 (공개방)");
  setStatus(els.roomStatus, roomName, "good");
  clearMessages();
  appendSystem("✦ " + roomName + "에 입장했습니다.");
}

// ── 네트워크 ────────────────────────────────────────────────────────────────
function closeConnections() {
  if (state.channel) { state.channel.close(); state.channel = null; }
  if (state.socket)  { state.socket.close();  state.socket = null; }
  state.isPublic = false; state.key = null;
}

function connectLocalChannel() {
  state.channel = new BroadcastChannel("quiet-room:" + state.roomId);
  state.channel.addEventListener("message", function(e) { handleRelayMessage(e.data); });
}

function connectRelay(url, isPublic) {
  if (!url) { setStatus(els.relayStatus, "로컬 모드"); return; }
  try {
    var wsUrl = url.replace(/\/+$/,"") + "/room/" + encodeURIComponent(state.roomId)
      + "?clientId=" + encodeURIComponent(state.clientId)
      + "&nickname=" + encodeURIComponent(state.nickname)
      + (isPublic ? "&public=1" : "");
    var socket = new WebSocket(wsUrl);
    state.socket = socket;
    socket.addEventListener("open", function() {
      setStatus(els.relayStatus, "연결됨", "good");
      if (!isPublic) setTimeout(sendHello, 100);
    });
    socket.addEventListener("message", function(e) {
      var parsed; try { parsed = JSON.parse(e.data); } catch { return; }
      handleRelayMessage(parsed);
    });
    socket.addEventListener("close", function() { setStatus(els.relayStatus, "끊김", "warn"); setStatus(els.onlineStatus, "오프라인"); });
    socket.addEventListener("error", function() { setStatus(els.relayStatus, "오류", "warn"); setStatus(els.onlineStatus, "오프라인"); });
  } catch { setStatus(els.relayStatus, "URL 오류", "warn"); }
}

function handleRelayMessage(parsed) {
  if (!parsed) return;
  if (parsed.type === "system") {
    if (parsed.event === "join") appendSystem("✦ " + parsed.nickname + " 님이 입장했습니다");
    else if (parsed.event === "leave") appendSystem("✧ " + parsed.nickname + " 님이 퇴장했습니다");
    else if (parsed.event === "rateLimit") appendSystem("⚠ " + (parsed.message || "메시지 속도 제한"), "rate-limit-msg");
    setStatus(els.onlineStatus, "접속 중 " + parsed.online + "명", "good");
    return;
  }
  if (parsed.type === "online") { setStatus(els.onlineStatus, "접속 중 " + parsed.count + "명", "good"); return; }
  if (parsed.type === "packet" && parsed.roomId === state.roomId && parsed.sender !== state.clientId) {
    receivePrivatePacket(parsed); return;
  }
  // 공개방 평문 메시지
  if (state.isPublic && parsed.type === "text") {
    var empty = document.getElementById("emptyMsg"); if (empty) empty.remove();
    appendMessage(parsed, false);
  }
}

// 개인방 비밀키 핸드셰이크
var HELLO_TEXT = "__qr_hello__";
async function sendHello() {
  if (!state.key) return;
  var packet = await encryptPayload({ type:"hello", text:HELLO_TEXT, nickname:state.nickname, createdAt:Date.now() });
  broadcastPacket(packet);
}

function receivePrivatePacket(packet) {
  decryptPayload(packet).then(function(msg) {
    if (msg.type === "hello") return;
    appendMessage(msg, false);
  }).catch(function() {
    appendSystem("⚠ 비밀키가 다른 사용자가 접속을 시도했습니다. 방을 나갑니다.");
    setStatus(els.relayStatus, "비밀키 불일치", "warn");
    closeConnections();
    els.messageInput.disabled = true; els.sendButton.disabled = true; els.fileButton.disabled = true;
  });
}

function broadcastPacket(packet) {
  if (state.channel) state.channel.postMessage(packet);
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type:"packet", roomId:state.roomId, body:packet }));
  }
}

function broadcastPublic(message) {
  var msg = JSON.stringify(message);
  if (state.channel) state.channel.postMessage(message);
  if (state.socket && state.socket.readyState === WebSocket.OPEN) state.socket.send(msg);
}

// ── 메시지 전송 ────────────────────────────────────────────────────────────
els.form.addEventListener("submit", function(event) {
  event.preventDefault();
  var text = els.messageInput.value.trim();
  if (!text) return;
  if (text.length > 2000) { appendSystem("메시지는 2000자 이하입니다."); return; }
  var message = { type:"text", text:text, nickname:state.nickname, createdAt:Date.now() };
  if (state.isPublic) {
    appendMessage(message, true);
    broadcastPublic(message);
  } else {
    if (!state.key) return;
    encryptPayload(message).then(function(packet) {
      appendMessage(message, true);
      broadcastPacket(packet);
    });
  }
  els.messageInput.value = "";
});

// ── 파일 전송 (개인방 전용) ────────────────────────────────────────────────
function sendFile(file) {
  if (!file || !state.key) return;
  if (file.size > 3 * 1024 * 1024) { alert("3MB 이하 파일만 전송 가능합니다."); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    var isImage = file.type.startsWith("image/");
    var message = { type:isImage?"image":"file", dataUrl:e.target.result, fileName:file.name, nickname:state.nickname, createdAt:Date.now() };
    encryptPayload(message).then(function(packet) { appendMessage(message, true); broadcastPacket(packet); });
  };
  reader.readAsDataURL(file);
}

els.fileButton.addEventListener("click", function() { els.fileInput.click(); });
els.fileInput.addEventListener("change", function() { if (els.fileInput.files[0]) { sendFile(els.fileInput.files[0]); els.fileInput.value = ""; } });
els.messages.addEventListener("dragover", function(e) { e.preventDefault(); els.messages.classList.add("drag-over"); });
els.messages.addEventListener("dragleave", function() { els.messages.classList.remove("drag-over"); });
els.messages.addEventListener("drop", function(e) { e.preventDefault(); els.messages.classList.remove("drag-over"); if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]); });

// ── 개인방 입장 ────────────────────────────────────────────────────────────
function joinRoom() {
  var roomId = els.roomId.value.trim();
  var secret = els.roomSecret.value;
  var nickname = (els.nickname.value.trim() || "익명").slice(0, 20);
  if (!roomId || !secret) { alert("방 ID와 비밀키가 필요합니다."); return; }
  els.joinButton.disabled = true; els.joinButton.textContent = "입장 중…";
  setStatus(els.cryptoStatus, "키 유도 중…");
  closeConnections();
  deriveKey(secret, roomId).then(function(key) {
    state.roomId = roomId; state.nickname = nickname; state.key = key; state.isPublic = false;
    connectLocalChannel();
    connectRelay(els.relayUrl.value.trim() || RELAY_URL_DEFAULT, false);
    els.messageInput.disabled = false; els.sendButton.disabled = false; els.fileButton.disabled = false;
    els.messageInput.placeholder = "메시지를 입력하세요…";
    els.messageInput.focus();
    setStatus(els.cryptoStatus, "AES-GCM 256", "good");
    setStatus(els.roomStatus, "개인방: " + roomId, "good");
    clearMessages();
    history.replaceState(null, "", "#room=" + encodeURIComponent(roomId));
  }).catch(function() { setStatus(els.cryptoStatus, "키 생성 실패", "warn"); })
  .finally(function() { els.joinButton.disabled = false; els.joinButton.textContent = "방 입장"; });
}

function copyInvite() {
  var params = new URLSearchParams();
  if (els.roomId.value.trim()) params.set("room", els.roomId.value.trim());
  params.set("relay", els.relayUrl.value.trim() || RELAY_URL_DEFAULT);
  navigator.clipboard.writeText(location.origin + location.pathname + "#" + params.toString()).then(function() {
    els.copyInviteButton.textContent = "복사됨 ✓";
    setTimeout(function() { els.copyInviteButton.textContent = "초대 링크 복사"; }, 1400);
  });
}

function hydrateFromUrl() {
  var hash = new URLSearchParams(location.hash.slice(1));
  els.roomId.value   = hash.get("room")  || randomToken(12);
  els.relayUrl.value = hash.get("relay") || RELAY_URL_DEFAULT;
  els.nickname.value = "guest-" + randomToken(3);
  if (hash.get("room")) { els.tabPrivate.click(); }
}

els.newRoomButton.addEventListener("click", function() { els.roomId.value = randomToken(12); els.roomSecret.value = randomToken(24); joinRoom(); });
els.showSecretButton.addEventListener("click", function() { els.roomSecret.type = els.roomSecret.type === "password" ? "text" : "password"; });
els.joinButton.addEventListener("click", joinRoom);
els.copyInviteButton.addEventListener("click", copyInvite);
els.clearButton.addEventListener("click", clearMessages);

// ── 세션 복원 ──────────────────────────────────────────────────────────────
(function restoreSession() {
  var token = sessionStorage.getItem("chat_token");
  var user = sessionStorage.getItem("chat_user");
  if (token && user) {
    try {
      var u = JSON.parse(user);
      state.user = { userId:u.userId, realName:u.realName, token:token };
      updateUserUI();
    } catch {}
  }
})();

// ── 초기화 ─────────────────────────────────────────────────────────────────
hydrateFromUrl();
clearMessages();
updateUserUI();
if (!window.crypto || !window.crypto.subtle) { setStatus(els.cryptoStatus, "HTTPS 필요", "warn"); }
