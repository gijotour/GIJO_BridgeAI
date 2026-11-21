const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const { Client: SSHClient } = require('ssh2');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/webrtc-p2p' });

app.use(cors());

// 프록시는 본문 파서보다 먼저 건다. express.json() 이 본문을 먼저 읽어 버리면
// 원격 서버로 넘길 본문이 남지 않아 POST 요청이 응답 없이 멈춘다.
const proxy = httpProxy.createProxyServer({ changeOrigin: true });

// 원격 추론 서버가 꺼져 있을 때 프로세스가 죽지 않고 502 로 알린다.
proxy.on('error', (err, req, res) => {
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
  }
  if (res && typeof res.end === 'function') {
    res.end(JSON.stringify({ error: `원격 추론 서버에 연결하지 못했습니다: ${err.message}` }));
  }
});

app.use('/v1', (req, res) => {
  if (remoteAuthSession.isAuthSuccess) {
    // app.use('/v1') 는 주소에서 /v1 을 떼어 낸다. 원격 서버는 /v1/... 을 기다리므로 원래 주소로 되돌린다.
    req.url = req.originalUrl;
    proxy.web(req, res, { target: `http://${remoteAuthSession.hostIp}:11434` });
  } else {
    res.status(503).json({ error: 'GIJO_BridgeAI 오프라인 (SSH 로그인 필요)' });
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 설정 ──────────────────────────────────────────────────────────────
/** 연결된 동안 원격 자원을 다시 읽는 간격. */
const REFRESH_MS = 5000;
/** 처음 접속한 서버의 호스트 키 지문을 적어 두는 파일. 저장소에는 올리지 않는다(.gitignore). */
const KNOWN_HOSTS_FILE = process.env.BRIDGEAI_KNOWN_HOSTS || path.join(__dirname, 'known_hosts.json');

/** nvidia-smi 가 없으면 이 표시를 내보낸다. 그럴 때 용량을 지어내지 않는다. */
const NO_GPU_QUERY = '__BRIDGEAI_NO_GPU_QUERY__';
const GPU_COMMAND =
  'nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits' +
  ` || echo ${NO_GPU_QUERY}`;

// ── 상태 ──────────────────────────────────────────────────────────────
const emptyGpuInfo = (label, architecture) => ({
  gpuName: label,
  totalGB: 0,
  usedGB: 0,
  freeGB: 0,
  architecture,
  temperature: null,
  isRealAuthDevice: false,
  isMeasured: false
});

let activeSshClient = null;
let refreshTimer = null;
let remoteAuthSession = {
  isAuthSuccess: false,
  hostIp: '',
  port: 22,
  username: '',
  connectedAt: null,
  lastMeasuredAt: null,
  rttMs: null,
  gpuInfo: emptyGpuInfo('원격 GPU (SSH 로그인 필요)', 'SSH 미연결 상태')
};

// ── 호스트 키 확인 (처음 본 키를 적어 두고, 다음부터 달라지면 접속을 막는다) ──
function readKnownHosts() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function fingerprintOf(keyBuffer) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
}

/**
 * @returns {{ ok: boolean, fingerprint: string, firstSeen: boolean }}
 */
function checkHostKey(hostIp, port, keyBuffer) {
  const id = `${hostIp}:${port}`;
  const fingerprint = fingerprintOf(keyBuffer);
  const known = readKnownHosts();
  if (!known[id]) {
    known[id] = fingerprint;
    fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify(known, null, 2));
    return { ok: true, fingerprint, firstSeen: true };
  }
  return { ok: known[id] === fingerprint, fingerprint, firstSeen: false };
}

// ── 원격 자원 읽기 ────────────────────────────────────────────────────
/** nvidia-smi 한 줄(이름, 전체MB, 사용MB, 온도)을 읽는다. 읽지 못하면 null. */
function parseNvidiaSmi(output) {
  const line = output.trim().split('\n')[0] || '';
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 3) return null;
  const totalMb = parseFloat(parts[1]);
  const usedMb = parseFloat(parts[2]);
  if (!Number.isFinite(totalMb) || !Number.isFinite(usedMb) || totalMb <= 0) return null;
  const temp = parseInt(parts[3], 10);
  const totalGB = +(totalMb / 1024).toFixed(1);
  const usedGB = +(usedMb / 1024).toFixed(1);
  return {
    gpuName: parts[0],
    totalGB,
    usedGB,
    freeGB: +(totalGB - usedGB).toFixed(1),
    architecture: 'nvidia-smi 로 읽은 값',
    temperature: Number.isFinite(temp) ? temp : null,
    isRealAuthDevice: true,
    isMeasured: true
  };
}

