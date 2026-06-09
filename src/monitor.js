// src/monitor.js
// メインエントリ。Tesla オンラインショップの在庫を監視し、再入荷を検知して通知する。
//
// 設計方針（リサーチブリーフ反映）:
//  - 毎サイクル page.reload() で最新の在庫状態を取得する（初回のみ goto）。
//  - サイクル間は config.check.minMs〜maxMs のジッター付きスリープ。
//  - 連続失敗 / "Access Denied"（Akamai 再チャレンジ）時は指数バックオフ。
//  - 一定回数の連続失敗でブラウザを閉じて再起動（コンテキストをリセット）。
//  - 定期的にブラウザをリサイクルして RSS を解放する。
//  - IN_STOCK 検知時は alert 前に一度だけ確認リチェック（誤検知防止）。
//  - 在庫中の再通知はスロットルし、OUT_OF_STOCK に戻ったら再アーム。
//  - SIGINT でグレースフルシャットダウン（context.close で SingletonLock 解放）。
//
// NOTE: このスクリプトは監視本体（ワークフロースクリプトではない）ため、
//       Date.now() / Math.random() などの時刻・乱数 API を自由に利用する。

import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { STATES } from "./states.js";
import { fetchInventoryInPage, judgeInventory } from "./inventory.js";
import { alertInStock, notifyError } from "./notifier.js";
import {
  launchBrowser,
  closeBrowser,
  connectToChrome,
  disconnectChrome,
} from "./browser.js";

// --attach: 既存 Chrome（--remote-debugging-port=9222 で起動）に CDP 接続して監視するモード。
// スクリプト起動の自動ブラウザが Tesla にブロックされる場合、ユーザーのログイン済み・
// Akamai に信頼されたセッションをそのまま使うことでブロックを回避する。
const ATTACH = new Set(process.argv.slice(2)).has("--attach");

// ---- 監視ループの内部チューナブル（config から派生・上書き可能） ----
// すべて config 由来。ハードコードを避けつつ、未設定時のみ安全なデフォルトを補う。
const loopConfig = Object.freeze({
  // ページ読み込み待ち（ms）— config.browser に定義
  navTimeoutMs: config.browser?.navigationTimeoutMs ?? 60_000,
  // waitForSelector のタイムアウト（ms）— config.browser に定義
  waitSelectorMs: config.browser?.waitForTimeoutMs ?? 30_000,
  // 連続失敗がこの回数に達したらブラウザを再起動する — config.retry に定義
  maxFailuresBeforeRelaunch: config.retry?.relaunchAfterFailures ?? 4,
  // 指数バックオフの基準値（ms）と上限（ms）— config.retry に定義
  backoffBaseMs: config.retry?.backoffBaseMs ?? 15_000,
  backoffMaxMs: config.retry?.backoffMaxMs ?? 5 * 60_000,
  // ブラウザを定期リサイクルする間隔（ms）。RSS 解放のため。— config.browser に定義
  recycleIntervalMs: config.browser?.recycleIntervalMs ?? 2.5 * 60 * 60_000,
  // 決定的な在庫シグナルが描画されるまでの待機上限（ms）— config.browser に定義
  signalTimeoutMs: config.browser?.signalTimeoutMs ?? 8_000,
  // 待機セレクタ出現後の追加待機（ms）。在庫シグナルの描画安定待ち（誤検知防止）。
  settleMs: config.browser?.settleMs ?? 1200,
});

// Akamai のアクセス拒否を示す文字列（英語・日本語の両ロケール）。
const accessDeniedNeedles = ["Access Denied", "アクセスが拒否されました"];

// ---- 純粋ヘルパー（immutable / 副作用なし） ----

/**
 * config.check の範囲でジッター付きスリープ時間（ms）を返す。
 * @returns {number}
 */
