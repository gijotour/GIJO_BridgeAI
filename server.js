const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client: SSHClient } = require('ssh2');
const WebSocket = require('ws');

/*
 * GIJO_BridgeAI 로컬 서버.
 *
 * 내 PC 에서만 돈다. 하는 일은 셋이다.
 *   1. SSH 로 원격 GPU 서버에 붙어 GPU·메모리 상태를 5초마다 읽는다.
 *   2. http://localhost:<포트>/v1 로 온 AI 요청을 그 SSH 연결 **안쪽 터널**로 원격 추론 서버(기본 11434)에 넘긴다.
 *      원격 추론 서버를 인터넷이나 사내망에 열 필요가 없다(서버 쪽은 127.0.0.1 에만 떠 있으면 된다).
 *   3. 원격 서버에 이미 받아 둔 모델 목록을 보여 준다.
 *
 * 2026-11-24 바꾼 것(v1.1.0)
 *   · 예전에는 모든 네트워크(0.0.0.0)에 열려 있고 어느 웹사이트든 요청할 수 있었다(cors 전체 허용).
 *     같은 와이파이의 누구나, 또는 브라우저로 연 아무 사이트가 내 GPU 서버를 쓸 수 있었다.
 *     이제 127.0.0.1 에만 열고, 다른 사이트에서 온 요청과 다른 주소 이름(Host)으로 온 요청은 막는다.
 *   · 예전에는 /v1 요청을 원격 서버의 11434 포트로 **암호화 없이 직접** 보냈다.
 *     그러려면 원격 추론 서버를 외부에 열어야 했고, 그렇게 열린 Ollama 서버가 인터넷에 수십만 대 있다.
 *     이제 이미 연 SSH 연결 안으로 보낸다.
 *   · DGX Spark(GB10)처럼 GPU 와 CPU 가 메모리를 같이 쓰는 기기는 nvidia-smi 가 메모리를 「Not Supported」로 낸다.
 *     그때는 /proc/meminfo 의 시스템 메모리를 「통합 메모리」로 보여 준다.
 *   · SSH 키 파일 로그인, 원격 추론 서버 포트 지정, 서버에 있는 모델 목록을 더했다.
 */

// ── 설정 ──────────────────────────────────────────────────────────────
/** 연결된 동안 원격 자원을 다시 읽는 간격. */
const REFRESH_MS = 5000;
/** 원격 추론 서버 포트 기본값(Ollama). vLLM·llama.cpp 서버라면 로그인 때 바꾼다. */
const DEFAULT_INFERENCE_PORT = 11434;

/** nvidia-smi 가 없으면 이 표시를 내보낸다. 그럴 때 용량을 지어내지 않는다. */
const NO_GPU_QUERY = '__BRIDGEAI_NO_GPU_QUERY__';
const MEMINFO_MARK = '__BRIDGEAI_MEMINFO__';
const GPU_COMMAND =
  'nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu --format=csv,noheader,nounits' +
  ` || echo ${NO_GPU_QUERY}; echo ${MEMINFO_MARK}; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null`;

// ── 원격 출력 읽기 (순수 함수: 테스트가 직접 부른다) ─────────────────────
const toGB = (n, unitDivisor) => +(n / unitDivisor).toFixed(1);

/** /proc/meminfo 의 MemTotal·MemAvailable(kB)을 읽는다. 없으면 null. */
function parseMeminfo(text) {
  const kb = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text || '');
    return m ? parseInt(m[1], 10) : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (!total || available === null) return null;
  return { totalGB: toGB(total, 1024 * 1024), freeGB: toGB(available, 1024 * 1024) };
}

/**
 * GPU_COMMAND 의 출력 전체를 읽어 화면에 보낼 GPU 정보로 바꾼다.
 * · 전용 VRAM 이 있으면 nvidia-smi 값
 * · GPU 는 있는데 메모리가 Not Supported(통합 메모리)면 시스템 메모리 값
 * · 둘 다 못 읽으면 숫자 없이 「확인 불가」
 */
