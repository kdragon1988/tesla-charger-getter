// test-app-units.mjs
// Electron アプリ層の純粋関数のユニットテスト（Electron 本体に依存しない部分のみ）。
//   - chrome-launcher: 実行ファイル候補パスの導出
//   - settings: バリデーション / ロケール追従 URL 導出 / 実行時 config 合成
// 実行: node test-app-units.mjs

import assert from "node:assert/strict";
import path from "node:path";
import { chromeCandidatePaths } from "./electron/chrome-launcher.js";
import {
  defaultSettings,
  validateSettings,
  deriveShopBaseUrl,
  buildRuntimeConfig,
} from "./electron/settings.js";
import { config as baseConfig } from "./src/config.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
  }
}

console.log("=== chrome-launcher: chromeCandidatePaths ===");

test("darwin: /Applications の Chrome を最優先する", () => {
  const paths = chromeCandidatePaths("darwin", { HOME: "/Users/taro" });
  assert.equal(
    paths[0],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
  assert.ok(paths[1].startsWith("/Users/taro/"));
});

test("win32: Chrome 候補 → Edge フォールバックの順になる", () => {
  const env = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\taro\\AppData\\Local",
  };
  const paths = chromeCandidatePaths("win32", env);
  assert.equal(paths.length, 5);
  assert.ok(paths[0].includes(path.join("Google", "Chrome")));
  assert.ok(paths[2].includes("AppData"));
  assert.ok(paths[3].includes(path.join("Microsoft", "Edge")));
});

test("win32: 環境変数が無いものはスキップされる", () => {
  const paths = chromeCandidatePaths("win32", {
    PROGRAMFILES: "C:\\Program Files",
  });
  assert.equal(paths.length, 2); // Chrome ×1 + Edge ×1
});

test("linux: 既知の候補パスを返す", () => {
  const paths = chromeCandidatePaths("linux", {});
  assert.ok(paths.includes("/usr/bin/google-chrome"));
});

console.log("=== settings: validateSettings ===");

const validBase = Object.freeze({
  productUrl: "https://shop.tesla.com/ja_jp/product/gen-2-mobile-connector-bundle-jp",
  skuCode: "1458882-00-D",
  minSec: 10,
  maxSec: 20,
  debugPort: 9222,
});

test("正常な設定を受理する", () => {
  const result = validateSettings(validBase);
  assert.equal(result.ok, true);
  assert.equal(result.value.skuCode, "1458882-00-D");
});

test("shop.tesla.com 以外の URL を拒否する", () => {
  const result = validateSettings({ ...validBase, productUrl: "https://example.com/x" });
  assert.equal(result.ok, false);
});

test("http（非 https）の URL を拒否する", () => {
  const result = validateSettings({
    ...validBase,
    productUrl: "http://shop.tesla.com/ja_jp/product/x",
  });
  assert.equal(result.ok, false);
});

test("不正な SKU（記号入り）を拒否する", () => {
  const result = validateSettings({ ...validBase, skuCode: "abc;rm -rf" });
  assert.equal(result.ok, false);
});

test("間隔の下限（5秒未満）を拒否する", () => {
  const result = validateSettings({ ...validBase, minSec: 1 });
  assert.equal(result.ok, false);
});

test("最小 > 最大 を拒否する", () => {
  const result = validateSettings({ ...validBase, minSec: 30, maxSec: 10 });
  assert.equal(result.ok, false);
});

test("数値文字列の間隔も受理する（フォーム入力対応）", () => {
  const result = validateSettings({ ...validBase, minSec: "10", maxSec: "20" });
  assert.equal(result.ok, true);
  assert.equal(result.value.minSec, 10);
});

test("不正なデバッグポートを拒否する", () => {
  const result = validateSettings({ ...validBase, debugPort: 80 });
  assert.equal(result.ok, false);
});

console.log("=== settings: deriveShopBaseUrl ===");

test("ja_jp ロケールのベース URL を導出する", () => {
  assert.equal(
    deriveShopBaseUrl("https://shop.tesla.com/ja_jp/product/some-product"),
    "https://shop.tesla.com/ja_jp"
  );
});

test("en_us など別ロケールにも追従する", () => {
  assert.equal(
    deriveShopBaseUrl("https://shop.tesla.com/en_us/product/wall-connector"),
    "https://shop.tesla.com/en_us"
  );
});

test("ロケールが取れない URL は null を返す", () => {
  assert.equal(deriveShopBaseUrl("https://shop.tesla.com/product/x"), null);
  assert.equal(deriveShopBaseUrl("not-a-url"), null);
});

console.log("=== settings: defaultSettings / buildRuntimeConfig ===");

test("defaultSettings が baseConfig から既定値を導出する", () => {
  const defaults = defaultSettings(baseConfig);
  assert.equal(defaults.productUrl, baseConfig.productUrl);
  assert.equal(defaults.skuCode, baseConfig.inventory.skuCode);
  assert.equal(defaults.minSec, Math.round(baseConfig.check.minMs / 1000));
});

test("buildRuntimeConfig がユーザー設定とアプリパスを反映する", () => {
  const settings = Object.freeze({
    productUrl: "https://shop.tesla.com/en_us/product/wall-connector",
    skuCode: "9999999-00-A",
    minSec: 15,
    maxSec: 30,
    debugPort: 9333,
  });
  const paths = Object.freeze({
    chromeProfile: "/tmp/profile",
    logFile: "/tmp/logs/monitor.log",
  });
  const runtime = buildRuntimeConfig(baseConfig, settings, paths);

  assert.equal(runtime.productUrl, settings.productUrl);
  assert.equal(runtime.check.minMs, 15000);
  assert.equal(runtime.check.maxMs, 30000);
  assert.equal(runtime.inventory.skuCode, "9999999-00-A");
  assert.equal(runtime.inventory.apiUrl, "https://shop.tesla.com/en_us/inventory.json");
  assert.equal(runtime.browser.warmUpUrl, "https://shop.tesla.com/en_us/");
  assert.equal(runtime.browser.userDataDir, "/tmp/profile");
  assert.equal(runtime.attach.cdpUrl, "http://localhost:9333");
  assert.equal(runtime.logFile, "/tmp/logs/monitor.log");
  // baseConfig 自体は変更されていない（イミュータブル）。
  assert.equal(baseConfig.inventory.skuCode, "1458882-00-D");
});

test("buildRuntimeConfig はロケール不明時に既定の apiUrl を維持する", () => {
  const settings = Object.freeze({
    productUrl: "https://shop.tesla.com/ja_jp/product/x",
    skuCode: "1458882-00-D",
    minSec: 10,
    maxSec: 20,
    debugPort: 9222,
  });
  const runtime = buildRuntimeConfig(baseConfig, settings, {
    chromeProfile: "/tmp/p",
    logFile: "/tmp/l.log",
  });
  assert.equal(runtime.inventory.apiUrl, "https://shop.tesla.com/ja_jp/inventory.json");
});

console.log("");
console.log(`結果: ${passed} 件成功 / ${failed} 件失敗`);
if (failed > 0) {
  process.exit(1);
}
