// Instinct for Windows. Loads the bundled chat UI; the built-in app key means no passkey.
const { app, BrowserWindow, shell, ipcMain, Menu, nativeImage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.setAppUserModelId('com.mido.instinct'); // Windows needs this for notifications
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveState() {
  if (!win) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* */ }
}

function show() {
  if (!win) return;
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
    },
  });
  if (st.maximized) win.maximize();
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.once('ready-to-show', () => win.show());

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
  win.on('close', saveState);
  win.on('closed', () => { win = null; });
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

app.whenReady().then(() => { setupSession(); createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!win) createWindow(); });
