require("dotenv").config();
const path = require("path");
const express = require("express");
const axios = require("axios");
const { Store } = require("./src/store");
const { WhatsAppSessionManager } = require("./src/whatsapp-session");
const { SalesService } = require("./src/service");
const { CurrencyPricing } = require("./src/pricing");

const ROOT = __dirname;
const configuredDataDir = String(process.env.DATA_DIR || "data").trim() || "data";
const DATA_DIR = path.isAbsolute(configuredDataDir) ? configuredDataDir : path.resolve(ROOT, configuredDataDir);
const PORT = Number(process.env.PORT) || 3010;
const HOST = process.env.HOST || "127.0.0.1";

const store = new Store(DATA_DIR, {
  mysql: {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "whatsapp_sales_ai",
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 8),
    ssl: process.env.MYSQL_SSL === "true" ? {} : undefined
  }
});
const session = new WhatsAppSessionManager({
  authDir: path.join(DATA_DIR, "auth"),
  getSettings: () => store.getRuntimeSettings(),
  persistence: store,
  authEncryptionKey: process.env.AUTH_SESSION_ENCRYPTION_KEY || "",
  backupSyncIntervalMs: Number(process.env.WHATSAPP_SESSION_BACKUP_INTERVAL_MS || 300000),
  autoStart: true
});
const service = new SalesService({ store, session, dataDir: DATA_DIR });
const currencyPricing = new CurrencyPricing();
const app = express();

app.use(express.json({ limit: "50mb" }));
app.use("/media", express.static(service.mediaDir, { fallthrough: false, index: false, maxAge: "1h" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/supplier-image", async (req, res) => {
  try {
    const target = new URL(String(req.query.url || ""));
    const allowedDomains = ["product.aliyizhan.com", "alicdn.com", "geilicdn.com", "qpic.cn", "gxhy1688.com"];
    if (target.protocol !== "https:" && target.protocol !== "http:") throw Object.assign(new Error("图片地址无效"), { statusCode: 400 });
    if (!allowedDomains.some((domain) => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) {
      throw Object.assign(new Error("不支持代理该货源图片域名"), { statusCode: 400 });
    }
    const response = await axios.get(target.toString(), {
      responseType: "arraybuffer",
      timeout: 20000,
      maxContentLength: 10 * 1024 * 1024,
      headers: { Accept: "image/*", Referer: "", "User-Agent": "Mozilla/5.0" }
    });
    res.setHeader("Content-Type", String(response.headers["content-type"] || "image/jpeg"));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(response.data));
  } catch (error) { fail(res, error); }
});

function fail(res, error) {
  res.status(Number(error.statusCode) || 500).json({ ok: false, error: error.message || "服务器错误" });
}

app.get("/api/status", async (_req, res) => {
  try { res.json({ ok: true, ...(await service.status()) }); } catch (error) { fail(res, error); }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const handler = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25000);
  service.on("update", handler);
  req.on("close", () => { clearInterval(keepalive); service.off("update", handler); });
});

app.post("/api/whatsapp/connect", async (_req, res) => {
  try { res.json({ ok: true, session: await session.initialize() }); } catch (error) { fail(res, error); }
});

app.post("/api/whatsapp/logout", async (_req, res) => {
  try {
    const accountId = String(_req.body?.accountId || "primary");
    res.json({ ok: true, session: await session.removeAccount(accountId) });
  } catch (error) { fail(res, error); }
});

app.post("/api/whatsapp/sync", async (_req, res) => {
  try {
    if (!session.getStatus().readyCount) throw Object.assign(new Error("没有已连接的 WhatsApp 账号"), { statusCode: 409 });
    res.json({ ok: true, sync: await session.syncHistory(String(_req.body?.accountId || "")) });
  } catch (error) { fail(res, error); }
});

app.post("/api/whatsapp/accounts", async (req, res) => {
  try { res.json({ ok: true, account: await session.createAccount(req.body?.label) }); } catch (error) { fail(res, error); }
});

app.post("/api/whatsapp/accounts/:accountId/connect", async (req, res) => {
  try { res.json({ ok: true, account: await session.connectAccount(req.params.accountId) }); } catch (error) { fail(res, error); }
});

app.post("/api/whatsapp/accounts/:accountId/sync", async (req, res) => {
  try { res.json({ ok: true, sync: await session.syncHistory(req.params.accountId) }); } catch (error) { fail(res, error); }
});

