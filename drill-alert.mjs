// drill-alert.mjs（模擬テスト）: 在庫復活アラートを本番と同じ経路で発報する。
// 回数だけ短くして（repeat:2）、通知バナー・サウンド・日本語音声・商品ページオープンを確認する。
import { config } from "./src/config.js";
import { createLogger } from "./src/logger.js";
import { alertInStock } from "./src/notifier.js";

const logger = createLogger(config.logFile);

// 本番 config（repeat:20, interval:3000 ≒ 1分）を、訓練用に短縮（repeat:2）した新オブジェクト。
const drillConfig = {
  ...config,
  alert: { ...config.alert, repeat: 2, intervalMs: 2000 },
};

console.log("=== 模擬アラート発報（本番と同じ通知・音・音声・URLオープン） ===");
// page は null（bringToFront は notifier 内で握りつぶされる）。商品ページは open で開く。
await alertInStock({ page: null, config: drillConfig, logger });
console.log("=== 模擬アラート完了 ===");
