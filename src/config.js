// src/config.js
// ------------------------------------------------------------------
// 集中設定モジュール（唯一の信頼できる設定ソース）。
// ------------------------------------------------------------------
// ロジック側にはハードコード値を一切置かない方針のため、
// 調整可能なパラメータはすべてこのファイルに集約する。
// 値はイミュータブルに扱うため Object.freeze で凍結し、
// 実行中に誤って書き換えられないようにする。
// ------------------------------------------------------------------

/**
 * 監視対象の Tesla オンラインショップ商品ページ URL。
 */
const productUrl =
  "https://shop.tesla.com/ja_jp/product/gen-2-mobile-connector-bundle-jp";

/**
 * ポーリング間隔（ミリ秒）。
 * 在庫復活はランダムなタイミングで発生するため、ジッターを入れてアクセスを自然化する。
 *
 * トレードオフ: 間隔が短いほど在庫復活を早く検知できるが、高頻度で同一商品ページを
 *   reload し続けると Akamai がアクセスパターンを学習し "Access Denied" でブロックする
 *   （実測: 30〜60 秒で約2時間後に発生）。
 *   現在の在庫は復活後 2〜3 分で売り切れる競争状況のため、検知速度を優先して 60〜90 秒に設定する。
 *   ブロック対策は接続/再接続時の warmUp（ショップトップ経由）と指数バックオフで補う。
 */
const check = Object.freeze({
  minMs: 10000, // 最小ポーリング間隔: 10 秒（在庫API直叩きは軽量なため高頻度化）
  maxMs: 20000, // 最大ポーリング間隔: 20 秒（谷間を最大20秒に圧縮し取りこぼしを低減）
});

/**
 * ブラウザ起動設定。
 * Akamai Bot Manager を満たすため、永続コンテキスト
 * （chromium.launchPersistentContext）で実ブラウザ（channel:"chrome"）を
 * ヘッドありで起動する。userDataDir により Cookie / ログインが
 * 長時間セッションをまたいで保持される。
 */
const browser = Object.freeze({
  userDataDir: "./.user-data", // 永続プロファイル（.gitignore 対象）
  channel: "chrome", // まず実 Chrome を試し、失敗時は bundled chromium にフォールバック
  headless: false, // Akamai 対策のためヘッドありで実行
  locale: "ja-JP", // 日本語ロケール
  timezoneId: "Asia/Tokyo", // タイムゾーンを東京に固定
  viewport: Object.freeze({ width: 1280, height: 900 }), // 一般的なデスクトップ解像度
  navigationTimeoutMs: 60000, // ページ遷移のタイムアウト（ミリ秒）
  waitForTimeoutMs: 30000, // 安定セレクタ待機のタイムアウト（ミリ秒）
  recycleIntervalMs: 2.5 * 60 * 60000, // ブラウザ定期リサイクル間隔（2.5時間, RSS解放）
  warmUpUrl: "https://shop.tesla.com/ja_jp/", // 商品ページ前に温めるショップトップ（Akamaiセッション確立用。null で無効化）
  signalTimeoutMs: 8000, // 決定的な在庫シグナル（バリアントのoutOfStockクラス/本文「在庫切れ」/「カートに追加」/購入ボタン可視化）が描画されるまでの待機上限（誤検知防止の要）
  settleMs: 1200, // 上記シグナル確定後、描画の最終安定を待つ追加クッション（誤検知防止）
});

/**
 * 検出に用いる CSS セレクタ群（detector / monitor で共有）。
 * ライブページ（2026-06-08 確認）に対して検証済みの値であり、
 * 仕様から逸脱してはならない（verbatim）。
 *
 * - activeVariant    : 現在選択中のバリアント（在庫切れ時は outOfStock クラスを持つ）
 * - anyVariant       : 任意のバリアント要素（activeVariant が取れない場合のフォールバック）
 * - purchasable      : 「カートに追加する」ボタン（在庫ありかつログイン時に表示）
 * - outOfStockBtn    : 「在庫切れ」ボタン（在庫切れ時に表示）
 * - productContainer : 商品詳細コンテナ（ページ読み込み判定に使用）
 * - waitFor          : 各サイクルで待機する安定セレクタ
 *
 * 注意: JSON-LD の offers.availability と data-inventory-availability="true" は
 *       常に「在庫あり」を返すトラップのため、検出には絶対に使用しない。
 */