function parseGpuOutput(output) {
  const [gpuPart, memPart = ''] = String(output || '').split(MEMINFO_MARK);
  const noGpu = gpuPart.includes(NO_GPU_QUERY);
  const line = noGpu ? '' : (gpuPart.trim().split('\n')[0] || '');
  const parts = line.split(',').map((p) => p.trim());
  const gpuName = parts[0] || '';
  const totalMb = parseFloat(parts[1]);
  const usedMb = parseFloat(parts[2]);
  const temp = parseInt(parts[3], 10);
  const temperature = Number.isFinite(temp) ? temp : null;

  if (gpuName && Number.isFinite(totalMb) && Number.isFinite(usedMb) && totalMb > 0) {
    const totalGB = toGB(totalMb, 1024);
    const usedGB = toGB(usedMb, 1024);
    return {
      gpuName,
      totalGB,
      usedGB,
      freeGB: +(totalGB - usedGB).toFixed(1),
      memoryKind: 'vram',
      architecture: 'nvidia-smi 로 읽은 전용 VRAM',
      temperature,
      isRealAuthDevice: true,
      isMeasured: true
    };
  }

  const mem = parseMeminfo(memPart);
  if (gpuName && mem) {
    return {
      gpuName,
      totalGB: mem.totalGB,
      usedGB: +(mem.totalGB - mem.freeGB).toFixed(1),
      freeGB: mem.freeGB,
      memoryKind: 'unified',
      architecture: '통합 메모리 — GPU 와 CPU 가 같이 쓰는 시스템 메모리 기준(/proc/meminfo)',
      temperature,
      isRealAuthDevice: true,
      isMeasured: true
    };
  }

  return {
    ...emptyGpuInfo(
      'GPU 정보를 읽지 못했습니다',
      gpuName ? 'GPU 메모리 값을 읽지 못해 용량 확인 불가' : 'GPU 상태 조회 명령(nvidia-smi)이 없어 용량·온도 확인 불가'
    ),
    gpuName: gpuName || 'GPU 정보를 읽지 못했습니다',
    temperature,
    isRealAuthDevice: true
  };
}

function emptyGpuInfo(label, architecture) {
  return {
    gpuName: label,
    totalGB: 0,
    usedGB: 0,
    freeGB: 0,
    memoryKind: null,
    architecture,
    temperature: null,
    isRealAuthDevice: false,
    isMeasured: false
  };
}

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

// ── 요청 출처 확인 (순수 함수) ─────────────────────────────────────────
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Origin 머리가 없거나(편집기·파이썬 코드) 내 PC 의 주소면 받아 준다. */
function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 관리 API(/api/…, 실시간 갱신)는 이 앱 화면에서 온 요청만 받는다.
 * 같은 PC 의 다른 포트(개발 서버·미리보기 등)에 떠 있는 남의 페이지가 로그인·해제를 부르지 못하게 한다.
 * Origin 이 없는 요청(편집기·명령줄)은 받는다. /v1 은 다른 로컬 도구도 쓰므로 isLocalOrigin 만 본다.
 */
function isSameAppOrigin(origin, port) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOCAL_HOSTNAMES.has(u.hostname) && Number(u.port || 80) === Number(port);
  } catch {
    return false;
  }
}

/** Host 머리가 내 PC 이름이어야 한다. 다른 이름이면 DNS 를 바꿔치기한 웹사이트일 수 있다. */
function isLocalHostHeader(host) {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOCAL_HOSTNAMES.has(name.toLowerCase());
}

// ── SSH 터널 에이전트 ─────────────────────────────────────────────────
/**
 * http 요청을 새 TCP 연결 대신, 열려 있는 SSH 연결 안의 채널(direct-tcpip)로 보낸다.
 * 원격 서버 쪽에서는 127.0.0.1:<추론 포트> 로 접속한 것과 같다.
 */
class SshTunnelAgent extends http.Agent {
  constructor(getTarget) {
    super({ keepAlive: false });
    this.getTarget = getTarget;
  }

