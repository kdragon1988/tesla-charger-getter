#!/usr/bin/env bash
# setup.sh — 初回セットアップ（依存関係のインストール）。
# これを1回実行したあと、./start.sh で監視を開始できます。
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================================"
echo " Tesla充電器Getter セットアップ"
echo "============================================================"

# Node.js の確認
if ! command -v node >/dev/null 2>&1; then
  echo "[setup] エラー: Node.js が見つかりません。" >&2
  echo "[setup] https://nodejs.org/ja から LTS 版をインストールして、もう一度実行してください。" >&2
  exit 1
fi
echo "[setup] Node.js $(node -v) を検出しました。"

# 依存パッケージ（Playwright）のインストール
echo "[setup] 依存パッケージをインストールします..."
npm install

# Playwright のブラウザ実体を準備（実 Chrome が無い環境のフォールバック用）
echo "[setup] Playwright のブラウザを準備します..."
npx playwright install chromium || true

echo ""
echo "[setup] ✅ セットアップ完了！"
echo "[setup] 次は ./start.sh を実行すると監視が始まります。"
