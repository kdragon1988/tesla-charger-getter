// src/states.js
// 在庫状態の定数（複数モジュールで共有する単一の信頼できる定義）。
//
// 設計方針: 誤った IN_STOCK よりも UNKNOWN を優先する（保守的に倒す）。
// monitor 側でアラート前に必ず再確認するため、判定不能時は UNKNOWN を返す。
export const STATES = Object.freeze({
  IN_STOCK: "in_stock", // 在庫あり（購入可能）
  OUT_OF_STOCK: "out_of_stock", // 在庫切れ
  UNKNOWN: "unknown", // 判定不能（通信失敗 / Akamai チャレンジ / 不正レスポンス）
});
