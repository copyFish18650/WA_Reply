const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const EventEmitter = require("node:events");
const { AccountSession, WhatsAppSessionManager } = require("../src/whatsapp-session");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, accounts = [{ id: "primary", clientId: "sales-ai", label: "Account A", account: { id: "111@c.us", name: "Owner A" } }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-account-isolation-"));
  fs.writeFileSync(path.join(root, "accounts.json"), JSON.stringify(accounts));
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor() { super(); this.info = { wid: "111@c.us", pushname: "Owner A" }; clients.push(this); }
    async initialize() {}
    async logout() { this.emit("disconnected", "LOGOUT"); }
    async destroy() {}
    async getChats() { return []; }
  }
  const mocks = {
    "whatsapp-web.js": { Client: FakeClient, LocalAuth: class {}, RemoteAuth: class {} },
    qrcode: { toDataURL: async () => "data:image/png;base64,fake" }
  };
  for (const [name, exports] of Object.entries(mocks)) {
    const id = require.resolve(name);
    const previous = require.cache[id];
    require.cache[id] = { id, filename: id, loaded: true, exports };
    t.after(() => { if (previous) require.cache[id] = previous; else delete require.cache[id]; });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const create = () => new WhatsAppSessionManager({ authDir: root, getSettings: () => ({ historySyncLimit: 0 }), autoStart: false });
  return { root, clients, create, manager: create() };
}

async function emitAsync(client, name, ...args) {
  await Promise.all(client.listeners(name).map((listener) => listener(...args)));
}

for (const reason of ["UNPAIRED", "UNPAIRED_IDLE"]) {
  test(`device unlink ${reason} clears before a later LOGOUT callback`, async (t) => {
    const { manager, clients } = fixture(t);
    const events = [];
    manager.on("account-cleared", event => events.push(event));
    await manager.connectAccount("primary");
    clients[0].emit("disconnected", reason);
    clients[0].emit("disconnected", "LOGOUT");
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "logout");
    assert.equal(manager.getSession("primary").getStatus().status, "offline");
  });
}

test("removing an offline final account clears before teardown and never reuses primary", async (t) => {
  const { manager, create } = fixture(t);
  const old = manager.getSession("primary");
  const gate = deferred();
  let teardownStarted = false;
  old.logout = async () => { teardownStarted = true; await gate.promise; };
  const events = [];
  manager.on("account-cleared", (event) => {
    assert.equal(teardownStarted, false);
    assert.equal(manager.getSessionIdentity("primary"), "");
    events.push(event);
  });
  const removing = manager.removeAccount("primary");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { accountId: "primary", reason: "removed", previousAccountId: "111@c.us" });
  assert.equal(manager.getStatus().totalAccounts, 0);
  assert.equal(create().getStatus().totalAccounts, 0);
  let forwarded = 0;
  for (const name of ["message", "outbound", "history", "history-complete", "ack", "status", "sync-error"]) manager.on(name, () => { forwarded += 1; });
  old.emit("message", {});
  old.emit("history", {});
  old.emit("outbound", {});
  old.emit("status", { accountId: "primary", status: "ready" });
  old.emit("sync-error", new Error("stale"));
  assert.equal(forwarded, 0);
  gate.resolve();
  await removing;
  const [first, second] = await Promise.all([manager.createAccount(), manager.createAccount()]);
  assert.notEqual(first.accountId, "primary");
  assert.notEqual(first.accountId, second.accountId);
});

test("owner survives QR and restart; a new owner clears before history starts", async (t) => {
  const { manager, create, clients, root } = fixture(t);
  await manager.connectAccount("primary");
  await emitAsync(clients[0], "qr", "qr");
  const saved = JSON.parse(fs.readFileSync(path.join(root, "accounts.json"), "utf8"))[0];
  assert.equal(saved.account, null);
  assert.equal(saved.lastAccount.id, "111@c.us");
  const restarted = create();
  await restarted.connectAccount("primary");
  const client = clients[1];
  client.info = { wid: "222@c.us", pushname: "Owner B" };
  const ordered = [];
  restarted.on("account-cleared", (event) => ordered.push(event));
  restarted.on("status", (status) => {
    if (status.accounts[0]?.account?.id === "222@c.us") ordered.push("new-owner-status");
  });
  restarted.on("history-complete", () => ordered.push("history"));
  const previous = restarted.getSessionIdentity("primary");
  await emitAsync(client, "ready");
  assert.deepEqual(ordered[0], { accountId: "primary", reason: "identity-changed", previousAccountId: "111@c.us", nextAccountId: "222@c.us" });
  assert.ok(ordered.includes("history"));
  assert.notEqual(restarted.getSessionIdentity("primary"), previous);
  assert.equal(restarted.registry[0].lastAccount.id, "222@c.us");
});

