// src/monitor-core.js
// 監視ループの中核（プラットフォーム非依存・UI 非依存）。
// CLI（src/monitor.js）と Electron アプリ（electron/）の両方がこのモジュールを共有する。
//
// 設計方針:
//  - 通知手段（alerter）と実行モード（attach）を外部から注入できるようにし、
//    macOS CLI（osascript/afplay/say）と Electron GUI（Notification/WebAudio）の
//    どちらでも同じ監視ロジックを使い回す。
//  - process.exit / SIGINT などプロセス制御は呼び出し側の責務（ここでは扱わない）。
//  - 連続失敗 / "Access Denied"（Akamai 再チャレンジ）時は指数バックオフ。
//  - 一定回数の連続失敗でブラウザを再接続/再起動（コンテキストをリセット）。
//  - IN_STOCK 検知時は alert 前に一度だけ確認リチェック（誤検知防止）。
//  - 在庫中の再通知はスロットルし、OUT_OF_STOCK に戻ったら再アーム。
//  - 状態更新はイミュータブル（withState が常に新オブジェクトを返す）。
//
// NOTE: このスクリプトは監視本体（ワークフロースクリプトではない）ため、
//       Date.now() / Math.random() などの時刻・乱数 API を自由に利用する。

import { STATES } from "./states.js";
import { fetchInventoryInPage, judgeInventory } from "./inventory.js";
import {
  launchBrowser,
  closeBrowser,
  connectToChrome,
  disconnectChrome,
} from "./browser.js";

// Akamai のアクセス拒否を示す文字列（英語・日本語の両ロケール）。
const accessDeniedNeedles = Object.freeze([
  "Access Denied",
  "アクセスが拒否されました",
]);

// ---- 純粋ヘルパー（immutable / 副作用なし） ----

/**
 * config からループ用チューナブルを導出する（未設定時のみ安全なデフォルトを補う）。
 * @param {object} config
 * @returns {object} 凍結済みループ設定
 */
function buildLoopConfig(config) {
  return Object.freeze({
    navTimeoutMs: config.browser?.navigationTimeoutMs ?? 60_000,
    waitSelectorMs: config.browser?.waitForTimeoutMs ?? 30_000,
    maxFailuresBeforeRelaunch: config.retry?.relaunchAfterFailures ?? 4,
    backoffBaseMs: config.retry?.backoffBaseMs ?? 15_000,
    backoffMaxMs: config.retry?.backoffMaxMs ?? 5 * 60_000,
    recycleIntervalMs: config.browser?.recycleIntervalMs ?? 2.5 * 60 * 60_000,
    signalTimeoutMs: config.browser?.signalTimeoutMs ?? 8_000,
    settleMs: config.browser?.settleMs ?? 1200,
  });
}

/**
 * config.check の範囲でジッター付きスリープ時間（ms）を返す。
 * @param {{minMs:number, maxMs:number}} check
 * @returns {number}
 */