app.patch("/api/whatsapp/accounts/:accountId/automation", (req, res) => {
  try {
    if (typeof req.body?.enabled !== "boolean") throw Object.assign(new Error("enabled 必须是布尔值"), { statusCode: 400 });
    res.json({ ok: true, automation: service.setAccountAutomation(req.params.accountId, req.body.enabled) });
  } catch (error) { fail(res, error); }
});

app.post("/api/whatsapp/accounts/:accountId/read-records", async (req, res) => {
  try { res.json({ ok: true, ...(await service.readAccountRecords(req.params.accountId)) }); }
  catch (error) { fail(res, error); }
});

app.post("/api/whatsapp/accounts/:accountId/style/analyze", async (req, res) => {
  try { res.json({ ok: true, style: await service.analyzeAccountStyle(req.params.accountId, { force: true }) }); } catch (error) { fail(res, error); }
});

app.put("/api/whatsapp/accounts/:accountId/style", (req, res) => {
  try { res.json({ ok: true, style: service.updateAccountStyle(req.params.accountId, req.body || {}) }); } catch (error) { fail(res, error); }
});

app.put("/api/whatsapp/accounts/:accountId/profile", (req, res) => {
  try { res.json({ ok: true, style: service.updateAccountProfile(req.params.accountId, req.body || {}) }); } catch (error) { fail(res, error); }
});

app.get("/api/agents", (_req, res) => {
  try { res.json({ ok: true, agents: store.listAgents() }); } catch (error) { fail(res, error); }
});

app.post("/api/agents", (req, res) => {
  try { res.json({ ok: true, agent: service.createAgent(req.body || {}) }); } catch (error) { fail(res, error); }
});

app.post("/api/agents/import", express.raw({ type: ["application/zip", "application/octet-stream", "application/x-zip-compressed"], limit: "200mb" }), async (req, res) => {
  try { res.json({ ok: true, agent: await service.importAgentPackage(req.body) }); } catch (error) { fail(res, error); }
});

app.get("/api/agents/:agentId/export", async (req, res) => {
  try {
    const exported = await service.exportAgentPackage(req.params.agentId);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", exported.buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="agent.wa-agent"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`);
    res.send(exported.buffer);
  } catch (error) { fail(res, error); }
});

app.put("/api/agents/:agentId", (req, res) => {
  try { res.json({ ok: true, agent: service.updateAgent(req.params.agentId, req.body || {}) }); } catch (error) { fail(res, error); }
});

app.post("/api/agents/:agentId/welcome-media", (req, res) => {
  try { res.json({ ok: true, asset: service.uploadAgentWelcomeMedia(req.params.agentId, req.body || {}) }); } catch (error) { fail(res, error); }
});

app.post("/api/agents/:agentId/clone", (req, res) => {
  try { res.json({ ok: true, agent: service.cloneAgent(req.params.agentId, req.body?.name) }); } catch (error) { fail(res, error); }
});

app.delete("/api/agents/:agentId", (req, res) => {
  try { res.json({ ok: true, agent: service.deleteAgent(req.params.agentId) }); } catch (error) { fail(res, error); }
});

app.put("/api/whatsapp/accounts/:accountId/agent", (req, res) => {
  try { res.json({ ok: true, style: service.bindAccountAgent(req.params.accountId, req.body?.agentId) }); } catch (error) { fail(res, error); }
});

app.delete("/api/whatsapp/accounts/:accountId", async (req, res) => {
  try { res.json({ ok: true, session: await session.removeAccount(req.params.accountId) }); } catch (error) { fail(res, error); }
});

app.get("/api/conversations", (req, res) => {
  res.json({ ok: true, conversations: store.listContacts(req.query.q, String(req.query.filter || "all")) });
});

app.get("/api/conversations/:chatId/messages", (req, res) => {
  const chatId = req.params.chatId;
  res.json({
    ok: true,
    contact: store.getContact(chatId),
    messages: store.listMessages(chatId, { limit: req.query.limit, before: req.query.before, markRead: true }),
    quotes: store.listQuotes("all", chatId)
  });
});

app.get("/api/conversations/:chatId/insights", (req, res) => {
  try { res.json({ ok: true, ...service.getConversationInsights(req.params.chatId, req.query.limit) }); }
  catch (error) { fail(res, error); }
});

