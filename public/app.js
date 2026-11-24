let currentStatus = 'disconnected';
let socket = null;
let lastConnectedHost = null;

const $ = (id) => document.getElementById(id);

/** 화면에 넣는 글자는 모두 이걸 거친다(서버 이름·모델 이름에 < 가 섞여도 깨지지 않게). */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 프록시 주소. 서버가 알려 준 값을 쓰고, 받기 전에는 이 화면의 포트로 만든다(포트 3000 이 쓰이면 앱이 다른 포트를 쓴다). */
let serverProxyUrl = null;
function proxyBaseUrl() {
  return serverProxyUrl || `http://127.0.0.1:${window.location.port || 80}/v1`;
}

document.addEventListener('DOMContentLoaded', () => {
  $('proxyUrl').innerText = proxyBaseUrl();
  fetchStatus();
  loadHfRecommendations();
  initTelemetrySocket();
  setInterval(fetchStatus, 2000);
});

function initTelemetrySocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    socket = new WebSocket(`${protocol}//${window.location.host}/webrtc-p2p`);
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'telemetry_push' && data.hostVram) updateGpuTelemetryUI(data.hostVram, data.sshRoundTripMs);
    };
  } catch (e) {
    console.warn('실시간 갱신을 못 열어 2초마다 다시 묻습니다');
  }
}

function updateGpuTelemetryUI(vram, rttMs) {
  $('gpuName').innerText = vram.gpuName;
  $('gpuArch').innerText = `구조: ${vram.architecture}`;
  // 읽지 못한 값은 숫자를 지어내지 않고 '-' 로 둔다.
  const hasTemp = vram.temperature !== null && vram.temperature !== undefined;
  $('valTemp').innerText = hasTemp ? `${vram.temperature} °C` : '-';
  if (rttMs !== undefined) $('valRtt').innerText = rttMs != null ? `${rttMs} ms` : '-';

  const unified = vram.memoryKind === 'unified';
  $('memLabel').innerText = unified ? '통합 메모리 사용량 (GPU·CPU 공용)' : 'GPU 메모리(VRAM) 사용량';
  $('freeLabel').innerText = unified ? '남은 통합 메모리' : '남은 VRAM';

  const known = vram.totalGB > 0;
  const pct = known ? ((vram.usedGB / vram.totalGB) * 100).toFixed(1) : 0;
  $('valFreeVram').innerText = known ? `${vram.freeGB} GB` : '-';
  $('vramText').innerText = known ? `${vram.usedGB} GB / ${vram.totalGB} GB (남은 용량: ${vram.freeGB} GB)` : '용량 확인 불가';
  $('vramProgress').style.width = `${pct}%`;
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/bridge/status');
    updateUI(await res.json());
  } catch (err) {
    console.error('상태를 읽지 못했습니다:', err);
  }
}

function updateUI(data) {
  currentStatus = data.status;
  if (data.proxyBaseUrl && data.proxyBaseUrl !== serverProxyUrl) {
    serverProxyUrl = data.proxyBaseUrl;
    $('proxyUrl').innerText = serverProxyUrl;
  }
  const btnConnect = $('btnConnect');

  if (data.status === 'connected') {
    const s = data.authSession;
    $('statusDot').className = 'status-indicatorConnected';
    $('statusTitle').innerText = `원격 서버 (${data.hostIp}) 연결됨`;
    $('statusSub').innerText = `${s.username} · ${s.authMethod === 'key' ? 'SSH 키' : '비밀번호'} 로그인 · 추론 서버 포트 ${s.inferencePort} · 5초마다 다시 읽습니다`;
    btnConnect.innerText = '🔌 SSH 접속 끊기';
    btnConnect.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
    $('userAuthTag').innerText = `${s.username}@${data.hostIp}`;
    $('valAuthStatus').innerText = '연결됨';
    $('valAuthStatus').className = 'stat-value text-green';
    if (lastConnectedHost !== data.hostIp) {
      lastConnectedHost = data.hostIp;
      loadRemoteModels();
    }
  } else if (data.status === 'connecting') {
    $('statusDot').className = 'status-indicatorDisconnected';
    $('statusTitle').innerText = '원격 서버에 접속하는 중…';
    $('statusSub').innerText = 'SSH 로그인 뒤 nvidia-smi 로 GPU 상태를 읽습니다';
    btnConnect.innerText = '⏳ 접속하는 중…';
  } else {
    $('statusDot').className = 'status-indicatorDisconnected';
    $('statusTitle').innerText = 'SSH 미연결';
    $('statusSub').innerText = '원격 서버 주소와 SSH 계정을 입력해 접속하세요';
    btnConnect.innerText = '🔑 SSH 접속하고 GPU 상태 읽기';
    btnConnect.style.background = 'linear-gradient(135deg, var(--primary), var(--accent-cyan))';
    $('userAuthTag').innerText = 'SSH 미연결';
    $('valAuthStatus').innerText = '미연결';
    $('valAuthStatus').className = 'stat-value text-red';
    if (lastConnectedHost) {
      lastConnectedHost = null;
      $('remoteModelList').innerHTML = '<div class="hf-loading">SSH 접속 후 표시됩니다.</div>';
    }
  }

  if (data.hostVram) updateGpuTelemetryUI(data.hostVram, data.latency);
}