function jitterMs() {
  const min = config.check.minMs;
  const max = config.check.maxMs;
  if (typeof min !== "number" || typeof max !== "number" || max < min) {
    // 設定不正時は安全側に倒して固定 45 秒。
    return 45_000;
  }
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * 連続失敗回数に応じた指数バックオフ時間（ms, 上限あり, 軽いジッター付き）。
 * @param {number} failures 1 以上
 * @returns {number}
 */
function backoffMs(failures) {
  const n = Math.max(1, failures);
  const raw = loopConfig.backoffBaseMs * Math.pow(2, n - 1);
  const capped = Math.min(raw, loopConfig.backoffMaxMs);
  // ±20% のジッターで同期的な再試行を避ける。
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.floor(jitter);
}

/**
 * Promise ベースのスリープ。AbortSignal で早期中断可能。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * detect 結果から監視ループ用の要約シグナルを抽出する（immutable）。
 * @param {{state:string, signals:object}} result
 * @returns {object}
 */
function summarizeSignals(result) {
  const s = result?.signals ?? {};
  return Object.freeze({
    state: result?.state ?? STATES.UNKNOWN,
    inventoryCount: s.inventoryCount ?? null,
    purchasable: s.purchasable ?? null,
    status: s.status ?? null,
    apiError: s.apiError ?? null,
  });
}

// ---- ページ操作（副作用あり。例外は呼び出し側で必ずハンドル） ----

/**
 * 在庫を評価する。
 * 初回（firstLoad）のみ商品ページを開いて tesla.com オリジンと Akamai セッションを確立し、
 * 以降は reload せず、在庫 API（inventory.json）をブラウザ内 fetch で叩いて判定する。
 * @param {import("playwright").Page} page
 * @param {boolean} firstLoad 初回なら商品ページを開く（セッション確立）
 * @returns {Promise<{state:string, signals:object}>}
 */
async function evaluatePage(page, firstLoad) {
  // 初回（firstLoad）のみ商品ページを開いて tesla.com オリジンと Akamai セッションを確立する。
  // 以降は reload せず、在庫 API（inventory.json）をブラウザ内 fetch で叩いて判定する。
  // これにより reload の重さ・Akamai 負荷を排し、軽量・高頻度・確実な検知を行う。
  if (firstLoad) {
    await page.goto(config.productUrl, {
      waitUntil: "domcontentloaded",
      timeout: loopConfig.navTimeoutMs,
    });
  }

  // 在庫 API を POST で叩く（reload しない）。fetchInventoryInPage は page.evaluate 用の純粋関数。
  const raw = await page.evaluate(fetchInventoryInPage, {
    apiUrl: config.inventory.apiUrl,
    skuCode: config.inventory.skuCode,
  });
  return judgeInventory(raw, config.inventory.skuCode);
}

/**
 * Access Denied（Akamai 再チャレンジ）かどうかを判定する。
 * @param {{signals:object}} result
 * @returns {boolean}
 */
function isAccessDenied(result) {
  const title = result?.signals?.title;
  if (typeof title !== "string") return false;
  return accessDeniedNeedles.some((needle) => title.includes(needle));
}

// ---- --once モード ----

/**
 * 単発チェック。reload → evaluate → JSON 出力 → クローズ → exit 0。
 * @returns {Promise<void>}
 */
async function runOnce(logger) {
  let handle = null;
  try {
    handle = await acquireBrowser(logger);
    const result = await evaluatePage(handle.page, true);
    // 機械可読な JSON を stdout に出す（呼び出し側が parse できるよう純粋に）。
    process.stdout.write(
      JSON.stringify({ state: result.state, signals: result.signals }) + "\n"
    );
  } catch (err) {
    // --once の失敗も JSON で返す（state=unknown）。
    const message = err instanceof Error ? err.message : String(err);
    logger.error("単発チェックに失敗しました", { error: message });
    process.stdout.write(
      JSON.stringify({
        state: STATES.UNKNOWN,
        signals: { error: message },
      }) + "\n"
    );
  } finally {
    if (handle) {
      try {
        await releaseBrowser(handle, logger);
      } catch (closeErr) {
        const m = closeErr instanceof Error ? closeErr.message : String(closeErr);
        logger.warn("ブラウザの解放に失敗しました", { error: m });
      }
    }
  }
}

// ---- ループモード ----

/**
 * 監視ループの可変状態。1 つのオブジェクトに集約し、
 * 更新は常に新しいオブジェクトを返す（immutable 更新）。
 * @typedef {Object} LoopState
 * @property {number} failures           連続失敗回数
 * @property {boolean} firstLoad         次の評価が初回 goto かどうか
 * @property {boolean} inStockAlerted    在庫中で既に通知済みか（再通知スロットル）
 * @property {number} launchedAt         現在のブラウザ起動時刻（ms epoch）
 */

/** @returns {LoopState} */
function freshState(launchedAt) {
  return Object.freeze({
    failures: 0,
    firstLoad: true,
    inStockAlerted: false,
    launchedAt,
  });
}

/**
 * 成功時の状態更新（immutable）。failures をリセットし firstLoad を解除。
 * @param {LoopState} state
 * @param {Partial<LoopState>} patch
 * @returns {LoopState}
 */
function withState(state, patch) {
  return Object.freeze({ ...state, ...patch });
}

/**
 * IN_STOCK の確認リチェック。reload + 再評価して再度 IN_STOCK なら true。
 * @returns {Promise<boolean>}
 */
async function confirmInStock(page, logger) {
  try {
    logger.info("在庫検知 → 確認リチェックを実行します");
    const confirm = await evaluatePage(page, false);
    const ok = confirm.state === STATES.IN_STOCK;
    if (!ok) {
      logger.warn("確認リチェックで在庫が確認できませんでした（誤検知の可能性）", {
        state: confirm.state,
      });
    }
    return ok;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.warn("確認リチェックでエラーが発生しました", { error: m });
    return false;
  }
}

/**
 * ブラウザを安全に再起動する。古い context は必ずクローズを試みる。
 * @returns {Promise<{context:any, page:any, launchedAt:number}>}
 */
/**
 * モードに応じてブラウザを取得する。
 * - attach: 既存 Chrome に CDP 接続（ユーザーの信頼済みセッションを利用）。
 * - 通常 : 永続コンテキストを起動（ウォームアップ含む）。
 * @returns {Promise<{context:any, page:any, cdp:any, attached:boolean, launchedAt:number}>}
 */
async function acquireBrowser(logger) {
  if (ATTACH) {
    const { browser, context, page, ownsPage } = await connectToChrome(
      config,
      logger
    );
    return {
      context,
      page,
      cdp: browser,
      attached: true,
      ownsPage,
      launchedAt: Date.now(),
    };
  }
  const { context, page } = await launchBrowser(config, logger);
  return { context, page, cdp: null, attached: false, launchedAt: Date.now() };
}

/**
 * モードに応じてブラウザを解放する。
 * - attach: 監視用に開いた新規タブを閉じてから CDP 切断（ユーザーの Chrome / 既存タブは閉じない）。
 * - 通常 : コンテキストを close（SingletonLock 解放）。
 * @param {{context:any, page:any, cdp:any, attached:boolean, ownsPage:boolean}} handle
 */
async function releaseBrowser(handle, logger) {
  if (!handle) return;
  if (handle.attached) {
    // 監視が自分で開いた新規タブのみ閉じる。これを怠ると --once / 再接続のたびに
    // 商品ページタブが残留し、Chrome のメモリを圧迫する（実測でタブ大量残留を確認）。
    if (handle.ownsPage && handle.page) {
      try {
        await handle.page.close();
        logger?.info?.("監視タブを閉じました");
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger?.warn?.("監視タブのクローズに失敗しました（無視して継続）", {
          error: m,
        });
      }
    }
    await disconnectChrome(handle.cdp, logger);
  } else {
    await closeBrowser(handle.context, logger);
  }
}

/**
 * ブラウザを安全に再取得する。古いハンドルは必ず解放を試みる。
 * attach 時は CDP 再接続、通常時はブラウザ再起動になる。
 * @returns {Promise<{context:any, page:any, cdp:any, attached:boolean, launchedAt:number}>}
 */
async function relaunch(oldHandle, logger, reason) {
  logger.warn(ATTACH ? "CDP を再接続します" : "ブラウザを再起動します", { reason });
  try {
    await releaseBrowser(oldHandle, logger);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    logger.warn("旧ブラウザの解放に失敗しました（続行）", { error: m });
  }
  return acquireBrowser(logger);
}

/**
 * 1 サイクルを処理し、新しいループ状態と、必要なら relaunch 要求を返す。
 * 例外は内部で握り、failures をインクリメントした状態を返す（ループは止めない）。
 * @returns {Promise<{state:LoopState, needRelaunch:boolean, relaunchReason:?string}>}
 */
async function runCycle(page, state, logger, signal) {
  try {
    const result = await evaluatePage(page, state.firstLoad);
    const summary = summarizeSignals(result);

    // Access Denied は失敗扱い（Akamai 再チャレンジ）。
    if (isAccessDenied(result)) {
      logger.warn("Akamai 再チャレンジを検知しました（Access Denied）", {
        title: summary.title,
      });
      const next = withState(state, {
        failures: state.failures + 1,
        firstLoad: false,
      });
      const needRelaunch = next.failures >= loopConfig.maxFailuresBeforeRelaunch;
      return {
        state: next,
        needRelaunch,
        relaunchReason: needRelaunch ? "access-denied" : null,
      };
    }

    // ハートビートログ（毎サイクル）。
    logger.event("ハートビート", summary);

    // --- 状態別の処理 ---
    if (result.state === STATES.IN_STOCK) {
      // 在庫中。既に通知済みなら再通知しない（スロットル）。
      if (state.inStockAlerted) {
        return {
          state: withState(state, { failures: 0, firstLoad: false }),
          needRelaunch: false,
          relaunchReason: null,
        };
      }
      // 未通知 → 確認リチェック後に通知。
      const confirmed = await confirmInStock(page, logger);
      if (confirmed) {
        logger.event("在庫あり（確認済み）→ アラートを発報します", summary);
        try {
          await alertInStock({ page, config, logger });
        } catch (alertErr) {
          // 通知失敗で監視を止めない。
          const m = alertErr instanceof Error ? alertErr.message : String(alertErr);
          logger.error("アラート発報中にエラーが発生しました（監視は継続）", {
            error: m,
          });
        }
        // 通知済みフラグを立て、failures をリセット。監視は継続。
        return {
          state: withState(state, {
            failures: 0,
            firstLoad: false,
            inStockAlerted: true,
          }),
          needRelaunch: false,
          relaunchReason: null,
        };
      }
      // 確認できず → UNKNOWN 相当として扱い、通知はしない。
      return {
        state: withState(state, { failures: 0, firstLoad: false }),
        needRelaunch: false,
        relaunchReason: null,
      };
    }

    if (result.state === STATES.OUT_OF_STOCK) {
      // 在庫切れ → 再通知アームを解除（次回の在庫復活で再び通知できる）。
      if (state.inStockAlerted) {
        logger.info("在庫切れに戻りました → アラートを再アームします");
      }
      return {
        state: withState(state, {
          failures: 0,
          firstLoad: false,
          inStockAlerted: false,
        }),
        needRelaunch: false,
        relaunchReason: null,
      };
    }

    // UNKNOWN → 失敗としてカウントしバックオフ対象にする。
    logger.warn("状態を判定できませんでした（UNKNOWN）", summary);
    const next = withState(state, {
      failures: state.failures + 1,
      firstLoad: false,
    });
    const needRelaunch = next.failures >= loopConfig.maxFailuresBeforeRelaunch;
    return {
      state: next,
      needRelaunch,
      relaunchReason: needRelaunch ? "repeated-unknown" : null,
    };
  } catch (err) {
    // ナビゲーション/評価エラー全般。監視は止めず failures を増やす。
    const m = err instanceof Error ? err.message : String(err);
    logger.error("サイクル処理でエラーが発生しました", { error: m });
    // 監視タブ/コンテキストが閉じられた場合は、failures 閾値を待たず即座に再接続する。
    // （ユーザーが監視タブを誤って閉じても、次サイクルで新タブを開いて素早く回復させる）
    const pageClosed =
      /Target (page,? context or browser|closed)|has been closed/i.test(m);
    const next = withState(state, {
      failures: state.failures + 1,
      firstLoad: false,
    });
    const needRelaunch =
      pageClosed || next.failures >= loopConfig.maxFailuresBeforeRelaunch;
    return {
      state: next,
      needRelaunch,
      relaunchReason: needRelaunch
        ? pageClosed
          ? "page-closed"
          : "cycle-error"
        : null,
    };
  }
}

/**
 * 監視のメインループ。SIGINT が来るまで回り続ける。
 * @returns {Promise<void>}
 */
async function runLoop(logger) {
  const abortController = new AbortController();
  const { signal } = abortController;

  let shuttingDown = false;
  let browser = null;

  // ---- グレースフルシャットダウン ----
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("シャットダウンを開始します", { reason });
    abortController.abort();
    if (browser) {
      try {
        await releaseBrowser(browser, logger);
        logger.info(
          browser.attached
            ? "CDP 接続を切断しました（Chrome は起動したまま）"
            : "ブラウザをクローズしました（SingletonLock 解放）"
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.warn("シャットダウン時の解放に失敗しました", { error: m });
      }
    }
    logger.info("監視を終了しました。さようなら。");
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").then(() => process.exit(0));
  });

  // ---- 初回起動 ----
  try {
    browser = await acquireBrowser(logger);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (ATTACH) {
      logger.error("既存 Chrome への CDP 接続に失敗しました", {
        error: m,
        hint: "Chrome を --remote-debugging-port=9222 付きで起動しているか確認してください",
      });
      await notifyError(`CDP 接続に失敗しました: ${m}`, config, logger);
    } else {
      logger.error("ブラウザの初回起動に失敗しました", { error: m });
      await notifyError(`ブラウザ起動に失敗しました: ${m}`, config, logger);
    }
    process.exitCode = 1;
    return;
  }

  let state = freshState(Date.now());
  logger.info("監視を開始します", {
    mode: ATTACH ? "attach(CDP/既存Chrome)" : "launch(自動ブラウザ)",
    url: config.productUrl,
    minMs: config.check.minMs,
    maxMs: config.check.maxMs,
  });

  // ---- メインループ ----
  while (!shuttingDown) {
    // 定期リサイクル（RSS 解放）。失敗回数とは独立。
    // attach モードではユーザーの Chrome を再起動しない（メモリ管理は Chrome 任せ）。
    const age = Date.now() - state.launchedAt;
    if (!browser.attached && age >= loopConfig.recycleIntervalMs) {
      try {
        browser = await relaunch(browser, logger, "periodic-recycle");
        state = withState(state, { firstLoad: true, launchedAt: browser.launchedAt });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.error("定期リサイクルに失敗しました", { error: m });
        await sleep(backoffMs(1), signal);
        continue;
      }
    }

    const { state: nextState, needRelaunch, relaunchReason } = await runCycle(
      browser.page,
      state,
      logger,
      signal
    );
    state = nextState;

    if (shuttingDown) break;

    // 連続失敗でブラウザ再起動が要求された場合。
    if (needRelaunch) {
      // バックオフを先に取ってから再起動する（リサーチブリーフ: backoff first）。
      const wait = backoffMs(state.failures);
      logger.warn("再起動前にバックオフします", {
        failures: state.failures,
        reason: relaunchReason,
        waitMs: wait,
      });
      await sleep(wait, signal);
      if (shuttingDown) break;
      try {
        browser = await relaunch(browser, logger, relaunchReason);
        // 再起動後は failures リセット & 初回ロード扱い。
        state = withState(state, {
          failures: 0,
          firstLoad: true,
          launchedAt: browser.launchedAt,
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.error("ブラウザの再起動に失敗しました", { error: m });
        await notifyError(`ブラウザ再起動に失敗しました: ${m}`, config, logger);
        // 致命的だが、長めに待って再試行する（監視を諦めない）。
        await sleep(loopConfig.backoffMaxMs, signal);
      }
      continue;
    }

    // 通常サイクル後のスリープ。
    // 失敗が残っている（再起動閾値未満）場合はバックオフ、そうでなければジッター。
    const waitMs = state.failures > 0 ? backoffMs(state.failures) : jitterMs();
    logger.info("次のチェックまで待機します", {
      waitMs,
      failures: state.failures,
      inStockAlerted: state.inStockAlerted,
    });
    await sleep(waitMs, signal);
  }
}

// ---- エントリポイント ----

async function main() {
  const logger = createLogger(config.logFile);
  const args = new Set(process.argv.slice(2));

  if (args.has("--once")) {
    await runOnce(logger);
    process.exit(0);
  }

  await runLoop(logger);
}

// トップレベルの致命的エラーは握って明示的に終了する（サイレント失敗を避ける）。
main().catch((err) => {
  const m = err instanceof Error ? (err.stack ?? err.message) : String(err);
  // logger が使えない可能性もあるため stderr に直書きする。
  process.stderr.write(`[FATAL] 監視プロセスが異常終了しました:\n${m}\n`);
  process.exit(1);
});
