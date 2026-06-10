// electron/settings.js
// GUI アプリのユーザー設定（商品URL / SKU / チェック間隔など）の検証・永続化と、
// src/config.js のデフォルト設定にユーザー設定を重ねた「実行時 config」の生成。
//
// Electron に依存しないプレーン Node モジュール（ユニットテスト可能）。
// 保存先ファイルのパスは呼び出し側（main プロセス）が userData から渡す。

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DEBUG_PORT } from "./chrome-launcher.js";

// チェック間隔の許容範囲（秒）。Tesla への過度なアクセスを防ぐ下限を設ける。
const MIN_INTERVAL_SEC = 5;
const MAX_INTERVAL_SEC = 600;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

// 設定として受け付けるキー（これ以外は無視して保存しない）。
const SETTING_KEYS = Object.freeze([
  "productUrl",
  "skuCode",
  "minSec",
  "maxSec",
  "debugPort",
]);

/**
 * baseConfig（src/config.js）から既定のユーザー設定を導出する（純粋関数）。
 * @param {object} baseConfig
 * @returns {object} 凍結済み設定
 */
export function defaultSettings(baseConfig) {
  return Object.freeze({
    productUrl: baseConfig.productUrl,
    skuCode: baseConfig.inventory.skuCode,
    minSec: Math.round(baseConfig.check.minMs / 1000),
    maxSec: Math.round(baseConfig.check.maxMs / 1000),
    debugPort: DEFAULT_DEBUG_PORT,
  });
}

/**
 * 設定候補を検証する（純粋関数）。
 * @param {object} candidate
 * @returns {{ok:true, value:object} | {ok:false, error:string}}
 */
export function validateSettings(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, error: "設定の形式が不正です" };
  }

  // --- 商品 URL: shop.tesla.com の https URL のみ許可 ---
  const productUrl = String(candidate.productUrl ?? "").trim();
  let parsedUrl = null;
  try {
    parsedUrl = new URL(productUrl);
  } catch {
    return { ok: false, error: "商品ページURLが不正です（URL として解釈できません）" };
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "shop.tesla.com") {
    return {
      ok: false,
      error: "商品ページURLは https://shop.tesla.com/ で始まる URL を指定してください",
    };
  }

  // --- SKU: 英数字とハイフンのみ ---
  const skuCode = String(candidate.skuCode ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(skuCode)) {
    return {
      ok: false,
      error: "SKU は英数字とハイフンで指定してください（例: 1458882-00-D）",
    };
  }

  // --- チェック間隔（秒） ---
  const minSec = Number(candidate.minSec);
  const maxSec = Number(candidate.maxSec);
  if (!Number.isInteger(minSec) || !Number.isInteger(maxSec)) {
    return { ok: false, error: "チェック間隔は整数（秒）で指定してください" };
  }
  if (minSec < MIN_INTERVAL_SEC || maxSec > MAX_INTERVAL_SEC || minSec > maxSec) {
    return {
      ok: false,
      error: `チェック間隔は ${MIN_INTERVAL_SEC}〜${MAX_INTERVAL_SEC} 秒の範囲で、最小 ≦ 最大 になるよう指定してください`,
    };
  }

  // --- デバッグポート（上級者向け・設定ファイル直編集用） ---
  const debugPort = Number(candidate.debugPort ?? DEFAULT_DEBUG_PORT);
  if (!Number.isInteger(debugPort) || debugPort < MIN_PORT || debugPort > MAX_PORT) {
    return {
      ok: false,
      error: `デバッグポートは ${MIN_PORT}〜${MAX_PORT} の整数で指定してください`,
    };
  }

  return {
    ok: true,
    value: Object.freeze({ productUrl, skuCode, minSec, maxSec, debugPort }),
  };
}

/**
 * 設定ファイルを読み込み、デフォルトとマージして返す。
 * ファイルが無い・壊れている・検証に通らない場合はデフォルトに戻す（fail-safe）。
 * @param {string} settingsFile 設定ファイルのパス
 * @param {object} baseConfig src/config.js の config
 * @returns {object} 凍結済み設定
 */
