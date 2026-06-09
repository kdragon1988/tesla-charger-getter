// src/browser.js
// ブラウザの起動・終了を担う。Akamai Bot Manager を回避するため、
// 実ブラウザ(可能なら channel:"chrome")を永続コンテキストで起動する。
// リサーチブリーフに従い、反検知用の最小限の起動オプションのみを適用する。

import { chromium } from "playwright";

// --- 反検知のための起動引数（リサーチブリーフより） ---
// userAgent は意図的に詐称しない（実ブラウザのまま使う方が安全）。
const ANTI_DETECTION_ARGS = Object.freeze([
  "--disable-blink-features=AutomationControlled", // navigator.webdriver 系の痕跡を抑制
  "--no-first-run", // 初回起動ダイアログを抑止
  "--no-default-browser-check", // 既定ブラウザ確認を抑止
]);

// enable-automation を無効化することで navigator.webdriver と
// 自動操作インフォバーを消す（Akamai の検知ポイントを潰す重要フラグ）。
const IGNORE_DEFAULT_ARGS = Object.freeze(["--enable-automation"]);

const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/**
 * 永続コンテキストの起動オプションを生成する（純粋関数・イミュータブル）。
 * @param {object} config アプリ設定
 * @param {boolean} useChromeChannel channel:"chrome" を使うか
 * @returns {object} launchPersistentContext に渡すオプション
 */
function buildLaunchOptions(config, useChromeChannel) {
  const browser = config?.browser ?? {};

  // 共通オプション（毎回新しいオブジェクトを生成して共有状態を汚さない）。
  const baseOptions = {
    headless: browser.headless ?? false, // new-headless は WebGL/GPU の痕跡が漏れるため headed 推奨
    locale: browser.locale ?? "ja-JP",
    timezoneId: browser.timezoneId ?? "Asia/Tokyo",
    viewport: { ...VIEWPORT },
    deviceScaleTotal: undefined, // 後段で deviceScaleFactor を設定
    args: [...ANTI_DETECTION_ARGS],
    ignoreDefaultArgs: [...IGNORE_DEFAULT_ARGS],
    // Retina(arm64) 想定。実機に近い表示倍率で痕跡を減らす。
    deviceScaleFactor: 2,
  };

  // 不要な仮プロパティを取り除いた新オブジェクトを返す。
  const { deviceScaleTotal: _omit, ...cleaned } = baseOptions;

  // chrome チャンネル指定は使う場合のみ付与（不要なら付けない）。
  return useChromeChannel
    ? { ...cleaned, channel: browser.channel ?? "chrome" }
    : { ...cleaned };
}

/**
 * 永続コンテキストの最初のページを取得する。
 * 既存ページがあれば再利用し、無ければ新規作成する。
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>}
 */
async function resolveFirstPage(context) {
  const existing = context.pages();
  if (existing.length > 0) {
    return existing[0];
  }
  return context.newPage();
}

/**
 * Akamai セッションを温める。
 * 商品ページ（保護が厳しい）に直接行く前に、保護の緩いショップトップを一度読み込み、
 * Akamai のセンサー JS に _abck クッキーを検証させて正当なセッションを確立する。
 * これによりコールドスタート時の "Access Denied" を減らせる。
 * ベストエフォート: 失敗しても throw せず監視を継続する。
 * @param {import('playwright').Page} page
 * @param {object} config アプリ設定
 * @param {object} [logger]
 * @returns {Promise<void>}
 */
