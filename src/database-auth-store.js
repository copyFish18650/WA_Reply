const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fse = require("fs-extra");
const archiver = require("archiver");

function sessionKey(value) {
  const key = String(value || "");
  if (!/^[-_\w]+$/i.test(key)) throw new Error("WhatsApp session name is invalid");
  return key;
}

function encryptionKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (parsed.length !== 32) {
    throw new Error("AUTH_SESSION_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)");
  }
  return parsed;
}

function zipDirectory(source, target) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(target);
    const archive = archiver("zip", { zlib: { level: 6 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize();
  });
}

class DatabaseRemoteAuthStore {
  constructor({ database, dataPath, accountId, encryptionKey: key = "" }) {
    if (!database) throw new Error("MySQL database is required for WhatsApp authentication");
    this.database = database;
    this.dataPath = path.resolve(dataPath);
    this.accountId = String(accountId || "");
    this.key = encryptionKey(key);
    fs.mkdirSync(this.dataPath, { recursive: true });
  }

  async sessionExists({ session }) {
    return this.database.hasWhatsAppSession(sessionKey(session));
  }

  encode(buffer) {
    if (!this.key) return { archive: buffer, encrypted: false, iv: null, authTag: null };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const archive = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return { archive, encrypted: true, iv, authTag: cipher.getAuthTag() };
  }

  decode(record) {
    const archive = Buffer.from(record.archive);
    if (!record.encrypted) return archive;
    if (!this.key) throw new Error("WhatsApp login session is encrypted; configure AUTH_SESSION_ENCRYPTION_KEY");
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv));
      decipher.setAuthTag(Buffer.from(record.auth_tag));
      return Buffer.concat([decipher.update(archive), decipher.final()]);
    } catch (_) {
      throw new Error("Unable to decrypt the WhatsApp login session; check AUTH_SESSION_ENCRYPTION_KEY");
    }
  }

  persist(session, archive) {
    const name = sessionKey(session);
    const payload = Buffer.from(archive);
    if (!payload.length) throw new Error("WhatsApp login session archive is empty");
    const checksum = crypto.createHash("sha256").update(payload).digest("hex");
    const current = this.database.readWhatsAppSession(name);
    if (current?.checksum === checksum && Boolean(current.encrypted) === Boolean(this.key)) return false;
    const encoded = this.encode(payload);
    this.database.saveWhatsAppSession({
      sessionName: name,
      accountId: this.accountId,
      archive: encoded.archive,
      checksum,
      encrypted: encoded.encrypted,
      iv: encoded.iv,
      authTag: encoded.authTag,
      sizeBytes: payload.length
    });
    this.database.updateWhatsAppAccount(this.accountId, {
      sessionBackedUpAt: Date.now(),
      sessionChecksum: checksum,
      sessionEncrypted: encoded.encrypted
    });
    return true;
  }

  async save({ session }) {
    const name = sessionKey(session);
    const archivePath = path.join(this.dataPath, `${name}.zip`);
    const archive = await fs.promises.readFile(archivePath);
    this.persist(name, archive);
  }

  async extract({ session, path: targetPath }) {
    const name = sessionKey(session);
    const record = this.database.readWhatsAppSession(name);
    if (!record) throw new Error(`WhatsApp login session ${name} does not exist in the database`);
    const archive = this.decode(record);
    const checksum = crypto.createHash("sha256").update(archive).digest("hex");
    if (checksum !== record.checksum) throw new Error(`WhatsApp login session ${name} failed its integrity check`);
    if (!record.encrypted && this.key) this.persist(name, archive);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, archive);
  }

  async delete({ session }) {
    this.database.deleteWhatsAppSession(sessionKey(session));
  }

  async importLegacySession({ session, profilePath }) {
    const name = sessionKey(session);
    if (this.database.hasWhatsAppSession(name)) return { imported: false, reason: "already-stored" };
    const sourceDefault = path.join(path.resolve(profilePath), "Default");
    const required = ["IndexedDB", "Local Storage"];
    const available = required.filter((dir) => fs.existsSync(path.join(sourceDefault, dir)));
    if (!available.length) return { imported: false, reason: "legacy-session-not-found" };

    const workingPath = await fs.promises.mkdtemp(path.join(this.dataPath, ".auth-import-"));
    const stageDefault = path.join(workingPath, "stage", "Default");
    const archivePath = path.join(workingPath, `${name}.zip`);
    try {
      await fse.ensureDir(stageDefault);
      for (const dir of available) {
        await fse.copy(path.join(sourceDefault, dir), path.join(stageDefault, dir), {
          overwrite: true,
          errorOnExist: false
        });
      }
      await zipDirectory(path.join(workingPath, "stage"), archivePath);
      const archive = await fs.promises.readFile(archivePath);
      this.persist(name, archive);
      return { imported: true, sizeBytes: archive.length, encrypted: Boolean(this.key) };
    } finally {
      await fs.promises.rm(workingPath, { recursive: true, force: true });
    }
  }
}

module.exports = { DatabaseRemoteAuthStore, encryptionKey };
