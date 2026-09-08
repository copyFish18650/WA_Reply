const path = require("path");
const fs = require("fs");
const { Worker, MessageChannel, receiveMessageOnPort } = require("worker_threads");

const SCHEMA_VERSION = 1;

class MysqlStateDatabase {
  constructor(options = {}) {
    this.closed = false;
    this.dataDir = path.resolve(options.dataDir || "data");
    this.sequence = 0;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(path.join(__dirname, "mysql-database-worker.js"), {
      workerData: { port: port2 },
      transferList: [port2]
    });
    this.worker.unref();
    try {
      this.request("initialize", options, Number(options.startupTimeoutMs || 60000));
    } catch (error) {
      this.worker.terminate().catch(() => {});
      this.port.close();
      throw error;
    }
  }

  request(operation, args = {}, timeoutMs = 30000) {
    if (this.closed && operation !== "close") throw new Error("MySQL connection is closed");
    const id = ++this.sequence;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    this.port.postMessage({ id, operation, args, signal: signal.buffer });
    const wait = Atomics.wait(signal, 0, 0, timeoutMs);
    if (wait === "timed-out") throw new Error(`MySQL operation timed out: ${operation}`);
    let packet = receiveMessageOnPort(this.port)?.message;
    while (packet && packet.id !== id) packet = receiveMessageOnPort(this.port)?.message;
    if (!packet) throw new Error(`MySQL worker returned no result for ${operation}`);
    if (!packet.ok) {
      const error = new Error(packet.error?.message || `MySQL operation failed: ${operation}`);
      error.code = packet.error?.code || "";
      error.stack = packet.error?.stack || error.stack;
      throw error;
    }
    return packet.result;
  }

  loadState() { return this.request("loadState"); }
  persistState(state) { return this.request("persistState", state, 60000); }
  listWhatsAppAccounts() { return this.request("listAccounts"); }
  replaceWhatsAppAccounts(accounts) { return this.request("replaceAccounts", accounts); }
  updateWhatsAppAccount(accountId, patch = {}) { return this.request("updateAccount", { accountId, patch }); }
  deleteWhatsAppAccount(accountId) { return this.request("deleteAccount", { accountId }); }
  hasWhatsAppSession(sessionName) { return this.request("hasSession", { sessionName }); }
  readWhatsAppSession(sessionName) { return this.request("readSession", { sessionName }); }
  saveWhatsAppSession(record) { return this.request("saveSession", record, 60000); }
  deleteWhatsAppSession(sessionName) { return this.request("deleteSession", { sessionName }); }
  listWorkflowNodes(chatId) { return this.request("listWorkflowNodes", { chatId }); }
  status() { return this.request("status"); }
  backupLegacyJson(legacyPath) {
    if (!fs.existsSync(legacyPath)) return "";
    const backupDir = path.join(this.dataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const target = path.join(backupDir, `state-pre-mysql-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(legacyPath, target);
    return target;
  }

  close() {
    if (this.closed) return;
    try { this.request("close", {}, 15000); }
    finally {
      this.closed = true;
      this.port.close();
      this.worker.terminate().catch(() => {});
    }
  }
}

module.exports = { MysqlStateDatabase, SCHEMA_VERSION };
