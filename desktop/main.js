// Instinct for Windows. Loads the bundled chat UI; the built-in app key means no passkey.
// Closing the window keeps Instinct running in the system tray, so notifications keep
// coming. It also starts with Windows (in the tray). Quit from the tray icon's menu.
const { app, BrowserWindow, shell, ipcMain, Menu, nativeImage, session, Tray, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.setAppUserModelId('com.mido.instinct'); // Windows needs this for notifications
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
let tray = null;
let quitting = false;
const startHidden = process.argv.includes('--hidden'); // started with Windows: stay in the tray
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try { return { startAtLogin: true, trayHintShown: false, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; }
  catch { return { startAtLogin: true, trayHintShown: false }; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try { fs.writeFileSync(settingsFile(), JSON.stringify(next)); } catch { /* */ }
  return next;
}
function applyLoginItem(on) {
  if (!app.isPackaged) return; // only the installed app registers itself
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveState() {
  if (!win) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* */ }
}

function show() {
  if (!win) { createWindow(); win.once('ready-to-show', () => win.show()); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const st = readState();
  win = new BrowserWindow({
    width: st.width || 1180,
    height: st.height || 780,
    x: st.x,
    y: st.y,
    minWidth: 380,
    minHeight: 520,
    title: 'Instinct',
    backgroundColor: '#f3f1ed',
    icon: path.join(__dirname, 'app', 'assets', 'img', 'icon-512.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false, // keep checking for messages while hidden in the tray
    },
  });
  if (st.maximized) win.maximize();
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Links open in the default browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  // Right-click: copy, paste and spelling suggestions
  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    for (const s of p.dictionarySuggestions || []) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
    if (p.misspelledWord) {
      items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
      items.push({ type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    if (p.linkURL) items.push({ label: 'Copy link', click: () => require('electron').clipboard.writeText(p.linkURL) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('focus', () => win.flashFrame(false));
  // The close button hides to the tray instead of quitting
  win.on('close', (e) => {
    saveState();
    if (quitting) return;
    e.preventDefault();
    win.hide();
    const st = readSettings();
    if (!st.trayHintShown && Notification.isSupported()) {
      writeSettings({ trayHintShown: true });
      const n = new Notification({ title: 'Instinct is still running', body: 'You’ll keep getting notifications. To quit, right-click the Instinct icon in the taskbar tray.', silent: true });
      n.on('click', show);
      n.show();
    }
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'app', 'assets', 'img', 'icon-192.png')).resize({ width: 32, height: 32, quality: 'best' });
  tray = new Tray(img);
  tray.setToolTip('Instinct');
  tray.on('click', show);
  tray.on('double-click', show);
  updateTrayMenu();
}
function updateTrayMenu() {
  if (!tray) return;
  const st = readSettings();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Instinct', click: show },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox', checked: !!st.startAtLogin, enabled: app.isPackaged,
      click: (item) => { writeSettings({ startAtLogin: item.checked }); applyLoginItem(item.checked); },
    },
    { type: 'separator' },
    { label: 'Quit Instinct', click: () => { quitting = true; app.quit(); } },
  ]));
}

let badgeIcon = null;
ipcMain.on('mido:flash', () => { if (win && !win.isFocused()) win.flashFrame(true); });
ipcMain.on('mido:show', show);
ipcMain.on('mido:badge', (_e, n) => {
  if (!win) return;
  n = Number(n) || 0;
  if (process.platform === 'win32') {
    if (!badgeIcon) badgeIcon = nativeImage.createFromPath(path.join(__dirname, 'build', 'badge.png'));
    win.setOverlayIcon(n ? badgeIcon : null, n ? n + ' unread' : '');
    if (tray) tray.setToolTip(n ? 'Instinct · ' + n + ' unread' : 'Instinct');
  } else {
    app.setBadgeCount(n);
  }
});

app.on('second-instance', show);
// Only what the chat needs: the microphone for voice notes, notifications and copy.
const ALLOWED = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen']);
function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    if (permission === 'media') return done(!(details.mediaTypes || []).includes('video')); // microphone only
    done(ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((wc, permission) => ALLOWED.has(permission));
  // Saving an attachment opens the normal Windows "Save as" dialog in Downloads
  ses.on('will-download', (e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
}

app.whenReady().then(() => {
  setupSession();
  createWindow();
  createTray();
  applyLoginItem(readSettings().startAtLogin); // on by default; turn off from the tray menu
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting) app.quit(); }); // otherwise keep running in the tray
app.on('activate', () => { if (!win) createWindow(); });
