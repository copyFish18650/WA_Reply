process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const EventEmitter = require("events");
const { Store } = require("../src/store");
const { SalesService, conversationKey } = require("../src/service");

async function settle(service) {
  for (let i = 0; i < 12; i++) {
    await Promise.all([...service.accountQueueJobs.values()]);
    await new Promise(resolve => setImmediate(resolve));
    if (!service.accountQueueJobs.size) return;
  }
  throw new Error("Automatic queue did not settle");
}

function fixture(t, status = "syncing") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-auto-flow-"));
  const store = new Store(root);
  const session = new EventEmitter();
  session.account = { accountId: "primary", status, account: status === "syncing" ? { id: "owner@c.us" } : null };
  session.getStatus = () => ({ accounts: [session.account] });
  session.sent = [];
  session.sendText = async (accountId, chatId, body) => {
    session.sent.push({ accountId, chatId, body });
    return { id: `sent-${session.sent.length}`, createdAt: Date.now() };
  };
  store.updateAccountStyle("primary", { status: "ready", summary: "Concise and helpful", persona: { gender: "female", business: "Fashion", tone: "friendly", personality: "patient" } });
  const service = new SalesService({ store, session, dataDir: root });
  service.ai.decide = async () => ({ action: "reply", reply: "Please send a photo of the wallet you like.", reason: "Clarify request", confidence: 1 });
  t.after(async () => {
    await settle(service);
    for (const timer of service.memoryTimers.values()) clearTimeout(timer);
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, session, service };
}

function incoming(id, chatId = "buyer@c.us", createdAt = Date.now()) {
  return { id, accountId: "primary", chatId, direction: "inbound", type: "text", body: "Please tell me about the material of this wallet.", createdAt };
}

test("开启自动后，同步历史期间的新消息无需手动点击即可发出回复", async t => {
  const { store, session, service } = fixture(t);
  service.setAccountAutomation("primary", true);
  await settle(service);
  session.emit("message", incoming("live"));
  await settle(service);
  assert.equal(session.sent.length, 1);
  assert.equal(store.getMessage(conversationKey("primary", "buyer@c.us"), "live").metadata.automationState, "replied");
  assert.equal(service.queueSnapshot("primary").status, "idle");
});

test("连接恢复进入同步状态时自动唤醒等待队列，未登录的同步状态不能发送", async t => {
  const { store, session, service } = fixture(t, "starting");
  service.setAccountAutomation("primary", true);
  session.emit("message", incoming("waiting"));
  await settle(service);
  assert.equal(session.sent.length, 0);
  assert.equal(store.listQueuedMessages("primary").length, 1);
  session.account.status = "syncing";
  session.emit("status", session.getStatus());
  await settle(service);
  assert.equal(session.sent.length, 0);
  session.account.account = { id: "owner@c.us" };
  session.emit("status", session.getStatus());
  await settle(service);
  assert.equal(session.sent.length, 1);
});

test("开启自动时补入最近未处理消息，不补发旧历史、已回复或人工锁定会话", async t => {
  const { store, session, service } = fixture(t);
  for (const [name, at] of [["recent", Date.now() - 1000], ["old", Date.now() - 86400000], ["answered", Date.now() - 2000], ["manual", Date.now() - 1000]]) {
    const chatId = conversationKey("primary", `${name}@c.us`);
    store.importHistory(chatId, name, [{ ...incoming(name, chatId, at), status: "history" }]);
    if (name === "answered") store.addMessage({ id: "human-answer", chatId, direction: "outbound", type: "text", body: "Already answered", createdAt: Date.now() - 100 });
    if (name === "manual") store.setConversationMode(chatId, "human");
  }
  service.setAccountAutomation("primary", true);
  await settle(service);
  assert.deepEqual(session.sent.map(row => row.chatId), ["recent@c.us"]);
});

test("历史分批同步到新消息后立即回复，不等待整批历史完成", async t => {
  const { session, service } = fixture(t);
  service.setAccountAutomation("primary", true);
  await settle(service);
  session.emit("history", { accountId: "primary", accountName: "Owner", chatId: "recent@c.us", profileName: "Recent buyer", unread: 1, messages: [incoming("history-live", "recent@c.us", Date.now() - 500)] });
  await settle(service);
  assert.equal(session.account.status, "syncing");
  assert.equal(session.sent.length, 1);
});

test("历史先入库、实时事件随后到达也能启动回复，重复事件不重复发送", async t => {
  const { store, session, service } = fixture(t);
  store.updateAccountAutomation("primary", { enabled: true });
  const message = incoming("duplicate");
  store.importHistory(conversationKey("primary", message.chatId), "Buyer", [{ ...message, status: "history" }]);
  await service.ingest(message);
  await settle(service);
  await service.ingest(message);
  await settle(service);
  assert.equal(session.sent.length, 1);
});

test("队列结束的同一瞬间收到新消息仍自动接着处理", async t => {
  const { session, service } = fixture(t);
  service.setAccountAutomation("primary", true);
  await settle(service);
  let injected = false;
  service.on("update", event => {
    if (!injected && event.type === "account-queue" && event.automation.status === "idle" && session.sent.length === 1) {
      injected = true;
      session.emit("message", incoming("edge", "second@c.us"));
    }
  });
  session.emit("message", incoming("first"));
  await settle(service);
  assert.equal(injected, true);
  assert.equal(session.sent.length, 2);
});

