process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const EventEmitter = require("events");
const { Store } = require("../src/store");
const { SalesService, conversationKey } = require("../src/service");

class FakeSession extends EventEmitter {
  constructor() { super(); this.sent = []; }
  getStatus() { return { accounts: [{ accountId: "primary", status: "ready" }, { accountId: "second", status: "ready" }] }; }
  async sendText(accountId, chatId, body) { this.sent.push({ accountId, chatId, body }); return { id: `sent-${this.sent.length}`, createdAt: Date.now() }; }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, setup = null) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-account-service-"));
  const store = new Store(dataDir);
  const session = new FakeSession();
  setup?.(store, session);
  const service = new SalesService({ store, session, dataDir });
  t.after(() => {
    for (const timer of service.memoryTimers.values()) clearTimeout(timer);
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { store, session, service };
}

function contact(store, accountId = "primary", options = {}) {
  const chatId = conversationKey(accountId, "buyer@c.us");
  store.upsertContact(chatId, { accountId, providerChatId: "buyer@c.us", profileName: `${accountId} buyer`, ...options });
  return chatId;
}

test("退出同步清空对应会话、定时任务与列表，保留另一账号及显式演示会话", t => {
  const { store, session, service } = fixture(t);
  const first = contact(store);
  const second = contact(store, "second");
  contact(store, "removed");
  contact(store, "demo");
  store.updateConversationMemory(first, { currentScene: "旧账号记忆" });
  service.scheduleConversationMemory(first, 60000);
  assert.deepEqual(new Set(service.listConversations().map(item => item.chatId)), new Set([first, second]));
  assert.equal(service.listConversations("", "all", "demo").length, 1);
  const events = [];
  service.on("update", event => events.push(event));
  session.emit("account-cleared", { accountId: "primary", reason: "logout" });
  assert.equal(store.getContact(first), null);
  assert.equal(service.memoryTimers.has(first), false);
  assert.equal(service.isConversationAvailable(first), false);
  assert.equal(service.isConversationAvailable(second), true);
  assert.deepEqual(service.listConversations().map(item => item.chatId), [second]);
  const cleared = events.find(event => event.type === "account-cleared");
  assert.equal(cleared.accountId, "primary");
  assert.equal(fs.existsSync(cleared.archivePath), true);
});

test("退出后旧模型结果不会向替换账号发送或重新建立消息", async t => {
  const { store, session, service } = fixture(t);
  const chatId = contact(store);
  store.updateAccountStyle("primary", { status: "ready", summary: "简洁礼貌", rules: [] });
  const message = store.addMessage({ id: "incoming", chatId, accountId: "primary", type: "text", body: "What colors does this wallet come in?", direction: "inbound" }).message;
  const started = deferred();
  const model = deferred();
  service.ai.decide = () => { started.resolve(); return model.promise; };
  const work = service.processAndRecord(message);
  const rejected = assert.rejects(work, { code: "ACCOUNT_CHANGED" });
  await started.promise;
  session.emit("account-cleared", { accountId: "primary", reason: "identity-changed" });
  contact(store, "primary", { profileName: "replacement buyer" });
  model.resolve({ action: "reply", confidence: 1, reply: "It comes in black." });
  await rejected;
  assert.equal(session.sent.length, 0);
  assert.equal(store.listMessages(chatId, { markRead: false }).length, 0);
  assert.equal(store.getContact(chatId).profileName, "replacement buyer");
});

test("退出取消排队工作，不在原任务结束后执行旧账号待发送任务", async t => {
  const { store, session, service } = fixture(t);
  const chatId = contact(store);
  const gate = deferred();
  const started = deferred();
  const first = service.enqueue(chatId, async () => { started.resolve(); await gate.promise; });
  await started.promise;
  const second = service.enqueue(chatId, () => service.sendText(chatId, "old queued reply"));
  const rejected = assert.rejects(second, { code: "ACCOUNT_CHANGED" });
  session.emit("account-cleared", { accountId: "primary", reason: "logout" });
  contact(store);
  gate.resolve();
  await first;
  await rejected;
  assert.equal(session.sent.length, 0);
});

test("退出后翻译、长期记忆、风格结果不能回写，旧清理不能移除新任务", async t => {
  const { store, session, service } = fixture(t);
  const chatId = contact(store);
  store.addMessage({ id: "outbound", chatId, accountId: "primary", direction: "outbound", type: "text", body: "Please choose your preferred color." });
  const translation = deferred();
  const memory = deferred();
  const style = deferred();
  service.ai.translate = () => translation.promise;
  service.ai.summarizeConversationMemory = () => memory.promise;
  service.ai.analyzeStyle = () => style.promise;
  const translationWork = service.translateMessages(chatId);
  const memoryWork = service.organizeConversationMemory(chatId, { force: true });
  const styleWork = service.analyzeAccountStyle("primary", { force: true });
  const rejected = [translationWork, memoryWork, styleWork].map(work => assert.rejects(work, { code: "ACCOUNT_CHANGED" }));
  session.emit("account-cleared", { accountId: "primary", reason: "logout" });
  const replacementJob = Promise.resolve("new owner");
  service.styleJobs.set("primary", replacementJob);
  service.translationJobs.set(`${chatId}::outbound`, replacementJob);
  translation.resolve("请选择喜欢的颜色。");
  memory.resolve({ currentScene: "旧账号", historySummary: "旧内容", memories: [] });
  style.resolve({ summary: "旧风格", rules: ["旧规则"], sampleCount: 1 });
  await Promise.all(rejected);
  assert.equal(store.getContact(chatId), null);
  assert.equal(store.state.accountStyles.primary, undefined);
  assert.equal(store.state.conversationMemories[chatId], undefined);
  assert.equal(service.styleJobs.get("primary"), replacementJob);
  assert.equal(service.translationJobs.get(`${chatId}::outbound`), replacementJob);
});

test("启动时归档旧版退出残留与失效账号，会话不流入新建空账号位", t => {
  const { store, service } = fixture(t, (store, session) => {
    contact(store, "primary", { createdAt: 10 });
    contact(store, "removed", { createdAt: 10 });
    contact(store, "second", { createdAt: 10 });
    contact(store, "demo", { createdAt: 10 });
    session.registry = [
      { id: "primary", createdAt: 100 },
      { id: "second", createdAt: 100, lastAccount: { id: "known-owner" } }
    ];
  });
  assert.equal(store.listContacts().some(item => ["primary", "removed"].includes(item.accountId)), false);
  assert.equal(service.listConversations().length, 1);
  assert.equal(service.listConversations()[0].accountId, "second");
  assert.equal(store.listContacts().some(item => item.accountId === "demo"), true);
});

test("退出归档失败会中止清空与任务失效，原账号工作仍可继续", async t => {
  const { store, session, service } = fixture(t);
  const chatId = contact(store);
  const original = store.clearAccountConversations;
  store.clearAccountConversations = () => { throw new Error("archive unavailable"); };
  assert.throws(() => session.emit("account-cleared", { accountId: "primary", reason: "logout" }), /archive unavailable/);
  store.clearAccountConversations = original;
  assert.equal(store.getContact(chatId).accountId, "primary");
  await service.sendText(chatId, "Current owner reply");
  assert.equal(session.sent.length, 1);
});

test("旧数据库将已退出身份合并进重建账号位时仍归档残留，但保留正常重连账号", t => {
  const { store } = fixture(t, (store, session) => {
    contact(store, "primary", { createdAt: 10 });
    contact(store, "second", { createdAt: 10 });
    session.registry = [
      { id: "primary", createdAt: 100, lastConnectedAt: 50, lastAccount: { id: "old-owner" } },
      { id: "second", createdAt: 5, lastConnectedAt: 50, lastAccount: { id: "current-owner" } }
    ];
  });
  assert.equal(store.listContacts().some(item => item.accountId === "primary"), false);
  assert.equal(store.listContacts().some(item => item.accountId === "second"), true);
});