  createConnection(_options, callback) {
    const target = this.getTarget();
    if (!target) {
      callback(new Error('SSH 연결이 없습니다'));
      return undefined;
    }
    target.ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', target.port, (err, stream) => {
      if (err) return callback(new Error(`SSH 터널을 열지 못했습니다(원격 127.0.0.1:${target.port}): ${err.message}`));
      // http 모듈이 소켓에 부르는 함수들. SSH 채널에는 없으므로 아무 일 안 하는 것으로 채운다.
      for (const fn of ['setKeepAlive', 'setNoDelay', 'setTimeout', 'ref', 'unref']) {
        if (typeof stream[fn] !== 'function') stream[fn] = () => stream;
      }
      callback(null, stream);
    });
    return undefined;
  }
}

/** 터널로 원격 추론 서버에 GET 을 보내 JSON 을 받는다. */
function tunnelGetJson(agent, urlPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: 80, path: urlPath, method: 'GET', agent, headers: { accept: 'application/json' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON 이 아닌 응답')); }
        });
      }
    );
    // SSH 채널에는 소켓 시간 제한이 없다(req.setTimeout 이 듣지 않는다). 타이머로 직접 끊는다.
    const timer = setTimeout(() => req.destroy(new Error('응답이 없습니다')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// ── 서버 만들기 ───────────────────────────────────────────────────────
/**
 * @param {{ port?: number, host?: string, knownHostsFile?: string }} [opts]
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>}
 */
function startServer(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const requestedPort = opts.port ?? 3000;
  /** 처음 접속한 서버의 호스트 키 지문을 적어 두는 파일. 저장소에는 올리지 않는다(.gitignore). */
  const knownHostsFile = opts.knownHostsFile || process.env.BRIDGEAI_KNOWN_HOSTS || path.join(__dirname, 'known_hosts.json');

  const app = express();
  const server = http.createServer(app);

  let activeSshClient = null;
  let refreshTimer = null;
  const session = {
    isAuthSuccess: false,
    hostIp: '',
    port: 22,
    username: '',
    inferencePort: DEFAULT_INFERENCE_PORT,
    authMethod: null,
    connectedAt: null,
    lastMeasuredAt: null,
    rttMs: null,
    gpuInfo: emptyGpuInfo('원격 GPU (SSH 로그인 필요)', 'SSH 미연결 상태')
  };

  const tunnelAgent = new SshTunnelAgent(() =>
    session.isAuthSuccess && activeSshClient ? { ssh: activeSshClient, port: session.inferencePort } : null
  );

  // ── 문지기: 내 PC 에서, 내 PC 이름으로 온 요청만 ──
  app.use((req, res, next) => {
    if (!isLocalHostHeader(req.headers.host)) {
      return res.status(403).json({ error: '이 주소 이름으로는 쓸 수 없습니다(localhost 로 여세요).' });
    }
    const origin = req.headers.origin;
    if (!isLocalOrigin(origin)) {
      return res.status(403).json({ error: '다른 웹사이트에서 온 요청은 받지 않습니다.' });
    }
    if (!req.path.startsWith('/v1') && !isSameAppOrigin(origin, server.address()?.port)) {
      return res.status(403).json({ error: '이 앱 화면에서만 쓸 수 있습니다.' });
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'content-type, authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });

  // 프록시는 본문 파서보다 먼저 건다. express.json() 이 본문을 먼저 읽어 버리면
  // 원격 서버로 넘길 본문이 남지 않아 POST 요청이 응답 없이 멈춘다.
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, agent: tunnelAgent });

  // 원격 추론 서버가 꺼져 있을 때 프로세스가 죽지 않고 502 로 알린다.
  proxy.on('error', (err, req, res) => {
    // 이미 응답을 보내는 중이었다면(스트리밍 도중 SSH 가 끊김) 본문 중간에 오류 JSON 을 끼우지 않는다.
    // 연결을 끊어야 받는 쪽이 「중간에 끊겼다」는 것을 안다.
    if (res && res.headersSent) {
      if (typeof res.destroy === 'function') res.destroy(err);
      return;
    }
    if (res && !res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (res && typeof res.end === 'function') {
      res.end(JSON.stringify({
        error: `원격 추론 서버에 연결하지 못했습니다: ${err.message}`,
        hint: `원격 서버에서 추론 서버가 127.0.0.1:${session.inferencePort} 에 떠 있는지 확인하세요(예: ollama serve).`
      }));
    }
  });

  // 편집기에서 「생성 중지」를 누르면 받는 쪽 연결이 닫힌다. 그때 원격 요청도 끊어 GPU 를 놓아 준다.
  proxy.on('proxyReq', (proxyReq, req, res) => {
    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy();
    });
  });

  app.use('/v1', (req, res) => {
    if (!session.isAuthSuccess) {
      return res.status(503).json({ error: 'GIJO_BridgeAI 오프라인 (SSH 로그인 필요)' });
    }
    // app.use('/v1') 는 주소에서 /v1 을 떼어 낸다. 원격 서버는 /v1/... 을 기다리므로 원래 주소로 되돌린다.
    req.url = req.originalUrl;
    proxy.web(req, res, { target: `http://127.0.0.1:${session.inferencePort}` });
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── 호스트 키 확인 (처음 본 키를 적어 두고, 다음부터 달라지면 접속을 막는다) ──
  function readKnownHosts() {
    try {
      return JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function checkHostKey(hostIp, port, keyBuffer) {
    const id = `${hostIp}:${port}`;
    const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
    const known = readKnownHosts();
    if (!known[id]) {
      known[id] = fingerprint;
      try {
        fs.mkdirSync(path.dirname(knownHostsFile), { recursive: true });
        fs.writeFileSync(knownHostsFile, JSON.stringify(known, null, 2));
      } catch (e) {
        console.error('[SSH] 호스트 키를 적어 두지 못했습니다:', e.message);
      }
      return { ok: true, fingerprint, firstSeen: true };
    }
    return { ok: known[id] === fingerprint, fingerprint, firstSeen: false };
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
          resolve({ gpuInfo: parseGpuOutput(out), rttMs });
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
    session.isAuthSuccess = false;
    session.authMethod = null;
    session.connectedAt = null;
    session.lastMeasuredAt = null;
    session.rttMs = null;
    session.gpuInfo = emptyGpuInfo(label, architecture);
  }

  function applyMeasurement({ gpuInfo, rttMs }) {
    session.gpuInfo = gpuInfo;
    session.rttMs = rttMs;
    session.lastMeasuredAt = Date.now();
  }

  /** SSH 로 접속해 GPU 상태를 읽고, 연결을 열어 둔 채 REFRESH_MS 마다 다시 읽는다. */
  function connectSsh({ hostIp, port, username, password, privateKey, passphrase, inferencePort }) {
    return new Promise((resolve, reject) => {
      const portNum = parseInt(port, 10) || 22;
      const inferPort = parseInt(inferencePort, 10) || DEFAULT_INFERENCE_PORT;
      const ssh = new SSHClient();
      let hostKey = null;
      let settled = false;
      let closed = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        try { ssh.end(); } catch { /* 이미 닫힘 */ }
        reject(new Error(message));
      };

      ssh.on('ready', async () => {
        try {
          const first = await queryGpu(ssh);
          // 상태를 읽는 사이에 연결이 끊겼으면 이 연결을 세션으로 올리지 않는다.
          if (closed) return fail('GPU 상태를 읽는 중에 SSH 연결이 끊겼습니다');
          // 새 연결이 확인된 뒤에 앞선 연결을 닫는다.
          stopSession('원격 GPU (미연결)', 'SSH 접속 해제됨');
          activeSshClient = ssh;
          Object.assign(session, {
            isAuthSuccess: true,
            hostIp,
            port: portNum,
            username,
            inferencePort: inferPort,
            authMethod: privateKey ? 'key' : 'password',
            connectedAt: Date.now()
          });
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
          const memWord = g.memoryKind === 'unified' ? '남은 통합 메모리' : '남은 VRAM';
          resolve({
            success: true,
            message: g.isMeasured
              ? `SSH 연결 성공: ${hostIp} (${g.gpuName}) ${memWord} ${g.freeGB}GB`
              : `SSH 연결은 됐지만 GPU 메모리를 읽지 못했습니다 (${hostIp})`,
            hostKey,
            session
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
        closed = true;
        // 로그인이 끝나기 전에 서버가 연결을 닫으면 오류 없이 close 만 온다. 그때도 접속 요청을 끝낸다.
        if (!settled) fail('SSH 연결이 접속 도중 닫혔습니다');
        if (activeSshClient === ssh) {
          stopSession('원격 GPU (연결 끊김)', '원격 서버와의 SSH 연결이 끊어졌습니다');
        }
      });

      const config = {
        host: hostIp,
        port: portNum,
        username,
        readyTimeout: 8000,
        keepaliveInterval: 10000,
        hostVerifier: (keyBuffer) => {
          hostKey = checkHostKey(hostIp, portNum, keyBuffer);
          return hostKey.ok;
        }
      };
      if (privateKey) {
        config.privateKey = privateKey;
        if (passphrase) config.passphrase = passphrase;
      }
      if (password) config.password = password;
      try {
        ssh.connect(config);
      } catch (e) {
        // 키 파일이 깨졌거나 암호가 틀리면 connect 가 바로 예외를 던진다.
        fail(`SSH 키를 읽지 못했습니다: ${e.message}`);
      }
    });
  }

  // ── 화면으로 상태 밀어 주기 ────────────────────────────────────────
  const wss = new WebSocket.Server({
    server,
    path: '/webrtc-p2p',
    verifyClient: ({ origin, req }) => isSameAppOrigin(origin, server.address()?.port) && isLocalHostHeader(req.headers.host)
  });
  // ws 는 http 서버의 'error'(예: 포트가 이미 쓰임)를 자기에게 다시 내보낸다. 받는 곳이 없으면
  // 그 오류가 처리되지 않은 예외가 되어 앱이 멈춘다(2026-11-24 설치판에서 실제로 났다).
  // 포트 오류는 아래 listen 쪽에서 이미 처리하므로 여기서는 받아만 둔다.
  wss.on('error', () => {});
  wss.on('connection', (ws) => {
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'telemetry_push',
          // SSH 로 GPU 상태를 읽고 오는 데 걸린 시간(실제 측정값). 미연결이면 null.
          sshRoundTripMs: session.rttMs,
          hostVram: session.gpuInfo,
          authSession: session,
          timestamp: Date.now()
        }));
      }
    }, 1000);
    ws.on('close', () => clearInterval(timer));
  });

  // ── API ────────────────────────────────────────────────────────────
  async function handleLogin(req, res) {
    const { hostIp, port, username, password, privateKeyPath, passphrase, inferencePort } = req.body || {};

    if (!hostIp || !username || (!password && !privateKeyPath)) {
      return res.status(400).json({
        success: false,
        error: '원격 서버 주소와 계정 ID, 그리고 비밀번호나 SSH 키 파일 중 하나를 입력해주세요.'
      });
    }

    let privateKey = null;
    if (privateKeyPath) {
      const keyPath = String(privateKeyPath).trim().replace(/^~(?=[\\/])/, require('os').homedir());
      try {
        // 장치·파이프나 큰 파일을 읽다가 앱이 멈추지 않게, 보통 파일이고 64KB 이하인 것만 키로 읽는다.
        const st = fs.statSync(keyPath);
        if (!st.isFile() || st.size > 64 * 1024) {
          return res.status(400).json({ success: false, error: 'SSH 키 파일이 아닙니다(보통 파일, 64KB 이하만 읽습니다).' });
        }
        privateKey = fs.readFileSync(keyPath);
      } catch (e) {
        return res.status(400).json({ success: false, error: 'SSH 키 파일을 열지 못했습니다. 경로를 확인하세요.' });
      }
    }

    try {
      res.json(await connectSsh({ hostIp, port: port || 22, username, password, privateKey, passphrase, inferencePort }));
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
    res.json(session.gpuInfo);
  });

  /** 원격 서버에 이미 받아 둔 모델. Ollama(/api/tags)를 먼저 묻고, 아니면 OpenAI 호환(/v1/models)을 묻는다. */
  app.get('/api/bridge/remote-models', async (req, res) => {
    if (!session.isAuthSuccess) {
      return res.json({ connected: false, models: [] });
    }
    try {
      const tags = await tunnelGetJson(tunnelAgent, '/api/tags');
      const models = (tags.models || []).map((m) => ({
        name: m.name,
        sizeGB: m.size ? +(m.size / 1024 ** 3).toFixed(1) : null,
        parameterSize: m.details?.parameter_size || null,
        quantization: m.details?.quantization_level || null
      }));
      return res.json({ connected: true, server: 'ollama', inferencePort: session.inferencePort, models });
    } catch (ollamaErr) {
      try {
        const list = await tunnelGetJson(tunnelAgent, '/v1/models');
        const models = (list.data || []).map((m) => ({ name: m.id, sizeGB: null, parameterSize: null, quantization: null }));
        return res.json({ connected: true, server: 'openai-compatible', inferencePort: session.inferencePort, models });
      } catch {
        return res.json({
          connected: true,
          server: null,
          inferencePort: session.inferencePort,
          models: [],
          error: `원격 127.0.0.1:${session.inferencePort} 에서 추론 서버가 답하지 않습니다(${ollamaErr.message}).`
        });
      }
    }
  });

  app.get('/api/bridge/huggingface-recommendations', (req, res) => {
    const availableVramGB = session.gpuInfo.freeGB || 0;

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
      totalVramGB: session.gpuInfo.totalGB,
      usedVramGB: session.gpuInfo.usedGB,
      gpuName: session.gpuInfo.gpuName,
      recommendations: recommendedModels
    });
  });

  app.get('/api/bridge/status', (req, res) => {
    res.json({
      status: session.isAuthSuccess ? 'connected' : 'disconnected',
      hostIp: session.hostIp,
      authSession: session,
      hostVram: session.gpuInfo,
      // SSH 로 GPU 상태를 읽고 오는 데 걸린 시간(ms, 실제 측정값). 미연결이면 null.
      latency: session.rttMs,
      // 서버는 127.0.0.1 에만 열려 있다. localhost 를 ::1 로 먼저 푸는 도구가 있어 숫자 주소로 알려 준다.
      proxyBaseUrl: `http://127.0.0.1:${server.address()?.port}/v1`
    });
  });

  app.post('/api/bridge/disconnect', (req, res) => {
    stopSession('원격 GPU (미연결)', 'SSH 접속 해제됨');
    res.json({ success: true, message: 'SSH 세션 연결 해제 완료' });
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => {
          stopSession('원격 GPU (미연결)', '앱 종료');
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.close(() => done());
          server.closeAllConnections?.();
        })
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });
}

