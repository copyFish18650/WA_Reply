function isNewAccountInstance(existing, incoming) {
  const previousCreatedAt = Number(existing?.createdAt);
  const nextCreatedAt = Number(incoming?.createdAt);
  return Number.isFinite(previousCreatedAt) && previousCreatedAt > 0
    && Number.isFinite(nextCreatedAt) && nextCreatedAt > 0
    && previousCreatedAt !== nextCreatedAt;
}

function mergeAccountRegistryRecord(existing, incoming, now = Date.now()) {
  const previous = isNewAccountInstance(existing, incoming) ? {} : (existing || {});
  const merged = { ...previous, ...incoming };
  const id = String(incoming.id || incoming.accountId || previous.id || previous.accountId || "");
  const createdAt = Number(incoming.createdAt || previous.createdAt || now);
  return {
    ...merged,
    id,
    accountId: id,
    clientId: String(merged.clientId || id),
    label: String(merged.label || id),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now
  };
}

function mergeAccountStatusRecord(existing, patch, now = Date.now()) {
  const id = String(existing.id || existing.accountId || "");
  const account = Object.prototype.hasOwnProperty.call(patch, "account") ? patch.account : (existing.account || null);
  return { ...existing, ...patch, id, accountId: id, account, updatedAt: now };
}

module.exports = { isNewAccountInstance, mergeAccountRegistryRecord, mergeAccountStatusRecord };
