// electron/preload.cjs
// レンダラに公開する安全な API ブリッジ（contextIsolation 前提）。
// Node / Electron の API はレンダラへ直接露出させず、必要な操作のみを window.teslaApp に束ねる。

const { contextBridge, ipcRenderer } = require("electron");

// イベント購読の共通ヘルパー。リスナーの多重登録（リーク）を防ぐため、
// 購読解除関数を返す（呼び出し側が不要になったら呼ぶ）。
const subscribe = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("teslaApp", {
  // 設定
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),

  // 監視の開始/停止/状態
  startMonitor: () => ipcRenderer.invoke("monitor:start"),
  stopMonitor: () => ipcRenderer.invoke("monitor:stop"),
  getStatus: () => ipcRenderer.invoke("monitor:status"),

  // アラートテスト
  testAlert: () => ipcRenderer.invoke("alert:test"),

  // メインプロセスからのイベント購読（戻り値は購読解除関数）
  onEvent: subscribe("monitor:event"),
  onLog: subscribe("monitor:log"),
  onRing: subscribe("alert:ring"),
});
