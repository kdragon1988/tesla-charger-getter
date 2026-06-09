// src/logger.js
// 在庫監視ロガー。Asia/Tokyo のタイムスタンプ付きで、
// コンソール出力とログファイル追記を同時に行う。
// 1行 = タイムスタンプ + レベル + メッセージ + 任意の JSON メタ（grep しやすい単一行形式）。

import fs from "node:fs";
import path from "node:path";

// ログレベル定数（マジック文字列をロジックに散らさない）
const LEVELS = Object.freeze({
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  EVENT: "EVENT",
});

// Asia/Tokyo 固定のタイムスタンプフォーマッタ。
// Intl.DateTimeFormat を 1 度だけ生成して使い回す（毎回生成しない）。
const TIME_ZONE = "Asia/Tokyo";
const timeFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

// 現在時刻を "YYYY-MM-DD HH:mm:ss JST" 形式の文字列にする。
// Intl の parts から組み立て、ロケール差による区切り文字の揺れを吸収する。
function formatTimestamp(date) {
  const parts = timeFormatter.formatToParts(date).reduce((acc, part) => {
    // 非破壊的にコピーを積み上げる（既存オブジェクトを変更しない）
    return part.type === "literal" ? acc : { ...acc, [part.type]: part.value };
  }, {});

  const { year, month, day, hour, minute, second } = parts;
  return `${year}-${month}-${day} ${hour}:${minute}:${second} JST`;
}

// メタ情報を安全に単一行 JSON へ変換する。
// 循環参照や BigInt など JSON 化できない値でもロガー自体は落とさない。
function formatMeta(meta) {
  if (meta === undefined || meta === null) return "";
  if (typeof meta !== "object") {
    // プリミティブはそのまま値として包む
    return ` ${safeStringify({ value: meta })}`;
  }
  // Error は own enumerable キーを持たないため、専用に取り出して救済する
  // （そのまま渡すと「空オブジェクト」と誤判定され詳細が失われる）。
  if (meta instanceof Error) {
    return ` ${safeStringify({ error: meta })}`;
  }
  // 空オブジェクトはノイズになるので出力しない
  if (Object.keys(meta).length === 0) return "";
  return ` ${safeStringify(meta)}`;
}

// JSON.stringify の失敗を握りつぶさず、フォールバック文字列で代替する。
function safeStringify(value) {
  try {
    return JSON.stringify(value, jsonReplacer);
  } catch (err) {
    return JSON.stringify({
      __metaError: "メタ情報の JSON 変換に失敗しました",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// Error / BigInt など標準では落ちる値を文字列化して救済する replacer。
function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

// ログ出力先ディレクトリを必要なら作成する。
// 作成に失敗してもコンソール出力は継続できるよう、例外は呼び出し側へ返す。
function ensureLogDir(logFile) {
  const dir = path.dirname(path.resolve(logFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// 1 行を組み立てる純粋関数（副作用なし・既存値を変更しない）。
function buildLine(level, message, meta) {
  const timestamp = formatTimestamp(new Date());
  const text = message === undefined || message === null ? "" : String(message);
  return `[${timestamp}] [${level}] ${text}${formatMeta(meta)}`;
}

// 標準出力/標準エラーへの振り分け。レベルに応じて stderr を使う。
function writeToConsole(level, line) {
  if (level === LEVELS.ERROR) {
    console.error(line);
  } else if (level === LEVELS.WARN) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * ロガーを生成する。
 * @param {string} logFile 追記先ログファイルパス（例: "./logs/monitor.log"）
 * @returns {{ info: Function, warn: Function, error: Function, event: Function }}
 *
 * 各メソッドは (message, meta?) を受け取り、Asia/Tokyo タイムスタンプ付きで
 * コンソールへ出力し、同じ 1 行を logFile へ fs.appendFileSync で追記する。
 * ファイル書き込みに失敗してもログ処理自体は止めず、警告を stderr に出す
 * （エラーを黙って握りつぶさない）。
 */
export function createLogger(logFile) {
  if (typeof logFile !== "string" || logFile.trim() === "") {
    throw new TypeError("createLogger には有効な logFile パスが必要です");
  }

  const resolvedLogFile = path.resolve(logFile);

  // 起動時にログディレクトリを用意する。失敗したら明示的に通知して投げ直す。
  try {
    ensureLogDir(resolvedLogFile);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`ログディレクトリの作成に失敗しました: ${reason}`);
  }

  // ファイル追記が一度失敗したら、毎行同じ警告を出し続けないよう状態を保持する。
  // クロージャ内のローカル状態であり、共有オブジェクトの破壊的変更ではない。
  let fileWriteWarned = false;

  function appendToFile(line) {
    try {
      fs.appendFileSync(resolvedLogFile, `${line}\n`, { encoding: "utf8" });
      // 復旧したら再度警告を出せるようにフラグを戻す
      fileWriteWarned = false;
    } catch (err) {
      if (!fileWriteWarned) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `[logger] ログファイルへの追記に失敗しました (${resolvedLogFile}): ${reason}`
        );
        fileWriteWarned = true;
      }
    }
  }

  function emit(level, message, meta) {
    const line = buildLine(level, message, meta);
    writeToConsole(level, line);
    appendToFile(line);
    return line;
  }

  return Object.freeze({
    info: (message, meta) => emit(LEVELS.INFO, message, meta),
    warn: (message, meta) => emit(LEVELS.WARN, message, meta),
    error: (message, meta) => emit(LEVELS.ERROR, message, meta),
    event: (message, meta) => emit(LEVELS.EVENT, message, meta),
  });
}
