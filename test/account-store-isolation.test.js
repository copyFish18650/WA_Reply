process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Store } = require("../src/store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-account-store-"));
  const store = new Store(root);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const accountId of ["account_a", "account_b"]) {
    const chatId = `${accountId}::same-customer@c.us`;
    store.upsertContact(chatId, { accountId, providerChatId: "same-customer@c.us", profileName: accountId });
    store.addMessage({ id: "same-message", chatId, accountId, direction: "inbound", body: "Hello", metadata: { automationState: "queued" } });
    store.updateAccountAutomation(accountId, { enabled: true });
    store.ensureAccountAgent(accountId, `${accountId} agent`);
    store.learnManualReply({ accountId, chatId, question: "Which colour?", answer: accountId });
    store.createCustomerMemory(chatId, { text: `Preference for ${accountId}` });
    store.updateConversationMemory(chatId, { historySummary: accountId });
    store.state.quotes.push({ id: accountId === "account_a" ? 1 : 2, chatId, status: "pending" });
  }
  store.save();
  return { store, root };
}

test("退出仅清空指定账号的会话、报价、队列和记忆，保留本地归档与独立智能体", (t) => {
  const { store, root } = fixture(t);
  const agentsBefore = store.listAgents().map((agent) => agent.id);
  const result = store.clearAccountConversations("account_a", { reason: "logout", previousAccountId: "a@c.us" });
  assert.equal(result.contacts, 1);
  assert.equal(result.messages, 1);
  assert.equal(result.quotes, 1);
  assert.equal(path.dirname(result.archivePath), path.join(root, "account-archives"));
  const archive = JSON.parse(fs.readFileSync(result.archivePath, "utf8"));
  assert.equal(archive.previousAccountId, "a@c.us");
  assert.equal(archive.messages[0].body, "Hello");
  assert.equal(archive.customerMemories.length, 1);
  assert.equal(archive.learnedReplies.length, 1);
  assert.deepEqual(store.listContacts().map((row) => row.accountId), ["account_b"]);
  assert.equal(store.listQueuedMessages("account_a").length, 0);
  assert.equal(store.getAccountAutomation("account_a").enabled, false);
  assert.equal(store.listLearnedReplies("account_a").length, 0);
  assert.equal(store.listQuotes().length, 1);
  assert.equal(store.listCustomerMemories("account_a::same-customer@c.us").length, 0);
  assert.deepEqual(store.listAgents().map((agent) => agent.id).sort(), agentsBefore.sort());
  assert.equal(store.state.accountAgentBindings.account_a, undefined);
  assert.equal(store.listQueuedMessages("account_b").length, 1);
  assert.equal(store.getAccountAutomation("account_b").enabled, true);
  const reopened = new Store(root);
  try {
    assert.equal(reopened.getContact("account_a::same-customer@c.us"), null);
    assert.equal(reopened.listMessages("account_b::same-customer@c.us", { markRead: false }).length, 1);
    assert.equal(reopened.ensureAccountAgent("account_a").rules.length, 0);
    assert.equal(reopened.listMessages("account_a::same-customer@c.us", { markRead: false }).length, 0);
  } finally { reopened.close(); }
});

test("归档写入失败时不清除账号数据", (t) => {
  const { store, root } = fixture(t);
  fs.writeFileSync(path.join(root, "account-archives"), "not a directory");
  assert.throws(() => store.clearAccountConversations("account_a"));
  assert.equal(store.listContacts().length, 2);
  assert.equal(store.listQueuedMessages("account_a").length, 1);
});

test("账号统计按组隔离，同一客户在另一个账号下仍是独立会话", (t) => {
  const { store } = fixture(t);
  assert.equal(store.stats().conversations, 2);
  assert.deepEqual(store.stats([]), { conversations: 0, unread: 0, humanNeeded: 0, pendingQuotes: 0, messages: 0 });
  assert.equal(store.stats(["account_a"]).messages, 1);
  assert.equal(store.stats(["account_b"]).pendingQuotes, 1);
  store.clearAccountConversations("account_a");
  store.upsertContact("account_a::same-customer@c.us", { accountId: "account_a" });
  assert.equal(store.listMessages("account_a::same-customer@c.us", { markRead: false }).length, 0);
  assert.equal(store.listMessages("account_b::same-customer@c.us", { markRead: false }).length, 1);
});