app.post("/api/conversations/:chatId/memory/organize", (req, res) => {
  try {
    const result = service.startConversationMemoryOrganization(req.params.chatId, { force: req.body?.force === true });
    res.status(result.started ? 202 : 200).json({ ok: true, ...result });
  } catch (error) { fail(res, error); }
});

app.patch("/api/conversations/:chatId/memory/summary", (req, res) => {
  try { res.json({ ok: true, memorySummary: service.updateConversationMemorySummary(req.params.chatId, req.body || {}) }); }
  catch (error) { fail(res, error); }
});

app.post("/api/conversations/:chatId/memories", (req, res) => {
  try { res.json({ ok: true, memory: service.createCustomerMemory(req.params.chatId, req.body || {}) }); }
  catch (error) { fail(res, error); }
});

app.patch("/api/conversations/:chatId/memories/:memoryId", (req, res) => {
  try { res.json({ ok: true, memory: service.updateCustomerMemory(req.params.chatId, req.params.memoryId, req.body || {}) }); }
  catch (error) { fail(res, error); }
});

app.delete("/api/conversations/:chatId/memories/:memoryId", (req, res) => {
  try { res.json({ ok: true, memory: service.deleteCustomerMemory(req.params.chatId, req.params.memoryId) }); }
  catch (error) { fail(res, error); }
});

app.post("/api/conversations/:chatId/translations", async (req, res) => {
  try {
    const messages = await service.translateMessages(req.params.chatId, req.body?.messageIds || []);
    res.json({ ok: true, messages });
  } catch (error) { fail(res, error); }
});

app.post("/api/translate", async (req, res) => {
  try {
    const translated = await service.translateText(req.body?.text, req.body?.targetLanguage || "auto", req.body?.chatId || "");
    res.json({ ok: true, ...translated, provider: "local" });
  } catch (error) { fail(res, error); }
});

app.patch("/api/conversations/:chatId/mode", (req, res) => {
  try {
    if (!["auto", "human"].includes(req.body?.mode)) throw Object.assign(new Error("mode 必须是 auto 或 human"), { statusCode: 400 });
    const contact = store.setConversationMode(req.params.chatId, req.body.mode, req.body.mode === "human" ? "管理员手动接管" : "");
    service.publish("mode", { chatId: req.params.chatId, contact });
    res.json({ ok: true, contact });
  } catch (error) { fail(res, error); }
});

app.post("/api/conversations/:chatId/messages", async (req, res) => {
  try { res.json({ ok: true, ...(await service.sendManualReply(req.params.chatId, req.body?.body)) }); }
  catch (error) { fail(res, error); }
});

app.post("/api/conversations/:chatId/media", async (req, res) => {
  try {
    const body = req.body || {};
    const result = Array.isArray(body.items)
      ? await service.sendManualMediaBatch(req.params.chatId, body)
      : await service.sendManualMedia(req.params.chatId, body);
    res.json({ ok: true, ...result });
  }
  catch (error) { fail(res, error); }
});

app.post("/api/conversations/:chatId/ai-reply", async (req, res) => {
  try { res.json({ ok: true, result: await service.replyToMessage(req.params.chatId, req.body?.messageId) }); }
  catch (error) { fail(res, error); }
});

app.post("/api/conversations/:chatId/messages/:messageId/media", async (req, res) => {
  try { res.json({ ok: true, message: await service.recoverMessageMedia(req.params.chatId, req.params.messageId) }); }
  catch (error) { fail(res, error); }
});

app.get("/api/quotes", (req, res) => {
  res.json({ ok: true, quotes: store.listQuotes(String(req.query.status || "all"), String(req.query.chatId || "")) });
});

app.get("/api/exchange-rates", async (_req, res) => {
  try { res.json({ ok: true, ...(await currencyPricing.getRates()) }); } catch (error) { fail(res, error); }
});

app.patch("/api/quotes/:id", (req, res) => {
  try { res.json({ ok: true, quote: service.updateQuote(req.params.id, req.body || {}) }); } catch (error) { fail(res, error); }
});

app.post("/api/quotes/:id/language", async (req, res) => {
  try { res.json({ ok: true, quote: await service.translateQuote(req.params.id, req.body || {}) }); } catch (error) { fail(res, error); }
});

app.delete("/api/quotes/:id", (req, res) => {
  try { res.json({ ok: true, quote: service.deleteQuote(req.params.id) }); } catch (error) { fail(res, error); }
});

app.post("/api/quotes/:id/search", async (req, res) => {
  try { res.json({ ok: true, quote: await service.retryQuoteSearch(req.params.id) }); } catch (error) { fail(res, error); }
});

