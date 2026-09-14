const { workerData } = require("worker_threads");
const mysql = require("mysql2/promise");
const { isNewAccountInstance, mergeAccountRegistryRecord, mergeAccountStatusRecord } = require("./account-registry");

const SCHEMA_VERSION = 1;
const TABLES = [
  { name: "contacts", keys: ["chat_id"], columns: ["chat_id", "account_id", "provider_chat_id", "profile_name", "last_message_at", "updated_at", "data_json"] },
  { name: "messages", keys: ["chat_id", "message_id"], columns: ["chat_id", "message_id", "account_id", "direction", "message_type", "created_at", "updated_at", "position", "data_json"] },
  { name: "quotes", keys: ["id"], columns: ["id", "chat_id", "inbound_message_id", "status", "created_at", "updated_at", "position", "data_json"] },
  { name: "account_styles", keys: ["account_id"], columns: ["account_id", "updated_at", "data_json"] },
  { name: "agents", keys: ["agent_id"], columns: ["agent_id", "updated_at", "data_json"] },
  { name: "account_agent_bindings", keys: ["account_id"], columns: ["account_id", "agent_id", "data_json"] },
  { name: "account_automation", keys: ["account_id"], columns: ["account_id", "updated_at", "data_json"] },
  { name: "learned_replies", keys: ["record_id"], columns: ["record_id", "account_id", "created_at", "position", "data_json"] },
  { name: "customer_memories", keys: ["memory_id"], columns: ["memory_id", "chat_id", "account_id", "updated_at", "position", "data_json"] },
  { name: "conversation_memories", keys: ["chat_id"], columns: ["chat_id", "updated_at", "data_json"] },
  { name: "workflow_nodes", keys: ["node_id"], columns: ["node_id", "account_id", "chat_id", "node_type", "status", "message_id", "quote_id", "created_at", "updated_at", "data_json"] },
  { name: "app_settings", keys: ["id"], columns: ["id", "data_json"] }
];

const port = workerData.port;
let pool = null;
let config = null;
let caches = {};
let lastCounts = { contacts: 0, messages: 0, quotes: 0, agents: 0, memories: 0 };

const json = (value) => JSON.stringify(value ?? null);
const parseJson = (value, label) => {
  try { return JSON.parse(String(value)); } catch (error) { throw new Error(`MySQL 中的 ${label} 数据损坏：${error.message}`); }
};
const safeRecordId = (prefix, item, index) => String(item?.id || `${prefix}-${index}`);
const quoted = (value) => `\`${String(value).replace(/`/g, "``")}\``;