function jitterMs(check) {
  const min = check?.minMs;
  const max = check?.maxMs;
  if (typeof min !== "number" || typeof max !== "number" || max < min) {
    // 設定不正時は安全側に倒して固定 45 秒。
    return 45_000;
  }
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * 連続失敗回数に応じた指数バックオフ時間（ms, 上限あり, 軽いジッター付き）。
 * @param {object} loopConfig buildLoopConfig の戻り値
 * @param {number} failures 1 以上
 * @returns {number}
 */
function backoffMs(loopConfig, failures) {
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
 * 状態更新（immutable）。
 * @param {LoopState} state
 * @param {Partial<LoopState>} patch
 * @returns {LoopState}
 */
function withState(state, patch) {
  return Object.freeze({ ...state, ...patch });
}

// ---- ページ操作（副作用あり。例外は呼び出し側で必ずハンドル） ----

/**
 * 在庫を評価する。
 * 初回（firstLoad）のみ商品ページを開いて tesla.com オリジンと Akamai セッションを確立し、
 * 以降は reload せず、在庫 API（inventory.json）をブラウザ内 fetch で叩いて判定する。
 * @param {import("playwright").Page} page
 * @param {boolean} firstLoad 初回なら商品ページを開く（セッション確立）
 * @param {object} config
 * @param {object} loopConfig
 * @returns {Promise<{state:string, signals:object}>}
 */
async function evaluatePage(page, firstLoad, config, loopConfig) {
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

// ---- 公開 API ----

/**
 * 監視モニターを生成する。
 *
 * @param {object} params
 * @param {object} params.config   src/config.js 互換の設定オブジェクト
 * @param {object} params.logger   createLogger が返すロガー
 * @param {boolean} [params.attach=false]
 *   true: 既存 Chrome に CDP 接続（ユーザーの信頼済みセッションを利用）
 *   false: Playwright の永続コンテキストを起動
 * @param {{alertInStock:Function, notifyError:Function}} params.alerter
 *   通知の実装（macOS CLI 版 notifier.js / Electron 版 alerter.js）
 * @param {(event:object)=>void} [params.onEvent]
 *   状態変化の通知コールバック（GUI 用）。例外は内部で握りつぶす。
 * @returns {{start:()=>Promise<void>, stop:(reason?:string)=>Promise<void>, checkOnce:()=>Promise<object>, isRunning:()=>boolean}}
 */
export function createMonitor({ config, logger, attach = false, alerter, onEvent }) {
  // ---- システム境界のバリデーション ----
  if (!config || typeof config !== "object") {
    throw new TypeError("createMonitor: config が必要です");
  }
  if (!logger || typeof logger.info !== "function") {
    throw new TypeError("createMonitor: 有効な logger が必要です");
  }
  if (
    !alerter ||
    typeof alerter.alertInStock !== "function" ||
    typeof alerter.notifyError !== "function"
  ) {
    throw new TypeError(
      "createMonitor: alerter には alertInStock / notifyError が必要です"
    );
  }

  const loopConfig = buildLoopConfig(config);

  // ---- 内部状態（このクロージャ内に閉じたローカル状態） ----
  let shuttingDown = false;
  let abortController = null;
  let activeLoop = null;
  let browserHandle = null;

  const emit = (event) => {
    if (typeof onEvent !== "function") return;
    try {
      onEvent(Object.freeze({ ...event }));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.warn("onEvent コールバックでエラーが発生しました（無視）", { error: m });
    }
  };

  /**
   * モードに応じてブラウザを取得する。
   * - attach: 既存 Chrome に CDP 接続（ユーザーの信頼済みセッションを利用）。
   * - 通常 : 永続コンテキストを起動（ウォームアップ含む）。
   */
  async function acquire() {
    if (attach) {
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
   * - attach: 監視用に開いた新規タブを閉じてから CDP 切断（ユーザーの Chrome は閉じない）。
   * - 通常 : コンテキストを close（SingletonLock 解放）。
   */
  async function release(handle) {
    if (!handle) return;
    if (handle.attached) {
      // 監視が自分で開いた新規タブのみ閉じる。これを怠ると --once / 再接続のたびに
      // 商品ページタブが残留し、Chrome のメモリを圧迫する（実測でタブ大量残留を確認）。
      if (handle.ownsPage && handle.page) {
        try {
          await handle.page.close();
          logger.info("監視タブを閉じました");
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          logger.warn("監視タブのクローズに失敗しました（無視して継続）", {
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
   */
  async function relaunchHandle(oldHandle, reason) {
    logger.warn(attach ? "CDP を再接続します" : "ブラウザを再起動します", { reason });
    emit({ type: "relaunch", reason });
    try {
      await release(oldHandle);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.warn("旧ブラウザの解放に失敗しました（続行）", { error: m });
    }
    return acquire();
  }

  /**
   * IN_STOCK の確認リチェック。再評価して再度 IN_STOCK なら true。
   */
  async function confirmInStock(page) {
    try {
      logger.info("在庫検知 → 確認リチェックを実行します");
      const confirm = await evaluatePage(page, false, config, loopConfig);
      const ok = confirm.state === STATES.IN_STOCK;
      if (!ok) {
        logger.warn(
          "確認リチェックで在庫が確認できませんでした（誤検知の可能性）",
          { state: confirm.state }
        );
      }
      return ok;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      logger.warn("確認リチェックでエラーが発生しました", { error: m });
      return false;
    }
  }

  /**
   * 1 サイクルを処理し、新しいループ状態と、必要なら relaunch 要求を返す。
   * 例外は内部で握り、failures をインクリメントした状態を返す（ループは止めない）。
   */
  async function runCycle(page, state) {
    try {
      const result = await evaluatePage(page, state.firstLoad, config, loopConfig);
      const summary = summarizeSignals(result);

      // Access Denied は失敗扱い（Akamai 再チャレンジ）。
      if (isAccessDenied(result)) {
        logger.warn("Akamai 再チャレンジを検知しました（Access Denied）");
        const next = withState(state, {
          failures: state.failures + 1,
          firstLoad: false,
        });
        const needRelaunch =
          next.failures >= loopConfig.maxFailuresBeforeRelaunch;
        return {
          state: next,
          needRelaunch,
          relaunchReason: needRelaunch ? "access-denied" : null,
        };
      }

      // ハートビートログ（毎サイクル）。
      logger.event("ハートビート", summary);
      emit({ type: "heartbeat", summary });

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
        const confirmed = await confirmInStock(page);
        if (confirmed) {
          logger.event("在庫あり（確認済み）→ アラートを発報します", summary);
          emit({ type: "instock", summary });
          try {
            await alerter.alertInStock({ page, config, logger });
          } catch (alertErr) {
            // 通知失敗で監視を止めない。
            const m =
              alertErr instanceof Error ? alertErr.message : String(alertErr);
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
   * 監視のメインループ。stop() が呼ばれるまで回り続ける。
   */
  async function runLoopInternal() {
    const { signal } = abortController;
    emit({ type: "status", status: "starting", attach });

    // ---- 初回起動 ----
    try {
      browserHandle = await acquire();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (attach) {
        logger.error("既存 Chrome への CDP 接続に失敗しました", {
          error: m,
          hint: "Chrome を --remote-debugging-port 付きで起動しているか確認してください",
        });
        await alerter.notifyError(`CDP 接続に失敗しました: ${m}`, config, logger);
      } else {
        logger.error("ブラウザの初回起動に失敗しました", { error: m });
        await alerter.notifyError(`ブラウザ起動に失敗しました: ${m}`, config, logger);
      }
      emit({ type: "status", status: "error", message: m });
      throw err instanceof Error ? err : new Error(m);
    }

    let state = freshState(Date.now());
    logger.info("監視を開始します", {
      mode: attach ? "attach(CDP/既存Chrome)" : "launch(自動ブラウザ)",
      url: config.productUrl,
      minMs: config.check.minMs,
      maxMs: config.check.maxMs,
    });
    emit({ type: "status", status: "monitoring" });

    try {
      // ---- メインループ ----
      while (!shuttingDown) {
        // 定期リサイクル（RSS 解放）。失敗回数とは独立。
        // attach モードではユーザーの Chrome を再起動しない（メモリ管理は Chrome 任せ）。
        const age = Date.now() - state.launchedAt;
        if (!browserHandle.attached && age >= loopConfig.recycleIntervalMs) {
          try {
            browserHandle = await relaunchHandle(browserHandle, "periodic-recycle");
            state = withState(state, {
              firstLoad: true,
              launchedAt: browserHandle.launchedAt,
            });
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            logger.error("定期リサイクルに失敗しました", { error: m });
            await sleep(backoffMs(loopConfig, 1), signal);
            continue;
          }
        }

        const { state: nextState, needRelaunch, relaunchReason } = await runCycle(
          browserHandle.page,
          state
        );
        state = nextState;

        if (shuttingDown) break;

        // 連続失敗でブラウザ再起動が要求された場合。
        if (needRelaunch) {
          // バックオフを先に取ってから再起動する（リサーチブリーフ: backoff first）。
          const wait = backoffMs(loopConfig, state.failures);
          logger.warn("再起動前にバックオフします", {
            failures: state.failures,
            reason: relaunchReason,
            waitMs: wait,
          });
          await sleep(wait, signal);
          if (shuttingDown) break;
          try {
            browserHandle = await relaunchHandle(browserHandle, relaunchReason);
            // 再起動後は failures リセット & 初回ロード扱い。
            state = withState(state, {
              failures: 0,
              firstLoad: true,
              launchedAt: browserHandle.launchedAt,
            });
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            logger.error("ブラウザの再起動に失敗しました", { error: m });
            await alerter.notifyError(
              `ブラウザ再起動に失敗しました: ${m}`,
              config,
              logger
            );
            // 致命的だが、長めに待って再試行する（監視を諦めない）。
            await sleep(loopConfig.backoffMaxMs, signal);
          }
          continue;
        }

        // 通常サイクル後のスリープ。
        // 失敗が残っている（再起動閾値未満）場合はバックオフ、そうでなければジッター。
        const waitMs =
          state.failures > 0
            ? backoffMs(loopConfig, state.failures)
            : jitterMs(config.check);
        logger.info("次のチェックまで待機します", {
          waitMs,
          failures: state.failures,
          inStockAlerted: state.inStockAlerted,
        });
        await sleep(waitMs, signal);
      }
    } finally {
      // ---- グレースフルシャットダウン（停止要求・例外の両方で必ず解放する） ----
      try {
        await release(browserHandle);
        logger.info(
          attach
            ? "CDP 接続を切断しました（Chrome は起動したまま）"
            : "ブラウザをクローズしました（SingletonLock 解放）"
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.warn("シャットダウン時の解放に失敗しました", { error: m });
      }
      browserHandle = null;
      emit({ type: "status", status: "stopped" });
      logger.info("監視を終了しました。さようなら。");
    }
  }

  /**
   * 監視を開始する。停止（stop / 致命的エラー）まで解決しない。
   * @returns {Promise<void>}
   */
  async function start() {
    if (activeLoop) {
      throw new Error("監視は既に実行中です");
    }
    shuttingDown = false;
    abortController = new AbortController();
    activeLoop = runLoopInternal();
    try {
      await activeLoop;
    } finally {
      activeLoop = null;
      abortController = null;
    }
  }

  /**
   * 監視を停止する。ループの完全終了（ブラウザ解放まで）を待って解決する。
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async function stop(reason = "stop") {
    const loop = activeLoop;
    if (!loop) return;
    if (!shuttingDown) {
      shuttingDown = true;
      logger.info("シャットダウンを開始します", { reason });
      abortController?.abort();
    }
    try {
      await loop;
    } catch {
      // start() 側で処理されるエラーはここでは無視する。
    }
  }

  /**
   * 単発チェック。接続 → 評価 → 解放して結果を返す（--once 用）。
   * 失敗しても throw せず state=unknown を返す（呼び出し側で扱いやすい形）。
   * @returns {Promise<{state:string, signals:object}>}
   */
  async function checkOnce() {
    if (activeLoop) {
      throw new Error("監視ループの実行中は checkOnce を使えません");
    }
    let handle = null;
    try {
      handle = await acquire();
      const result = await evaluatePage(handle.page, true, config, loopConfig);
      return Object.freeze({ state: result.state, signals: result.signals });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("単発チェックに失敗しました", { error: message });
      return Object.freeze({
        state: STATES.UNKNOWN,
        signals: Object.freeze({ error: message }),
      });
    } finally {
      if (handle) {
        try {
          await release(handle);
        } catch (closeErr) {
          const m =
            closeErr instanceof Error ? closeErr.message : String(closeErr);
          logger.warn("ブラウザの解放に失敗しました", { error: m });
        }
      }
    }
  }

  return Object.freeze({
    start,
    stop,
    checkOnce,
    isRunning: () => activeLoop !== null,
  });
}
