// electron/monitor-service.js
// GUI からの開始/停止要求と monitor-core を仲立ちするサービス層。
//   - 監視開始時に監視用 Chrome（専用プロファイル + デバッグポート）を自動起動
//   - monitor-core のイベントをレンダラへ転送し、現在ステータスを保持
//   - IPC ハンドラが扱いやすい {ok, error} エンベロープで結果を返す

import { createMonitor } from "../src/monitor-core.js";
import { ensureMonitorChrome } from "./chrome-launcher.js";
import { loadSettings, buildRuntimeConfig } from "./settings.js";

// アラートテスト時の鳴動回数・間隔（drill-alert.mjs と同じ短縮値）。
const TEST_ALERT_REPEAT = 2;
const TEST_ALERT_INTERVAL_MS = 2000;

/**
 * 監視サービスを生成する。
 * @param {object} params
 * @param {object} params.baseConfig src/config.js の config
 * @param {{settingsFile:string, logFile:string, chromeProfile:string}} params.paths
 * @param {object} params.logger
 * @param {{alertInStock:Function, notifyError:Function}} params.alerter
 * @param {(channel:string, payload:object)=>void} params.send レンダラへの IPC 送信
 */
export function createMonitorService({ baseConfig, paths, logger, alerter, send }) {
  let monitor = null;
  let status = "idle";
  let starting = false;

  const setStatus = (next, extra = {}) => {
    status = next;
    send("monitor:event", Object.freeze({ type: "status", status: next, ...extra }));
  };

  // monitor-core からのイベント: ローカルのステータスを更新しつつレンダラへ転送する。
  const onEvent = (event) => {
    if (event.type === "status") {
      // core の "stopped" はサービス視点では待機状態に戻る。
      status = event.status === "stopped" ? "idle" : event.status;
    } else if (event.type === "instock") {
      status = "instock";
    } else if (event.type === "heartbeat") {
      status = event.summary?.state === "in_stock" ? "instock" : "monitoring";
    }
    send("monitor:event", event);
  };

  /**
   * 監視を開始する。Chrome 起動 → CDP 接続 → 監視ループ（バックグラウンド実行）。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function start() {
    if (starting) {
      return { ok: false, error: "起動処理の実行中です" };
    }
    if (monitor?.isRunning()) {
      return { ok: false, error: "既に監視中です" };
    }
    starting = true;
    try {
      const settings = loadSettings(paths.settingsFile, baseConfig);
      const runtimeConfig = buildRuntimeConfig(baseConfig, settings, paths);

      setStatus("launching-chrome");
      const chrome = await ensureMonitorChrome({
        port: settings.debugPort,
        profileDir: paths.chromeProfile,
        logger,
      });
      if (!chrome.ok) {
        logger.error("監視用ブラウザの準備に失敗しました", { error: chrome.error });
        setStatus("error", { message: chrome.error });
        return { ok: false, error: chrome.error };
      }

      monitor = createMonitor({
        config: runtimeConfig,
        logger,
        attach: true,
        alerter,
        onEvent,
      });

      // 監視ループはバックグラウンドで回す（start() の解決はループ終了時のため await しない）。
      void monitor
        .start()
        .then(() => {
          setStatus("idle");
        })
        .catch((err) => {
          const m = err instanceof Error ? err.message : String(err);
          setStatus("error", { message: m });
        });

      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error("監視の開始に失敗しました", { error: m });
      setStatus("error", { message: m });
      return { ok: false, error: m };
    } finally {
      starting = false;
    }
  }

  /**
   * 監視を停止する。ループの完全終了（CDP 切断まで）を待つ。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function stop() {
    try {
      if (monitor?.isRunning()) {
        await monitor.stop("gui-stop");
      }
      setStatus("idle");
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error("監視の停止に失敗しました", { error: m });
      return { ok: false, error: m };
    }
  }

  /**
   * アラートの鳴動テスト（通知・音・音声・商品ページオープン）。短縮版で実行する。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async function testAlert() {
    try {
      const settings = loadSettings(paths.settingsFile, baseConfig);
      const runtimeConfig = buildRuntimeConfig(baseConfig, settings, paths);
      const drillConfig = {
        ...runtimeConfig,
        alert: {
          ...runtimeConfig.alert,
          repeat: TEST_ALERT_REPEAT,
          intervalMs: TEST_ALERT_INTERVAL_MS,
        },
      };
      await alerter.alertInStock({ page: null, config: drillConfig, logger });
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.error("アラートテストに失敗しました", { error: m });
      return { ok: false, error: m };
    }
  }

  return Object.freeze({
    start,
    stop,
    testAlert,
    status: () => status,
    isRunning: () => monitor?.isRunning() ?? false,
  });
}
