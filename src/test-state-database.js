const fs = require("fs");
const path = require("path");

const clone = (value) => value == null ? value : structuredClone(value);

function workflowRows(state) {
  const rows = [];
  const contacts = state?.contacts || {};
  for (const message of state?.messages || []) {
    const status = String(message.metadata?.automationState || "");
    if (!status) continue;
    const contact = contacts[message.chatId] || {};
    rows.push({
      node_type: status === "quote_pending" ? "quote_review" : status === "handoff" ? "human_handoff" : ["queued", "processing", "failed"].includes(status) ? "reply_queue" : "message_result",
      status,
      message_id: String(message.id || ""),
      chat_id: String(message.chatId || ""),
      account_id: String(message.accountId || contact.accountId || "")
    });
  }
  for (const quote of state?.quotes || []) rows.push({ node_type: "quote_review", status: String(quote.status || "pending"), message_id: String(quote.inboundMessageId || ""), chat_id: String(quote.chatId || "") });
  for (const contact of Object.values(contacts)) if (contact.needsHuman || contact.mode === "human") rows.push({ node_type: "human_handoff", status: "pending", message_id: String(contact.handoffMessageId || ""), chat_id: String(contact.chatId || ""), account_id: String(contact.accountId || "") });
  return rows;
}

class TestStateDatabase {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, ".test-mysql-state.json");
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.payload = { state: null, accounts: [], sessions: {} };
    if (fs.existsSync(this.filePath)) this.payload = { ...this.payload, ...JSON.parse(fs.readFileSync(this.filePath, "utf8")) };
  }

  write() { fs.writeFileSync(this.filePath, JSON.stringify(this.payload), "utf8"); }
  loadState() { return clone(this.payload.state); }
  persistState(state) { this.payload.state = clone(state); this.write(); }
  listWhatsAppAccounts() { return clone(this.payload.accounts); }
  replaceWhatsAppAccounts(accounts) { this.payload.accounts = clone(accounts || []); this.write(); return this.listWhatsAppAccounts(); }
  updateWhatsAppAccount(accountId, patch = {}) {
    const index = this.payload.accounts.findIndex((item) => String(item.id || item.accountId) === String(accountId));
    if (index < 0) return null;
    this.payload.accounts[index] = { ...this.payload.accounts[index], ...clone(patch), id: String(accountId), accountId: String(accountId), updatedAt: Date.now() };
    this.write();
    return clone(this.payload.accounts[index]);
  }
  deleteWhatsAppAccount(accountId) {
    const before = this.payload.accounts.length;
    this.payload.accounts = this.payload.accounts.filter((item) => String(item.id || item.accountId) !== String(accountId));
    for (const [name, session] of Object.entries(this.payload.sessions)) if (session.accountId === String(accountId)) delete this.payload.sessions[name];
    this.write();
    return before - this.payload.accounts.length;
  }
  hasWhatsAppSession(sessionName) { return Boolean(this.payload.sessions[String(sessionName)]); }
  readWhatsAppSession(sessionName) {
    const record = this.payload.sessions[String(sessionName)];
    if (!record) return null;
    return { ...clone(record), archive: Buffer.from(record.archive, "base64"), iv: record.iv ? Buffer.from(record.iv, "base64") : null, auth_tag: record.auth_tag ? Buffer.from(record.auth_tag, "base64") : null };
  }
  saveWhatsAppSession(record) {
    this.payload.sessions[String(record.sessionName)] = {
      session_name: String(record.sessionName), accountId: String(record.accountId), account_id: String(record.accountId),
      archive: Buffer.from(record.archive).toString("base64"), checksum: String(record.checksum || ""), encrypted: record.encrypted ? 1 : 0,
      iv: record.iv ? Buffer.from(record.iv).toString("base64") : null, auth_tag: record.authTag ? Buffer.from(record.authTag).toString("base64") : null,
      size_bytes: Number(record.sizeBytes || record.archive?.length || 0), updated_at: Date.now()
    };
    this.write();
  }
  deleteWhatsAppSession(sessionName) { const existed = this.hasWhatsAppSession(sessionName); delete this.payload.sessions[String(sessionName)]; this.write(); return existed ? 1 : 0; }
  listWorkflowNodes(chatId) { return workflowRows(this.payload.state).filter((row) => row.chat_id === String(chatId)); }
  status() {
    const state = this.payload.state || {};
    const sessions = Object.values(this.payload.sessions);
    return {
      driver: "mysql-test-adapter", schemaVersion: 1, integrity: "ok", database: path.basename(this.filePath),
      counts: { contacts: Object.keys(state.contacts || {}).length, messages: (state.messages || []).length, quotes: (state.quotes || []).length, agents: Object.keys(state.agents || {}).length, memories: (state.customerMemories || []).length, whatsappAccounts: this.payload.accounts.length, workflowNodes: workflowRows(state).length, whatsappSessions: sessions.length },
      authSessions: { totalBytes: sessions.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0), encrypted: sessions.filter((item) => item.encrypted).length }
    };
  }
  backupLegacyJson(legacyPath) {
    if (!fs.existsSync(legacyPath)) return "";
    const backupDir = path.join(this.dataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const target = path.join(backupDir, `state-pre-mysql-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.copyFileSync(legacyPath, target);
    return target;
  }
  close() {}
}

module.exports = { TestStateDatabase };
