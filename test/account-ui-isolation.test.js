const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8").replace(/\nstart\(\);\s*$/, "");
const account = (id) => ({ accountId: id, status: "ready", account: { id, name: `Current ${id}` } });
const contact = (id) => ({ chatId: `${id}::customer`, accountId: id, profileName: "Customer", lastMessageAt: Date.now() });

function setup() {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: "", innerHTML: "", textContent: "", disabled: false, style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {}
    });
    return elements.get(selector);
  }
  const requests = [];
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], activeElement: null },
    URL, URLSearchParams, Set, Map, Date, Intl,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {},
    fetch(url) {
      return new Promise((resolve) => requests.push({
        url,
        respond(payload) { resolve({ ok: true, json: async () => payload }); }
      }));
    }
  });
  vm.runInContext(`${source}\nglobalThis.ui = { state, loadConversations, selectConversation, setConversationGroup, reconcileConversationGroups, scheduleRefresh, translateComposer, loadInspectorInsights, renderStatus };`, context);
  const ui = context.ui;
  ui.state.status = { session: { accounts: [account("a"), account("b")] } };
  ui.reconcileConversationGroups();
  return { ui, element, requests };
}

test("switching account groups rejects old list responses and other-account contacts", async () => {
  const { ui, requests } = setup();
  const first = ui.loadConversations();
  assert.equal(new URL(requests[0].url, "http://local").searchParams.get("accountId"), "a");
  ui.setConversationGroup("b");
  const second = ui.loadConversations();
  requests[1].respond({ conversations: [contact("b"), contact("a")] });
  await second;
  requests[0].respond({ conversations: [contact("a")] });
  await first;
  assert.equal(ui.state.conversations.length, 1);
  assert.equal(ui.state.conversations[0].accountId, "b");
});

test("late chat responses cannot restore a former account or its draft", async () => {
  const { ui, requests, element } = setup();
  ui.state.conversations = [contact("a")];
  const pending = ui.selectConversation("a::customer");
  element("#messageInput").value = "Old account draft";
  element("#memoryCurrentScene").value = "Old account memory";
  ui.setConversationGroup("b");
  requests[0].respond({ contact: contact("a"), messages: [] });
  await pending;
  assert.equal(ui.state.selectedChatId, "");
  assert.equal(ui.state.active, null);
  assert.equal(element("#messageInput").value, "");
  assert.equal(element("#memoryCurrentScene").value, "");
});

test("old composer translation cannot replace matching text in another account", async () => {
  const { ui, requests, element } = setup();
  ui.state.conversations = [contact("a")];
  ui.state.selectedChatId = "a::customer";
  ui.state.active = { contact: contact("a"), messages: [] };
  element("#messageInput").value = "Translate me";
  const pending = ui.translateComposer();
  ui.setConversationGroup("b");
  element("#messageInput").value = "Translate me";
  requests[0].respond({ translation: "STALE TRANSLATION" });
  await pending;
  assert.equal(element("#messageInput").value, "Translate me");
});

test("logout notification clears selection immediately and rejects late inspector responses", async () => {
  const { ui, requests } = setup();
  ui.state.conversations = [contact("a")];
  ui.state.selectedChatId = "a::customer";
  ui.state.active = { contact: contact("a"), messages: [] };
  const pending = ui.loadInspectorInsights();
  ui.scheduleRefresh({ data: JSON.stringify({ type: "account-cleared", accountId: "a" }) });
  assert.equal(ui.state.active, null);
  assert.equal(ui.state.selectedChatId, "");
  assert.equal(ui.state.conversations.length, 0);
  requests[0].respond({ memories: ["old customer"] });
  await pending;
  assert.equal(ui.state.inspectorCache.size, 0);
});

test("removed selected conversations clear the reply target and last logout never chooses demo", async () => {
  const { ui, requests } = setup();
  ui.state.conversations = [contact("a")];
  ui.state.selectedChatId = "a::customer";
  ui.state.active = { contact: contact("a"), messages: [] };
  const pending = ui.loadConversations();
  requests[0].respond({ conversations: [] });
  await pending;
  assert.equal(ui.state.selectedChatId, "");
  assert.equal(ui.state.active, null);
  ui.state.status.session.accounts = [];
  ui.reconcileConversationGroups();
  assert.equal(ui.state.accountGroupId, "");
  ui.setConversationGroup("demo");
  ui.reconcileConversationGroups();
  assert.equal(ui.state.accountGroupId, "demo");
});

test("connected accounts keep automation controls usable during history sync", () => {
  const { ui, element } = setup();
  ui.state.status.session = { status: "syncing", readyCount: 0, accounts: [{
    ...account("a"), status: "syncing",
    sync: { completed: 2, total: 8, imported: 12 },
    style: { persona: { completed: true } },
    automation: { enabled: true, status: "idle" }
  }] };
  ui.renderStatus();
  assert.equal(element("#connectionText").textContent, "1 个账号在线 · 同步历史中");
  assert.equal(element("#accountSummary").textContent, "1 个账号 · 1 个在线");
  assert.equal(element("#syncButton").disabled, true);
  for (const selector of ["#accountList", "#accountQueueBoard"]) {
    const html = element(selector).innerHTML;
    assert.doesNotMatch(html.match(/<input[^>]*data-account-automation[^>]*>/)[0], /disabled/);
    assert.doesNotMatch(html.match(/<button[^>]*data-account-action="read-records"[^>]*>/)[0], /disabled/);
    assert.doesNotMatch(html, /等待连接/);
  }
  assert.match(element("#accountList").innerHTML, /2\/8 会话 · 12 条/);
  assert.match(element("#accountQueueBoard").innerHTML, /WhatsApp 在线 · 同步历史中/);
});

test("QR, startup, and syncing without a logged-in identity keep automation disabled", () => {
  const { ui, element } = setup();
  for (const status of ["qr", "starting", "authenticated", "offline", "syncing"]) {
    ui.state.status.session = { status, readyCount: 0, accounts: [{
      accountId: "a", status, account: status === "syncing" ? null : { id: "a" },
      style: { persona: { completed: true } },
      automation: { enabled: false, status: "waiting_connection" }
    }] };
    ui.renderStatus();
    assert.equal(element("#syncButton").disabled, true, status);
    assert.equal(element("#accountSummary").textContent, "1 个账号 · 0 个在线", status);
    for (const selector of ["#accountList", "#accountQueueBoard"]) {
      assert.match(element(selector).innerHTML.match(/<input[^>]*data-account-automation[^>]*>/)[0], /disabled/, status);
    }
    assert.match(element("#accountQueueBoard").innerHTML, /等待连接/, status);
  }
});
