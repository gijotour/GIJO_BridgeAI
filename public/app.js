let currentStatus = 'disconnected';
let pollInterval = null;
let socket = null;

document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  loadHfRecommendations();
  initWebRtcP2pSocket();
  pollInterval = setInterval(fetchStatus, 2000);
});

function initWebRtcP2pSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/webrtc-p2p`;
  
  try {
    socket = new WebSocket(wsUrl);
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'telemetry_push') {
        if (data.hostVram) {
          updateGpuTelemetryUI(data.hostVram);
        }
      }
    };
  } catch (e) {
    console.warn('WebSockets fallback');
  }
}

function updateGpuTelemetryUI(vram) {
  document.getElementById('gpuName').innerText = vram.gpuName;
  document.getElementById('gpuArch').innerText = `구조: ${vram.architecture}`;
  // 읽지 못한 값은 숫자를 지어내지 않고 '-' 로 둔다.
  const hasTemp = vram.temperature !== null && vram.temperature !== undefined;
  document.getElementById('valTemp').innerText = hasTemp ? `${vram.temperature} °C` : '-';

  const known = vram.totalGB > 0;
  const freeVram = known ? (vram.freeGB || (vram.totalGB - vram.usedGB).toFixed(1)) : '-';
  document.getElementById('valFreeVram').innerText = known ? `${freeVram} GB` : '-';

  const used = vram.usedGB;
  const total = vram.totalGB;
  const pct = total > 0 ? ((used / total) * 100).toFixed(1) : 0;

  document.getElementById('vramText').innerText = known
    ? `${used} GB / ${total} GB (남은 용량: ${freeVram} GB)`
    : '용량 확인 불가';
  document.getElementById('vramProgress').style.width = `${pct}%`;
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/bridge/status');
    const data = await res.json();
    updateUI(data);
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

function updateUI(data) {
  currentStatus = data.status;

  const statusDot = document.getElementById('statusDot');
  const statusTitle = document.getElementById('statusTitle');
  const statusSub = document.getElementById('statusSub');
  const btnConnect = document.getElementById('btnConnect');
  const userAuthTag = document.getElementById('userAuthTag');
  const valAuthStatus = document.getElementById('valAuthStatus');

  if (data.status === 'connected') {
    statusDot.className = 'status-indicatorConnected';
    statusTitle.innerText = `원격 GPU 서버 (${data.hostIp}) SSH2 연결 성공`;
    statusSub.innerText = `SSH 계정(${data.authSession.username}) 접속 완료 · 5초마다 다시 읽습니다${data.latency != null ? ` · SSH 왕복 ${data.latency} ms` : ''}`;
    btnConnect.innerText = '🔌 SSH2 접속 끊기';
    btnConnect.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
    userAuthTag.innerText = `SSH2: ${data.authSession.username} (연결됨)`;
    valAuthStatus.innerText = 'SSH2 연결됨';
    valAuthStatus.className = 'stat-value text-green';
  } else if (data.status === 'connecting') {
    statusDot.className = 'status-indicatorDisconnected';
    statusTitle.innerText = '원격 GPU 서버 22번 포트 접속 중...';
    statusSub.innerText = 'SSH2 패킷 핸드셰이크 및 명령어(nvidia-smi) 실행 중입니다';
    btnConnect.innerText = '⏳ SSH2 접속 및 자원 읽는 중...';
  } else {
    statusDot.className = 'status-indicatorDisconnected';
    statusTitle.innerText = '진짜 SSH 미연결';
    statusSub.innerText = '원격 서버 주소와 SSH 계정을 입력해 접속하세요';
    btnConnect.innerText = '🔑 진짜 SSH 접속 및 실시간 GPU 자원 읽어오기';
    btnConnect.style.background = 'linear-gradient(135deg, var(--primary), var(--accent-cyan))';
    userAuthTag.innerText = 'SSH2 세션 미연결';
    valAuthStatus.innerText = '미연결';
    valAuthStatus.className = 'stat-value text-red';
  }

  if (data.hostVram) {
    updateGpuTelemetryUI(data.hostVram);
  }
}

async function loadHfRecommendations() {
  const container = document.getElementById('hfModelList');

  try {
    const res = await fetch('/api/bridge/huggingface-recommendations');
    const data = await res.json();

    if (!data.recommendations || data.recommendations.length === 0) {
      container.innerHTML = '<div class="text-muted">SSH2로 접속된 자원이 없습니다. 계정을 입력해 연결하세요.</div>';
      return;
    }

    container.innerHTML = '';
    data.recommendations.forEach(model => {
      const card = document.createElement('div');
      card.className = `hf-card ${model.isFit ? 'fit' : 'unfit'}`;

      card.innerHTML = `
        <div class="hf-card-left">
          <div class="hf-model-name">${model.name}</div>
          <div class="hf-model-repo">${model.repo}</div>
          <div class="hf-tags">
            ${model.tags.map(t => `<span class="hf-tag">${t}</span>`).join('')}
            <span class="hf-tag-vram">최소 VRAM: ${model.reqVramGB} GB</span>
          </div>
        </div>
        <div class="hf-card-right">
          <div class="hf-status-text ${model.isFit ? 'text-green' : 'text-red'}">${model.vramStatusText}</div>
          ${model.isFit ? `<button class="btn-hf-load" onclick="loadModelToHost('${model.id}', '${model.name}')">원클릭 로드</button>` : `<button class="btn-hf-disabled" disabled>VRAM 부족</button>`}
        </div>
      `;
      container.appendChild(card);
    });
  } catch (e) {
    container.innerHTML = '<div class="text-red">SSH 자원 수집 대기 중</div>';
  }
}

async function loadModelToHost(modelId, modelName) {
  if (!confirm(`[GIJO_BridgeAI SSH2]\n\n${modelName} 모델을 SSH로 원격 AI 서버 GPU VRAM에 배포하시겠습니까?`)) {
    return;
  }

  try {
    const res = await fetch('/api/bridge/load-hf-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, modelName })
    });
    const result = await res.json();
    alert(result.message);
    fetchStatus();
    loadHfRecommendations();
  } catch (e) {
    alert('모델 배포 오류');
  }
}

async function toggleConnect() {
  const hostIp = document.getElementById('inputHostIp').value;
  const port = document.getElementById('inputPort').value || 22;
  const username = document.getElementById('inputUsername').value;
  const password = document.getElementById('inputPassword').value;

  if (currentStatus === 'connected') {
    await fetch('/api/bridge/disconnect', { method: 'POST' });
  } else {
    if (!hostIp || !username || !password) {
      alert('원격 서버 주소, SSH 계정 ID, 비밀번호를 입력해주세요!');
      return;
    }

    updateUI({ status: 'connecting', hostIp, authSession: { username }, hostVram: {} });
    
    try {
      const res = await fetch('/api/bridge/auth-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostIp, port, username, password })
      });
      const data = await res.json();
      
      if (data.success) {
        alert(data.message);
      } else {
        alert(data.error || 'SSH 접속에 실패했습니다.');
      }
    } catch (e) {
      alert(`[SSH 접속 에러] ${hostIp}:${port} 서버와 통신할 수 없습니다.`);
    }
  }
  fetchStatus();
  loadHfRecommendations();
}

async function switchMode(mode) {
  document.getElementById('btnModeClient').classList.toggle('active', mode === 'client');
  document.getElementById('btnModeHost').classList.toggle('active', mode === 'host');
  
  await fetch('/api/bridge/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  });

  fetchStatus();
  loadHfRecommendations();
}

function copyProxyUrl() {
  navigator.clipboard.writeText('http://localhost:3000/v1');
  alert('로컬 프록시 주소 (http://localhost:3000/v1) 가 복사되었습니다!\nVS Code Continue, Cursor, Python 딥러닝 코드의 Base URL에 붙여넣으시면 SSH 접속된 원격 GPU 자원으로 자동 오프로드됩니다.');
}
