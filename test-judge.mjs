// test-judge.mjs（ユニット検証）: judgeInventory の判定を全ケースで確認する。
// 実 API を叩かないので軽量・Akamai 負荷ゼロ。実測したレスポンス形式を網羅する。
import { judgeInventory } from "./src/inventory.js";

const J = (entry) => ({ ok: true, status: 200, json: [entry], textSnippet: "" });
const cases = [
  {
    name: "在庫あり（purchasable:true, count:0）★実測のアパレル形式",
    raw: J({ purchasable: true, skuCode: "X", error: "", inventoryCount: 0 }),
    sku: "X",
    expect: "in_stock",
  },
  {
    name: "在庫あり（count>0）",
    raw: J({ purchasable: true, skuCode: "Z", error: "", inventoryCount: 5 }),
    sku: "Z",
    expect: "in_stock",
  },
  {
    name: "在庫なし（purchasable:false, Out of stock）★実測の監視商品形式",
    raw: J({ purchasable: false, skuCode: "Y", error: "Out of stock", inventoryCount: 0 }),
    sku: "Y",
    expect: "out_of_stock",
  },
  {
    name: "Access Denied（非JSON）",
    raw: { ok: true, status: 200, json: null, textSnippet: "Access Denied" },
    sku: "X",
    expect: "unknown",
  },
  { name: "非200", raw: { ok: true, status: 403, json: null }, sku: "X", expect: "unknown" },
  { name: "通信失敗", raw: { ok: false, status: 0, error: "net error" }, sku: "X", expect: "unknown" },
];

let pass = 0;
for (const c of cases) {
  const v = judgeInventory(c.raw, c.sku);
  const ok = v.state === c.expect;
  if (ok) pass += 1;
  console.log(`${ok ? "✓" : "✗"} ${c.name} => ${v.state} (期待:${c.expect})`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
