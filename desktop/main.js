/*
 * GIJO_BridgeAI 데스크톱(Windows 설치판).
 *
 * 하는 일: 로컬 서버(../server.js)를 이 PC(127.0.0.1)에서 띄우고, 그 대시보드를 창으로 연다.
 * 창을 닫으면 서버도 같이 꺼진다. SSH 비밀번호는 저장하지 않는다.
 *
 * 포트: 3000 을 먼저 쓰고, 다른 프로그램이 쓰고 있으면 3001, 3002 … 를 쓴다.
 * 그때는 대시보드의 「로컬 프록시」 주소도 그 포트로 바뀐다.
 */
const { app, BrowserWindow, Menu, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { startOnFreePort } = require('../server');

const FIRST_PORT = 3000;
const PORT_TRIES = 20;
const REPO_URL = 'https://github.com/gijotour/GIJO_BridgeAI';

let bridge = null;
let mainWindow = null;
/** 로컬 서버를 한 번만 닫는다. 종료 경로(창 닫기·업데이트·메뉴 종료)가 겹쳐도 같은 약속을 돌려준다. */
let bridgeClosing = null;
function closeBridge() {
  if (!bridgeClosing) bridgeClosing = bridge ? bridge.close() : Promise.resolve();
  return bridgeClosing;
}
// 「지금 재시작」을 누른 뒤 창이 실제로 닫혔을 때만 설치를 시작하려고 둔 표시.
let installAfterClose = false;

// ── 설정 (MD Studio 와 같은 방식: 사용자 데이터 폴더의 settings.json) ──
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    // 임시 파일에 다 쓴 뒤 이름을 바꾼다. 쓰는 도중에 앱이 죽어도 반쯤 쓰인 파일이 남지 않는다.
    const tmp = settingsPath() + '.tmp';
    const body = JSON.stringify(next, null, 2);
    fs.writeFileSync(tmp, body);
    try {
      fs.renameSync(tmp, settingsPath());
    } catch {
      // 백신·동기화 프로그램이 파일을 잡고 있으면 이름 바꾸기가 실패한다. 그때는 바로 덮어쓴다.
      fs.writeFileSync(settingsPath(), body);
      fs.rmSync(tmp, { force: true });
    }
    return true;
  } catch (err) {
    console.error('설정을 저장하지 못했습니다:', err);
    return false;
  }
}

function updateCheckEnabled() {
  return readSettings().checkForUpdates !== false;
}

// ── 창 ────────────────────────────────────────────────────────────────
function dashboardUrl() {
  return `http://localhost:${bridge.port}`;
}

function isDashboardUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && Number(u.port) === bridge.port;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'GIJO BridgeAI',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // 대시보드 밖으로는 창을 옮기지 않는다. 바깥 링크는 기본 브라우저로 연다.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isDashboardUrl(url)) e.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (e, url) => {
    if (!isDashboardUrl(url)) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.loadURL(dashboardUrl());
}

function buildMenu() {
  const template = [
    {
      label: '파일 (File)',
      submenu: [
        {
          label: '로컬 프록시 주소 복사',
          click: () => clipboard.writeText(`http://127.0.0.1:${bridge.port}/v1`)
        },
        { type: 'separator' },
        { label: '종료', role: 'quit' }
      ]
    },
    {
      label: '보기 (View)',
      submenu: [
        { label: '새로고침', role: 'reload' },
        { label: '확대', role: 'zoomIn' },
        { label: '축소', role: 'zoomOut' },
        { label: '원래 크기', role: 'resetZoom' },
        { type: 'separator' },
        { label: '전체 화면', role: 'togglefullscreen' }
      ]
    },
    {
      label: '도움말 (Help)',
      submenu: [
        {
          // 업데이트 확인은 이 앱이 스스로 바깥과 통신하는 유일한 곳이라 끌 수 있게 둔다.
          label: '시작할 때 업데이트 확인',
          type: 'checkbox',
          checked: updateCheckEnabled(),
          click: (item) => {
            const saved = writeSettings({ ...readSettings(), checkForUpdates: item.checked });
            // 저장에 실패했으면 표시를 실제 설정으로 되돌려 거짓으로 보이지 않게 한다.
            if (!saved) item.checked = updateCheckEnabled();
          }
        },
        {
          label: '호스트 키 기록 폴더 열기',
          click: () => shell.openPath(app.getPath('userData'))
        },
        { type: 'separator' },
        { label: '저장소와 사용법 (GitHub)', click: () => shell.openExternal(REPO_URL) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── 자동 업데이트 (GitHub Releases) ─────────────────────────────────────
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  if (!updateCheckEnabled()) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.error('electron-updater 를 불러오지 못했습니다:', err);
    return;
  }

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      title: '업데이트 준비 완료',
      message: `새 버전 ${info.version} 이(가) 준비되었습니다.`,
      detail: '지금 재시작하면 업데이트가 적용됩니다. 열려 있는 SSH 연결은 끊기고, 다시 접속해야 합니다.'
    });
    if (response !== 0) return;
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      autoUpdater.quitAndInstall();
      return;
    }
    installAfterClose = true;
    win.once('closed', async () => {
      if (!installAfterClose) return;
      // SSH 연결과 로컬 서버를 먼저 닫고 나서 설치 파일을 띄운다.
      await closeBridge();
      autoUpdater.quitAndInstall();
    });
    win.close();
  });

  // 업데이트 실패는 평소 사용을 막지 않는다(릴리스 없음, 오프라인, 막힌 네트워크).
  autoUpdater.on('error', (err) => console.error('업데이트 확인 실패:', err));

  if (typeof autoUpdater.isUpdaterActive === 'function' && !autoUpdater.isUpdaterActive()) return;
  autoUpdater.checkForUpdates().catch((err) => console.error('업데이트 확인 실패:', err));
}

// ── 시작과 끝 ─────────────────────────────────────────────────────────
// 두 번 실행하면 서버가 둘 뜬다. 이미 떠 있으면 그 창을 앞으로 가져온다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      bridge = await startOnFreePort(FIRST_PORT, PORT_TRIES, {
        // 설치 폴더는 읽기 전용이라, 호스트 키 기록은 사용자 데이터 폴더에 둔다.
        knownHostsFile: path.join(app.getPath('userData'), 'known_hosts.json')
      });
    } catch (err) {
      dialog.showErrorBox(
        'GIJO BridgeAI 를 시작하지 못했습니다',
        `로컬 서버를 띄우지 못했습니다(포트 ${FIRST_PORT}~${FIRST_PORT + PORT_TRIES - 1}).\n${err.message}`
      );
      app.quit();
      return;
    }
    buildMenu();
    createWindow();
    setupAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 업데이트를 설치하려고 창을 닫은 것이면, 끄는 일은 업데이트 쪽(quitAndInstall)에 맡긴다.
    if (installAfterClose) return;
    if (process.platform !== 'darwin') app.quit();
  });

  // 끌 때 SSH 연결과 로컬 서버를 닫는다.
  let closed = false;
  app.on('before-quit', (e) => {
    if (!bridge || closed) return;
    e.preventDefault();
    closeBridge().finally(() => {
      closed = true;
      app.quit();
    });
  });
}
