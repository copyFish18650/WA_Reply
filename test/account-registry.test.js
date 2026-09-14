const test = require("node:test");
const assert = require("node:assert/strict");
const { isNewAccountInstance, mergeAccountRegistryRecord, mergeAccountStatusRecord } = require("../src/account-registry");

const original = {
  id: "primary",
  accountId: "primary",
  clientId: "sales-ai",
  label: "Original account",
  createdAt: 100,
  account: { id: "111@c.us", name: "Old owner" },
  lastAccount: { id: "111@c.us", name: "Old owner" },
  lastConnectedAt: 150,
  lastStatus: "ready",
  sessionChecksum: "old-auth-checksum",
  automation: { enabled: true }
};

test("a recreated account slot discards the previous identity and login metadata", () => {
  const incoming = { id: "primary", clientId: "sales-ai", label: "New account", createdAt: 200 };
  assert.equal(isNewAccountInstance(original, incoming), true);
  assert.deepEqual(mergeAccountRegistryRecord(original, incoming), { ...incoming, accountId: "primary" });
  assert.equal(original.account.id, "111@c.us");
});

test("same instance registry updates preserve owner and auth metadata", () => {
  const incoming = { id: "primary", createdAt: "100", label: "Renamed account" };
  assert.equal(isNewAccountInstance(original, incoming), false);
  const merged = mergeAccountRegistryRecord(original, incoming);
  assert.equal(merged.label, "Renamed account");
  assert.equal(merged.createdAt, 100);
  assert.equal(merged.clientId, "sales-ai");
  assert.deepEqual(merged.account, original.account);
  assert.equal(merged.sessionChecksum, "old-auth-checksum");
});

test("partial registry updates without creation timestamps do not replace the account instance", () => {
  const incoming = { id: "primary", label: "Renamed account" };
  assert.equal(isNewAccountInstance(original, incoming), false);
  const merged = mergeAccountRegistryRecord(original, incoming, 999);
  assert.equal(merged.createdAt, 100);
  assert.equal(merged.lastConnectedAt, 150);
  assert.deepEqual(merged.lastAccount, original.lastAccount);
  assert.deepEqual(mergeAccountRegistryRecord(null, { id: "new" }, 999), { id: "new", accountId: "new", clientId: "new", label: "new", createdAt: 999 });
});

test("QR or logout can clear current identity while remembering the previous owner", () => {
  const loggedOut = mergeAccountStatusRecord(original, { account: null, lastStatus: "offline" }, 250);
  assert.equal(loggedOut.account, null);
  assert.equal(loggedOut.lastStatus, "offline");
  assert.deepEqual(loggedOut.lastAccount, original.lastAccount);
  assert.equal(loggedOut.updatedAt, 250);
  const partial = mergeAccountStatusRecord(original, { statusMessage: "Background sync" }, 260);
  assert.deepEqual(partial.account, original.account);
});
