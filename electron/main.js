// electron/main.js
// Electron メインプロセス。ウィンドウ生成・IPC 配線・アプリのライフサイクルのみを担当し、
// 監視ロジックは monitor-service / monitor-core に委譲する。

import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { config as baseConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createElectronAlerter } from "./alerter.js";
import { findChromeExecutable } from "./chrome-launcher.js";
import { createMonitorService } from "./monitor-service.js";
import { loadSettings, saveSettings } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Windows のトースト通知に必要（electron-builder の appId と一致させる）。
app.setAppUserModelId("com.kdragon1988.tesla-charger-getter");
// アラート音（WebAudio）をユーザー操作なしで再生できるようにする。
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

let mainWindow = null;
let service = null;
let quitting = false;

// レンダラへの IPC 送信。ウィンドウが閉じられていれば何もしない（安全な no-op）。
const sendToRenderer = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

// ベースロガーの各メソッドをラップし、整形済みログ行をレンダラのログビューへも流す。
function createTeeLogger(base) {
  const tee = (fn) => (message, meta) => {
    const line = fn(message, meta);
    sendToRenderer("monitor:log", line);
    return line;
  };
  return Object.freeze({
    info: tee(base.info),
    warn: tee(base.warn),
    error: tee(base.error),
    event: tee(base.event),
  });
}

// アプリ専用の保存先パス（設定・ログ・監視用 Chrome プロファイル）。
function appPaths() {
  const userData = app.getPath("userData");
  return Object.freeze({
    settingsFile: path.join(userData, "settings.json"),
    logFile: path.join(userData, "logs", "monitor.log"),
    chromeProfile: path.join(userData, "chrome-profile"),
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 720,
    minHeight: 540,
    title: "Tesla充電器Getter",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// IPC は {ok, data?, error?} のエンベロープで統一する。
function registerIpcHandlers(paths) {
  const toError = (err) => (err instanceof Error ? err.message : String(err));

  ipcMain.handle("settings:get", () => {
    try {
      return { ok: true, data: loadSettings(paths.settingsFile, baseConfig) };
    } catch (err) {
      return { ok: false, error: toError(err) };
    }
  });

  ipcMain.handle("settings:save", (_event, patch) => {
    try {
      const saved = saveSettings(paths.settingsFile, baseConfig, patch ?? {});
      return { ok: true, data: saved };
    } catch (err) {
      return { ok: false, error: toError(err) };
    }
  });

  ipcMain.handle("monitor:start", () => service.start());
  ipcMain.handle("monitor:stop", () => service.stop());
  ipcMain.handle("alert:test", () => service.testAlert());

  ipcMain.handle("monitor:status", () => ({
    ok: true,
    data: {
      status: service.status(),
      chromeFound: findChromeExecutable() !== null,
    },
  }));
}

// 多重起動を防ぐ（2つ目の起動は既存ウィンドウを前面化して終了）。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    const paths = appPaths();
    const logger = createTeeLogger(createLogger(paths.logFile));
    const alerter = createElectronAlerter({
      getWindow: () => mainWindow,
      send: sendToRenderer,
    });
    service = createMonitorService({
      baseConfig,
      paths,
      logger,
      alerter,
      send: sendToRenderer,
    });
    registerIpcHandlers(paths);
    createWindow();

    app.on("activate", () => {
      // macOS: Dock クリックでウィンドウを再生成する。
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // ウィンドウを閉じたら監視ごと終了する（挙動を予測可能に保つ）。
  app.on("window-all-closed", () => {
    app.quit();
  });

  // 終了前に監視を確実に停止する（CDP 切断・監視タブのクローズまで待つ）。
  // 停止処理がハングしてもアプリが終了できなくならないよう、タイムアウトで打ち切る。
  const QUIT_STOP_TIMEOUT_MS = 10_000;
  app.on("before-quit", (event) => {
    if (quitting) return;
    if (service?.isRunning()) {
      event.preventDefault();
      quitting = true;
      const timeout = new Promise((resolve) =>
        setTimeout(resolve, QUIT_STOP_TIMEOUT_MS)
      );
      void Promise.race([service.stop(), timeout]).finally(() => app.quit());
    }
  });
}
