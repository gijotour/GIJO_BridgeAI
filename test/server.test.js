// node --test test/
// 가짜 SSH 서버(ssh2 Server)와 가짜 추론 서버를 이 PC 에 띄워, 실제 SSH 터널로 요청이 넘어가는지 본다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server: SSHServer, utils } = require('ssh2');
const { startServer, parseGpuOutput, parseMeminfo, isLocalOrigin, isLocalHostHeader } = require('../server');

// ── 순수 함수 ────────────────────────────────────────────────────────
test('전용 VRAM: nvidia-smi 값을 쓴다', () => {
  const g = parseGpuOutput('NVIDIA GeForce RTX 4090, 24564, 2048, 51\n__BRIDGEAI_MEMINFO__\nMemTotal: 65000000 kB\nMemAvailable: 60000000 kB\n');
  assert.equal(g.gpuName, 'NVIDIA GeForce RTX 4090');
  assert.equal(g.memoryKind, 'vram');
  assert.equal(g.totalGB, 24);
  assert.equal(g.usedGB, 2);
  assert.equal(g.freeGB, 22);
  assert.equal(g.temperature, 51);
  assert.equal(g.isMeasured, true);
});

test('통합 메모리(GB10): 메모리가 Not Supported 면 /proc/meminfo 를 쓴다', () => {
  const out = 'NVIDIA GB10, [N/A], [N/A], 44\n__BRIDGEAI_MEMINFO__\nMemTotal:       127552000 kB\nMemAvailable:   100663296 kB\n';
  const g = parseGpuOutput(out);
  assert.equal(g.gpuName, 'NVIDIA GB10');
  assert.equal(g.memoryKind, 'unified');
  assert.equal(g.totalGB, 121.6);
  assert.equal(g.freeGB, 96);
  assert.equal(g.usedGB, 25.6);
  assert.equal(g.temperature, 44);
  assert.equal(g.isMeasured, true);
});

test('nvidia-smi 가 없으면 숫자를 지어내지 않는다', () => {
  const g = parseGpuOutput('__BRIDGEAI_NO_GPU_QUERY__\n__BRIDGEAI_MEMINFO__\nMemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n');
  assert.equal(g.isMeasured, false);
  assert.equal(g.totalGB, 0);
  assert.equal(g.freeGB, 0);
});

test('meminfo 가 비었거나 깨졌으면 null', () => {
  assert.equal(parseMeminfo(''), null);
  assert.equal(parseMeminfo('MemTotal: 100 kB'), null);
});

test('요청 출처: 내 PC 만 받는다', () => {
  assert.equal(isLocalOrigin(undefined), true);
  assert.equal(isLocalOrigin('http://localhost:5173'), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isLocalOrigin('https://evil.example'), false);
  assert.equal(isLocalOrigin('http://localhost.evil.example'), false);
  assert.equal(isLocalOrigin('null'), false);
  assert.equal(isLocalHostHeader('localhost:3000'), true);
  assert.equal(isLocalHostHeader('127.0.0.1:3000'), true);
  assert.equal(isLocalHostHeader('[::1]:3000'), true);
  assert.equal(isLocalHostHeader('attacker.example:3000'), false);
  assert.equal(isLocalHostHeader(undefined), false);
});

