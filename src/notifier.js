// src/notifier.js
// 在庫復活時のラウドなmacOSアラートと、致命的エラー時の通知を担当するモジュール。
// child_process.spawn で osascript / afplay / say / open を起動する。
// 各外部コマンドは失敗してもログに残すだけでスロー（throw）せず、監視ループを止めない。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// ===== 内部ヘルパー（純粋に近い小関数） =====================================

// 1ミリ秒単位でスリープするPromiseを返す（イミュータブル: 引数を変更しない）。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// osascript用に文字列をエスケープする。
// ダブルクォートとバックスラッシュをエスケープし、AppleScript文字列リテラルへの注入を防ぐ。
const escapeForOsa = (value) =>
  String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// 外部コマンドを spawn し、終了を待つ。
// 失敗（spawnエラー / 非ゼロ終了）してもreject/throwせず、logger.warn に記録するだけ。
// これにより osascript 等の失敗が監視全体をクラッシュさせない。
const runCommand = (command, args, logger) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      // detached:false / stdio無視。標準入出力は監視ログを汚さない。
      const child = spawn(command, args, { stdio: "ignore" });

      // spawn自体の失敗（コマンド未検出など）。
      child.on("error", (err) => {
        if (logger && typeof logger.warn === "function") {
          logger.warn(`外部コマンドの起動に失敗しました: ${command}`, {
            error: err?.message ?? String(err),
            args,
          });
        }
        finish();
      });

      // 終了コードを確認。非ゼロは警告として記録するが、処理は継続する。
      child.on("close", (code) => {
        if (code !== 0 && logger && typeof logger.warn === "function") {
          logger.warn(`外部コマンドが非ゼロ終了しました: ${command}`, {
            code,
            args,
          });
        }
        finish();
      });
    } catch (err) {
      // 同期的な例外もここで吸収する（never throw 契約の徹底）。
      if (logger && typeof logger.warn === "function") {
        logger.warn(`外部コマンド実行で例外が発生しました: ${command}`, {
          error: err?.message ?? String(err),
          args,
        });
      }
      finish();
    }
  });

// macOS通知センターへバナーを表示する（osascript経由）。
const showNotification = (title, message, subtitle, logger) => {
  const script =
    `display notification "${escapeForOsa(message)}" ` +
    `with title "${escapeForOsa(title)}" ` +
    `subtitle "${escapeForOsa(subtitle)}"`;
  return runCommand("osascript", ["-e", script], logger);
};

// 実在するサウンドファイルのパスを解決する（イミュータブル: 引数は変更しない）。
// 主サウンドが存在しなければフォールバックを使い、どちらも無ければ null。
const resolveSoundPath = (sound, soundFallback) => {
  if (sound && existsSync(String(sound))) return String(sound);
  if (soundFallback && existsSync(String(soundFallback))) return String(soundFallback);
  return null;
};

// システムサウンドを鳴らす（afplay経由）。soundが未指定/不在ならスキップ。
const playSound = (soundPath, logger) => {
  if (!soundPath) return Promise.resolve();
  return runCommand("afplay", [String(soundPath)], logger);
};

// 日本語の音声読み上げ（say経由）。voiceMessageが未指定ならスキップ。
const speak = (voiceMessage, logger) => {
  if (!voiceMessage) return Promise.resolve();
  // say はテキストを引数として安全に受け取る（シェル経由ではないため注入の心配なし）。
  return runCommand("say", [String(voiceMessage)], logger);
};

// 既定ブラウザで商品URLを開く（open経由）。1クリック購入へ素早く遷移するため。
const openInBrowser = (url, logger) => {
  if (!url) return Promise.resolve();
  return runCommand("open", [String(url)], logger);
};

// alert設定を安全なデフォルトで正規化する（イミュータブル: 新しいオブジェクトを返す）。
const normalizeAlert = (alert) => {
  const repeatRaw = Number(alert?.repeat);
  const intervalRaw = Number(alert?.intervalMs);
  // 実在するサウンドへ解決（主サウンド欠落時は soundFallback を使う）。
  const resolvedSound = resolveSoundPath(alert?.sound, alert?.soundFallback);
  return Object.freeze({
    repeat: Number.isFinite(repeatRaw) && repeatRaw > 0 ? Math.floor(repeatRaw) : 1,
    intervalMs:
      Number.isFinite(intervalRaw) && intervalRaw >= 0 ? Math.floor(intervalRaw) : 3000,
    sound: resolvedSound,
    voiceMessage: alert?.voiceMessage ?? null,
  });
};