test("实际断开连接时保留未发出的消息，重新连上后自动继续", async t => {
  const { store, session, service } = fixture(t);
  service.setAccountAutomation("primary", true);
  await settle(service);
  const send = session.sendText;
  let disconnected = false;
  session.sendText = async (...args) => {
    if (!disconnected) {
      disconnected = true;
      session.account.status = "offline";
      session.account.account = null;
      session.emit("status", session.getStatus());
      throw Object.assign(new Error("WhatsApp 尚未连接"), { statusCode: 409 });
    }
    return send(...args);
  };
  session.emit("message", incoming("recover"));
  await settle(service);
  assert.equal(session.sent.length, 0);
  assert.equal(store.listQueuedMessages("primary").length, 1);
  session.account.status = "syncing";
  session.account.account = { id: "owner@c.us" };
  session.emit("status", session.getStatus());
  await settle(service);
  assert.equal(session.sent.length, 1);
  assert.equal(store.listQueuedMessages("primary").length, 0);
});

test("客户问题后面的 ManosID 标记不会吞掉问题，开启后只回复一次", async t => {
  const { store, session, service } = fixture(t);
  const now = Date.now();
  await service.ingest(incoming("question", "buyer@c.us", now - 100));
  await service.ingest({ ...incoming("marker", "buyer@c.us", now), body: 'ManosID--"DBJGZJMN"' });
  service.setAccountAutomation("primary", true);
  await settle(service);
  const chatId = conversationKey("primary", "buyer@c.us");
  assert.equal(session.sent.length, 1);
  assert.equal(store.getMessage(chatId, "question").metadata.automationState, "replied");
  assert.equal(store.getMessage(chatId, "marker").metadata.automationState, "ignored");
});

test("重连自动补回旧版本被 ManosID 错误合并的近期未回答问题", async t => {
  const { store, session, service } = fixture(t, "starting");
  const chatId = conversationKey("primary", "buyer@c.us");
  store.importHistory(chatId, "Buyer", [
    { ...incoming("lost-question", chatId, Date.now() - 100), metadata: { automationState: "superseded", automationReason: "已合并到该客户更新的消息中" } },
    { ...incoming("marker", chatId), body: 'ManosID--"DBJGZJMN"', metadata: { automationState: "ignored" } }
  ]);
  store.updateAccountAutomation("primary", { enabled: true });
  session.account = { accountId: "primary", status: "syncing", account: { id: "owner@c.us" } };
  session.emit("status", session.getStatus());
  await settle(service);
  assert.equal(session.sent.length, 1);
  assert.equal(store.getMessage(chatId, "lost-question").metadata.automationState, "replied");
});

test("历史完成事件的消息补回不被风格学习失败阻断", async t => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "buyer@c.us");
  store.importHistory(chatId, "Buyer", [{ ...incoming("greeting", chatId), body: "Hello" }]);
  store.updateAccountAutomation("primary", { enabled: true });
  service.ensureAccountStyle = async () => { throw new Error("Background style unavailable"); };
  session.emit("history-complete", { accountId: "primary" });
  await settle(service);
  assert.equal(session.sent.length, 1);
  assert.equal(store.getMessage(chatId, "greeting").metadata.automationState, "replied");
});

test("同一秒的多条文本合并到最后一条真实问题，保留完整上下文", async t => {
  const { store, service, session } = fixture(t);
  const now = Date.now();
  await service.ingest(incoming("first", "buyer@c.us", now));
  await service.ingest({ ...incoming("last", "buyer@c.us", now), body: "Could you show me the lining too?" });
  service.setAccountAutomation("primary", true);
  await settle(service);
  const chatId = conversationKey("primary", "buyer@c.us");
  assert.equal(session.sent.length, 1);
  assert.equal(store.getMessage(chatId, "last").metadata.automationState, "replied");
  assert.equal(store.getMessage(chatId, "first").metadata.automationState, "superseded");
  assert.equal(store.getContext(chatId).filter(row => row.direction === "inbound").length, 2);
});

test("队列 preparing 状态持续落库失败时不自行无限重试，恢复后可继续", async t => {
  const { store, service, session } = fixture(t);
  await service.ingest(incoming("database-failure"));
  store.updateAccountAutomation("primary", { enabled: true });
  const updateAutomation = store.updateAccountAutomation.bind(store);
  let preparingAttempts = 0;
  store.updateAccountAutomation = (accountId, patch) => {
    if (patch.status === "preparing") {
      preparingAttempts += 1;
      // Stop a regressed microtask loop so the test fails instead of hanging.
      if (preparingAttempts >= 3) updateAutomation(accountId, { enabled: false });
      throw new Error("Database unavailable during preparing");
    }
    return updateAutomation(accountId, patch);
  };
  await assert.rejects(service.runAccountQueue("primary"), /Database unavailable during preparing/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preparingAttempts, 1);
  assert.equal(service.accountQueueJobs.size, 0);
  assert.equal(store.listQueuedMessages("primary").length, 1);
  assert.equal(session.sent.length, 0);

  store.updateAccountAutomation = updateAutomation;
  await service.runAccountQueue("primary");
  await settle(service);
  assert.equal(session.sent.length, 1);
  assert.equal(store.listQueuedMessages("primary").length, 0);
});
