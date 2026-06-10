// src/monitor.js
// CLI エントリポイント。監視ロジックの本体は src/monitor-core.js にあり、
// ここでは引数解釈・シグナルハンドリング・プロセス終了コードのみを扱う。
//
// 使い方:
//   node src/monitor.js            # Playwright の自動ブラウザで監視（フォールバック用途）
//   node src/monitor.js --attach   # 既存 Chrome（--remote-debugging-port）に CDP 接続して監視 ★推奨
//   node src/monitor.js --once     # 単発チェックして JSON を stdout に出力
//
// 通知は macOS 専用の notifier.js（osascript / afplay / say / open）を使う。
// Windows / GUI で使う場合は Electron アプリ（electron/）を利用すること。

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { createMonitor } from "./monitor-core.js";
import { alertInStock, notifyError } from "./notifier.js";

// --attach: 既存 Chrome（--remote-debugging-port=9222 で起動）に CDP 接続して監視するモード。
// スクリプト起動の自動ブラウザが Tesla にブロックされる場合、ユーザーのログイン済み・
// Akamai に信頼されたセッションをそのまま使うことでブロックを回避する。
const args = new Set(process.argv.slice(2));
const ATTACH = args.has("--attach");

async function main() {
  const logger = createLogger(config.logFile);
  const monitor = createMonitor({
    config,
    logger,
    attach: ATTACH,
    alerter: { alertInStock, notifyError },
  });

  // ---- --once モード: 単発チェック → 機械可読な JSON を stdout へ ----
  if (args.has("--once")) {
    const result = await monitor.checkOnce();
    process.stdout.write(
      JSON.stringify({ state: result.state, signals: result.signals }) + "\n"
    );
    process.exit(0);
  }

  // ---- グレースフルシャットダウン（SIGINT / SIGTERM） ----
  process.on("SIGINT", () => {
    void monitor.stop("SIGINT").then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void monitor.stop("SIGTERM").then(() => process.exit(0));
  });

  // ---- 監視ループ（停止まで解決しない） ----
  try {
    await monitor.start();
  } catch {
    // 初回接続失敗などの致命的エラー。詳細は core 側でログ・通知済み。
    process.exitCode = 1;
  }
}

// トップレベルの致命的エラーは握って明示的に終了する（サイレント失敗を避ける）。
main().catch((err) => {
  const m = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // logger が使えない可能性もあるため stderr に直書きする。
  process.stderr.write(`[FATAL] 監視プロセスが異常終了しました:\n${m}\n`);
  process.exit(1);
});