const selectors = Object.freeze({
  activeVariant: ".product__container__details__size__items__item.active",
  anyVariant: ".product__container__details__size__items__item",
  purchasable: ".btn-purchasable",
  outOfStockBtn: ".btn-outOfStock",
  productContainer: ".product__container__details",
  // 待機セレクタは購入ボタン領域にする。コンテナは早く attach されるが、
  // 在庫シグナル（バリアントの outOfStock クラス・「在庫切れ」テキスト・購入ボタン）は
  // 後から描画されるため、購入ボタンが出るまで待ってから評価する（誤検知防止）。
  waitFor: ".product__container__details__submit__buy",
});

/**
 * 在庫復活時のアラート設定。
 * macOS の通知 + システムサウンド + 日本語の音声読み上げを
 * repeat 回、intervalMs 間隔で繰り返す。
 *
 * 注意: 仕様で指定された Sonar.aiff は新しい macOS では削除されている
 *       場合がある。notifier 側で sound が存在しない場合に備え、
 *       検証済みの soundFallback（Glass.aiff）を併せて提供する。
 */
const alert = Object.freeze({
  repeat: 20, // アラート最大繰り返し回数
  intervalMs: 3000, // アラート間隔: 3 秒
  sound: "/System/Library/Sounds/Sonar.aiff", // 主サウンド（仕様準拠）
  soundFallback: "/System/Library/Sounds/Glass.aiff", // 主サウンド欠落時のフォールバック
  voiceMessage: "テスラの在庫が復活しました。今すぐ購入してください。", // say コマンド用の日本語メッセージ
  reAlertThrottleMs: 5 * 60000, // 一度アラート後、再アラートを抑制する時間（ミリ秒）
});

/**
 * 監視のリトライ / バックオフ挙動。
 * UNKNOWN や例外が連続したときの指数バックオフと、
 * Akamai 再チャレンジ対策としてのブラウザ再起動しきい値を定義する。
 */
const retry = Object.freeze({
  backoffBaseMs: 15000, // 連続失敗時のバックオフ基準（ミリ秒）
  backoffMaxMs: 5 * 60000, // バックオフの上限（ミリ秒）
  relaunchAfterFailures: 4, // この回数連続で失敗したらブラウザを再起動する
});

/**
 * ログ出力先ファイル。
 * logger が親ディレクトリ（logs/）を自動生成する。
 */
const logFile = "./logs/monitor.log";

/**
 * --attach モード（CDP 接続）の設定。
 * ユーザーが起動済みの実 Chrome（--remote-debugging-port=9222）に接続し、
 * ログイン済み・Akamai に信頼されたセッションをそのまま使って監視する。
 * スクリプトが起動する自動ブラウザが Tesla にブロックされる場合の本命の回避策。
 */
const attach = Object.freeze({
  cdpUrl: "http://localhost:9222", // 既存 Chrome の DevTools Protocol エンドポイント
  useNewTab: true, // 監視用に新規タブを開く（ユーザーの現在のタブを乗っ取らない）
});

/**
 * 在庫 API（inventory.json）設定。
 * 商品ページが内部で叩く本物の在庫 API。POST + ["SKU"] で在庫数を直接返す:
 *   [{"purchasable":false,"skuCode":"...","error":"Out of stock","inventoryCount":0}]
 * reload（重い・Akamai 負荷大）を使わず、この API をブラウザ内 fetch で叩くことで、
 * 軽量・確実・高頻度な在庫検知を実現する（取りこぼし・誤検知・ブロックを同時に低減）。
 */
const inventory = Object.freeze({
  apiUrl: "https://shop.tesla.com/ja_jp/inventory.json", // 在庫 API エンドポイント（POST）
  skuCode: "1458882-00-D", // 監視対象 SKU（Gen 2 モバイルコネクター バンドル JP）
  refreshSessionMs: 25 * 60000, // この間隔でページを開き直して Akamai セッション(_abck)を再確立（25分）
});

/**
 * アプリ全体の設定オブジェクト。
 * 不変性を保証するため Object.freeze で凍結する。
 */
export const config = Object.freeze({
  productUrl,
  check,
  browser,
  selectors,
  alert,
  retry,
  attach,
  inventory,
  logFile,
});
