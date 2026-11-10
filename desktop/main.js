// SCALVS.ai desktop: a secure window onto https://scalvs.app. The app itself
// is the live site, so it updates with every deploy. Only scalvs.app pages
// open inside the window; every other link opens in the system browser.
const { app, BrowserWindow, shell, Menu, session } = require('electron');
const path = require('node:path');

const HOME = 'https://scalvs.app/#/command';
const ALLOWED = new Set(['scalvs.app', 'www.scalvs.app']);
const isAllowed = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && ALLOWED.has(u.hostname); } catch { return false; } };

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 380, minHeight: 560,
    title: 'SCALVS.ai',
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.loadURL(HOME);
  // Offline or the site unreachable: show a retry page instead of a blank window.
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: url || HOME } });
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowed(url)) return { action: 'allow' };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (isAllowed(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url); // OAuth sign-ins and links go to the real browser
  });
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  // Microphone for voice input is the only permission the app may request, and only from scalvs.app.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' && isAllowed(wc.getURL()));
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Go', submenu: [
      { label: 'New task', accelerator: 'CmdOrCtrl+N', click: () => win?.loadURL(HOME) },
      { label: 'Automations', click: () => win?.loadURL('https://scalvs.app/#/automations') },
      { label: 'Connect', click: () => win?.loadURL('https://scalvs.app/#/connect') },
      { type: 'separator' },
      { label: 'Back', accelerator: 'Alt+Left', click: () => win?.webContents.navigationHistory.goBack() },
    ] },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
