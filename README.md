# GIJO_BridgeAI

> **한국형 원클릭 원격 GPU VRAM 오프로드 & P2P 릴레이 솔루션**  
> **(Remote VRAM / GPU Offloading Platform for NVIDIA GB10, Mac M4 & RTX Workstations)**

`GIJO_BridgeAI`는 VRAM 및 메모리가 부족한 외출용 노트북/클라이언트 PC에서 집에 24시간 항시 켜둔 하이엔드 AI 전용 홈 서버(NVIDIA GB10, Mac Studio M4 128GB, Dual RTX 4090 등)의 자원을 **네트워크(WireGuard/P2P VPN/SSH)**를 통해 로컬 VRAM처럼 연결하여 연산을 위임하는 **가상 GPU 브릿지 플랫폼**입니다.

---

## 🔥 Key Features

1. **로컬 VRAM 소비 0 MB (Zero-Local VRAM Offload)**:
   - 내 노트북의 로컬 API 프록시 (`http://localhost:3000/v1` 또는 `/ollama`)로 요청을 보내면, 연산을 원격 호스트 PC로 자동 라우팅합니다.
   - VS Code Continue, Cursor AI, Python 딥러닝 스크립트 코드 수정 없이 클릭 한 번으로 연계 가능합니다.

2. **🤗 HuggingFace 남은 VRAM 기반 스마트 AI 모델 추천**:
   - 원격 GPU/통합 메모리의 **실시간 남은 가용 VRAM**을 계산하여 구동 가능한 모델만 초록색으로 자동 매칭 및 **원클릭 배포**를 지원합니다.

3. **📡 WebRTC UDP P2P DataChannel & WireGuard 커널 핑 모니터링**:
   - 단순 ICMP Ping의 한계를 넘어, UDP 소켓 기반 무소음 하트비트로 RTT 지연시간(ms), Jitter, 패킷 손실률(Loss %)을 0.1ms 단위로 정밀 측정합니다.

4. **🔑 SSH2 (Port 22) 진짜 원격 자원 수집 엔진**:
   - 원격 PC의 계정 ID/PW를 통한 안전한 SSH2 핸드셰이크를 거쳐 원격 서버 내부의 `nvidia-smi` / `sysctl` 실측 자원만 오차 없이 수집합니다.

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express, `http-proxy`, `ssh2`, `ws` (WebSockets/WebRTC DataChannel Simulator)
- **Frontend**: Vanilla JavaScript (ES6+), Modern Glassmorphism Dark UI / CSS3, HTML5
- **Telemetry**: `nvidia-smi` (NVIDIA CUDA), `sysctl` (Apple Silicon Metal/MLX)

---

## 🚀 Quick Start

### 1. Repository Clone & Install
```bash
git clone https://github.com/gijotour/GIJO_BridgeAI.git
cd GIJO_BridgeAI
npm install
```

### 2. Run Application
```bash
node server.js
```

### 3. Access Dashboard
웹 브라우저에서 `http://localhost:3000` 접속 후 대시보드를 사용할 수 있습니다.

- **컨트룰 대시보드**: `http://localhost:3000`
- **로컬 API 프록시 Base URL**: `http://localhost:3000/v1` (또는 `/ollama`)

---

## 📄 License
ISC License © 2026 GIJO_BridgeAI Corp.