// ── 통합: 가짜 SSH 서버 + 가짜 추론 서버 ─────────────────────────────
let sshServer, sshPort, inference, inferencePort, bridge, tmp;
let slowClosedEarly = null;
const seen = [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));

  // 가짜 추론 서버: 원격 서버 안쪽(127.0.0.1)에만 떠 있다고 가정한다.
  inference = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      if (req.url === '/v1/slow') {
        // 토큰을 천천히 흘려보내는 스트리밍 응답 흉내
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let n = 0;
        const t = setInterval(() => { res.write(`data: ${n++}\n\n`); if (n > 60) { clearInterval(t); res.end(); } }, 30);
        res.on('close', () => { clearInterval(t); slowClosedEarly = n <= 60; });
        return;
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'qwen3:32b', size: 20 * 1024 ** 3, details: { parameter_size: '32B', quantization_level: 'Q4_K_M' } }] }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: body, url: req.url }));
    });
  });
  await new Promise((r) => inference.listen(0, '127.0.0.1', r));
  inferencePort = inference.address().port;

  // 가짜 SSH 서버: 비밀번호 확인, nvidia-smi 명령 흉내, direct-tcpip(포트 포워딩) 허용
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  sshServer = new SSHServer({ hostKeys: [hostKey] }, (client) => {
    // 키가 바뀐 경우를 시험할 때 상대가 연결을 끊는다. 가짜 서버가 그 일로 죽지 않게 한다.
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'pw') return ctx.accept();
      ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('exec', (acceptExec) => {
          const stream = acceptExec();
          stream.write('NVIDIA GB10, [N/A], [N/A], 40\n__BRIDGEAI_MEMINFO__\nMemTotal: 127552000 kB\nMemAvailable: 104857600 kB\n');
          stream.exit(0);
          stream.end();
        });
      });
      client.on('tcpip', (accept, _reject, info) => {
        const ch = accept();
        const sock = net.connect(info.destPort, info.destIP);
        ch.pipe(sock).pipe(ch);
        sock.on('error', () => ch.close());
      });
    });
  });
  await new Promise((r) => sshServer.listen(0, '127.0.0.1', r));
  sshPort = sshServer.address().port;

  bridge = await startServer({ port: 0, knownHostsFile: path.join(tmp, 'known_hosts.json') });
});

after(async () => {
  await bridge?.close();
  await new Promise((r) => sshServer.close(r));
  await new Promise((r) => inference.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function call(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: bridge.port,
      path: urlPath,
      method,
      headers: { host: `localhost:${bridge.port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers }
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch { /* 본문이 JSON 이 아님 */ }
        resolve({ status: res.statusCode, json, text: out, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('127.0.0.1 에만 열린다', () => {
  assert.equal(bridge.server.address().address, '127.0.0.1');
});

test('로그인 전 /v1 은 503', async () => {
  const r = await call('POST', '/v1/chat/completions', { body: { model: 'x' } });
  assert.equal(r.status, 503);
});

test('다른 웹사이트에서 온 요청은 403', async () => {
  const r = await call('GET', '/api/bridge/status', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('같은 PC 의 다른 포트 페이지는 관리 API 를 못 부르고, /v1 은 쓸 수 있다', async () => {
  const other = { origin: 'http://localhost:5173' };
  assert.equal((await call('POST', '/api/bridge/auth-login', { body: { hostIp: 'x', username: 'u', password: 'p' }, headers: other })).status, 403);
  assert.equal((await call('POST', '/api/bridge/disconnect', { headers: other })).status, 403);
  assert.equal((await call('POST', '/v1/chat/completions', { body: { model: 'x' }, headers: other })).status, 503);
  const own = { origin: `http://localhost:${bridge.port}` };
  assert.equal((await call('GET', '/api/bridge/status', { headers: own })).status, 200);
});

test('키 경로에 폴더나 큰 파일을 넣으면 읽지 않고 400', async () => {
  const big = path.join(tmp, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(200 * 1024));
  for (const p of [tmp, big]) {
    const r = await call('POST', '/api/bridge/auth-login', { body: { hostIp: '127.0.0.1', port: sshPort, username: 'tester', privateKeyPath: p } });
    assert.equal(r.status, 400);
    assert.doesNotMatch(r.json.error, /ENOENT|EISDIR|EACCES/);
  }
});

test('다른 주소 이름(Host)으로 온 요청은 403', async () => {
  const r = await call('GET', '/api/bridge/status', { headers: { host: 'attacker.example' } });
  assert.equal(r.status, 403);
});

test('비밀번호가 틀리면 401', async () => {
  const r = await call('POST', '/api/bridge/auth-login', { body: { hostIp: '127.0.0.1', port: sshPort, username: 'tester', password: 'nope', inferencePort } });
  assert.equal(r.status, 401);
  assert.equal(r.json.success, false);
});

test('로그인하면 통합 메모리를 읽고, /v1 요청이 SSH 터널로 넘어간다', async () => {
  const login = await call('POST', '/api/bridge/auth-login', { body: { hostIp: '127.0.0.1', port: sshPort, username: 'tester', password: 'pw', inferencePort } });
  assert.equal(login.status, 200, login.text);
  assert.equal(login.json.success, true);
  assert.equal(login.json.session.gpuInfo.memoryKind, 'unified');
  assert.equal(login.json.session.gpuInfo.freeGB, 100);

  const status = await call('GET', '/api/bridge/status');
  assert.equal(status.json.status, 'connected');
  assert.equal(status.json.proxyBaseUrl, `http://127.0.0.1:${bridge.port}/v1`);

  const rec = await call('GET', '/api/bridge/huggingface-recommendations');
  assert.equal(rec.status, 200);
  assert.equal(rec.json.recommendations.length, 8);
  assert.equal(rec.json.availableVramGB, 100);
  assert.ok(rec.json.recommendations.some((m) => m.isFit));

  const chat = await call('POST', '/v1/chat/completions', { body: { model: 'qwen3:32b', messages: [{ role: 'user', content: '안녕' }] } });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json.url, '/v1/chat/completions');
  assert.match(chat.json.echo, /안녕/);

  const models = await call('GET', '/api/bridge/remote-models');
  assert.equal(models.json.server, 'ollama');
  assert.equal(models.json.models[0].name, 'qwen3:32b');
  assert.equal(models.json.models[0].sizeGB, 20);
});

test('편집기가 스트리밍을 멈추면 원격 요청도 끊는다', async () => {
  slowClosedEarly = null;
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/v1/slow', method: 'POST', headers: { host: `localhost:${bridge.port}`, 'content-type': 'application/json' } }, (res) => {
      res.once('data', () => { req.destroy(); setTimeout(resolve, 300); });
    });
    req.on('error', () => {});
    req.end('{}');
    setTimeout(() => reject(new Error('응답이 오지 않음')), 3000);
  });
  assert.equal(slowClosedEarly, true);
});

