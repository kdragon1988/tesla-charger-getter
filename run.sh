#!/usr/bin/env bash
# run.sh
# Tesla 在庫監視のランチャー。リポジトリのルートから node src/monitor.js を起動する。
# 引数（例: --once）はそのまま監視スクリプトへ渡す。
#
# 使い方:
#   ./run.sh            # 常駐監視モード
#   ./run.sh --once     # 単発チェック（結果を JSON 出力して終了）
#
# 実行権限が無い場合は:  chmod +x run.sh

set -euo pipefail

# このスクリプトが置かれているディレクトリ（= リポジトリルート）へ移動する。
# どこから呼ばれても相対パス（./logs, ./.user-data 等）が正しく解決される。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# node の存在チェック（無ければ分かりやすく失敗させる）。
if ! command -v node >/dev/null 2>&1; then
  echo "[run.sh] エラー: node が見つかりません。Node.js をインストールしてください。" >&2
  exit 1
fi

# 依存（playwright）が未インストールなら案内する。
if [ ! -d "node_modules/playwright" ]; then
  echo "[run.sh] 依存関係が見つかりません。先に 'npm install' を実行してください。" >&2
  exit 1
fi

echo "[run.sh] Tesla 在庫監視を起動します: node src/monitor.js $*"
exec node src/monitor.js "$@"
