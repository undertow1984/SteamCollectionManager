import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ELECTRON_PORT = 3001;

function getUserDataDir() {
  return app.isPackaged ? app.getPath('userData') : __dirname;
}

function loadConfig() {
  try {
    const dataDir = getUserDataDir();
    const configFile = path.join(dataDir, 'config', 'config.json');
    if (fs.existsSync(configFile)) {
      const raw = fs.readFileSync(configFile, 'utf8');
      return JSON.parse(raw || '{}');
    }
  } catch (e) {
    console.warn('Failed to read config.json:', e.message);
  }
  return {};
}

let tray = null;
let isQuitting = false;

function createTray() {
  if (tray) return;
  const iconPath = app.isPackaged 
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, 'icon.png');
  
  try {
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
      { 
        label: 'Open SteamCollectionManager', 
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        } 
      },
      { type: 'separator' },
      { 
        label: 'Exit', 
        click: () => {
          isQuitting = true;
          app.quit();
        } 
      }
    ]);
    
    tray.setToolTip('SteamCollectionManager');
    tray.setContextMenu(contextMenu);
    
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (e) {
    console.error('Failed to create Tray:', e.message);
  }
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function applyTraySettings() {
  const config = loadConfig();
  const startWithWindows = config.startWithWindows === true;
  const startMinimizedToTray = config.startMinimizedToTray === true;
  
  try {
    app.setLoginItemSettings({
      openAtLogin: startWithWindows,
      path: app.getPath('exe'),
      args: startMinimizedToTray ? ['--minimized'] : []
    });
  } catch (e) {
    console.error('Failed to set login item settings:', e.message);
  }

  const minimizeToTray = config.minimizeToTrayOnClose !== false;
  if (minimizeToTray || startMinimizedToTray) {
    createTray();
  } else {
    destroyTray();
  }
}

ipcMain.on('update-tray-settings', () => {
  applyTraySettings();
});

function getConfiguredElectronPort() {
  try {
    const dataDir = getUserDataDir();
    const configFile = path.join(dataDir, 'config', 'config.json');
    if (fs.existsSync(configFile)) {
      const raw = fs.readFileSync(configFile, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      const p = parseInt(cfg.electronPort, 10);
      if (!isNaN(p) && p > 0) return p;
    }
  } catch (e) {
    console.warn('Failed to read configured electron port, using default:', e.message);
  }
  return DEFAULT_ELECTRON_PORT;
}

let mainWindow;

function showOnScreenKeyboard() {
  if (process.platform !== 'win32') return;

  // Always try to ensure only one instance (hide first)
  hideOnScreenKeyboard();

  // Use full path because direct 'osk.exe' often fails (ENOENT) from packaged Electron
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const oskPath = path.join(systemRoot, 'System32', 'osk.exe');

  // exec + start is more reliable than spawn for launching osk in Electron on Windows
  const command = `start "" "${oskPath}"`;
  exec(command, { windowsHide: true }, (error) => {
    if (error) {
      // Fallback: try simple osk command
      console.warn('Primary OSK launch failed, trying fallback:', error.message);
      exec('start osk', { windowsHide: true }, (err2) => {
        if (err2) {
          console.warn('Failed to launch on-screen keyboard (all methods):', err2.message);
        }
      });
    }
  });
}

function hideOnScreenKeyboard() {
  if (process.platform === 'win32') {
    exec('taskkill /IM osk.exe /F 2>nul', () => {});
  }
}

ipcMain.on('show-keyboard', showOnScreenKeyboard);
ipcMain.on('hide-keyboard', hideOnScreenKeyboard);

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.on('restore-window', () => {
  if (!mainWindow) return;

  try {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);

    // Extra nudge for some Windows + Electron combinations
    if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop();
    mainWindow.webContents?.focus();
  } catch (e) {
    console.warn('Failed to restore window after game close:', e.message);
  }
});

ipcMain.on('toggle-fullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }
});