/** 열려 있는 SSH 연결로 GPU 상태를 한 번 읽는다. 왕복에 걸린 시간도 함께 돌려준다. */
function queryGpu(ssh) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    ssh.exec(GPU_COMMAND, (err, stream) => {
      if (err) return reject(new Error(`SSH 명령 실행 실패: ${err.message}`));
      let out = '';
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        const rttMs = +(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1);
        const measured = out.includes(NO_GPU_QUERY) ? null : parseNvidiaSmi(out);
        const gpuInfo = measured || {
          ...emptyGpuInfo('GPU 정보를 읽지 못했습니다', 'GPU 상태 조회 명령(nvidia-smi)이 없어 용량·온도 확인 불가'),
          isRealAuthDevice: true
        };
        resolve({ gpuInfo, rttMs });
      });
    });
  });
}

function stopSession(label, architecture) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  const ssh = activeSshClient;
  activeSshClient = null;
  if (ssh) {
    try { ssh.end(); } catch { /* 이미 닫힘 */ }
  }
  remoteAuthSession.isAuthSuccess = false;
  remoteAuthSession.connectedAt = null;
  remoteAuthSession.lastMeasuredAt = null;
  remoteAuthSession.rttMs = null;
  remoteAuthSession.gpuInfo = emptyGpuInfo(label, architecture);
}

function applyMeasurement({ gpuInfo, rttMs }) {
  remoteAuthSession.gpuInfo = gpuInfo;
  remoteAuthSession.rttMs = rttMs;
  remoteAuthSession.lastMeasuredAt = Date.now();
}

/** SSH 로 접속해 GPU 상태를 읽고, 연결을 열어 둔 채 REFRESH_MS 마다 다시 읽는다. */
function connectSsh(hostIp, port, username, password) {
  return new Promise((resolve, reject) => {
    const portNum = parseInt(port, 10) || 22;
    const ssh = new SSHClient();
    let hostKey = null;
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      try { ssh.end(); } catch { /* 이미 닫힘 */ }
      reject(new Error(message));
    };

    ssh.on('ready', async () => {
      try {
        const first = await queryGpu(ssh);
        // 새 연결이 확인된 뒤에 앞선 연결을 닫는다.
        stopSession('원격 GPU (미연결)', 'SSH 접속 해제됨');
        activeSshClient = ssh;
        remoteAuthSession.isAuthSuccess = true;
        remoteAuthSession.hostIp = hostIp;
        remoteAuthSession.port = portNum;
        remoteAuthSession.username = username;
        remoteAuthSession.connectedAt = Date.now();
        applyMeasurement(first);

        let busy = false;
        refreshTimer = setInterval(async () => {
          if (busy || activeSshClient !== ssh) return;
          busy = true;
          try {
            applyMeasurement(await queryGpu(ssh));
          } catch (e) {
            console.error('[SSH] 다시 읽기 실패:', e.message);
          } finally {
            busy = false;
          }
        }, REFRESH_MS);

        settled = true;
        const g = first.gpuInfo;
        resolve({
          success: true,
          message: g.isMeasured
            ? `SSH 연결 성공: ${hostIp} (${g.gpuName}) 남은 VRAM ${g.freeGB}GB`
            : `SSH 연결은 됐지만 GPU 상태 조회 명령이 없어 용량을 읽지 못했습니다 (${hostIp})`,
          hostKey,
          session: remoteAuthSession
        });
      } catch (e) {
        fail(e.message);
      }
    });

    ssh.on('error', (err) => {
      console.error('[SSH Error]:', err.message);
      if (hostKey && !hostKey.ok) {
        return fail(
          `서버의 호스트 키가 처음 접속했을 때와 다릅니다 (${hostIp}:${portNum}). ` +
          '서버를 다시 설치했다면 known_hosts.json 에서 이 서버 줄을 지우고 다시 접속하세요. ' +
          '그런 일이 없었다면 접속하지 마세요.'
        );
      }
      fail(`SSH 접속 실패 (${hostIp}:${portNum}): ${err.message}`);
    });

    ssh.on('close', () => {
      if (activeSshClient === ssh) {
        stopSession('원격 GPU (연결 끊김)', '원격 서버와의 SSH 연결이 끊어졌습니다');
      }
    });

    ssh.connect({
      host: hostIp,
      port: portNum,
      username,
      password,
      readyTimeout: 5000,
      keepaliveInterval: 10000,
      hostVerifier: (keyBuffer) => {
        hostKey = checkHostKey(hostIp, portNum, keyBuffer);
        return hostKey.ok;
      }
    });
  });
}

// ── 화면으로 상태 밀어 주기 ────────────────────────────────────────────
wss.on('connection', (ws) => {
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'telemetry_push',
        // SSH 로 GPU 상태를 읽고 오는 데 걸린 시간(실제 측정값). 미연결이면 null.
        sshRoundTripMs: remoteAuthSession.rttMs,
        hostVram: remoteAuthSession.gpuInfo,
        authSession: remoteAuthSession,
        timestamp: Date.now()
      }));
    }
  }, 1000);

  ws.on('close', () => clearInterval(timer));
});

