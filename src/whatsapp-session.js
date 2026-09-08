const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const { isSystemChatId, isSystemConversation } = require("./message-policy");

function browserExecutable() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || undefined;
}

function serializedId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value._serialized || `${value.user || ""}@${value.server || "c.us"}`;
}

function messageId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value._serialized) return value._serialized;
  const stanza = value.id || value.stanzaId || value.stanzaID || "";
  const remote = serializedId(value.remote || value.from || value.to);
  const participant = serializedId(value.participant);
  if (stanza) return `${value.fromMe ? "true" : "false"}_${remote}_${stanza}${participant ? `_${participant}` : ""}`;
  try {
    const raw = JSON.stringify(value);
    if (raw && raw !== "{}") return raw;
  } catch (_) {}
  return `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizedType(type) {
  if (type === "image") return "image";
  if (type === "video") return "video";
  if (["chat", "text"].includes(type)) return "text";
  return type || "unknown";
}

function safeError(error) {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try { return new Error(JSON.stringify(error)); } catch (_) { return new Error(String(error)); }
}

function messageFromMe(message, ownId = "") {
  const own = serializedId(ownId);
  const from = serializedId(message?.from);
  const to = serializedId(message?.to);
  if (own && from && from === own) return true;
  if (own && to && to === own) return false;
  if (typeof message?.id?.fromMe === "boolean") return message.id.fromMe;
  return Boolean(message?.fromMe);
}

class AccountSession extends EventEmitter {
  constructor({ accountId, clientId, label, authDir, getSettings, authStore = null, backupSyncIntervalMs = 300000, autoStart = false }) {
    super();
    this.accountId = accountId;
    this.clientId = clientId;
    this.label = label || accountId;
    this.authDir = path.resolve(authDir);
    this.getSettings = getSettings;
    this.authStore = authStore;
    this.backupSyncIntervalMs = Math.max(60000, Number(backupSyncIntervalMs || 300000));
    this.client = null;
    this.initializing = null;
    this.recentInbound = new Map();
    this.state = {
      accountId,
      label: this.label,
      status: "offline",
      message: "等待启动",
      qrDataUrl: "",
      account: null,
      sync: null,
      updatedAt: Date.now()
    };
    fs.mkdirSync(this.authDir, { recursive: true });
    if (autoStart) setImmediate(() => this.initialize().catch(() => {}));
  }

  setState(patch) {
    this.state = { ...this.state, ...patch, accountId: this.accountId, label: this.label, updatedAt: Date.now() };
    this.emit("status", this.getStatus());
  }

  getStatus() {
    return { ...this.state, qrAvailable: Boolean(this.state.qrDataUrl) };
  }

  accountName() {
    return this.state.account?.name || this.label;
  }

  isFromMe(message) {
    return messageFromMe(message, this.client?.info?.wid || this.state.account?.id || "");
  }

  handleLoadingScreen(percent, message) {
    const loadingText = `${Number(percent || 0)}% · ${String(message || "WhatsApp")}`;
    if (this.state.account?.id) {
      this.setState({ status: "ready", message: `WhatsApp 已连接 · 后台载入 ${loadingText}` });
      return this.getStatus();
    }
    this.setState({ status: "starting", message: `正在载入 ${loadingText}` });
    return this.getStatus();
  }

  async downloadMediaPayload(message, retries = 2) {
    if (!message || typeof message.downloadMedia !== "function") return null;
    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const media = await message.downloadMedia();
        if (media?.data) return { data: media.data, mimeType: media.mimetype || "application/octet-stream", filename: media.filename || "" };
      } catch (error) {
        lastError = safeError(error);
      }
      if (attempt + 1 < retries) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    try {
      const fallback = await this.downloadMediaFromPage(message.id?._serialized || messageId(message.id));
      if (fallback?.data) return fallback;
    } catch (error) {
      lastError = safeError(error);
    }
    if (lastError) throw lastError;
    return null;
  }

  async downloadMediaFromPage(id) {
    if (!this.client?.pupPage) return null;
    const result = await this.client.pupPage.evaluate(async (msgId) => {
      const collection = window.require("WAWebCollections").Msg;
      const msg = collection.get(msgId) || (await collection.getMessagesById([msgId]))?.messages?.[0];
      if (!msg) return null;
      const encode = async (buffer) => window.WWebJS.arrayBufferToBase64Async(buffer);
      const renderableUrl = msg.mediaData?.renderableUrl || msg.mediaData?.mediaBlob?.url?.();
      if (renderableUrl) {
        try {
          const response = await fetch(renderableUrl);
          if (response.ok) return { data: await encode(await response.arrayBuffer()), mimetype: msg.mimetype, filename: msg.filename };
        } catch (_) {}
      }
      try {
        const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
        const decrypted = await window.require("WAWebDownloadManager").downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath || msg.mediaData?.directPath,
          encFilehash: msg.encFilehash || msg.mediaData?.encFilehash,
          filehash: msg.filehash || msg.mediaData?.filehash,
          mediaKey: msg.mediaKey || msg.mediaData?.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp || msg.mediaData?.mediaKeyTimestamp,
          type: msg.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl
        });
        return { data: await encode(decrypted), mimetype: msg.mimetype, filename: msg.filename };
      } catch (_) { return null; }
    }, String(id || ""));
    if (!result?.data) return null;
    return { data: result.data, mimeType: result.mimetype || "application/octet-stream", filename: result.filename || "" };
  }

  async downloadMessageMedia(id) {
    if (!this.client) throw new Error("WhatsApp 尚未启动");
    const message = await this.client.getMessageById(String(id || ""));
    if (!message) throw new Error("WhatsApp 中找不到这条媒体消息");
    const media = await this.downloadMediaPayload(message, 3);
    if (!media) throw new Error("WhatsApp 没有返回媒体内容");
    return media;
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    if (this.client && ["qr", "authenticated", "syncing", "ready", "starting"].includes(this.state.status)) return this.getStatus();
    if (this.client) {
      try { await this.client.destroy(); } catch (_) {}
      this.client = null;
    }
    this.initializing = this.createClient().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async createClient() {
    this.setState({ status: "starting", message: "正在启动 WhatsApp Web…", qrDataUrl: "", sync: null });
    const { Client, LocalAuth, RemoteAuth } = require("whatsapp-web.js");
    const QRCode = require("qrcode");
    const executablePath = browserExecutable();
    let authStrategy;
    if (this.authStore) {
      const sessionName = `RemoteAuth-${this.clientId}`;
      const legacyPath = path.join(this.authDir, `session-${this.clientId}`);
      const migration = await this.authStore.importLegacySession({ session: sessionName, profilePath: legacyPath });
      authStrategy = new RemoteAuth({
        clientId: this.clientId,
        dataPath: this.authDir,
        store: this.authStore,
        backupSyncIntervalMs: this.backupSyncIntervalMs
      });
      if (migration.imported) {
        this.setState({ authPersistence: { stored: true, migrated: true, sizeBytes: migration.sizeBytes, encrypted: migration.encrypted } });
      }
    } else {
      authStrategy = new LocalAuth({ clientId: this.clientId, dataPath: this.authDir });
    }
    const client = new Client({
      authStrategy,
      puppeteer: {
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0
    });
    this.client = client;

    client.on("remote_session_saved", () => {
      this.setState({ authPersistence: { stored: true, backedUpAt: Date.now(), encrypted: Boolean(this.authStore?.key) } });
    });

    client.on("qr", async (qr) => {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 2, width: 320 });
        this.setState({ status: "qr", message: "请用手机 WhatsApp 扫码登录", qrDataUrl, account: null });
      } catch (error) {
        this.setState({ status: "error", message: `二维码生成失败：${error.message}`, qrDataUrl: "" });
      }
    });
    client.on("authenticated", () => this.setState({ status: "authenticated", message: "登录成功，正在载入会话…", qrDataUrl: "" }));
    client.on("auth_failure", (message) => this.setState({ status: "error", message: `登录失效：${message}`, qrDataUrl: "", account: null }));
    client.on("loading_screen", (percent, message) => this.handleLoadingScreen(percent, message));
    client.on("ready", async () => {
      const info = client.info || {};
      this.setState({
        status: "syncing",
        message: "已连接，正在同步全部可用历史…",
        qrDataUrl: "",
        account: { id: serializedId(info.wid), name: info.pushname || this.label, platform: info.platform || "WhatsApp Web" },
        sync: { completed: 0, total: 0, imported: 0, errors: [] }
      });
      try {
        const sync = await this.syncHistory();
        this.setState({ status: "ready", message: sync.errors.length ? `已连接；${sync.errors.length} 个会话同步失败` : "WhatsApp 已连接，历史同步完成", sync: { ...sync, finishedAt: Date.now() } });
      } catch (error) {
        const normalized = safeError(error);
        this.emit("sync-error", normalized);
        this.setState({ status: "ready", message: `已连接；历史同步失败：${normalized.message}`, sync: { ...(this.state.sync || {}), fatalError: normalized.message } });
      }
    });
    client.on("disconnected", (reason) => {
      if (this.client === client) this.client = null;
      this.setState({ status: "offline", message: `连接已断开：${reason}`, qrDataUrl: "", account: null });
    });

    const receive = (message) => this.handleInboundOnce(message);
    client.on("message", receive);
    client.on("message_create", async (message) => {
      if (this.isFromMe(message)) {
        try {
          const normalized = await this.normalizeMessage(message, false);
          if (message.hasMedia && ["image", "video"].includes(message.type)) {
            try { normalized.media = await this.downloadMediaPayload(message, 2); } catch (error) { normalized.mediaError = safeError(error).message; }
          }
          this.emit("outbound", normalized);
        } catch (error) { this.emit("session-error", safeError(error)); }
      } else {
        receive(message);
      }
    });
    client.on("message_ack", (message, ack) => this.emit("ack", { accountId: this.accountId, id: messageId(message.id), ack }));

    try {
      await client.initialize();
      if (["starting", "authenticated"].includes(this.state.status) && client.pupPage) {
        const missedReadyEvent = await client.pupPage.evaluate(() => {
          const socket = window.require?.("WAWebSocketModel")?.Socket;
          return Boolean(socket?.hasSynced && typeof window.onAppStateHasSyncedEvent === "function" && typeof window.WWebJS === "undefined");
        }).catch(() => false);
        if (missedReadyEvent) await client.pupPage.evaluate(() => window.onAppStateHasSyncedEvent());
      }
    } catch (error) {
      if (this.client === client) this.client = null;
      try { await client.destroy(); } catch (_) {}
      const normalized = safeError(error);
      this.setState({ status: "error", message: `WhatsApp Web 启动失败：${normalized.message}`, qrDataUrl: "", account: null });
      throw normalized;
    }
    return this.getStatus();
  }

  async handleInboundOnce(message) {
    const id = messageId(message.id);
    const now = Date.now();
    for (const [key, value] of this.recentInbound) if (now - value > 120000) this.recentInbound.delete(key);
    if (id && this.recentInbound.has(id)) return;
    if (id) this.recentInbound.set(id, now);
    try {
      const normalized = await this.normalizeMessage(message, false);
      if (normalized.isGroup && this.getSettings().ignoreGroups !== false) return;
      if (isSystemConversation(normalized)) return;
      try { const chat = await message.getChat(); await chat.sendSeen(); } catch (_) {}
      if (message.hasMedia && ["image", "video"].includes(message.type)) {
        try {
          const media = await this.downloadMediaPayload(message, 3);
          if (media?.data) normalized.media = media;
        } catch (error) {
          normalized.mediaError = safeError(error).message;
        }
      }
      this.emit("message", normalized);
    } catch (error) {
      this.emit("session-error", safeError(error));
    }
  }

  async normalizeMessage(message, history = false) {
    const fromMe = this.isFromMe(message);
    const providerChatId = serializedId(fromMe ? message.to : message.from);
    let profileName = providerChatId.replace(/@.+$/, "");
    try {
      const chat = await message.getChat();
      profileName = chat.name || chat.formattedTitle || profileName;
    } catch (_) {
      try {
        const contact = await this.client?.getContactById?.(providerChatId);
        profileName = contact?.pushname || contact?.name || contact?.shortName || profileName;
      } catch (_) {}
    }
    return {
      id: messageId(message.id),
      accountId: this.accountId,
      accountName: this.accountName(),
      chatId: providerChatId,
      profileName,
      direction: fromMe ? "outbound" : "inbound",
      type: normalizedType(message.type),
      body: String(message.body || (message.type === "image" ? "[客户发送图片]" : message.type === "video" ? "[客户发送视频]" : `[${message.type || "消息"}]`)),
      replyToId: serializedId(message._data?.quotedStanzaID),
      createdAt: Number(message.timestamp || 0) * 1000 || Date.now(),
      status: history ? "history" : (fromMe ? "sent" : "received"),
      isGroup: providerChatId.endsWith("@g.us")
    };
  }

  async getChatSummaries() {
    try {
      const chats = await this.client.getChats();
      return chats.map((chat) => ({
        chatId: serializedId(chat.id),
        profileName: chat.name || chat.formattedTitle || serializedId(chat.id).replace(/@.+$/, ""),
        unread: Number(chat.unreadCount || 0),
        isGroup: Boolean(chat.isGroup),
        timestamp: Number(chat.timestamp || 0)
      }));
    } catch (error) {
      const nativeError = safeError(error).message;
      const rows = await this.client.pupPage.evaluate(() => {
        const chats = window.require?.("WAWebCollections")?.Chat?.getModelsArray?.()
          || window.Store?.Chat?.getModelsArray?.()
          || [];
        return chats.map((chat) => {
          const id = chat.id?._serialized || "";
          return {
            chatId: id,
            profileName: chat.formattedTitle || chat.name || chat.contact?.pushname || chat.contact?.name || id.replace(/@.+$/, ""),
            unread: Number(chat.unreadCount || 0),
            isGroup: id.endsWith("@g.us"),
            timestamp: Number(chat.t || chat.timestamp || chat.lastMessage?.t || 0)
          };
        });
      });
      this.emit("sync-error", new Error(`标准会话读取失败，已启用兼容模式：${nativeError}`));
      return rows;
    }
  }

  async fetchMessagesForChat(chatId, limit) {
    try {
      const chat = await this.client.getChatById(chatId);
      if (!chat) throw new Error("会话不存在");
      const messages = await chat.fetchMessages({ limit: limit > 0 ? limit : Infinity });
      const normalized = [];
      for (const message of messages) {
        const row = await this.normalizeMessage(message, true);
        if (["image", "video"].includes(row.type) && message.hasMedia) {
          try { row.media = await this.downloadMediaPayload(message, 2); } catch (error) { row.mediaError = safeError(error).message; }
        }
        normalized.push(row);
      }
      return normalized;
    } catch (error) {
      const nativeError = safeError(error).message;
      const rows = await this.client.pupPage.evaluate(async ({ chatId, limit }) => {
        const chat = window.Store?.Chat?.get?.(chatId) || await window.WWebJS.getChat(chatId, { getAsModel: false });
        if (!chat) throw new Error("chat_not_found");
        const valid = (message) => !message.isNotification && !/(?:notification|protocol|ciphertext)/i.test(String(message.type || ""));
        let messages = (chat.msgs?.getModelsArray?.() || []).filter(valid);
        let batches = 0;
        while ((limit <= 0 || messages.length < limit) && batches < 1000) {
          const loaded = await window.require("WAWebChatLoadMessages").loadEarlierMsgs({ chat });
          if (!loaded?.length) break;
          messages = [...loaded.filter(valid), ...messages];
          batches += 1;
        }
        const unique = new Map();
        const wid = (value) => {
          if (!value) return "";
          if (typeof value === "string") return value;
          return value._serialized || `${value.user || ""}@${value.server || "c.us"}`;
        };
        const msgId = (value) => {
          if (!value) return "";
          if (typeof value === "string") return value;
          if (value._serialized) return value._serialized;
          const stanza = value.id || value.stanzaId || value.stanzaID || "";
          const remote = wid(value.remote || value.from || value.to);
          const participant = wid(value.participant);
          return stanza ? `${value.fromMe ? "true" : "false"}_${remote}_${stanza}${participant ? `_${participant}` : ""}` : "";
        };
        for (const message of messages) {
          const id = msgId(message.id);
          if (!id) continue;
          unique.set(id, {
            id,
            chatId,
            direction: message.id?.fromMe ? "outbound" : "inbound",
            type: message.type === "chat" ? "text" : (message.type || "unknown"),
            body: ["image", "video"].includes(message.type)
              ? String(message.caption || (message.type === "video" ? "[历史视频]" : "[历史图片]"))
              : String(message.body || message.caption || `[${message.type || "消息"}]`),
            replyToId: msgId(message.quotedStanzaID),
            createdAt: Number(message.t || message.timestamp || 0) * 1000 || Date.now(),
            status: "history"
          });
        }
        let result = [...unique.values()].sort((a, b) => a.createdAt - b.createdAt);
        if (limit > 0 && result.length > limit) result = result.slice(-limit);
        return result;
      }, { chatId, limit });
      this.emit("sync-error", new Error(`会话 ${chatId} 已使用兼容读取：${nativeError}`));
      const normalized = [];
      for (const row of rows) {
        const next = { ...row, accountId: this.accountId, accountName: this.accountName() };
        if (["image", "video"].includes(row.type)) {
          try { next.media = await this.downloadMessageMedia(row.id); } catch (mediaError) { next.mediaError = safeError(mediaError).message; }
        }
        normalized.push(next);
      }
      return normalized;
    }
  }

  async syncHistory() {
    if (!this.client) throw new Error("WhatsApp 尚未启动");
    const configured = Number(this.getSettings().historySyncLimit);
    const limit = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 5000) : 0;
    const chats = await this.getChatSummaries();
    const eligible = chats
      .filter((chat) => chat.chatId
        && !isSystemChatId(chat.chatId)
        && !(chat.isGroup && this.getSettings().ignoreGroups !== false))
      .sort((a, b) => b.timestamp - a.timestamp);
    let imported = 0;
    let completed = 0;
    const errors = [];
    this.setState({ sync: { completed, total: eligible.length, imported, errors, mode: limit > 0 ? `最近 ${limit} 条/会话` : "全部可用历史" } });
    for (const chat of eligible) {
      try {
        const messages = await this.fetchMessagesForChat(chat.chatId, limit);
        imported += messages.length;
        this.emit("history", {
          accountId: this.accountId,
          accountName: this.accountName(),
          chatId: chat.chatId,
          profileName: chat.profileName,
          unread: chat.unread,
          messages
        });
      } catch (error) {
        const message = safeError(error).message;
        errors.push({ chatId: chat.chatId, profileName: chat.profileName, error: message });
        this.emit("sync-error", new Error(`同步 ${chat.profileName || chat.chatId} 失败：${message}`));
      }
      completed += 1;
      this.setState({ sync: { completed, total: eligible.length, imported, errors: [...errors], mode: limit > 0 ? `最近 ${limit} 条/会话` : "全部可用历史" } });
    }
    const result = { completed, total: eligible.length, imported, errors, mode: limit > 0 ? `最近 ${limit} 条/会话` : "全部可用历史" };
    this.emit("history-complete", { accountId: this.accountId, accountName: this.accountName(), ...result });
    return result;
  }

  async sendText(chatId, body) {
    if (!this.client || !["ready", "syncing"].includes(this.state.status)) throw Object.assign(new Error(`${this.label} 尚未连接，请先扫码`), { statusCode: 409 });
    const fallback = () => ({
      id: `provisional-${this.accountId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
      provisional: true
    });
    try {
      const message = await this.client.sendMessage(String(chatId), String(body));
      if (!message) return fallback();
      return { id: messageId(message.id), createdAt: Number(message.timestamp || 0) * 1000 || Date.now(), provisional: !messageId(message.id) };
    } catch (error) {
      const normalized = safeError(error);
      if (/Cannot read properties of (?:undefined|null).*['\"]id['\"]/i.test(normalized.message)) return fallback();
      throw normalized;
    }
  }

  async sendMedia(chatId, media = {}) {
    if (!this.client || !["ready", "syncing"].includes(this.state.status)) throw Object.assign(new Error(`${this.label} 尚未连接，请先扫码`), { statusCode: 409 });
    const { MessageMedia } = require("whatsapp-web.js");
    const mimeType = String(media.mimeType || "application/octet-stream");
    const data = String(media.data || "");
    const filename = String(media.filename || (mimeType.startsWith("video/") ? "video.mp4" : "image.jpg"));
    const caption = String(media.caption || "").trim();
    if (!data) throw Object.assign(new Error("附件内容为空"), { statusCode: 400 });
    const fallback = () => ({
      id: `provisional-${this.accountId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: Date.now(),
      provisional: true
    });
    try {
      const payload = new MessageMedia(mimeType, data, filename);
      const message = await this.client.sendMessage(String(chatId), payload, { caption });
      if (!message) return fallback();
      return { id: messageId(message.id), createdAt: Number(message.timestamp || 0) * 1000 || Date.now(), provisional: !messageId(message.id) };
    } catch (error) {
      const normalized = safeError(error);
      if (/Cannot read properties of (?:undefined|null).*['\"]id['\"]/i.test(normalized.message)) return fallback();
      throw normalized;
    }
  }

  async logout() {
    if (!this.client) return this.getStatus();
    const client = this.client;
    this.client = null;
    try { await client.logout(); } finally {
      try { await client.destroy(); } catch (_) {}
      this.setState({ status: "offline", message: "已退出 WhatsApp", qrDataUrl: "", account: null, sync: null });
    }
    return this.getStatus();
  }

  async shutdown() {
    const client = this.client;
    if (!client) return;
    const strategy = client.authStrategy;
    if (this.authStore && this.state.account?.id && typeof strategy?.storeRemoteSession === "function") {
      try { await strategy.storeRemoteSession(); } catch (error) { this.emit("session-error", safeError(error)); }
    }
    this.client = null;
    try { await client.destroy(); } catch (_) {}
  }
}

class WhatsAppSessionManager extends EventEmitter {
  constructor({ authDir, getSettings, persistence = null, authEncryptionKey = "", backupSyncIntervalMs = 300000, autoStart = true }) {
    super();
    this.authDir = path.resolve(authDir);
    this.getSettings = getSettings;
    this.persistence = persistence;
    this.authEncryptionKey = String(authEncryptionKey || "");
    this.backupSyncIntervalMs = Math.max(60000, Number(backupSyncIntervalMs || 300000));
    this.registryPath = path.join(this.authDir, "accounts.json");
    this.sessions = new Map();
    this.persistedStatus = new Map();
    fs.mkdirSync(this.authDir, { recursive: true });
    this.registry = this.loadRegistry();
    for (const meta of this.registry) this.addSession(meta, false);
    if (autoStart) setImmediate(() => this.startAll());
  }

  loadRegistry() {
    let registry = [];
    if (this.persistence) {
      try { registry = this.persistence.listWhatsAppAccounts(); } catch (error) { throw new Error(`读取数据库中的 WhatsApp 账号失败：${error.message}`); }
      if (Array.isArray(registry) && registry.length) {
        fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
        return registry;
      }
    }
    const hadRegistry = fs.existsSync(this.registryPath);
    try {
      if (hadRegistry) registry = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
    } catch (_) {}
    if (!Array.isArray(registry) || !registry.length) {
      registry = [{ id: "primary", clientId: "sales-ai", label: "账号 1", createdAt: Date.now() }];
    }
    if (!hadRegistry) {
      const known = new Set(registry.map((item) => item.clientId));
      for (const entry of fs.readdirSync(this.authDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
        const clientId = entry.name.slice("session-".length);
        if (known.has(clientId)) continue;
        const id = clientId === "sales-ai" ? "primary" : clientId;
        registry.push({ id, clientId, label: id === "primary" ? "账号 1" : `账号 ${registry.length + 1}`, createdAt: Date.now() });
        known.add(clientId);
      }
    }
    if (this.persistence) this.persistence.replaceWhatsAppAccounts(registry);
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
    return registry;
  }

  saveRegistry() {
    if (this.persistence) this.persistence.replaceWhatsAppAccounts(this.registry);
    fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2), "utf8");
  }

  persistSessionStatus(status) {
    if (!this.persistence || !status?.accountId) return;
    const snapshot = {
      lastStatus: String(status.status || "offline"),
      statusMessage: String(status.message || ""),
      account: status.account || null,
      sync: status.sync?.finishedAt ? status.sync : null,
      ...(status.status === "ready" ? { lastConnectedAt: Date.now() } : {})
    };
    const signature = JSON.stringify(snapshot);
    if (this.persistedStatus.get(status.accountId) === signature) return;
    this.persistedStatus.set(status.accountId, signature);
    try { this.persistence.updateWhatsAppAccount(status.accountId, snapshot); } catch (error) { this.emit("session-error", safeError(error)); }
  }

  addSession(meta, autoStart = false) {
    if (this.sessions.has(meta.id)) return this.sessions.get(meta.id);
    const authStore = this.persistence?.createWhatsAppAuthStore?.({
      accountId: meta.id,
      authDir: this.authDir,
      encryptionKey: this.authEncryptionKey
    }) || null;
    const session = new AccountSession({
      accountId: meta.id,
      clientId: meta.clientId,
      label: meta.label,
      authDir: this.authDir,
      getSettings: this.getSettings,
      authStore,
      backupSyncIntervalMs: this.backupSyncIntervalMs,
      autoStart
    });
    for (const event of ["history", "history-complete", "message", "outbound", "ack", "session-error", "sync-error"]) {
      session.on(event, (payload) => this.emit(event, payload));
    }
    session.on("status", (status) => {
      this.persistSessionStatus(status);
      this.emit("status", this.getStatus());
    });
    this.sessions.set(meta.id, session);
    return session;
  }

  async startAll() {
    for (const session of this.sessions.values()) {
      try { await session.initialize(); } catch (error) { this.emit("session-error", safeError(error)); }
    }
  }

  getStatus() {
    const accounts = [...this.sessions.values()].map((session) => session.getStatus());
    const ready = accounts.filter((item) => item.status === "ready");
    const active = accounts.find((item) => item.status === "qr") || ready[0] || accounts.find((item) => item.status === "syncing") || accounts[0] || null;
    let status = "offline";
    if (ready.length) status = "ready";
    else if (accounts.some((item) => item.status === "qr")) status = "qr";
    else if (accounts.some((item) => item.status === "syncing")) status = "syncing";
    else if (accounts.some((item) => ["starting", "authenticated"].includes(item.status))) status = "starting";
    else if (accounts.some((item) => item.status === "error")) status = "error";
    return {
      status,
      message: ready.length ? `${ready.length} 个 WhatsApp 账号已连接` : (active?.message || "暂无 WhatsApp 账号"),
      readyCount: ready.length,
      totalAccounts: accounts.length,
      accounts,
      account: active?.account || null,
      qrDataUrl: active?.qrDataUrl || "",
      qrAvailable: accounts.some((item) => item.qrAvailable),
      sync: active?.sync || null,
      updatedAt: Math.max(0, ...accounts.map((item) => item.updatedAt || 0))
    };
  }

  async initialize() {
    const target = [...this.sessions.values()].find((item) => !["ready", "qr", "starting", "authenticated", "syncing"].includes(item.getStatus().status)) || this.sessions.values().next().value;
    if (!target) return this.createAccount();
    return target.initialize();
  }

  async createAccount(label = "") {
    if (this.sessions.size >= 20) throw Object.assign(new Error("单机最多同时管理 20 个 WhatsApp 账号"), { statusCode: 409 });
    const id = `account_${Date.now().toString(36)}`;
    const meta = { id, clientId: id, label: String(label || `账号 ${this.sessions.size + 1}`), createdAt: Date.now() };
    this.registry.push(meta);
    this.saveRegistry();
    const session = this.addSession(meta, false);
    await session.initialize();
    return session.getStatus();
  }

  getSession(accountId) {
    const session = this.sessions.get(String(accountId));
    if (!session) throw Object.assign(new Error("WhatsApp 账号不存在"), { statusCode: 404 });
    return session;
  }

  async connectAccount(accountId) {
    return this.getSession(accountId).initialize();
  }

  async removeAccount(accountId) {
    const session = this.getSession(accountId);
    await session.logout();
    const meta = this.registry.find((item) => item.id === String(accountId));
    this.sessions.delete(String(accountId));
    this.registry = this.registry.filter((item) => item.id !== String(accountId));
    if (meta?.clientId && /^[a-zA-Z0-9_-]+$/.test(meta.clientId)) {
      const authPath = path.resolve(this.authDir, `session-${meta.clientId}`);
      if (path.dirname(authPath) === this.authDir && path.basename(authPath) === `session-${meta.clientId}`) {
        try { fs.rmSync(authPath, { recursive: true, force: true }); } catch (_) {}
      }
    }
    if (!this.registry.length) {
      const meta = { id: "primary", clientId: "sales-ai", label: "账号 1", createdAt: Date.now() };
      this.registry.push(meta);
      this.addSession(meta, false);
    }
    this.saveRegistry();
    this.emit("status", this.getStatus());
    return this.getStatus();
  }

  async syncHistory(accountId = "") {
    if (accountId) return this.getSession(accountId).syncHistory();
    const results = [];
    for (const session of this.sessions.values()) {
      if (session.getStatus().status !== "ready") continue;
      results.push({ accountId: session.accountId, ...(await session.syncHistory()) });
    }
    return results;
  }

  async sendText(accountId, chatId, body) {
    return this.getSession(accountId).sendText(chatId, body);
  }

  async sendMedia(accountId, chatId, media) {
    return this.getSession(accountId).sendMedia(chatId, media);
  }

  async downloadMessageMedia(accountId, messageId) {
    return this.getSession(accountId).downloadMessageMedia(messageId);
  }

  async shutdown() {
    await Promise.allSettled([...this.sessions.values()].map((session) => session.shutdown()));
  }
}

module.exports = { AccountSession, WhatsAppSessionManager, serializedId, messageId, messageFromMe, browserExecutable, normalizedType };
