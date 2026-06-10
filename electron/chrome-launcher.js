// electron/chrome-launcher.js
// 監視用 Chrome（専用プロファイル + リモートデバッグポート）の検出・起動。
// start.sh の役割をクロスプラットフォーム（macOS / Windows / Linux）に移植したもの。
//
// 仕組み:
//  - 監視には「実 Chrome のデバッグ接続(CDP)」を使う。Playwright が起動する自動ブラウザは
//    Akamai(bot対策) に弾かれやすいが、実 Chrome のセッションは弾かれにくいため。
//  - 普段使いの Chrome と競合しないよう「専用プロファイル」で Chrome を起動する。
//  - Windows で Chrome が無い場合は Chromium ベースの Microsoft Edge にフォールバックする。
//
// Electron に依存しないプレーン Node モジュール（ユニットテスト可能）。

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 既定のリモートデバッグポート。 */
export const DEFAULT_DEBUG_PORT = 9222;

// デバッグポートが開くまでの待機（500ms × 40 = 最大 20 秒）。
const PORT_WAIT_RETRIES = 40;
const PORT_WAIT_INTERVAL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * プラットフォームごとの Chrome / Edge 実行ファイル候補パスを返す（純粋関数）。
 * 先頭に近いほど優先される。
 * @param {string} platform process.platform 互換（"darwin" | "win32" | "linux"）
 * @param {object} env process.env 互換
 * @returns {string[]}
 */
export function chromeCandidatePaths(platform, env) {
  if (platform === "darwin") {
    const home = env.HOME ?? "";
    return Object.freeze([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]);
  }

  if (platform === "win32") {
    const bases = [
      env["PROGRAMFILES"],
      env["PROGRAMFILES(X86)"],
      env["LOCALAPPDATA"],
    ].filter(Boolean);
    const chromePaths = bases.map((base) =>
      path.join(base, "Google", "Chrome", "Application", "chrome.exe")
    );
    // Chrome が無い環境向けフォールバック: Microsoft Edge（Chromium ベースで CDP 対応）。
    const edgeBases = [env["PROGRAMFILES(X86)"], env["PROGRAMFILES"]].filter(Boolean);
    const edgePaths = edgeBases.map((base) =>
      path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
    );
    return Object.freeze([...chromePaths, ...edgePaths]);
  }

  // Linux（おまけ対応）
  return Object.freeze([
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]);
}

/**
 * インストール済みの Chrome / Edge 実行ファイルを探す。
 * @param {string} [platform]
 * @param {object} [env]
 * @returns {string|null} 見つからなければ null
 */
export function findChromeExecutable(platform = process.platform, env = process.env) {
  const candidates = chromeCandidatePaths(platform, env);
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/**
 * 指定ポートで Chrome のデバッグエンドポイントが応答するか確認する。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isDebugPortOpen(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 監視用 Chrome をデバッグポート付きで起動し、ポートが開くまで待つ。
 * 既に開いていれば何もしない（再利用）。
 *
 * @param {object} params
 * @param {number} params.port リモートデバッグポート
 * @param {string} params.profileDir 専用プロファイルのディレクトリ
 * @param {object} [params.logger]
 * @returns {Promise<{ok:true, alreadyRunning:boolean, executable?:string} | {ok:false, error:string}>}
 *   失敗時も throw せず、ユーザー向け日本語メッセージを error に入れて返す。
 */
export async function ensureMonitorChrome({ port, profileDir, logger }) {
  if (await isDebugPortOpen(port)) {
    logger?.info?.("監視用ブラウザは起動済みです", { port });
    return { ok: true, alreadyRunning: true };
  }

  const executable = findChromeExecutable();
  if (!executable) {
    return {
      ok: false,
      error:
        "Google Chrome が見つかりません。https://www.google.com/chrome/ からインストールしてから、もう一度お試しください。",
    };
  }

  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `監視用プロファイルの作成に失敗しました: ${m}`,
    };
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  logger?.info?.("監視用ブラウザを起動します（専用プロファイル）", {
    executable,
    port,
  });

  try {
    // 独立プロセスとして起動し、アプリ終了後もブラウザを巻き込まない。
    const child = spawn(executable, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `ブラウザの起動に失敗しました: ${m}` };
  }

  // デバッグポートが開くまで待つ。
  for (let i = 0; i < PORT_WAIT_RETRIES; i += 1) {
    if (await isDebugPortOpen(port)) {
      logger?.info?.("監視用ブラウザの起動を確認しました", { port });
      return { ok: true, alreadyRunning: false, executable };
    }
    await sleep(PORT_WAIT_INTERVAL_MS);
  }

  return {
    ok: false,
    error: `監視用ブラウザのデバッグポート（${port}）が開きませんでした。既に別の用途でポートを使っていないか確認してください。`,
  };
}
