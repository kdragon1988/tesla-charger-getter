#!/usr/bin/env bash
# start.sh — 監視を開始する（監視用Chromeの起動 → 在庫監視）。
# これ1つで始められます。停止は Ctrl-C。
#
# 仕組み:
#   - 監視には「実Chromeのデバッグ接続(CDP)」を使う。Playwright が起動する自動ブラウザは
#     Akamai(bot対策)に弾かれやすいが、実Chromeのセッションは弾かれにくいため。
#   - 普段使いのChromeと競合しないよう「専用プロファイル」でChromeを起動する
#     （普段のChromeはそのまま使えます）。
#   - macOS の Chrome は既定プロファイルではデバッグポートを開けない仕様（136以降）のため、
#     専用プロファイルが必須。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${REMOTE_DEBUG_PORT:-9222}"
PROFILE="${MONITOR_CHROME_PROFILE:-$HOME/Library/Application Support/tesla-getter-chrome}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# 依存チェック
if [ ! -d node_modules ]; then
  echo "[start] 依存関係が未インストールです。先に ./setup.sh を実行してください。" >&2
  exit 1
fi

# 監視用Chromeがデバッグポートで起動済みか確認。未起動なら起動する。
if curl -s --max-time 2 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "[start] 監視用ブラウザは起動済みです（ポート ${PORT}）。"
else
  if [ ! -x "$CHROME" ]; then
    echo "[start] エラー: Google Chrome が見つかりません: $CHROME" >&2
    echo "[start] Chrome をインストールしてください: https://www.google.com/chrome/" >&2
    exit 1
  fi
  echo "[start] 監視用Chromeを起動します（専用プロファイル / 普段のChromeとは別）..."
  # open -na で独立インスタンスとして起動（直接バイナリ実行はサンドボックスでクラッシュするため）。
  open -na "Google Chrome" --args \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port="$PORT" \
    --no-first-run \
    --no-default-browser-check >/dev/null 2>&1 || true
  # デバッグポートが開くまで待つ（最大20秒）。
  for _ in $(seq 1 20); do
    curl -s --max-time 2 "http://localhost:${PORT}/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -s --max-time 2 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    echo "[start] エラー: 監視用Chromeのデバッグポートが開きませんでした。" >&2
    echo "[start] 既に別の用途でポート ${PORT} を使っていないか確認してください。" >&2
    exit 1
  fi
  echo "[start] 監視用Chromeを起動しました。"
fi

echo ""
echo "============================================================"
echo " 在庫監視を開始します。停止するには Ctrl-C を押してください。"
echo ""
echo " （任意・推奨）開いた監視用Chromeのウィンドウで Tesla アカウントに"
echo " 一度ログインしておくと、在庫復活時にワンクリックで購入できます。"
echo " ※このログインは初回だけでOK（専用プロファイルに保存されます）。"
echo "============================================================"
echo ""

exec node src/monitor.js --attach