export function loadSettings(settingsFile, baseConfig) {
  const defaults = defaultSettings(baseConfig);
  let parsed = null;
  try {
    const text = fs.readFileSync(settingsFile, "utf8");
    parsed = JSON.parse(text);
  } catch {
    // 初回起動（ファイル無し）や破損時はデフォルトを使う。
    return defaults;
  }
  const merged = { ...defaults, ...pickSettingKeys(parsed) };
  const result = validateSettings(merged);
  return result.ok ? result.value : defaults;
}

/**
 * 設定を検証して保存する。検証失敗時は Error を throw する。
 * @param {string} settingsFile 設定ファイルのパス
 * @param {object} baseConfig src/config.js の config
 * @param {object} patch 上書きしたい設定（部分指定可）
 * @returns {object} 保存後の凍結済み設定
 */
export function saveSettings(settingsFile, baseConfig, patch) {
  const current = loadSettings(settingsFile, baseConfig);
  const merged = { ...current, ...pickSettingKeys(patch) };
  const result = validateSettings(merged);
  if (!result.ok) {
    throw new Error(result.error);
  }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(result.value, null, 2) + "\n", {
    encoding: "utf8",
  });
  return result.value;
}

/**
 * 商品 URL からショップのベース URL（オリジン + ロケール）を導出する（純粋関数）。
 * 例: https://shop.tesla.com/ja_jp/product/xxx → https://shop.tesla.com/ja_jp
 * @param {string} productUrl
 * @returns {string|null} ロケールが取れない場合は null
 */
export function deriveShopBaseUrl(productUrl) {
  try {
    const u = new URL(productUrl);
    const firstSegment = u.pathname.split("/").filter(Boolean)[0] ?? "";
    if (/^[a-z]{2}_[a-z]{2}$/i.test(firstSegment)) {
      return `${u.origin}/${firstSegment}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * baseConfig にユーザー設定とアプリ用パスを重ねた「実行時 config」を生成する（純粋関数）。
 * 在庫 API / ウォームアップ URL は商品 URL のロケールに追従させる。
 * @param {object} baseConfig src/config.js の config
 * @param {object} settings loadSettings の戻り値
 * @param {{chromeProfile:string, logFile:string}} paths アプリ用パス
 * @returns {object} 凍結済み config（src/config.js 互換の形）
 */
export function buildRuntimeConfig(baseConfig, settings, paths) {
  const shopBase = deriveShopBaseUrl(settings.productUrl);
  const apiUrl = shopBase ? `${shopBase}/inventory.json` : baseConfig.inventory.apiUrl;
  const warmUpUrl = shopBase ? `${shopBase}/` : baseConfig.browser.warmUpUrl;

  return Object.freeze({
    ...baseConfig,
    productUrl: settings.productUrl,
    check: Object.freeze({
      minMs: settings.minSec * 1000,
      maxMs: settings.maxSec * 1000,
    }),
    inventory: Object.freeze({
      ...baseConfig.inventory,
      apiUrl,
      skuCode: settings.skuCode,
    }),
    browser: Object.freeze({
      ...baseConfig.browser,
      userDataDir: paths.chromeProfile,
      warmUpUrl,
    }),
    attach: Object.freeze({
      ...baseConfig.attach,
      cdpUrl: `http://localhost:${settings.debugPort}`,
    }),
    logFile: paths.logFile,
  });
}

/**
 * オブジェクトから設定キーのみを抜き出す（純粋関数・不明キーは捨てる）。
 * @param {object} source
 * @returns {object}
 */
function pickSettingKeys(source) {
  if (!source || typeof source !== "object") return {};
  return SETTING_KEYS.reduce(
    (acc, key) => (source[key] === undefined ? acc : { ...acc, [key]: source[key] }),
    {}
  );
}
