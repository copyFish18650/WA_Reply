process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const EventEmitter = require("events");
const { Store } = require("../src/store");
const { SalesService } = require("../src/service");
const { LocalAI } = require("../src/local-ai");
const { isSystemNotice, isSpamMessage } = require("../src/message-policy");

const PHISHING_MESSAGE = "尊敬的用户：您的 WhatsApp 因频繁使用不同 IP 网络登录，存在数据泄露以及非法行为。系统已标记为高风险账号，请在 24 小时内点击下方《验证账号》按钮，否则账号将自动注销。";
const OBFUSCATED_PHISHING_MESSAGE = "亲爱的用户：检\u200d测\u200c到您的帐号因频\u200d繁使用不\u200c同 I\u200dP 网络登录，存在数据泄漏以及非法行为。若在系统限定的 24 小时内未验证该帐号，系统将标记为高风险帐号并自动注销。请点击下方《验证帐号》按钮。";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-notice-"));
  const store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = new EventEmitter();
  session.getStatus = () => ({ accounts: [{ accountId: "primary", status: "ready" }] });
  session.sendText = () => { throw new Error("A system notice must not send a reply"); };
  const service = new SalesService({ store, session, dataDir: root });
  return { store, service, root };
}

test("没有有效客户输入时不向模型发送空用户请求", async () => {
  const ai = new LocalAI(() => ({ localAiProvider: "llama.cpp", localAiBaseUrl: "http://127.0.0.1:1", localAiModel: "test" }));
  ai.infer = () => { throw new Error("No model request should be made"); };
  for (const history of [[], [{ direction: "outbound", type: "text", body: "Previous reply" }]]) {
    const result = await ai.decide({}, history);
    assert.equal(result.action, "handoff");
    assert.equal(result.reason, "没有可处理的客户正文");
  }
});

test("obvious WhatsApp verification phishing is ignored before creating a conversation", async (t) => {
  const { store, service } = fixture(t);
  service.ai.decide = () => { throw new Error("Spam must not invoke AI"); };
  const result = await service.ingest({
    id: "phishing-live",
    accountId: "primary",
    chatId: "15553206934@c.us",
    profileName: "+1 (555) 320-6934",
    direction: "inbound",
    type: "image",
    body: PHISHING_MESSAGE,
    createdAt: Date.now()
  });
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "spam-message");
  assert.equal(store.listContacts().length, 0);
  assert.equal(store.listQuotes().length, 0);
  assert.equal(store.listQueuedMessages("primary").length, 0);
});

test("phishing detector requires combined signals and keeps ordinary customer account questions", () => {
  assert.equal(isSpamMessage(PHISHING_MESSAGE), true);
  assert.equal(isSpamMessage(OBFUSCATED_PHISHING_MESSAGE), true);
  assert.equal(isSpamMessage("My WhatsApp account is working now. Can you send the catalog here?"), false);
  assert.equal(isSpamMessage("I had an unusual login yesterday. Is my order still available?"), false);
  assert.equal(isSpamMessage("Can you verify whether this product is in stock?"), false);
});

test("history import drops phishing and startup cleanup removes old spam-only contacts and quotes", t => {
  const { store, root } = fixture(t);
  const cleanChatId = "primary::customer@c.us";
  assert.equal(store.importHistory(cleanChatId, "Customer", [
    { id: "clean", type: "text", direction: "inbound", body: "Hello, I need two bags", createdAt: 1 },
    { id: "phishing-history", type: "image", direction: "inbound", body: PHISHING_MESSAGE, createdAt: 2 }
  ], 2), 1);
  assert.deepEqual(store.listMessages(cleanChatId, { markRead: false }).map((row) => row.id), ["clean"]);
  assert.equal(store.getContact(cleanChatId).unread, 1);

  const spamChatId = "primary::spam@c.us";
  store.upsertContact(spamChatId, { profileName: "Spam", unread: 1, needsHuman: true, handoffMessageId: "old-spam" });
  store.state.messages.push({ id: "old-spam", chatId: spamChatId, accountId: "primary", direction: "inbound", type: "image", body: PHISHING_MESSAGE, createdAt: 3 });
  store.state.quotes.push({ id: 999, chatId: spamChatId, inboundMessageId: "old-spam", status: "pending", createdAt: 3 });
  store.save();

  const reopened = new Store(root);
  try {
    assert.equal(reopened.getContact(spamChatId), null);
    assert.equal(reopened.listMessages(spamChatId, { markRead: false }).length, 0);
    assert.equal(reopened.listQuotes("all", spamChatId).length, 0);
    assert.equal(reopened.getContact(cleanChatId).profileName, "Customer");
  } finally { reopened.close(); }
});