async function createSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_meta (meta_key VARCHAR(191) PRIMARY KEY, meta_value LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS contacts (chat_id VARCHAR(191) PRIMARY KEY, account_id VARCHAR(191) NOT NULL DEFAULT '', provider_chat_id VARCHAR(191) NOT NULL DEFAULT '', profile_name VARCHAR(255) NOT NULL DEFAULT '', last_message_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL, INDEX idx_contacts_account_updated(account_id, updated_at DESC), INDEX idx_contacts_last_message(last_message_at DESC)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS messages (chat_id VARCHAR(191) NOT NULL, message_id VARCHAR(512) NOT NULL, account_id VARCHAR(191) NOT NULL DEFAULT '', direction VARCHAR(32) NOT NULL DEFAULT '', message_type VARCHAR(64) NOT NULL DEFAULT 'text', created_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0, position INT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL, PRIMARY KEY(chat_id, message_id), INDEX idx_messages_chat_created(chat_id, created_at, position), INDEX idx_messages_account_created(account_id, created_at DESC)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS quotes (id BIGINT PRIMARY KEY, chat_id VARCHAR(191) NOT NULL, inbound_message_id VARCHAR(512) NOT NULL DEFAULT '', status VARCHAR(64) NOT NULL DEFAULT 'pending', created_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0, position INT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL, INDEX idx_quotes_status_created(status, created_at DESC), INDEX idx_quotes_message(chat_id, inbound_message_id(191))) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS account_styles (account_id VARCHAR(191) PRIMARY KEY, updated_at BIGINT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS agents (agent_id VARCHAR(191) PRIMARY KEY, updated_at BIGINT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS account_agent_bindings (account_id VARCHAR(191) PRIMARY KEY, agent_id VARCHAR(191) NOT NULL, data_json LONGTEXT NOT NULL, INDEX idx_agent_bindings_agent(agent_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS account_automation (account_id VARCHAR(191) PRIMARY KEY, updated_at BIGINT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS learned_replies (record_id VARCHAR(191) PRIMARY KEY, account_id VARCHAR(191) NOT NULL DEFAULT '', created_at BIGINT NOT NULL DEFAULT 0, position INT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL, INDEX idx_learned_replies_account(account_id, created_at DESC)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS customer_memories (memory_id VARCHAR(191) PRIMARY KEY, chat_id VARCHAR(191) NOT NULL, account_id VARCHAR(191) NOT NULL DEFAULT '', updated_at BIGINT NOT NULL DEFAULT 0, position INT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL, INDEX idx_customer_memories_chat(chat_id, updated_at DESC)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS conversation_memories (chat_id VARCHAR(191) PRIMARY KEY, updated_at BIGINT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS app_settings (id TINYINT PRIMARY KEY, data_json LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS workflow_nodes (node_id VARCHAR(768) PRIMARY KEY, account_id VARCHAR(191) NOT NULL DEFAULT '', chat_id VARCHAR(191) NOT NULL DEFAULT '', node_type VARCHAR(64) NOT NULL, status VARCHAR(64) NOT NULL, message_id VARCHAR(512) NOT NULL DEFAULT '', quote_id BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL, INDEX idx_workflow_nodes_account_status(account_id, status, updated_at DESC), INDEX idx_workflow_nodes_chat(chat_id, updated_at DESC)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_accounts (account_id VARCHAR(191) PRIMARY KEY, client_id VARCHAR(191) NOT NULL UNIQUE, label VARCHAR(255) NOT NULL DEFAULT '', wa_id VARCHAR(191) NOT NULL DEFAULT '', push_name VARCHAR(255) NOT NULL DEFAULT '', platform VARCHAR(64) NOT NULL DEFAULT '', last_status VARCHAR(64) NOT NULL DEFAULT 'offline', last_connected_at BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0, data_json LONGTEXT NOT NULL, INDEX idx_whatsapp_accounts_updated(updated_at DESC)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS whatsapp_sessions (session_name VARCHAR(191) PRIMARY KEY, account_id VARCHAR(191) NOT NULL, archive LONGBLOB NOT NULL, checksum CHAR(64) NOT NULL, encrypted TINYINT(1) NOT NULL DEFAULT 0, iv VARBINARY(32), auth_tag VARBINARY(32), size_bytes BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL DEFAULT 0, INDEX idx_whatsapp_sessions_account(account_id, updated_at DESC), CONSTRAINT fk_whatsapp_sessions_account FOREIGN KEY(account_id) REFERENCES whatsapp_accounts(account_id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];
  for (const sql of statements) await pool.query(sql);
  const [rows] = await pool.execute("SELECT meta_value FROM app_meta WHERE meta_key = 'schema_version'");
  const current = Number(rows[0]?.meta_value || 0);
  if (current > SCHEMA_VERSION) throw new Error(`MySQL schema ${current} is newer than supported schema ${SCHEMA_VERSION}`);
  await pool.execute("INSERT INTO app_meta(meta_key, meta_value) VALUES ('schema_version', ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)", [String(SCHEMA_VERSION)]);
}

async function initialize(options) {
  config = { ...options };
  if (!/^[a-zA-Z0-9_]+$/.test(config.database || "")) throw new Error("MYSQL_DATABASE may only contain letters, numbers and underscores");
  const base = {
    host: config.host || "127.0.0.1",
    port: Number(config.port || 3306),
    user: config.user || "root",
    password: config.password || "",
    charset: "utf8mb4",
    connectTimeout: Number(config.connectTimeout || 15000),
    supportBigNumbers: true,
    bigNumberStrings: false,
    ...(config.ssl ? { ssl: config.ssl } : {})
  };
  let databaseExists = false;
  try {
    const probe = await mysql.createConnection({ ...base, database: config.database });
    try { await probe.query("SELECT 1"); databaseExists = true; }
    finally { await probe.end(); }
  } catch (error) {
    if (error.code !== "ER_BAD_DB_ERROR") throw error;
  }
  if (!databaseExists) {
    const bootstrap = await mysql.createConnection(base);
    try { await bootstrap.query(`CREATE DATABASE ${quoted(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); }
    finally { await bootstrap.end(); }
  }
  pool = mysql.createPool({ ...base, database: config.database, waitForConnections: true, connectionLimit: Number(config.connectionLimit || 8), queueLimit: 0 });
  await createSchema();
  return status();
}

async function meta(key, executor = pool) {
  const [rows] = await executor.execute("SELECT meta_value FROM app_meta WHERE meta_key = ?", [String(key)]);
  return rows[0]?.meta_value;
}

async function isInitialized() { return (await meta("initialized")) === "1"; }

async function readJsonRows(table, orderBy = "") {
  const [rows] = await pool.query(`SELECT data_json FROM ${quoted(table)}${orderBy ? ` ORDER BY ${orderBy}` : ""}`);
  return rows.map((row, index) => parseJson(row.data_json, `${table}[${index}]`));
}

async function readJsonMap(table, keyColumn, orderBy = "") {
  const [rows] = await pool.query(`SELECT ${quoted(keyColumn)}, data_json FROM ${quoted(table)}${orderBy ? ` ORDER BY ${orderBy}` : ""}`);
  return Object.fromEntries(rows.map((row) => [String(row[keyColumn]), parseJson(row.data_json, `${table}.${row[keyColumn]}`)]));
}

async function primeCaches() {
  for (const table of TABLES) {
    const [rows] = await pool.query(`SELECT ${table.columns.map(quoted).join(", ")} FROM ${quoted(table.name)}`);
    caches[table.name] = new Map(rows.map((row) => {
      const values = table.keys.map((key) => row[key]);
      return [json(values), { values, signature: json(table.columns.map((column) => row[column])) }];
    }));
  }
}

async function loadState() {
  if (!(await isInitialized())) return null;
  const [settingsRows] = await pool.query("SELECT data_json FROM app_settings WHERE id = 1");
  const [bindingRows] = await pool.query("SELECT account_id, agent_id FROM account_agent_bindings");
  const state = {
    version: Number(await meta("state_version") || 0),
    nextQuoteId: Number(await meta("next_quote_id") || 1),
    contacts: await readJsonMap("contacts", "chat_id"),
    messages: await readJsonRows("messages", "position ASC"),
    quotes: await readJsonRows("quotes", "position ASC"),
    accountStyles: await readJsonMap("account_styles", "account_id"),
    agents: await readJsonMap("agents", "agent_id"),
    accountAgentBindings: Object.fromEntries(bindingRows.map((row) => [String(row.account_id), String(row.agent_id)])),
    accountAutomation: await readJsonMap("account_automation", "account_id"),
    learnedReplies: await readJsonRows("learned_replies", "position ASC"),
    customerMemories: await readJsonRows("customer_memories", "position ASC"),
    conversationMemories: await readJsonMap("conversation_memories", "chat_id"),
    settings: settingsRows[0] ? parseJson(settingsRows[0].data_json, "app_settings") : {}
  };
  await primeCaches();
  return state;
}

function workflowRows(state) {
  const rows = [];
  const contacts = state.contacts || {};
  for (const message of state.messages || []) {
    const automationState = String(message.metadata?.automationState || "");
    if (!automationState) continue;
    const contact = contacts[message.chatId] || {};
    const nodeType = automationState === "quote_pending" ? "quote_review" : automationState === "handoff" ? "human_handoff" : ["queued", "processing", "failed"].includes(automationState) ? "reply_queue" : "message_result";
    rows.push({ node_id: `message:${message.chatId}:${message.id}`, account_id: String(message.accountId || contact.accountId || ""), chat_id: String(message.chatId || ""), node_type: nodeType, status: automationState, message_id: String(message.id || ""), quote_id: 0, created_at: Number(message.createdAt || 0), updated_at: Number(message.metadata?.automationAt || message.updatedAt || message.createdAt || 0), data_json: json({ reason: String(message.metadata?.automationReason || ""), replyId: String(message.metadata?.automationReplyId || ""), replySource: String(message.metadata?.automationSource || "") }) });
  }
  for (const quote of state.quotes || []) {
    const contact = contacts[quote.chatId] || {};
    rows.push({ node_id: `quote:${quote.id}`, account_id: String(quote.accountId || contact.accountId || ""), chat_id: String(quote.chatId || ""), node_type: "quote_review", status: String(quote.status || "pending"), message_id: String(quote.inboundMessageId || ""), quote_id: Number(quote.id || 0), created_at: Number(quote.createdAt || 0), updated_at: Number(quote.updatedAt || quote.createdAt || 0), data_json: json({ currency: quote.currency || "", finalPrice: quote.finalPrice ?? quote.suggestedPrice ?? null }) });
  }
  for (const contact of Object.values(contacts)) {
    if (!contact?.needsHuman && contact?.mode !== "human") continue;
    rows.push({ node_id: `handoff:${contact.chatId}`, account_id: String(contact.accountId || ""), chat_id: String(contact.chatId || ""), node_type: "human_handoff", status: "pending", message_id: String(contact.handoffMessageId || ""), quote_id: 0, created_at: Number(contact.updatedAt || contact.lastMessageAt || 0), updated_at: Number(contact.updatedAt || contact.lastMessageAt || 0), data_json: json({ reason: String(contact.escalationReason || ""), mode: String(contact.mode || "auto") }) });
  }
  return rows;
}

function rowsForState(state) {
  return {
    contacts: Object.entries(state.contacts || {}).map(([chatId, item]) => ({ chat_id: chatId, account_id: String(item.accountId || ""), provider_chat_id: String(item.providerChatId || ""), profile_name: String(item.profileName || ""), last_message_at: Number(item.lastMessageAt || 0), updated_at: Number(item.updatedAt || 0), data_json: json(item) })),
    messages: (state.messages || []).map((item, position) => ({ chat_id: String(item.chatId || ""), message_id: String(item.id || ""), account_id: String(item.accountId || ""), direction: String(item.direction || ""), message_type: String(item.type || "text"), created_at: Number(item.createdAt || 0), updated_at: Number(item.updatedAt || 0), position, data_json: json(item) })),
    quotes: (state.quotes || []).map((item, position) => ({ id: Number(item.id), chat_id: String(item.chatId || ""), inbound_message_id: String(item.inboundMessageId || ""), status: String(item.status || "pending"), created_at: Number(item.createdAt || 0), updated_at: Number(item.updatedAt || 0), position, data_json: json(item) })),
    account_styles: Object.entries(state.accountStyles || {}).map(([accountId, item]) => ({ account_id: accountId, updated_at: Number(item.updatedAt || 0), data_json: json(item) })),
    agents: Object.entries(state.agents || {}).map(([agentId, item]) => ({ agent_id: agentId, updated_at: Number(item.updatedAt || 0), data_json: json(item) })),
    account_agent_bindings: Object.entries(state.accountAgentBindings || {}).map(([accountId, agentId]) => ({ account_id: accountId, agent_id: String(agentId || ""), data_json: json(String(agentId || "")) })),
    account_automation: Object.entries(state.accountAutomation || {}).map(([accountId, item]) => ({ account_id: accountId, updated_at: Number(item.updatedAt || 0), data_json: json(item) })),
    learned_replies: (state.learnedReplies || []).map((item, position) => ({ record_id: safeRecordId("learned", item, position), account_id: String(item.accountId || ""), created_at: Number(item.createdAt || 0), position, data_json: json(item) })),
    customer_memories: (state.customerMemories || []).map((item, position) => ({ memory_id: safeRecordId("memory", item, position), chat_id: String(item.chatId || ""), account_id: String(item.accountId || ""), updated_at: Number(item.updatedAt || 0), position, data_json: json(item) })),
    conversation_memories: Object.entries(state.conversationMemories || {}).map(([chatId, item]) => ({ chat_id: chatId, updated_at: Number(item.updatedAt || 0), data_json: json(item) })),
    workflow_nodes: workflowRows(state),
    app_settings: [{ id: 1, data_json: json(state.settings || {}) }]
  };
}

async function syncTable(connection, table, rows) {
  const oldCache = caches[table.name] || new Map();
  const nextCache = new Map();
  const placeholders = table.columns.map(() => "?").join(", ");
  const updates = table.columns.filter((column) => !table.keys.includes(column)).map((column) => `${quoted(column)} = VALUES(${quoted(column)})`).join(", ");
  const sql = `INSERT INTO ${quoted(table.name)} (${table.columns.map(quoted).join(", ")}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`;
  for (const row of rows) {
    const values = table.keys.map((key) => row[key]);
    const cacheKey = json(values);
    const signature = json(table.columns.map((column) => row[column]));
    if (oldCache.get(cacheKey)?.signature !== signature) await connection.execute(sql, table.columns.map((column) => row[column]));
    nextCache.set(cacheKey, { values, signature });
  }
  const where = table.keys.map((key) => `${quoted(key)} = ?`).join(" AND ");
  for (const [cacheKey, cached] of oldCache) if (!nextCache.has(cacheKey)) await connection.execute(`DELETE FROM ${quoted(table.name)} WHERE ${where}`, cached.values);
  return nextCache;
}

async function persistState(state) {
  const rows = rowsForState(state);
  const connection = await pool.getConnection();
  const nextCaches = {};
  try {
    await connection.beginTransaction();
    for (const table of TABLES) nextCaches[table.name] = await syncTable(connection, table, rows[table.name] || []);
    const setMeta = "INSERT INTO app_meta(meta_key, meta_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)";
    await connection.execute(setMeta, ["initialized", "1"]);
    await connection.execute(setMeta, ["state_version", String(Number(state.version || 0))]);
    await connection.execute(setMeta, ["next_quote_id", String(Number(state.nextQuoteId || 1))]);
    await connection.execute(setMeta, ["updated_at", String(Date.now())]);
    await connection.commit();
    caches = nextCaches;
    lastCounts = { contacts: rows.contacts.length, messages: rows.messages.length, quotes: rows.quotes.length, agents: rows.agents.length, memories: rows.customer_memories.length };
    return true;
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally { connection.release(); }
}

async function listAccounts(executor = pool) {
  const [rows] = await executor.query("SELECT data_json FROM whatsapp_accounts ORDER BY created_at, account_id");
  return rows.map((row, index) => parseJson(row.data_json, `whatsapp_accounts[${index}]`));
}

async function replaceAccounts(accounts) {
  const normalized = (Array.isArray(accounts) ? accounts : []).filter((item) => item && String(item.id || item.accountId || "") && /^[-_\w]+$/i.test(String(item.clientId || item.id || item.accountId || "")));
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const existingRows = await listAccounts(connection);
    const existing = new Map(existingRows.map((item) => [String(item.id || item.accountId), item]));
    const sql = `INSERT INTO whatsapp_accounts(account_id, client_id, label, wa_id, push_name, platform, last_status, last_connected_at, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE client_id=VALUES(client_id), label=VALUES(label), wa_id=VALUES(wa_id), push_name=VALUES(push_name), platform=VALUES(platform), last_status=VALUES(last_status), last_connected_at=VALUES(last_connected_at), created_at=VALUES(created_at), updated_at=VALUES(updated_at), data_json=VALUES(data_json)`;
    const keep = new Set();
    for (const incoming of normalized) {
      const accountId = String(incoming.id || incoming.accountId);
      const previous = existing.get(accountId);
      const merged = mergeAccountRegistryRecord(previous, incoming);
      if (isNewAccountInstance(previous, incoming)) await connection.execute("DELETE FROM whatsapp_sessions WHERE account_id = ?", [accountId]);
      const account = merged.account || {};
      const now = Date.now();
      keep.add(accountId);
      await connection.execute(sql, [accountId, String(merged.clientId || accountId), String(merged.label || accountId), String(account.id || merged.waId || ""), String(account.name || merged.pushName || ""), String(account.platform || merged.platform || ""), String(merged.lastStatus || "offline"), Number(merged.lastConnectedAt || 0), Number(merged.createdAt || now), now, json({ ...merged, updatedAt: now })]);
    }
    for (const accountId of existing.keys()) if (!keep.has(accountId)) await connection.execute("DELETE FROM whatsapp_accounts WHERE account_id = ?", [accountId]);
    await connection.commit();
  } catch (error) { try { await connection.rollback(); } catch (_) {} throw error; }
  finally { connection.release(); }
  return listAccounts();
}

async function updateAccount({ accountId, patch }) {
  const id = String(accountId || "");
  const accounts = await listAccounts();
  const current = accounts.find((item) => String(item.id || item.accountId) === id);
  if (!current) return null;
  const now = Date.now();
  const merged = mergeAccountStatusRecord(current, patch, now);
  const account = merged.account || {};
  const lastStatus = String(merged.lastStatus || merged.status || "offline");
  if (lastStatus === "ready" && !merged.lastConnectedAt) merged.lastConnectedAt = now;
  await pool.execute("UPDATE whatsapp_accounts SET label=?, wa_id=?, push_name=?, platform=?, last_status=?, last_connected_at=?, updated_at=?, data_json=? WHERE account_id=?", [String(merged.label || id), String(account.id || merged.waId || ""), String(account.name || merged.pushName || ""), String(account.platform || merged.platform || ""), lastStatus, Number(merged.lastConnectedAt || 0), now, json(merged), id]);
  return merged;
}

async function saveSession(record) {
  const now = Date.now();
  await pool.execute(`INSERT INTO whatsapp_sessions(session_name, account_id, archive, checksum, encrypted, iv, auth_tag, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id), archive=VALUES(archive), checksum=VALUES(checksum), encrypted=VALUES(encrypted), iv=VALUES(iv), auth_tag=VALUES(auth_tag), size_bytes=VALUES(size_bytes), updated_at=VALUES(updated_at)`, [String(record.sessionName || ""), String(record.accountId || ""), Buffer.from(record.archive), String(record.checksum || ""), record.encrypted ? 1 : 0, record.iv ? Buffer.from(record.iv) : null, record.authTag ? Buffer.from(record.authTag) : null, Number(record.sizeBytes || record.archive?.length || 0), now, now]);
  return true;
}

async function status() {
  const [[health]] = await pool.query("SELECT 1 AS ok");
  const count = async (table) => Number((await pool.query(`SELECT COUNT(*) AS count FROM ${quoted(table)}`))[0][0].count || 0);
  const persistedCounts = {
    contacts: await count("contacts"),
    messages: await count("messages"),
    quotes: await count("quotes"),
    agents: await count("agents"),
    memories: await count("customer_memories")
  };
  const [[accountCount]] = await pool.query("SELECT COUNT(*) AS count FROM whatsapp_accounts");
  const [[nodeCount]] = await pool.query("SELECT COUNT(*) AS count FROM workflow_nodes");
  const [[auth]] = await pool.query("SELECT COUNT(*) AS session_count, COALESCE(SUM(size_bytes),0) AS total_bytes, COALESCE(SUM(CASE WHEN encrypted=1 THEN 1 ELSE 0 END),0) AS encrypted_count FROM whatsapp_sessions");
  return { driver: "mysql", schemaVersion: SCHEMA_VERSION, integrity: health?.ok === 1 ? "ok" : "error", host: config?.host || "127.0.0.1", port: Number(config?.port || 3306), database: config?.database || "", counts: { ...persistedCounts, whatsappAccounts: Number(accountCount.count || 0), workflowNodes: Number(nodeCount.count || 0), whatsappSessions: Number(auth.session_count || 0) }, authSessions: { totalBytes: Number(auth.total_bytes || 0), encrypted: Number(auth.encrypted_count || 0) } };
}

const handlers = {
  initialize,
  loadState,
  persistState,
  listAccounts: async () => listAccounts(),
  replaceAccounts,
  updateAccount,
  deleteAccount: async ({ accountId }) => Number((await pool.execute("DELETE FROM whatsapp_accounts WHERE account_id=?", [String(accountId || "")]))[0].affectedRows || 0),
  hasSession: async ({ sessionName }) => Boolean((await pool.execute("SELECT 1 FROM whatsapp_sessions WHERE session_name=?", [String(sessionName || "")]))[0][0]),
  readSession: async ({ sessionName }) => (await pool.execute("SELECT * FROM whatsapp_sessions WHERE session_name=?", [String(sessionName || "")]))[0][0] || null,
  saveSession,
  deleteSession: async ({ sessionName }) => Number((await pool.execute("DELETE FROM whatsapp_sessions WHERE session_name=?", [String(sessionName || "")]))[0].affectedRows || 0),
  listWorkflowNodes: async ({ chatId }) => (await pool.execute("SELECT node_type, status, message_id FROM workflow_nodes WHERE chat_id=? ORDER BY node_id", [String(chatId || "")]))[0],
  status,
  close: async () => { if (pool) await pool.end(); pool = null; return true; }
};

port.on("message", async (message) => {
  const signal = new Int32Array(message.signal);
  try {
    const handler = handlers[message.operation];
    if (!handler) throw new Error(`Unknown MySQL worker operation: ${message.operation}`);
    const result = await handler(message.args || {});
    port.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, error: { message: error?.message || String(error), stack: error?.stack || "", code: error?.code || "" } });
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
  }
});
port.start();
