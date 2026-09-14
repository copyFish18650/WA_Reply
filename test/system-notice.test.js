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
const { isSystemNotice } = require("../src/message-policy");

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