// 공개 AI 모델과 최소 VRAM (내장 목록)
const hfModelDatabase = [
  { id: 'deepseek-r1-70b', name: 'DeepSeek-R1-Distill-70B (Q4_K_M)', repo: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-70B', reqVramGB: 43.0, category: 'LLM (추론/코딩)', tags: ['인기', '70B', 'High-Reasoning'] },
  { id: 'qwen2.5-coder-32b', name: 'Qwen2.5-Coder-32B-Instruct (Q8_0)', repo: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF', reqVramGB: 34.0, category: 'LLM (코딩 특화)', tags: ['추천', '32B', 'Code'] },
  { id: 'llama3.3-70b', name: 'Llama-3.3-70B-Instruct (Q4_K_M)', repo: 'meta-llama/Llama-3.3-70B-Instruct', reqVramGB: 42.5, category: 'LLM (범용)', tags: ['Meta', '70B'] },
  { id: 'flux1-dev', name: 'Flux.1-Dev Image Generator (FP8)', repo: 'black-forest-labs/FLUX.1-dev', reqVramGB: 16.0, category: '이미지 생성 (ComfyUI)', tags: ['Flux', 'Image'] },
  { id: 'gemma-2-27b', name: 'Gemma-2-27B-IT (Q5_K_M)', repo: 'google/gemma-2-27b-it', reqVramGB: 20.0, category: 'LLM (경량고성능)', tags: ['Google', '27B'] },
  { id: 'mistral-small-24b', name: 'Mistral-Small-24B-Instruct-2501', repo: 'mistralai/Mistral-Small-24B-Instruct-2501', reqVramGB: 15.5, category: 'LLM (빠른속도)', tags: ['Mistral', 'Fast'] },
  { id: 'sdxl-turbo', name: 'SDXL-Turbo Fast Generation', repo: 'stabilityai/sdxl-turbo', reqVramGB: 8.0, category: '이미지 생성', tags: ['Fast', 'SDXL'] },
  { id: 'deepseek-r1-8b', name: 'DeepSeek-R1-Distill-Qwen-8B', repo: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-8B', reqVramGB: 6.0, category: 'LLM (초경량)', tags: ['Lightweight'] }
];

async function handleLogin(req, res) {
  const { hostIp, port, username, password } = req.body || {};

  if (!hostIp || !username || !password) {
    return res.status(400).json({ success: false, error: '원격 서버 주소, 계정 ID, 비밀번호를 모두 입력해주세요.' });
  }

  try {
    res.json(await connectSsh(hostIp, port || 22, username, password));
  } catch (err) {
    res.status(401).json({
      success: false,
      error: `[SSH 접속 실패] ${err.message}`,
      suggestion: '원격 서버에 SSH 서비스가 켜져 있고 주소·포트·계정이 맞는지 확인하세요.'
    });
  }
}

app.post('/api/bridge/auth-login', handleLogin);
app.post('/api/bridge/connect', handleLogin);

app.get('/api/host/telemetry', (req, res) => {
  res.json(remoteAuthSession.gpuInfo);
});

app.get('/api/bridge/huggingface-recommendations', (req, res) => {
  const availableVramGB = remoteAuthSession.gpuInfo.freeGB || 0;

  const recommendedModels = hfModelDatabase.map(model => {
    const isFit = model.reqVramGB <= availableVramGB;
    const marginGB = +(availableVramGB - model.reqVramGB).toFixed(1);
    return {
      ...model,
      isFit,
      marginGB: isFit ? marginGB : 0,
      vramStatusText: isFit ? `장착 가능 (여유 VRAM: ${marginGB} GB)` : `VRAM 부족 (최소 ${model.reqVramGB} GB 필요)`
    };
  }).sort((a, b) => (b.isFit - a.isFit) || (b.reqVramGB - a.reqVramGB));

  res.json({
    availableVramGB,
    totalVramGB: remoteAuthSession.gpuInfo.totalGB,
    usedVramGB: remoteAuthSession.gpuInfo.usedGB,
    gpuName: remoteAuthSession.gpuInfo.gpuName,
    recommendations: recommendedModels
  });
});

app.get('/api/bridge/status', (req, res) => {
  res.json({
    status: remoteAuthSession.isAuthSuccess ? 'connected' : 'disconnected',
    hostIp: remoteAuthSession.hostIp,
    authSession: remoteAuthSession,
    hostVram: remoteAuthSession.gpuInfo,
    // SSH 로 GPU 상태를 읽고 오는 데 걸린 시간(ms, 실제 측정값). 미연결이면 null.
    latency: remoteAuthSession.rttMs
  });
});

app.post('/api/bridge/disconnect', (req, res) => {
  stopSession('원격 GPU (미연결)', 'SSH 접속 해제됨');
  res.json({ success: true, message: 'SSH 세션 연결 해제 완료' });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`
  ======================================================
   GIJO_BridgeAI (SSH 원격 GPU 자원 조회 · 로컬 프록시)
   ------------------------------------------------------
   - 대시보드 : http://localhost:${PORT}
   - 프록시   : http://localhost:${PORT}/v1
  ======================================================
  `);
});