// ===== 公開API =============================================================

/**
 * 在庫復活アラートを実行する。
 * 1) Playwrightページを最前面へ（page.bringToFront）。
 * 2) 既定ブラウザで商品URLを開く。
 * 3) ラウドなmacOSアラート（通知 + サウンド + 日本語読み上げ）を
 *    config.alert.repeat 回、config.alert.intervalMs 間隔でループ。
 * いずれの外部コマンド失敗も監視を止めない。
 *
 * @param {{ page: import("playwright").Page, config: object, logger: object }} params
 */
export async function alertInStock({ page, config, logger }) {
  // 引数バリデーション（システム境界での防御）。
  if (!config || typeof config !== "object") {
    throw new TypeError("alertInStock: config が必要です");
  }
  if (!logger || typeof logger.event !== "function") {
    throw new TypeError("alertInStock: 有効な logger が必要です");
  }

  const alert = normalizeAlert(config.alert);
  const productUrl = config.productUrl ?? null;

  const title = "🚗 Tesla 在庫復活！";
  const subtitle = "Gen 2 モバイルコネクター バンドル (JP)";
  const message = "在庫が復活しました！今すぐ購入できます。ブラウザを確認してください。";

  logger.event("在庫復活アラートを開始します", {
    repeat: alert.repeat,
    intervalMs: alert.intervalMs,
    productUrl,
  });

  // 1) Playwrightページを最前面へ。失敗しても継続する（ヘッドレス等でbringToFront不可な場合あり）。
  try {
    if (page && typeof page.bringToFront === "function") {
      await page.bringToFront();
    }
  } catch (err) {
    logger.warn("ページの最前面化に失敗しました（処理は継続します）", {
      error: err?.message ?? String(err),
    });
  }

  // 2) 既定ブラウザで商品URLを開く（ログイン済みなら即購入できる）。
  await openInBrowser(productUrl, logger);

  // 3) ラウドアラートをループ。各反復は通知・サウンド・読み上げを並行実行。
  for (let i = 0; i < alert.repeat; i += 1) {
    const round = i + 1;
    logger.info(`アラート鳴動 ${round}/${alert.repeat}`);

    // Promise.allSettled で個別失敗が他をブロックしないようにする。
    await Promise.allSettled([
      showNotification(title, message, subtitle, logger),
      playSound(alert.sound, logger),
      speak(alert.voiceMessage, logger),
    ]);

    // 最終回以外はインターバルを空ける。
    if (round < alert.repeat && alert.intervalMs > 0) {
      await sleep(alert.intervalMs);
    }
  }

  logger.event("在庫復活アラートを完了しました", { rounds: alert.repeat });
}

/**
 * 致命的エラー時の通知。監視継続が困難になった場合などに利用する。
 * 通知バナー + 日本語読み上げを1回実行する。外部コマンド失敗はスローしない。
 *
 * @param {string} message ユーザー向けの日本語メッセージ
 * @param {object} config  設定オブジェクト（alert.sound 等を参照）
 * @param {object} logger  ロガー
 */
export async function notifyError(message, config, logger) {
  const safeMessage = String(message ?? "不明なエラーが発生しました");

  // loggerが無い/壊れていても落ちないように防御。
  if (logger && typeof logger.error === "function") {
    logger.error(`致命的エラー通知: ${safeMessage}`);
  }

  const alert = normalizeAlert(config?.alert);
  const title = "⚠️ Tesla 在庫監視エラー";
  const subtitle = "監視が問題を検出しました";

  // 通知・サウンド・読み上げを並行実行。個別失敗は無視して継続。
  await Promise.allSettled([
    showNotification(title, safeMessage, subtitle, logger),
    playSound(alert.sound, logger),
    speak(`在庫監視でエラーが発生しました。${safeMessage}`, logger),
  ]);
}
