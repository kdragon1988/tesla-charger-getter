# Tesla充電器Getter 🔌🚗

Tesla オンラインショップの在庫を常駐監視し、**在庫が復活した瞬間に「アラーム音・デスクトップ通知・日本語音声・商品ページ自動オープン」で知らせる** ツールです。**Mac / Windows 対応のデスクトップアプリ**と、上級者向けの macOS CLI の2つの使い方があります。

人気の充電アクセサリ（Gen 2 モバイルコネクター等）は復活後 **数分で売り切れます**。このツールは在庫を **10〜20秒ごと** にチェックし、復活を逃さずお知らせします。

> 監視対象（既定）: **Gen 2 モバイルコネクター バンドル (JP)**
> アプリの設定画面から別の商品に変えることもできます（→「別の商品を監視する」）。

---

## ✨ 特徴

- **ターミナル不要** — インストールして起動するだけのデスクトップアプリ（Mac は DMG、Windows はインストーラ EXE）。
- **在庫API直叩き方式** — ページ全体を読み込み直すのではなく、Tesla の在庫API（`inventory.json`）を直接叩くため、軽量・高速・高頻度（10〜20秒）。取りこぼしを最小化します。
- **Akamai（bot対策）に強い** — 実 Chrome のセッションを使うのでブロックされにくい。
- **普段の Chrome と共存** — 監視には専用プロファイルの Chrome を使うので、普段のブラウジングを邪魔しません。
- **派手なアラート** — 通知バナー＋アラーム音＋日本語音声を約1分間繰り返し＋商品ページを自動で開く。気づかないことはまずありません。

---

## 🚀 インストール（推奨・ターミナル不要）

### 必要なもの