/** 포트가 이미 쓰이면 다음 포트를 시도한다. 데스크톱 앱이 쓴다. */
async function startOnFreePort(firstPort, tries, opts = {}) {
  let lastErr;
  for (let p = firstPort; p < firstPort + tries; p++) {
    try {
      return await startServer({ ...opts, port: p });
    } catch (e) {
      lastErr = e;
      // WSL·Hyper-V·Docker 가 잡아 둔 포트 범위에 걸리면 EACCES 가 난다. 그것도 다음 포트로 넘어간다.
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
    }
  }
  throw lastErr;
}

module.exports = { startServer, startOnFreePort, parseGpuOutput, parseMeminfo, isLocalOrigin, isLocalHostHeader, SshTunnelAgent };

if (require.main === module) {
  const port = parseInt(process.env.BRIDGEAI_PORT, 10) || 3000;
  startServer({ port }).then(({ port: actual }) => {
    console.log(`
  ======================================================
   GIJO_BridgeAI (SSH 원격 GPU 자원 조회 · 로컬 프록시)
   ------------------------------------------------------
   - 대시보드 : http://localhost:${actual}
   - 프록시   : http://127.0.0.1:${actual}/v1
   이 PC(127.0.0.1)에서만 열립니다.
  ======================================================
  `);
  }).catch((err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `포트 ${port} 를 이미 다른 프로그램이 쓰고 있습니다. BRIDGEAI_PORT 로 다른 포트를 지정하세요.`
      : err);
    process.exit(1);
  });
}