async function loadRemoteModels() {
  const box = $('remoteModelList');
  box.innerHTML = '<div class="hf-loading">원격 추론 서버에 묻는 중…</div>';
  try {
    const data = await (await fetch('/api/bridge/remote-models')).json();
    if (!data.connected) {
      box.innerHTML = '<div class="hf-loading">SSH 접속 후 표시됩니다.</div>';
      return;
    }
    if (data.error) {
      box.innerHTML = `<div class="text-red">${esc(data.error)}</div><div class="text-muted">원격 서버에서 추론 서버(예: ollama serve)가 떠 있는지, 포트가 맞는지 확인하세요.</div>`;
      return;
    }
    if (!data.models.length) {
      box.innerHTML = `<div class="text-muted">추론 서버(${esc(data.server)})는 답했지만 받아 둔 모델이 없습니다. 원격 서버에서 모델을 먼저 받아 주세요(예: ollama pull qwen3:8b).</div>`;
      return;
    }
    box.innerHTML = data.models.map((m) => `
      <div class="hf-card fit">
        <div class="hf-card-left">
          <div class="hf-model-name">${esc(m.name)}</div>
          <div class="hf-tags">
            ${m.parameterSize ? `<span class="hf-tag">${esc(m.parameterSize)}</span>` : ''}
            ${m.quantization ? `<span class="hf-tag">${esc(m.quantization)}</span>` : ''}
            ${m.sizeGB != null ? `<span class="hf-tag-vram">${esc(m.sizeGB)} GB</span>` : ''}
          </div>
        </div>
        <div class="hf-card-right">
          <button class="btn-hf-load" type="button" data-model="${esc(m.name)}" onclick="copyModelName(this.dataset.model)">이름 복사</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = '<div class="text-red">모델 목록을 읽지 못했습니다.</div>';
  }
}

async function loadHfRecommendations() {
  const container = $('hfModelList');
  try {
    const data = await (await fetch('/api/bridge/huggingface-recommendations')).json();
    if (!data.recommendations || data.recommendations.length === 0) {
      container.innerHTML = '<div class="text-muted">SSH 접속 후 표시됩니다.</div>';
      return;
    }
    container.innerHTML = data.recommendations.map((model) => `
      <div class="hf-card ${model.isFit ? 'fit' : 'unfit'}">
        <div class="hf-card-left">
          <div class="hf-model-name">${esc(model.name)}</div>
          <div class="hf-model-repo">${esc(model.repo)}</div>
          <div class="hf-tags">
            ${model.tags.map((t) => `<span class="hf-tag">${esc(t)}</span>`).join('')}
            <span class="hf-tag-vram">최소 ${esc(model.reqVramGB)} GB</span>
          </div>
        </div>
        <div class="hf-card-right">
          <div class="hf-status-text ${model.isFit ? 'text-green' : 'text-red'}">${esc(model.vramStatusText)}</div>
        </div>
      </div>`).join('');
  } catch (e) {
    container.innerHTML = '<div class="text-red">참고표를 읽지 못했습니다.</div>';
  }
}

async function toggleConnect() {
  if (currentStatus === 'connected') {
    await fetch('/api/bridge/disconnect', { method: 'POST' });
    fetchStatus();
    loadHfRecommendations();
    return;
  }

  const hostIp = $('inputHostIp').value.trim();
  const port = $('inputPort').value.trim() || 22;
  const username = $('inputUsername').value.trim();
  const password = $('inputPassword').value;
  const privateKeyPath = $('inputKeyPath').value.trim();
  const passphrase = $('inputPassphrase').value;
  const inferencePort = $('inputInferencePort').value.trim() || 11434;

  if (!hostIp || !username || (!password && !privateKeyPath)) {
    alert('원격 서버 주소와 계정 ID, 그리고 비밀번호나 SSH 키 파일 경로를 입력해 주세요.');
    return;
  }

  updateUI({ status: 'connecting', hostIp, authSession: { username }, hostVram: null });
  try {
    const res = await fetch('/api/bridge/auth-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostIp, port, username, password, privateKeyPath, passphrase, inferencePort })
    });
    const data = await res.json();
    // 비밀번호와 키 암호는 화면에도 남기지 않는다.
    $('inputPassword').value = '';
    $('inputPassphrase').value = '';
    if (!data.success) alert(`${data.error || 'SSH 접속에 실패했습니다.'}${data.suggestion ? `\n\n${data.suggestion}` : ''}`);
  } catch (e) {
    alert(`${hostIp}:${port} 에 접속하지 못했습니다.`);
  }
  fetchStatus();
  loadHfRecommendations();
}

function copyText(text, message) {
  navigator.clipboard.writeText(text).then(() => alert(message), () => prompt('복사하지 못했습니다. 직접 복사하세요:', text));
}

function copyProxyUrl() {
  const url = proxyBaseUrl();
  copyText(url, `로컬 프록시 주소(${url})를 복사했습니다.\n편집기나 파이썬 코드의 Base URL 에 붙여 넣으세요. API 키를 물으면 아무 값이나 넣어도 됩니다.`);
}

function copyModelName(name) {
  copyText(name, `모델 이름(${name})을 복사했습니다.`);
}
