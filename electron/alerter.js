// electron/alerter.js
// Electron 版アラート実装。monitor-core の alerter インターフェース
// （alertInStock / notifyError）を満たし、macOS 専用 notifier.js の代わりに
// クロスプラットフォームな手段で「派手なアラート」を実現する:
//   - デスクトップ通知: Electron Notification（Mac / Windows 共通）
//   - アラーム音      : レンダラの WebAudio（alert:ring IPC 経由）
//   - 日本語音声      : レンダラの speechSynthesis（同上）
//   - 商品ページを開く: shell.openExternal（既定ブラウザ）

import { app, Notification, shell } from "electron";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// alert 設定を安全なデフォルトで正規化する（イミュータブル: 新しいオブジェクトを返す）。
const normalizeAlert = (alert) => {
  const repeatRaw = Number(alert?.repeat);
  const intervalRaw = Number(alert?.intervalMs);
  return Object.freeze({
    repeat: Number.isFinite(repeatRaw) && repeatRaw > 0 ? Math.floor(repeatRaw) : 1,
    intervalMs:
      Number.isFinite(intervalRaw) && intervalRaw >= 0 ? Math.floor(intervalRaw) : 3000,
    voiceMessage: alert?.voiceMessage ?? null,
  });
};

/**
 * Electron 用 alerter を生成する。
 * @param {object} params
 * @param {() => import("electron").BrowserWindow | null} params.getWindow
 *   メインウィンドウを返す関数（閉じられている場合は null）
 * @param {(channel: string, payload: object) => void} params.send
 *   レンダラへ IPC 送信する関数（ウィンドウ破棄時は no-op であること）
 * @returns {{alertInStock: Function, notifyError: Function}}
 */
export function createElectronAlerter({ getWindow, send }) {
  if (typeof getWindow !== "function" || typeof send !== "function") {
    throw new TypeError("createElectronAlerter: getWindow / send が必要です");
  }

  // 通知バナー1回 + レンダラへの鳴動指示（音・音声）。失敗しても throw しない。
  const ringOnce = ({ title, body, url, voiceMessage }, logger) => {
    try {
      if (Notification.isSupported()) {
        // 音はレンダラの WebAudio で鳴らすため、OS 通知音は消して二重再生を防ぐ。
        const notification = new Notification({ title, body, silent: true });
        if (url) {
          notification.on("click", () => {
            void shell.openExternal(url);
          });
        }
        notification.show();
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger?.warn?.("デスクトップ通知の表示に失敗しました（継続）", { error: m });
    }
    send("alert:ring", { voiceMessage: voiceMessage ?? null });
  };

  // ウィンドウを前面に出して注意を引く（失敗は無視）。
  const raiseWindow = () => {
    try {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        win.flashFrame?.(true); // Windows: タスクバー点滅
      }
      app.dock?.bounce?.("critical"); // macOS: Dock アイコンをバウンス
    } catch {
      // 前面化の失敗は致命的でないため無視。
    }
  };

  /**
   * 在庫復活アラート。notifier.js（macOS CLI 版）と同じ流れ:
   * 監視タブ前面化 → 商品ページを既定ブラウザで開く → 通知+音+音声を repeat 回ループ。
   * @param {{ page: object|null, config: object, logger: object }} params
   */
  async function alertInStock({ page, config, logger }) {
    if (!config || typeof config !== "object") {
      throw new TypeError("alertInStock: config が必要です");
    }
    if (!logger || typeof logger.event !== "function") {
      throw new TypeError("alertInStock: 有効な logger が必要です");
    }

    const alert = normalizeAlert(config.alert);
    const productUrl = config.productUrl ?? null;
    const title = "🚗 Tesla 在庫復活！";
    const body =
      "在庫が復活しました！今すぐ購入できます。ブラウザを確認してください。";

    logger.event("在庫復活アラートを開始します", {
      repeat: alert.repeat,
      intervalMs: alert.intervalMs,
      productUrl,
    });

    raiseWindow();

    // 監視タブ（CDP 接続中の Chrome）も前面へ。失敗しても継続する。
    try {
      if (page && typeof page.bringToFront === "function") {
        await page.bringToFront();
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.warn("監視タブの最前面化に失敗しました（処理は継続します）", {
        error: m,
      });
    }

    // 既定ブラウザで商品ページを開く（ログイン済みなら即購入できる）。
    if (productUrl) {
      try {
        await shell.openExternal(productUrl);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.warn("商品ページのオープンに失敗しました（処理は継続します）", {
          error: m,
        });
      }
    }

    for (let i = 0; i < alert.repeat; i += 1) {
      const round = i + 1;
      logger.info(`アラート鳴動 ${round}/${alert.repeat}`);
      ringOnce({ title, body, url: productUrl, voiceMessage: alert.voiceMessage }, logger);
      if (round < alert.repeat && alert.intervalMs > 0) {
        await sleep(alert.intervalMs);
      }
    }

    logger.event("在庫復活アラートを完了しました", { rounds: alert.repeat });
  }

  /**
   * 致命的エラー時の通知。通知バナー + 鳴動1回。throw しない。
   * @param {string} message ユーザー向けの日本語メッセージ
   * @param {object} _config 設定オブジェクト（notifier.js とのインターフェース互換のため受け取るが未使用）
   * @param {object} logger ロガー
   */
  async function notifyError(message, _config, logger) {
    const safeMessage = String(message ?? "不明なエラーが発生しました");
    if (logger && typeof logger.error === "function") {
      logger.error(`致命的エラー通知: ${safeMessage}`);
    }
    ringOnce(
      {
        title: "⚠️ Tesla 在庫監視エラー",
        body: safeMessage,
        url: null,
        voiceMessage: null,
      },
      logger
    );
  }

  return Object.freeze({ alertInStock, notifyError });
}