async function warmUpSession(page, config, logger) {
  const warmUpUrl = config?.browser?.warmUpUrl;
  if (!warmUpUrl) return;
  try {
    logger?.info?.("Akamai セッションを温めます", { warmUpUrl });
    await page.goto(warmUpUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 人間らしい微小操作で Akamai の挙動スコアを上げる（失敗は無視）。
    try {
      await page.mouse.move(420, 360);
      await page.waitForTimeout(800);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(1200);
    } catch {
      // マウス操作失敗は致命的でないため無視。
    }
    logger?.info?.("温め完了");
  } catch (err) {
    logger?.warn?.("温めに失敗しました（処理は継続します）", {
      reason: err?.message ?? String(err),
    });
  }
}

/**
 * ブラウザを起動して { context, page } を返す。
 * まず channel:"chrome" を試し、失敗したらバンドル版 chromium にフォールバックする。
 * @param {object} config アプリ設定
 * @param {object} logger createLogger が返すロガー
 * @returns {Promise<{ context: import('playwright').BrowserContext, page: import('playwright').Page }>}
 */
export async function launchBrowser(config, logger) {
  const userDataDir = config?.browser?.userDataDir;
  if (!userDataDir) {
    const message = "browser.userDataDir が config に設定されていません";
    logger?.error?.(message);
    throw new Error(message);
  }

  // 1) まず実 Chrome（channel:"chrome"）で起動を試みる。
  const chromeOptions = buildLaunchOptions(config, true);
  try {
    logger?.info?.("ブラウザを起動します（channel: chrome を試行）", {
      userDataDir,
      headless: chromeOptions.headless,
    });
    const context = await chromium.launchPersistentContext(
      userDataDir,
      chromeOptions
    );
    const page = await resolveFirstPage(context);
    logger?.event?.("ブラウザ起動成功（channel: chrome）");
    await warmUpSession(page, config, logger);
    return { context, page };
  } catch (chromeError) {
    // chrome チャンネルが無い／壊れている場合はバンドル chromium にフォールバック。
    logger?.warn?.(
      "channel: chrome での起動に失敗。バンドル版 chromium にフォールバックします",
      { reason: chromeError?.message ?? String(chromeError) }
    );
  }

  // 2) フォールバック: channel なしのバンドル chromium で起動する。
  const bundledOptions = buildLaunchOptions(config, false);
  try {
    const context = await chromium.launchPersistentContext(
      userDataDir,
      bundledOptions
    );
    const page = await resolveFirstPage(context);
    logger?.event?.("ブラウザ起動成功（バンドル chromium）");
    await warmUpSession(page, config, logger);
    return { context, page };
  } catch (bundledError) {
    const message = `ブラウザの起動に失敗しました: ${
      bundledError?.message ?? String(bundledError)
    }`;
    logger?.error?.(message, { stack: bundledError?.stack });
    // 呼び出し側（monitor）が再起動/通知の判断をできるよう、必ず再スローする。
    throw new Error(message, { cause: bundledError });
  }
}

/**
 * 永続コンテキストを安全に閉じる。
 * SIGINT 時の SingletonLock 解放のためにも確実に close を呼ぶ。
 * close 自体の失敗で監視全体が落ちないよう、エラーはログに残して飲み込む。
 * @param {import('playwright').BrowserContext | null | undefined} context
 * @param {object} [logger]
 * @returns {Promise<void>}
 */
export async function closeBrowser(context, logger) {
  if (!context) {
    return;
  }
  try {
    await context.close();
    logger?.info?.("ブラウザコンテキストを閉じました");
  } catch (closeError) {
    // ここで投げると graceful shutdown が壊れるため、記録だけして継続する。
    logger?.warn?.("ブラウザコンテキストのクローズに失敗しました", {
      reason: closeError?.message ?? String(closeError),
    });
  }
}

/**
 * 既存の Chrome（--remote-debugging-port で起動済み）に CDP 接続する。
 * ユーザーのログイン済み・Akamai に信頼されたセッションをそのまま利用するため、
 * スクリプト起動の自動ブラウザが Tesla にブロックされる環境での本命の回避策。
 *
 * 重要: ここで得られる context はユーザーの Chrome の既存コンテキストであり、
 *       close してはならない（ユーザーのタブを巻き込んで閉じてしまうため）。
 *       監視用には新規タブ（page）を開いて使う。
 *
 * @param {object} config アプリ設定（config.attach.cdpUrl を参照）
 * @param {object} logger ロガー
 * @returns {Promise<{ browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page, ownsPage: boolean }>}
 */
export async function connectToChrome(config, logger) {
  const cdpUrl = config?.attach?.cdpUrl;
  if (!cdpUrl) {
    const message = "config.attach.cdpUrl が設定されていません";
    logger?.error?.(message);
    throw new Error(message);
  }

  logger?.info?.("既存 Chrome に CDP 接続します", { cdpUrl });
  const browser = await chromium.connectOverCDP(cdpUrl);

  // 既存コンテキスト（ユーザーのプロファイル）を取得。無ければ新規作成。
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

  // 監視用は新規タブを開く（ユーザーの現在のタブを乗っ取らない）。
  // ownsPage は「監視が自分で開いた新規タブか」を表す。解放時にこのタブだけを閉じ、
  // ユーザーの既存タブは閉じないために使う（タブ残留＝メモリリーク防止）。
  const useNewTab = config?.attach?.useNewTab !== false;
  const existing = context.pages();
  const ownsPage = useNewTab || existing.length === 0;
  const page = ownsPage ? await context.newPage() : existing[0];

  logger?.event?.("CDP 接続成功（既存 Chrome のセッションを利用）", {
    contexts: contexts.length,
  });

  // 商品ページ（保護が厳しい）へ行く前に、保護の緩いショップトップを一度開いて
  // Akamai セッション（_abck 等）を温める。attach の初回接続・再接続の両方で実行され、
  // Access Denied からの回復・予防に効く（launchBrowser と同じ温め処理を共有）。
  await warmUpSession(page, config, logger);

  return { browser, context, page, ownsPage };
}

/**
 * CDP 接続を切断する。ユーザーの Chrome 自体は終了しない
 * （Chrome は独立して起動しているため、接続を切るだけ）。
 * @param {import('playwright').Browser | null | undefined} browser connectToChrome が返した browser
 * @param {object} [logger]
 * @returns {Promise<void>}
 */
export async function disconnectChrome(browser, logger) {
  if (!browser) return;
  try {
    await browser.close(); // CDP 接続の切断。ユーザーの Chrome は閉じない。
    logger?.info?.("CDP 接続を切断しました（Chrome は起動したまま）");
  } catch (err) {
    logger?.warn?.("CDP 切断に失敗しました（無視して継続）", {
      reason: err?.message ?? String(err),
    });
  }
}