test("temporary disconnect keeps the group; mobile logout clears once and ignores old callbacks", async (t) => {
  const { manager, clients } = fixture(t);
  const events = [];
  manager.on("account-cleared", (event) => events.push(event));
  await manager.connectAccount("primary");
  const temporary = clients[0];
  await emitAsync(temporary, "ready");
  const identity = manager.getSessionIdentity("primary");
  temporary.emit("disconnected", "CONFLICT");
  assert.equal(events.length, 0);
  assert.equal(manager.getSessionIdentity("primary"), identity);
  await manager.connectAccount("primary");
  const current = clients[1];
  await emitAsync(current, "ready");
  current.emit("disconnected", "LOGOUT");
  current.emit("disconnected", "LOGOUT");
  temporary.emit("authenticated");
  await emitAsync(current, "qr", "stale");
  await emitAsync(current, "ready");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "logout");
  assert.notEqual(manager.getSessionIdentity("primary"), identity);
  assert.equal(manager.getSession("primary").getStatus().status, "offline");
});

test("inflight inbound and history work cannot emit into a replaced identity", async (t) => {
  const { manager, clients } = fixture(t);
  await manager.connectAccount("primary");
  const client = clients[0];
  await emitAsync(client, "ready");
  const session = manager.getSession("primary");
  const normalizeGate = deferred();
  const historyGate = deferred();
  session.normalizeMessage = async () => { await normalizeGate.promise; return { chatId: "buyer@c.us", isGroup: false }; };
  session.getChatSummaries = async () => [{ chatId: "buyer@c.us", timestamp: 1 }];
  session.fetchMessagesForChat = async () => { await historyGate.promise; return [{ id: "old" }]; };
  const forwarded = [];
  manager.on("message", () => forwarded.push("message"));
  manager.on("history", () => forwarded.push("history"));
  manager.on("history-complete", () => forwarded.push("complete"));
  const inbound = emitAsync(client, "message", { id: "old-inbound", getChat: async () => ({ sendSeen: async () => {} }) });
  const sync = session.syncHistory();
  await new Promise((resolve) => setImmediate(resolve));
  session.clearAccount("identity-changed", { id: "222@c.us", name: "Owner B" });
  normalizeGate.resolve();
  historyGate.resolve();
  await inbound;
  await assert.rejects(sync, /切换或断开/);
  assert.deepEqual(forwarded, []);
});

test("offline explicit logout still clears account data synchronously", async (t) => {
  const { root } = fixture(t, []);
  const session = new AccountSession({ accountId: "offline", clientId: "offline", authDir: root, getSettings: () => ({}) });
  const cleared = [];
  session.on("account-cleared", (event) => cleared.push(event));
  const logout = session.logout();
  assert.deepEqual(cleared, [{ accountId: "offline", reason: "logout" }]);
  await logout;
});

test("failed account archive keeps the existing session accessible for retry", async (t) => {
  const { manager } = fixture(t);
  const original = manager.getSession("primary");
  const identity = manager.getSessionIdentity("primary");
  manager.on("account-cleared", () => { throw new Error("archive disk full"); });
  await assert.rejects(manager.removeAccount("primary"), /archive disk full/);
  assert.equal(manager.getSession("primary"), original);
  assert.equal(manager.getSessionIdentity("primary"), identity);
  assert.equal(original.retired, false);
  assert.equal(manager.registry.length, 1);
});

test("offline removal deletes persisted auth and only this account's local caches", async (t) => {
  const { manager, root } = fixture(t);
  const session = manager.getSession("primary");
  const deleted = [];
  session.authStore = { delete: async (value) => deleted.push(value) };
  for (const name of ["session-sales-ai", "RemoteAuth-sales-ai", "wwebjs_temp_session_sales-ai", "RemoteAuth-other"]) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, "cache.txt"), "fake test login");
  }
  fs.writeFileSync(path.join(root, "RemoteAuth-sales-ai.zip"), "fake archive");
  await manager.removeAccount("primary");
  assert.deepEqual(deleted, [{ session: "RemoteAuth-sales-ai" }]);
  for (const name of ["session-sales-ai", "RemoteAuth-sales-ai", "wwebjs_temp_session_sales-ai", "RemoteAuth-sales-ai.zip"]) assert.equal(fs.existsSync(path.join(root, name)), false);
  assert.equal(fs.existsSync(path.join(root, "RemoteAuth-other", "cache.txt")), true);
});