test("status exposes compact per-account unread and review counters", async (t) => {
  const { store, service } = fixture(t);
  const chatId = "primary::customer@c.us";
  store.upsertContact(chatId, { accountId: "primary", profileName: "Customer", unread: 3 });
  store.state.quotes.push({ id: 1000, chatId, inboundMessageId: "photo", status: "pending", createdAt: 1 });
  store.save();
  service.ai.health = async () => ({ ok: true, model: "test" });
  const status = await service.status();
  assert.equal(status.session.accounts[0].inbox.unread, 3);
  assert.equal(status.session.accounts[0].inbox.pendingQuotes, 1);
});

test("空模板通知不进入会话或 AI 队列，客户实际文字保持可见", async (t) => {
  const { store, service } = fixture(t);
  service.ai.decide = () => { throw new Error("A system notice must not invoke AI"); };
  for (const body of ["", "[notification_template]"]) {
    const result = await service.ingest({ id: "notice", accountId: "primary", chatId: "customer@c.us", type: "notification_template", body });
    assert.equal(result.ignored, true);
  }
  assert.equal(store.listContacts().length, 0);
  assert.equal(store.listQueuedMessages("primary").length, 0);
  assert.equal(isSystemNotice({ type: "text", body: "[notification_template]" }), false);
  assert.equal(isSystemNotice({ type: "notification_template", body: "Your order is ready" }), false);
});

test("历史导入过滤空通知，不隐藏同一客户的正常对话", t => {
  const { store } = fixture(t);
  const chatId = "primary::customer@c.us";
  const inserted = store.importHistory(chatId, "Customer", [
    { id: "real", type: "text", direction: "inbound", body: "Hello", createdAt: 1 },
    { id: "notice", type: "notification_template", direction: "inbound", body: "[notification_template]", createdAt: 2 }
  ]);
  assert.equal(inserted, 1);
  assert.equal(store.listContacts()[0].isSystem, false);
  assert.equal(store.getContact(chatId).lastMessagePreview, "Hello");
  assert.deepEqual(store.listMessages(chatId, { markRead: false }).map(row => row.id), ["real"]);
});

test("启动修复旧通知待人工状态并停用错误学习，原始记录保留", t => {
  const { store, root } = fixture(t);
  const chatId = "primary::customer@c.us";
  store.upsertContact(chatId, { needsHuman: true, handoffMessageId: "notice", escalationReason: "本地 AI 不可用：Request failed with status code 400", lastMessagePreview: "[notification_template]", lastMessageAt: 2 });
  store.state.messages.push(
    { id: "real", chatId, accountId: "primary", type: "text", body: "Hello", direction: "inbound", createdAt: 1 },
    { id: "notice", chatId, accountId: "primary", type: "notification_template", body: "[notification_template]", direction: "inbound", createdAt: 2, metadata: { automationState: "queued" } }
  );
  store.state.learnedReplies.push({ id: "bad-learning", accountId: "primary", chatId, sourceMessageId: "notice", question: "[notification_template]", answer: ".", normalizedQuestion: "notification template" });
  store.save();
  const reopened = new Store(root);
  try {
    assert.equal(reopened.getContact(chatId).needsHuman, false);
    assert.equal(reopened.getContact(chatId).lastMessagePreview, "Hello");
    assert.equal(reopened.getMessage(chatId, "notice").metadata.automationState, "ignored");
    assert.equal(reopened.listMessages(chatId, { markRead: false }).length, 1);
    assert.equal(reopened.listQueuedMessages("primary").length, 0);
    assert.equal(reopened.listLearnedReplies("primary").length, 0);
    assert.equal(reopened.learnManualReply({ accountId: "primary", chatId, sourceMessageId: "notice", question: "[notification_template]", answer: "." }), null);
    assert.equal(reopened.state.learnedReplies.length, 1);
  } finally { reopened.close(); }
});