function createWindow(electronPort = 3001, serverStartError = null, startMinimized = false) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !startMinimized,
    icon: app.isPackaged 
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: app.isPackaged 
        ? path.join(process.resourcesPath, 'app.asar', 'preload.js')
        : path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.on('close', (e) => {
    const config = loadConfig();
    const minimizeToTray = config.minimizeToTrayOnClose !== false;
    if (!isQuitting && minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Hide menu bar when entering fullscreen in Electron
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents?.send('fullscreen-changed', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents?.send('fullscreen-changed', false);
  });

  // Spoof Chrome UA + rewrite headers for Steam video CDNs *early*.
  // This is required so that HLS/DASH adaptive trailers (hls_h264 etc) do not reject with
  // "must be ran from steam" when running inside Electron.
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  mainWindow.webContents.setUserAgent(chromeUA);

  try {
    const filter = { urls: [
      'https://*.steamstatic.com/*',
      'https://*.akamai.steamstatic.com/*',
      'https://*.fastly.steamstatic.com/*',
      'https://steamcdn-a.akamaihd.net/*'
    ]};
    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['Referer'] = 'https://store.steampowered.com/';
      details.requestHeaders['Origin'] = 'https://store.steampowered.com';
      details.requestHeaders['User-Agent'] = chromeUA;
      callback({ requestHeaders: details.requestHeaders });
    });
  } catch (e) {
    console.warn('webRequest header override setup failed:', e.message);
  }

  // Show a loading screen immediately to avoid white screen while waiting for backend
  const loadingHtml = `
    <html>
      <head>
        <style>
          body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center; background:#0f0f0f; color:#aaa; font-family: system-ui, sans-serif; }
          .msg { text-align:center; }
          .spinner { width:24px; height:24px; border:3px solid #333; border-top-color:#4a9eff; border-radius:50%; animation:spin 0.8s linear infinite; margin:0 auto 12px; }
          @keyframes spin { to { transform:rotate(360deg); } }
          .port { font-size: 11px; color: #666; margin-top: 8px; }
        </style>
      </head>
      <body>
        <div class="msg">
          <div class="spinner"></div>
          <div>Starting SteamCollectionManager...</div>
          <div class="port">localhost:${electronPort}</div>
        </div>
      </body>
    </html>
  `;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingHtml)}`);

  // Handle load failures gracefully (prevents silent white screen)
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[main] Load attempt failed for ${validatedURL || 'page'}: ${errorDescription} (code ${errorCode})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      let detail = errorDescription || '';
      if (serverStartError) {
        detail = `Server start error: ${serverStartError.message || serverStartError}`;
      }
      const errHtml = `<html><body style="background:#111;color:#f66;padding:20px;font-family:sans-serif">Failed to load the app UI.<br>Backend server may not have started.<br><small>${detail}</small></body></html>`;
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errHtml)}`);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    hideOnScreenKeyboard();
  });

  // Hide OSK if user somehow closes the window while an input is focused
  mainWindow.on('blur', () => {
    hideOnScreenKeyboard();
  });

  // Optional: hide keyboard when the window is minimized or hidden
  mainWindow.on('minimize', () => {
    hideOnScreenKeyboard();
  });
}