app.post("/api/quotes/:id/document", async (req, res) => {
  try {
    const body = req.body || {};
    const patch = { ...body };
    delete patch.selectedQuoteIds;
    const result = await service.prepareQuoteDocument(req.params.id, patch, { force: true, quoteIds: body.selectedQuoteIds });
    res.json({ ok: true, quote: result.quote, document: result.document });
  } catch (error) { fail(res, error); }
});

app.post("/api/quotes/:id/approve", async (req, res) => {
  try { res.json({ ok: true, quote: await service.approveQuote(req.params.id, req.body || {}) }); } catch (error) { fail(res, error); }
});

app.post("/api/quotes/:id/reject", async (req, res) => {
  try { res.json({ ok: true, quote: await service.rejectQuote(req.params.id, req.body?.reviewerNote) }); } catch (error) { fail(res, error); }
});

app.get("/api/settings", (_req, res) => {
  const settings = store.getSettings();
  res.json({ ok: true, settings: { ...settings, supplierApiKeyConfigured: Boolean(store.getRuntimeSettings().supplierApiKey) } });
});

app.put("/api/settings", (req, res) => {
  try {
    const patch = req.body || {};
    if (patch.quoteMarkup !== undefined && (!(Number(patch.quoteMarkup) > 0) || Number(patch.quoteMarkup) > 20)) {
      throw Object.assign(new Error("报价倍率必须大于 0 且不超过 20"), { statusCode: 400 });
    }
    if (patch.contextMessageLimit !== undefined && (Number(patch.contextMessageLimit) < 10 || Number(patch.contextMessageLimit) > 200)) {
      throw Object.assign(new Error("上下文消息数必须在 10 到 200 之间"), { statusCode: 400 });
    }
    if (patch.historySyncLimit !== undefined && (Number(patch.historySyncLimit) < 0 || Number(patch.historySyncLimit) > 5000)) {
      throw Object.assign(new Error("历史同步条数必须在 0 到 5000 之间，0 表示全部"), { statusCode: 400 });
    }
    res.json({ ok: true, settings: store.updateSettings(patch) });
    service.publish("settings", {});
  } catch (error) { fail(res, error); }
});

app.post("/api/dev/seed", async (_req, res) => {
  if (process.env.NODE_ENV === "production") return res.sendStatus(404);
  try { res.json({ ok: true, chatId: await service.seedDemo() }); } catch (error) { fail(res, error); }
});

app.post("/api/dev/inbound", async (req, res) => {
  if (process.env.NODE_ENV === "production") return res.sendStatus(404);
  try {
    const chatId = String(req.body?.chatId || "8613900000000@c.us");
    const type = ["image", "video"].includes(req.body?.type) ? req.body.type : "text";
    const mediaBase64 = req.body?.mediaBase64 || req.body?.imageBase64;
    const result = await service.ingest({
      id: `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      accountId: String(req.body?.accountId || "dev"),
      accountName: String(req.body?.accountName || "测试账号"),
      chatId,
      profileName: String(req.body?.profileName || "测试客户"),
      direction: "inbound",
      type,
      body: String(req.body?.body || (type === "image" ? "这个产品多少钱？" : type === "video" ? "[客户发送视频]" : "你好，请介绍一下你们的产品")),
      createdAt: Date.now(),
      ...(["image", "video"].includes(type) && mediaBase64 ? { media: { data: String(mediaBase64).replace(/^data:[^;]+;base64,/, ""), mimeType: String(req.body.mimeType || (type === "video" ? "video/mp4" : "image/jpeg")) } } : {})
    });
    res.json({ ok: true, result });
  } catch (error) { fail(res, error); }
});

app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));

const server = app.listen(PORT, HOST, () => {
  console.log(`WhatsApp Sales AI: http://${HOST}:${PORT}`);
  console.log("扫码登录后将自动同步会话；AI 仅调用本地模型。");
});

service.on("update", (event) => {
  if (["error", "sync-error"].includes(event.type)) console.error(`[${event.type}] ${event.message || "未知错误"}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  const timeout = setTimeout(() => {
    try { store.close(); } finally { process.exit(1); }
  }, 20000);
  timeout.unref();
  try {
    await session.shutdown();
  } finally {
    clearTimeout(timeout);
    try { store.close(); } finally { process.exit(0); }
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { app, store, session, service, server };
