#!/usr/bin/env node
/**
 * stdin: JSON { "fullText": "..." }（プロセカ結果画面の OCR テキスト、改行区切り）
 * stdout: parseGameResult の JSON（camelCase）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseGameResult } from "../ocr-postprocess.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const songDbPath = path.join(root, "songDatabase.json");

const stdin = fs.readFileSync(0, "utf8");
let payload;
try {
  payload = JSON.parse(stdin);
} catch {
  process.stderr.write("Invalid JSON on stdin\n");
  process.exit(1);
}
const fullText = payload.fullText ?? payload.full_text ?? "";
if (typeof fullText !== "string") {
  process.stderr.write("fullText must be a string\n");
  process.exit(1);
}

let songDb;
try {
  songDb = JSON.parse(fs.readFileSync(songDbPath, "utf8"));
} catch (e) {
  process.stderr.write(`Failed to read songDatabase.json: ${e}\n`);
  process.exit(1);
}

const result = parseGameResult({ fullText }, songDb);
process.stdout.write(JSON.stringify(result));