test('추론 서버가 꺼져 있으면 502 와 안내', async () => {
  const login = await call('POST', '/api/bridge/auth-login', { body: { hostIp: '127.0.0.1', port: sshPort, username: 'tester', password: 'pw', inferencePort: 1 } });
  assert.equal(login.status, 200);
  const r = await call('POST', '/v1/chat/completions', { body: { model: 'x' } });
  assert.equal(r.status, 502);
  assert.match(r.json.hint, /127\.0\.0\.1:1/);
});

test('처음 본 호스트 키를 적어 두고, 키가 바뀌면 접속을 막는다', async () => {
  const file = path.join(tmp, 'known_hosts.json');
  const known = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = `127.0.0.1:${sshPort}`;
  assert.match(known[id], /^SHA256:/);
  fs.writeFileSync(file, JSON.stringify({ [id]: 'SHA256:different' }));
  const r = await call('POST', '/api/bridge/auth-login', { body: { hostIp: '127.0.0.1', port: sshPort, username: 'tester', password: 'pw', inferencePort } });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /호스트 키/);
});

test('접속 해제 뒤 /v1 은 다시 503', async () => {
  await call('POST', '/api/bridge/disconnect');
  const r = await call('POST', '/v1/chat/completions', { body: { model: 'x' } });
  assert.equal(r.status, 503);
});

test('포트가 이미 쓰이면 처리되지 않은 예외 없이 다음 포트로 넘어간다', async () => {
  const { startOnFreePort } = require('../server');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  let uncaught = null;
  const onUncaught = (e) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);
  try {
    const b = await startOnFreePort(busy, 5, { knownHostsFile: path.join(tmp, 'kh2.json') });
    await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(b.port, busy);
    assert.equal(uncaught, null);
    await b.close();
  } finally {
    process.off('uncaughtException', onUncaught);
    blocker.close();
  }
});
