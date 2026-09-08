require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const configuredDataDir = String(process.env.DATA_DIR || "data").trim() || "data";
const dataDir = path.isAbsolute(configuredDataDir) ? configuredDataDir : path.resolve(root, configuredDataDir);
const backupDir = path.join(dataDir, "backups");
fs.mkdirSync(backupDir, { recursive: true });
const database = process.env.MYSQL_DATABASE || "whatsapp_sales_ai";
if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error("MYSQL_DATABASE is invalid");

const candidates = [
  process.env.MYSQLDUMP_PATH,
  "C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqldump.exe",
  "C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe",
  "mysqldump"
].filter(Boolean);
const executable = candidates.find((candidate) => candidate === "mysqldump" || fs.existsSync(candidate));
if (!executable) throw new Error("mysqldump was not found; configure MYSQLDUMP_PATH");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `${database}-${stamp}.sql`);
const output = fs.openSync(backupPath, "w");
try {
  const result = spawnSync(executable, [
    `--host=${process.env.MYSQL_HOST || "127.0.0.1"}`,
    `--port=${Number(process.env.MYSQL_PORT || 3306)}`,
    `--user=${process.env.MYSQL_USER || "root"}`,
    "--single-transaction",
    "--quick",
    "--routines",
    "--triggers",
    "--hex-blob",
    "--set-gtid-purged=OFF",
    "--default-character-set=utf8mb4",
    database
  ], {
    env: { ...process.env, MYSQL_PWD: process.env.MYSQL_PASSWORD || "" },
    stdio: ["ignore", output, "pipe"],
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(String(result.stderr || `mysqldump exited with ${result.status}`).trim());
} catch (error) {
  fs.closeSync(output);
  if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
  throw error;
}
fs.closeSync(output);
const sizeBytes = fs.statSync(backupPath).size;
if (!sizeBytes) {
  fs.rmSync(backupPath, { force: true });
  throw new Error("MySQL backup is empty");
}
console.log(JSON.stringify({ ok: true, driver: "mysql", database, backupPath, sizeBytes }, null, 2));