- **Google Chrome**（[ダウンロード](https://www.google.com/chrome/)）※Windows で Chrome が無い場合は Microsoft Edge でも動きます
- Mac（Apple Silicon / Intel）または Windows 10/11

### 1. ダウンロード

[**Releases ページ**](https://github.com/kdragon1988/tesla-charger-getter/releases) から、お使いの環境に合うファイルをダウンロードします。

| 環境 | ファイル |
|---|---|
| Mac（M1/M2/M3/M4） | `TeslaChargerGetter-x.x.x-arm64.dmg` |
| Mac（Intel） | `TeslaChargerGetter-x.x.x-x64.dmg` |
| Windows | `TeslaChargerGetter-Setup-x.x.x.exe` |

### 2. インストール

- **Mac**: DMG を開き、アプリを「アプリケーション」フォルダにドラッグ。
- **Windows**: EXE をダブルクリック（自動でインストールされ、デスクトップにショートカットができます）。

> **⚠️ 初回起動時のセキュリティ警告について（重要）**
> 本アプリは個人開発のため開発元署名（Apple/Microsoft への登録）がなく、初回に OS の警告が出ます。
> - **Mac**: 「"TeslaChargerGetter" は壊れているため開けません」と表示されます（アプリは壊れていません。未署名アプリをダウンロードすると必ず出る表示です）。**「キャンセル」を押し**、「ターミナル」アプリ（Launchpad →「その他」→「ターミナル」）を開いて、次の1行をコピー＆貼り付けして Enter を押してから、もう一度アプリを開いてください（初回のみ）:
>   ```
>   xattr -rd com.apple.quarantine /Applications/TeslaChargerGetter.app
>   ```
> - **Windows**: 「WindowsによってPCが保護されました」と出たら、**詳細情報 → 実行** をクリック。

### 3. 使い方

1. アプリを起動して **「▶ 監視開始」** をクリック。
2. 監視専用の Chrome が自動で開き、在庫監視が始まります（画面のバッジが「監視中」になります）。
3. **（推奨）開いた監視用 Chrome で一度 Tesla アカウントにログイン**しておくと、在庫復活時に**ワンクリックで購入**できます（初回だけでOK。専用プロファイルに保存されます）。
4. あとは在庫復活を待つだけ。**「🔔 アラートテスト」** ボタンで通知・音・音声の鳴り方を事前確認できます。
5. 停止は **「■ 停止」** ボタン、またはウィンドウを閉じるだけ（ウィンドウを閉じると監視も止まります）。

---

## 在庫が復活すると何が起きる？

検知した瞬間、誤検知防止の確認チェックを1回行ってから、以下が**約1分間（3秒間隔×20回）**発動します：

1. 🔔 デスクトップ通知バナー「🚗 Tesla 在庫復活！」
2. 🔊 アラーム音を繰り返し再生
3. 🗣️ 日本語の音声読み上げ「テスラの在庫が復活しました。今すぐ購入してください。」
4. 🌐 既定ブラウザで商品ページを自動で開く（ログイン済みならすぐ購入へ）

---

## 別の商品を監視する

既定は「Gen 2 モバイルコネクター バンドル (JP)」です。アプリの **設定** 欄で「商品ページURL」と「SKU」を書き換えて **保存** すれば、次回の監視開始から反映されます。

**SKU の調べ方**：
1. Chrome で対象の商品ページを開く
2. 右クリック →「検証」→「Network」タブ
3. ページを再読み込みし、`inventory.json` のリクエストを探す
4. その「Payload（送信データ）」に `["1234567-00-A"]` のような **SKU** が入っています

---

## トラブルシューティング

### `Access Denied` / 403 が続く・「UNKNOWN」が頻発する
Akamai に一時的にブロックされています。短時間に叩きすぎると起きます。
- ツールは自動でバックオフ＆再接続して回復を試みます。基本は放置でOK。
- 改善しない場合は、一度監視を止めて**数分〜十数分待ってから**再開してください。
- **Tesla にログイン**しておくと信頼されやすくブロックされにくくなります。

### 監視用 Chrome が起動しない
- Google Chrome がインストールされているか確認してください（アプリ画面に警告が出ます）。
- 既にポート 9222 を別用途で使っている場合は、設定ファイル（Mac: `~/Library/Application Support/TeslaChargerGetter/settings.json`、Windows: `%APPDATA%\TeslaChargerGetter\settings.json`）の `debugPort` を変更してください。

### 通知・音が出ない
- OS の通知設定で本アプリの通知を許可してください（Mac: システム設定 → 通知、Windows: 設定 → システム → 通知）。
- 音量・出力先を確認してください。「🔔 アラートテスト」で確認できます。

### 監視用 Chrome のタブを閉じてしまった
- 自動で新しいタブを開いて回復します（数十秒）。気づいたら、監視専用 Chrome ウィンドウは**最小化**しておくと安全です。

---

## 🛠 上級者向け: CLI で使う（macOS）

Node.js v18 以上が必要です。通知に `osascript` / `afplay` / `say` を使うため macOS 専用です。

```bash
git clone https://github.com/kdragon1988/tesla-charger-getter.git
cd tesla-charger-getter
./setup.sh    # 初回のみ（依存インストール）
./start.sh    # 監視開始（停止は Ctrl-C）
```

- `node src/monitor.js --attach --once` … 単発チェック（JSON 出力）
- `node drill-alert.mjs` … 通知の動作テスト

### デスクトップアプリを自分でビルドする

```bash
npm install
npm run app        # 開発モードで起動
npm run dist:mac   # Mac 用 DMG を dist/ に生成
npm run dist:win   # Windows 用インストーラを dist/ に生成
```

GitHub Actions（`.github/workflows/release.yml`）により、`v*` タグを push すると Mac / Windows 両方のインストーラが自動ビルドされ Releases に添付されます。

---

## 仕組み（技術メモ）

- 監視には **CDP（Chrome DevTools Protocol）接続** を使います。Playwright が起動する自動ブラウザは Akamai に弾かれやすいため、アプリが起動する**実 Chrome（専用プロファイル・デバッグポート9222）**に接続します。
- 在庫判定は **在庫API（`inventory.json`）を `POST ["SKU"]` で叩いた結果**で行います：
  - `purchasable: true` → **在庫あり**（`inventoryCount` は在庫ありでも 0 を返すため、`purchasable` を主軸に判定）
  - `purchasable: false` / `error: "Out of stock"` → 在庫切れ
  - 通信失敗・403・非JSON → UNKNOWN（バックオフして再接続）
- ページの reload はしません（初回にセッション確立のため1回だけ開く）。以降は軽量な API 呼び出しのみ。
- デスクトップアプリ（Electron）と CLI は同じ監視コア（`src/monitor-core.js`）を共有し、通知層だけを差し替えています（GUI: Electron Notification + WebAudio + speechSynthesis / CLI: osascript + afplay + say）。

---

## ディレクトリ構成

```
tesla-charger-getter/
├── electron/               # デスクトップアプリ（Mac / Windows）
│   ├── main.js             # Electron メインプロセス
│   ├── preload.cjs         # レンダラへの安全な API ブリッジ
│   ├── monitor-service.js  # GUI と監視コアの仲立ち
│   ├── chrome-launcher.js  # 監視用 Chrome の検出・起動（クロスプラットフォーム）
│   ├── settings.js         # ユーザー設定の検証・永続化
│   ├── alerter.js          # GUI 版アラート（通知・音・音声）
│   └── renderer/           # 画面（HTML / CSS / JS）
├── src/
│   ├── config.js           # 既定設定（商品URL・SKU・間隔・アラート）
│   ├── monitor-core.js     # 監視ループの中核（GUI / CLI 共通）
│   ├── monitor.js          # CLI エントリポイント
│   ├── inventory.js        # 在庫API検知（判定ロジック）
│   ├── browser.js          # Chrome への CDP 接続
│   ├── notifier.js         # CLI 版アラート（macOS: 通知・音・音声）
│   ├── logger.js           # ログ出力
│   └── states.js           # 在庫状態の定数
├── setup.sh                # CLI 用: 初回セットアップ
├── start.sh                # CLI 用: 監視開始
├── drill-alert.mjs         # CLI 用: 通知の動作テスト
├── test-judge.mjs          # 在庫判定ロジックの回帰テスト
├── test-app-units.mjs      # アプリ層（設定・Chrome検出）のユニットテスト
├── .github/workflows/release.yml  # Mac / Windows インストーラの自動ビルド
├── package.json
├── LICENSE
└── README.md
```

---

## ⚠️ 免責事項

- 本ツールは**個人利用**を想定しています。**自己責任**でご利用ください。
- Tesla の利用規約を尊重し、**ポーリング間隔を極端に短くする等の過度なアクセスは行わないでください**（既定の10〜20秒は通常利用の範囲です）。サーバーに負荷をかける使い方や、転売目的での大量取得は避けてください。
- 在庫情報・購入の成否について、本ツールは一切の保証をしません。
- 本ツールは Tesla, Inc. とは無関係の非公式ツールです。

---

## ライセンス

[MIT License](./LICENSE)

---

🤝 後続の同志たちが少しでも入手しやすくなりますように。Good luck! 🚗⚡
