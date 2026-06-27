# Quiet Room

무계정 임시 E2EE 채팅 웹앱. GitHub Pages에 그대로 올릴 수 있습니다.

## 파일 구성

| 파일 | 역할 |
|------|------|
| `index.html` | 앱 화면 |
| `styles.css` | 모노크롬 레트로 UI |
| `app.js` | 브라우저 암호화, 방 입장, 메시지 송수신 |
| `relay-worker.js` | Cloudflare Workers WebSocket 중계 (선택) |

## 암호화 설계

- 키 유도: **PBKDF2(SHA-256, 200,000회)** — salt = roomId
- 메시지 암호화: **AES-GCM 256-bit**, 메시지마다 새 12-byte IV
- 서버는 암호화된 패킷만 중계 — 내용 불가
- 비밀키는 서버에 전송되지 않음

## GitHub Pages 배포

1. 저장소 `Settings → Pages` 이동
2. Source: `Deploy from a branch`
3. Branch: `main`, Folder: `/ (root)`
4. 저장 후 발급된 Pages URL 확인

## 중계 서버 (Cloudflare Workers)

```bash
# 1. wrangler 설치
npm install -g wrangler

# 2. 로그인
wrangler login

# 3. wrangler.toml 생성
cat > wrangler.toml << 'EOF'
name = "quiet-room-relay"
main = "relay-worker.js"
compatibility_date = "2024-01-01"
EOF

# 4. 배포
wrangler deploy
```

배포 후 `wss://quiet-room-relay.<your-subdomain>.workers.dev` 형식의 URL이 생성됩니다.  
이 URL을 앱의 "중계 서버 URL" 칸에 입력하세요.

> **주의**: Workers 무료 플랜은 인스턴스가 여러 개 뜰 수 있어 방이 분산될 수 있습니다.  
> 트래픽이 늘면 Durable Objects 전환을 권장합니다.

## 보안 한계

- IP 주소, 접속 시간, 네트워크 경로 등 메타데이터는 중계 서버나 네트워크 사업자에게 보일 수 있습니다.
- 비밀키를 잃으면 메시지 복구 불가합니다.
- **비밀키는 앱 밖 별도 채널(전화, 다른 메신저 등)로 공유하세요.** 초대 링크에는 방 ID만 포함됩니다.
- 공개 서비스 전 외부 보안 리뷰를 권장합니다.