app.whenReady().then(async () => {
  // Determine writable data directory (userData in packaged installs to avoid permission issues in Program Files)
  const dataDir = getUserDataDir();
  process.env.STEAMCOLLECTIONMANAGER_DATA_DIR = dataDir;

  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const cacheDir = path.join(dataDir, 'cache');
    const logDir = path.join(dataDir, 'log');
    const configDir = path.join(dataDir, 'config');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  } catch (e) {
    console.warn('Failed to ensure data/cache/log/config directories:', e.message);
  }

  // Sync main application config and cache files to Electron's dataDir without wiping target data
  try {
    const mainAppDir = __dirname;
    if (mainAppDir !== dataDir) {
      const srcConfigDir = path.join(mainAppDir, 'config');
      const destConfigDir = path.join(dataDir, 'config');
      const srcCacheDir = path.join(mainAppDir, 'cache');
      const destCacheDir = path.join(dataDir, 'cache');

      // 1. Sync Config files
      if (fs.existsSync(srcConfigDir)) {
        // categories.json
        const catSrc = path.join(srcConfigDir, 'categories.json');
        const catDest = path.join(destConfigDir, 'categories.json');
        if (fs.existsSync(catSrc)) {
          if (!fs.existsSync(catDest)) {
            fs.copyFileSync(catSrc, catDest);
          } else {
            const srcStat = fs.statSync(catSrc);
            const destStat = fs.statSync(catDest);
            if (srcStat.mtimeMs > destStat.mtimeMs) {
              fs.copyFileSync(catSrc, catDest);
            }
          }
        }

        // config.json (merge to avoid wiping electron settings)
        const cfgSrc = path.join(srcConfigDir, 'config.json');
        const cfgDest = path.join(destConfigDir, 'config.json');
        if (fs.existsSync(cfgSrc)) {
          let srcConfig = {};
          let destConfig = {};
          try {
            srcConfig = JSON.parse(fs.readFileSync(cfgSrc, 'utf8') || '{}');
          } catch (e) {}
          try {
            if (fs.existsSync(cfgDest)) {
              destConfig = JSON.parse(fs.readFileSync(cfgDest, 'utf8') || '{}');
            }
          } catch (e) {}

          const electronKeys = ['electronPort', 'minimizeToTrayOnClose', 'startWithWindows', 'startMinimizedToTray'];
          const mergedConfig = { ...srcConfig };
          electronKeys.forEach(key => {
            if (destConfig[key] !== undefined) {
              mergedConfig[key] = destConfig[key];
            }
          });

          fs.writeFileSync(cfgDest, JSON.stringify(mergedConfig, null, 2), 'utf8');
        }
      }

      // 2. Sync Cache files
      if (fs.existsSync(srcCacheDir)) {
        const files = fs.readdirSync(srcCacheDir);
        for (const file of files) {
          const fileSrc = path.join(srcCacheDir, file);
          const fileDest = path.join(destCacheDir, file);
          if (fs.statSync(fileSrc).isFile()) {
            if (!fs.existsSync(fileDest)) {
              fs.copyFileSync(fileSrc, fileDest);
            } else {
              const srcStat = fs.statSync(fileSrc);
              const destStat = fs.statSync(fileDest);
              if (srcStat.mtimeMs > destStat.mtimeMs) {
                fs.copyFileSync(fileSrc, fileDest);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('Failed to sync main app config/cache to Electron:', err.message);
  }

  // Completely disable default Electron application menu bar globally
  Menu.setApplicationMenu(null);

  // Apply tray and auto-start settings initially
  applyTraySettings();

  // Start the backend server **in-process** (no separate 'node' process).
  // This fixes "spawn node ENOENT" in packaged builds (users don't have node in PATH).
  // In dev it also works without relying on global 'node' binary.
  const serverFile = app.isPackaged 
    ? path.join(process.resourcesPath, 'server.mjs')
    : path.join(__dirname, 'server.mjs');

  let serverStartError = null;
  try {
    await import(pathToFileURL(serverFile).href);
    console.log('Backend server started successfully');
  } catch (err) {
    serverStartError = err;
    console.error('Failed to start backend server:', err);
  }

  const electronPort = getConfiguredElectronPort();
  const config = loadConfig();
  const startMinimized = process.argv.includes('--minimized') || (config.startMinimizedToTray && process.argv.includes('--minimized'));
  createWindow(electronPort, serverStartError, startMinimized);

  // If we already know the server failed to import, show detailed error immediately.
  if (serverStartError) {
    const detail = serverStartError.stack || serverStartError.message || String(serverStartError);
    const errHtml = `Backend server failed to start in packaged app.<br><br>${detail}<br><br>Run the .exe from cmd.exe or PowerShell to see console output.`;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`data:text/html;charset=utf-8,<h1 style="color:#f66;font-family:sans-serif;padding:20px;">${errHtml}</h1>`);
    }
    return; // don't do retries
  }

  // Load the real UI. Use retry on connection failures so we don't get stuck on the
  // "Starting..." screen if the server takes a few seconds to bind in packaged builds.
  let loadAttempts = 0;
  const maxLoadAttempts = 50; // ~25s of retries
  function attemptLoad() {
    loadAttempts++;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`http://localhost:${electronPort}`);
    }
  }
  attemptLoad();

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[main] Load attempt ${loadAttempts} failed for localhost:${electronPort}: ${errorDescription} (code ${errorCode})`);
    const isConnectionError = errorCode === -102 || errorCode === -105 || errorCode === -106 || errorCode === -7;
    if (isConnectionError && loadAttempts < maxLoadAttempts) {
      setTimeout(attemptLoad, 500);
    } else if (loadAttempts >= maxLoadAttempts) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        let msg = 'Backend server failed to start after multiple attempts.<br>Restart the app or run from command line to see logs.';
        if (serverStartError) {
          msg = `Backend server failed to start: ${serverStartError.message || serverStartError}<br><br>Run the built exe from a terminal (cmd/powershell) to see the full error.`;
        }
        mainWindow.loadURL(`data:text/html;charset=utf-8,<h1 style="color:#f66;font-family:sans-serif;padding:20px;">${msg}</h1>`);
      }
    }
  });
});

app.on('window-all-closed', () => {
  hideOnScreenKeyboard();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});