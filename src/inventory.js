// src/inventory.js
// 在庫 API（inventory.json）ベースの検知。
// ページ全体の reload より軽量・確実・高頻度な検知方式。
//
// API 仕様（実測 2026-06-09）:
//   POST https://shop.tesla.com/ja_jp/inventory.json
//   body: ["<skuCode>"]   headers: content-type: application/json
//   resp: [{"purchasable":false,"skuCode":"...","error":"Out of stock","inventoryCount":0}]
//
// 設計:
//   - fetchInventoryInPage は page.evaluate に渡す「純粋関数」。tesla.com オリジンから
//     POST fetch し、生レスポンス（status/json/text）を返す（外部クロージャ参照なし）。
//   - judgeInventory は Node 側でその結果を在庫状態へ変換する純粋関数。
//   - 判定は inventoryCount（物理在庫数・ログイン非依存）を主軸にし、purchasable で補助する。

import { STATES } from "./states.js";

/**
 * page.evaluate に渡す純粋関数。在庫 API を POST で叩いて生レスポンスを返す。
 * 例外・非 JSON（Akamai の Access Denied HTML 等）も握って構造化して返す。
 * @param {{ apiUrl: string, skuCode: string }} arg
 * @returns {Promise<{ ok: boolean, status: number, json: any, textSnippet: string, error?: string }>}
 */
export const fetchInventoryInPage = async ({ apiUrl, skuCode }) => {
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([skuCode]),
      credentials: "include",
      cache: "no-store",
    });
    let text = "";
    try {
      text = await res.text();
    } catch (_e) {
      text = "";
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_e) {
      json = null;
    }
    return { ok: true, status: res.status, json, textSnippet: text.slice(0, 200) };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { ok: false, status: 0, json: null, textSnippet: "", error: msg };
  }
};

/**
 * fetch 結果を在庫状態へ変換する（Node 側・純粋関数・イミュータブル）。
 * @param {{ ok:boolean, status:number, json:any, textSnippet?:string, error?:string }} raw
 * @param {string} skuCode 対象 SKU
 * @returns {{ state: string, signals: object }}
 */
export function judgeInventory(raw, skuCode) {
  const mkSignals = (over) =>
    Object.freeze({
      source: "inventory-api",
      status: raw?.status ?? null,
      purchasable: null,
      inventoryCount: null,
      apiError: null,
      ...over,
    });

  // 通信失敗 / 非 200 → UNKNOWN（上位でバックオフ・再接続）
  if (!raw || raw.ok !== true || raw.status !== 200) {
    return {
      state: STATES.UNKNOWN,
      signals: mkSignals({ apiError: raw?.error ?? raw?.textSnippet ?? "non-200" }),
    };
  }
  // JSON でない（Access Denied の HTML 等）→ UNKNOWN
  if (!Array.isArray(raw.json)) {
    return {
      state: STATES.UNKNOWN,
      signals: mkSignals({ apiError: raw.textSnippet || "non-json" }),
    };
  }

  const entry =
    raw.json.find((e) => e && e.skuCode === skuCode) || raw.json[0] || null;
  if (!entry || typeof entry !== "object") {
    return { state: STATES.UNKNOWN, signals: mkSignals({ apiError: "no-entry" }) };
  }

  const count = Number(entry.inventoryCount);
  const hasCount = Number.isFinite(count);
  const errStr = typeof entry.error === "string" ? entry.error : null;
  const signals = mkSignals({
    purchasable: entry.purchasable ?? null,
    inventoryCount: hasCount ? count : null,
    apiError: errStr,
  });

  // --- 在庫あり: purchasable===true が真の指標 ---
  // 重要（実測 2026-06-09）: 在庫ありでも inventoryCount は 0 を返す商品がある
  //   在庫あり → {"purchasable":true, "error":"",            "inventoryCount":0}
  //   在庫なし → {"purchasable":false,"error":"Out of stock","inventoryCount":0}
  // よって inventoryCount===0 を在庫切れの根拠にしてはならない（在庫ありを取りこぼす）。
  // purchasable を主軸にし、inventoryCount>0 は在庫ありの十分条件として補助的に使う。
  if (entry.purchasable === true || (hasCount && count > 0)) {
    return { state: STATES.IN_STOCK, signals };
  }
  // --- 在庫切れ: purchasable===false または "Out of stock" ---
  if (entry.purchasable === false || errStr === "Out of stock") {
    return { state: STATES.OUT_OF_STOCK, signals };
  }
  // --- それ以外は保守的に UNKNOWN ---
  return { state: STATES.UNKNOWN, signals };
}
