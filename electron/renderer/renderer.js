// electron/renderer/renderer.js
// 画面側ロジック。preload が公開する window.teslaApp 経由でのみメインプロセスと通信する。
// アラーム音は WebAudio、日本語音声は speechSynthesis で鳴らす（外部コマンド不要）。

/* global teslaApp */

const statusBadge = document.getElementById("status-badge");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnTest = document.getElementById("btn-test");
const btnSave = document.getElementById("btn-save");
const inputUrl = document.getElementById("input-url");
const inputSku = document.getElementById("input-sku");
const inputMin = document.getElementById("input-min");
const inputMax = document.getElementById("input-max");
const settingsMessage = document.getElementById("settings-message");
const logView = document.getElementById("log-view");
const lastCheck = document.getElementById("last-check");
const chromeHint = document.getElementById("chrome-hint");

const MAX_LOG_LINES = 300;

// ステータス → バッジ表示（ラベルと色クラス）の対応表。
const STATUS_VIEW = Object.freeze({
  idle: { label: "待機中", className: "idle" },
  "launching-chrome": { label: "Chrome 起動中…", className: "busy" },
  starting: { label: "接続中…", className: "busy" },
  monitoring: { label: "監視中", className: "monitoring" },
  instock: { label: "🎉 在庫あり！", className: "instock" },
  error: { label: "エラー", className: "error" },
  stopped: { label: "停止", className: "idle" },
});

// 監視が動作している（＝開始ボタンを無効化すべき）ステータス。
const ACTIVE_STATUSES = Object.freeze([
  "launching-chrome",
  "starting",
  "monitoring",
  "instock",
]);

function applyStatus(status, message) {
  const view = STATUS_VIEW[status] ?? STATUS_VIEW.idle;
  statusBadge.textContent = view.label;
  statusBadge.className = `badge ${view.className}`;
  const active = ACTIVE_STATUSES.includes(status);
  btnStart.disabled = active;
  btnStop.disabled = !active;
  if (status === "error" && message) {
    appendLog(`[画面] エラー: ${message}`);
  }
}

// ログは循環バッファで保持し、表示時にまとめて文字列化する
// （毎回 textContent を split/join し直すより GC 負荷が小さい）。
const logLines = [];

function appendLog(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) {
    logLines.splice(0, logLines.length - MAX_LOG_LINES);
  }
  logView.textContent = logLines.join("\n");
  logView.scrollTop = logView.scrollHeight;
}

function showSettingsMessage(text, isError) {
  settingsMessage.textContent = text;
  settingsMessage.className = isError ? "hint warn" : "hint ok";
}

// ---- アラート鳴動（WebAudio ビープ + 日本語読み上げ） ----

let audioContext = null;

function playBeeps() {
  try {
    audioContext = audioContext ?? new AudioContext();
    const now = audioContext.currentTime;
    [0, 0.35, 0.7].forEach((offset, i) => {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = "square";
      osc.frequency.value = i % 2 === 0 ? 880 : 1175;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.3);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.32);
    });
  } catch {
    // 音が鳴らせない環境でも通知・音声は別経路で届くため無視。
  }
}

function speak(message) {
  if (!message || !("speechSynthesis" in window)) return;
  try {
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = "ja-JP";
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch {
    // 読み上げ失敗は無視（ビープと通知で代替される）。
  }
}

// ---- 設定の読み書き ----

async function loadSettingsIntoForm() {
  const res = await teslaApp.getSettings();
  if (!res.ok) {
    showSettingsMessage(`設定の読み込みに失敗しました: ${res.error}`, true);
    return;
  }
  inputUrl.value = res.data.productUrl;
  inputSku.value = res.data.skuCode;
  inputMin.value = res.data.minSec;
  inputMax.value = res.data.maxSec;
}

async function saveSettingsFromForm() {
  const patch = {
    productUrl: inputUrl.value.trim(),
    skuCode: inputSku.value.trim(),
    minSec: Number(inputMin.value),
    maxSec: Number(inputMax.value),
  };
  const res = await teslaApp.saveSettings(patch);
  if (!res.ok) {
    showSettingsMessage(res.error, true);
    return;
  }
  showSettingsMessage("保存しました（次回の監視開始から反映されます）", false);
}

// ---- 監視の開始/停止 ----

async function refreshStatus() {
  const res = await teslaApp.getStatus();
  if (!res.ok) return;
  applyStatus(res.data.status);
  chromeHint.classList.toggle("hidden", res.data.chromeFound);
}

async function startMonitor() {
  btnStart.disabled = true;
  const res = await teslaApp.startMonitor();
  if (!res.ok) {
    appendLog(`[画面] 監視を開始できませんでした: ${res.error}`);
    await refreshStatus();
  }
}

async function stopMonitor() {
  btnStop.disabled = true;
  const res = await teslaApp.stopMonitor();
  if (!res.ok) {
    appendLog(`[画面] 停止に失敗しました: ${res.error}`);
  }
  await refreshStatus();
}

async function testAlert() {
  btnTest.disabled = true;
  appendLog("[画面] アラートテストを実行します（通知・音・音声・ページオープン）");
  try {
    await teslaApp.testAlert();
  } finally {
    btnTest.disabled = false;
  }
}

// ---- イベント購読 ----

teslaApp.onEvent((event) => {
  if (event.type === "status") {
    applyStatus(event.status, event.message);
    return;
  }
  if (event.type === "instock") {
    applyStatus("instock");
    return;
  }
  if (event.type === "heartbeat") {
    const state = event.summary?.state;
    applyStatus(state === "in_stock" ? "instock" : "monitoring");
    lastCheck.textContent = `最終チェック: ${new Date().toLocaleTimeString("ja-JP")}`;
  }
});

teslaApp.onLog((line) => appendLog(line));

teslaApp.onRing(({ voiceMessage }) => {
  playBeeps();
  speak(voiceMessage);
});

btnStart.addEventListener("click", () => void startMonitor());
btnStop.addEventListener("click", () => void stopMonitor());
btnTest.addEventListener("click", () => void testAlert());
btnSave.addEventListener("click", () => void saveSettingsFromForm());

// 初期化
void loadSettingsIntoForm();
void refreshStatus();
