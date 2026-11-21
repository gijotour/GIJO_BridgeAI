# GIJO_BridgeAI

> 노트북에서 원격 GPU 서버에 SSH로 연결해 남은 GPU 메모리를 보고, AI 연산 요청을 그 서버로 넘기는 연결 도구

`GIJO_BridgeAI`는 메모리가 부족한 노트북이나 일반 PC에서, 집이나 사무실에 둔 GPU 서버로 AI 연산 요청을 넘기도록 돕는 브라우저 대시보드와 로컬 프록시입니다. 내 PC에서 직접 실행해 씁니다.

---

## 하는 일

1. **원격 GPU 서버 SSH 연결과 자원 조회**
   - 서버 주소와 SSH 계정으로 접속해 `nvidia-smi` 로 GPU 이름, 전체·사용·남은 VRAM, 온도를 읽습니다.
   - 연결된 동안 5초마다 다시 읽어 대시보드에 반영합니다.
   - `nvidia-smi` 가 없는 서버에서는 값을 지어내지 않고 「확인 불가」로 표시합니다.

2. **로컬 프록시로 AI 연산 요청 전달**
   - `http://localhost:3000/v1` 로 보낸 요청을 연결된 서버의 추론 서버(포트 11434)로 그대로 넘깁니다.
   - 코드 편집기나 파이썬 코드의 Base URL 만 이 주소로 바꾸면 됩니다.
   - 원격 추론 서버가 꺼져 있으면 502 와 까닭을 돌려줍니다.

3. **남은 VRAM 기준 모델 목록**
   - 읽어 온 남은 VRAM 을 내장된 공개 AI 모델 8개의 최소 요구 용량과 비교해, 지금 돌릴 수 있는 모델을 구분해 보여 줍니다.

4. **호스트 키 확인**
   - 처음 접속한 서버의 호스트 키 지문을 `known_hosts.json` 에 적어 둡니다. 다음 접속 때 키가 달라져 있으면 접속을 막습니다.
   - 서버를 다시 설치해 키가 바뀌었다면 `known_hosts.json` 에서 그 서버 줄을 지우고 다시 접속합니다.

## 미리 알려 드립니다

- 설치 파일이나 공개 웹 서비스는 없습니다. 코드를 받아 내 PC에서 실행합니다.
- 원격 서버에 SSH 접속이 열려 있어야 하고, 요청을 넘기려면 그 서버에 추론 서버가 떠 있어야 합니다.
- 대시보드에 표시되는 「SSH 왕복」 시간은 SSH 로 GPU 상태를 읽고 오는 데 걸린 시간입니다. 네트워크 지연만 따로 잰 값이 아닙니다.
- SSH 비밀번호는 저장하지 않습니다. 대시보드는 내 PC(`localhost`)에서만 여세요.
- 아직 안 되는 것: 추천 모델 바로 배포, 클라이언트·호스트 모드 전환(화면에 단추만 있습니다), SSH 키 파일 로그인.

---

## 기술 구성

- **Backend**: Node.js, Express, `http-proxy`, `ssh2`, `ws`
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **자원 조회**: `nvidia-smi`

---

## 실행

### 1. 받기와 설치
```bash
git clone https://github.com/gijotour/GIJO_BridgeAI.git
cd GIJO_BridgeAI
npm install
```

### 2. 실행
```bash
node server.js
```

### 3. 대시보드 열기

- **대시보드**: `http://localhost:3000`
- **로컬 프록시 Base URL**: `http://localhost:3000/v1`

---

## License
ISC License © 2026 GIJO_BridgeAI Corp.
