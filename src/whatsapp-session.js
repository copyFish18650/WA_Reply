const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const { randomUUID } = require("crypto");
const { isSystemChatId, isSystemConversation, isSystemNotice } = require("./message-policy");

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
  constructor({ accountId, clientId, label, authDir, getSettings, authStore = null, lastAccount = null, backupSyncIntervalMs = 300000, autoStart = false }) {
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
    this.lastAccount = lastAccount?.id ? { ...lastAccount } : null;
    this.generation = 0;
    this.instanceId = randomUUID();
    this.retired = false;
    this.connectedClient = null;
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
    if (this.retired) return;
    this.state = { ...this.state, ...patch, accountId: this.accountId, label: this.label, updatedAt: Date.now() };
    this.emit("status", this.getStatus());
  }

  getStatus() {
    return { ...this.state, lastAccount: this.lastAccount, qrAvailable: Boolean(this.state.qrDataUrl) };
  }

  getIdentity() {
    return `${this.instanceId}:${this.generation}`;
  }

  isCurrentClient(client, generation = this.generation) {
    return !this.retired && this.client === client && this.generation === generation;
  }

  clearAccount(reason, nextAccount = null) {
    const previousAccountId = this.lastAccount?.id || this.state.account?.id || "";
    const previousGeneration = this.generation;
    const previousConnectedClient = this.connectedClient;
    this.generation += 1;
    this.connectedClient = null;
    try {
      this.emit("account-cleared", {
        accountId: this.accountId,
        reason,
        ...(previousAccountId ? { previousAccountId } : {}),
        ...(nextAccount?.id ? { nextAccountId: nextAccount.id } : {})
      });
    } catch (error) {
      this.generation = previousGeneration;
      this.connectedClient = previousConnectedClient;
      throw error;
    }
    this.recentInbound.clear();
    // Remember the owner across QR/status resets and process restarts.
    this.lastAccount = nextAccount || this.lastAccount;
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
    if (this.retired) throw new Error("WhatsApp 账号已移除");
    if (this.initializing) return this.initializing;
    if (this.client && ["qr", "authenticated", "syncing", "ready", "starting"].includes(this.state.status)) return this.getStatus();
    if (this.client) {
      const previous = this.client;
      this.client = null;
      this.connectedClient = null;
      try { await previous.destroy(); } catch (_) {}
    }
    if (this.retired) throw new Error("WhatsApp 账号已移除");
    this.initializing = this.createClient().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async createClient() {
    const generation = this.generation;
    this.setState({ status: "starting", message: "正在启动 WhatsApp Web…", qrDataUrl: "", sync: null });
    const { Client, LocalAuth, RemoteAuth } = require("whatsapp-web.js");
    const QRCode = require("qrcode");
    const executablePath = browserExecutable();
    let authStrategy;
    if (this.authStore) {
      const sessionName = `RemoteAuth-${this.clientId}`;
      const legacyPath = path.join(this.authDir, `session-${this.clientId}`);
      const migration = await this.authStore.importLegacySession({ session: sessionName, profilePath: legacyPath });
      if (this.retired || this.generation !== generation) return this.getStatus();
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
    const current = () => this.isCurrentClient(client);

    client.on("remote_session_saved", () => {
      if (!current()) return;
      this.setState({ authPersistence: { stored: true, backedUpAt: Date.now(), encrypted: Boolean(this.authStore?.key) } });
    });

    client.on("qr", async (qr) => {
      if (!current()) return;
      const qrGeneration = this.generation;
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 2, width: 320 });
        if (!this.isCurrentClient(client, qrGeneration)) return;
        this.setState({ status: "qr", message: "请用手机 WhatsApp 扫码登录", qrDataUrl, account: null });
      } catch (error) {
        if (!this.isCurrentClient(client, qrGeneration)) return;
        this.setState({ status: "error", message: `二维码生成失败：${error.message}`, qrDataUrl: "" });
      }
    });
    client.on("authenticated", () => { if (current()) this.setState({ status: "authenticated", message: "登录成功，正在载入会话…", qrDataUrl: "" }); });
    client.on("auth_failure", (message) => { if (current()) this.setState({ status: "error", message: `登录失效：${message}`, qrDataUrl: "", account: null }); });
    client.on("loading_screen", (percent, message) => { if (current()) this.handleLoadingScreen(percent, message); });
    client.on("ready", async () => {
      if (!current()) return;
      const info = client.info || {};
      const account = { id: serializedId(info.wid), name: info.pushname || this.label, platform: info.platform || "WhatsApp Web" };
      if (!account.id) return;
      if (this.lastAccount?.id && this.lastAccount.id !== account.id) {
        try { this.clearAccount("identity-changed", account); }
        catch (error) {
          this.connectedClient = null;
          this.setState({ status: "error", message: `切换账号失败：${safeError(error).message}`, account: null, sync: null });
          this.emit("session-error", safeError(error));
          return;
        }
      }
      if (!current()) return;
      this.lastAccount = account;
      this.connectedClient = client;
      const readyGeneration = this.generation;
      this.setState({
        status: "syncing",
        message: "已连接，正在同步全部可用历史…",
        qrDataUrl: "",
        account,
        sync: { completed: 0, total: 0, imported: 0, errors: [] }
      });
      try {
        const sync = await this.syncHistory();
        if (!this.isCurrentClient(client, readyGeneration)) return;
        this.setState({ status: "ready", message: sync.errors.length ? `已连接；${sync.errors.length} 个会话同步失败` : "WhatsApp 已连接，历史同步完成", sync: { ...sync, finishedAt: Date.now() } });
      } catch (error) {
        if (!this.isCurrentClient(client, readyGeneration)) return;
        const normalized = safeError(error);
        this.emit("sync-error", normalized);
        this.setState({ status: "ready", message: `已连接；历史同步失败：${normalized.message}`, sync: { ...(this.state.sync || {}), fatalError: normalized.message } });
      }
    });
    client.on("disconnected", (reason) => {
      if (!current()) return;
      this.client = null;
      this.connectedClient = null;
      if (["LOGOUT", "UNPAIRED", "UNPAIRED_IDLE"].includes(String(reason || "").toUpperCase())) {
        try { this.clearAccount("logout"); }
        catch (error) {
          this.setState({ status: "error", message: `已退出，但会话清理失败：${safeError(error).message}`, qrDataUrl: "", account: null, sync: null });
          this.emit("session-error", safeError(error));
          return;
        }
      }
      this.setState({ status: "offline", message: `连接已断开：${reason}`, qrDataUrl: "", account: null });
    });

    const receive = (message) => {
      if (!current() || this.connectedClient !== client) return;
      return this.handleInboundOnce(message, client, this.generation);
    };
    client.on("message", receive);
    client.on("message_create", async (message) => {
      if (!current() || this.connectedClient !== client) return;
      const messageGeneration = this.generation;
      if (this.isFromMe(message)) {
        try {
          const normalized = await this.normalizeMessage(message, false);
          if (!this.isCurrentClient(client, messageGeneration)) return;
          if (message.hasMedia && ["image", "video"].includes(message.type)) {
            try { normalized.media = await this.downloadMediaPayload(message, 2); } catch (error) { normalized.mediaError = safeError(error).message; }
          }
          if (this.isCurrentClient(client, messageGeneration)) this.emit("outbound", normalized);
        } catch (error) { if (this.isCurrentClient(client, messageGeneration)) this.emit("session-error", safeError(error)); }
      } else {
        receive(message);
      }
    });
    client.on("message_ack", (message, ack) => { if (current() && this.connectedClient === client) this.emit("ack", { accountId: this.accountId, id: messageId(message.id), ack }); });

    try {
      await client.initialize();
      if (!current()) return this.getStatus();
      if (["starting", "authenticated"].includes(this.state.status) && client.pupPage) {
        const missedReadyEvent = await client.pupPage.evaluate(() => {
          const socket = window.require?.("WAWebSocketModel")?.Socket;
          return Boolean(socket?.hasSynced && typeof window.onAppStateHasSyncedEvent === "function" && typeof window.WWebJS === "undefined");
        }).catch(() => false);
        if (missedReadyEvent && current()) await client.pupPage.evaluate(() => window.onAppStateHasSyncedEvent());
      }
    } catch (error) {
      const wasCurrent = current();
      if (wasCurrent) this.client = null;
      try { await client.destroy(); } catch (_) {}
      if (!wasCurrent || this.retired || this.client) return this.getStatus();
      const normalized = safeError(error);
      this.setState({ status: "error", message: `WhatsApp Web 启动失败：${normalized.message}`, qrDataUrl: "", account: null });
      throw normalized;
    }
    return this.getStatus();
  }

  async handleInboundOnce(message, client = this.client, generation = this.generation) {
    if (!this.isCurrentClient(client, generation)) return;
    const id = messageId(message.id);
    const now = Date.now();
    for (const [key, value] of this.recentInbound) if (now - value > 120000) this.recentInbound.delete(key);
    if (id && this.recentInbound.has(id)) return;
    if (id) this.recentInbound.set(id, now);
    try {
      const normalized = await this.normalizeMessage(message, false);
      if (!this.isCurrentClient(client, generation)) return;
      if (normalized.isGroup && this.getSettings().ignoreGroups !== false) return;
      if (isSystemConversation(normalized)) return;
      try { const chat = await message.getChat(); await chat.sendSeen(); } catch (_) {}
      if (!this.isCurrentClient(client, generation)) return;
      if (message.hasMedia && ["image", "video"].includes(message.type)) {
        try {
          const media = await this.downloadMediaPayload(message, 3);
          if (media?.data) normalized.media = media;
        } catch (error) {
          normalized.mediaError = safeError(error).message;
        }
      }
      if (this.isCurrentClient(client, generation)) this.emit("message", normalized);
    } catch (error) {
      if (this.isCurrentClient(client, generation)) this.emit("session-error", safeError(error));
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
    const client = this.client;
    const generation = this.generation;
    if (!client || !this.isCurrentClient(client, generation)) throw new Error("WhatsApp 尚未启动");
    try {
      const chats = await client.getChats();
      if (!this.isCurrentClient(client, generation)) throw new Error("WhatsApp 连接已切换或断开");
      return chats.map((chat) => ({
        chatId: serializedId(chat.id),
        profileName: chat.name || chat.formattedTitle || serializedId(chat.id).replace(/@.+$/, ""),
        unread: Number(chat.unreadCount || 0),
        isGroup: Boolean(chat.isGroup),
        timestamp: Number(chat.timestamp || 0)
      }));
    } catch (error) {
      if (!this.isCurrentClient(client, generation)) throw error;
      const nativeError = safeError(error).message;
      const rows = await client.pupPage.evaluate(() => {
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
      if (!this.isCurrentClient(client, generation)) throw new Error("WhatsApp 连接已切换或断开");
      this.emit("sync-error", new Error(`标准会话读取失败，已启用兼容模式：${nativeError}`));
      return rows;
    }
  }

  async fetchMessagesForChat(chatId, limit) {
    const client = this.client;
    const generation = this.generation;
    if (!client || !this.isCurrentClient(client, generation)) throw new Error("WhatsApp 尚未启动");
    try {
      const chat = await client.getChatById(chatId);
      if (!this.isCurrentClient(client, generation)) throw new Error("WhatsApp 连接已切换或断开");
      if (!chat) throw new Error("会话不存在");
      const messages = await chat.fetchMessages({ limit: limit > 0 ? limit : Infinity });
      const normalized = [];
      for (const message of messages) {
        if (!this.isCurrentClient(client, generation)) throw new Error("WhatsApp 连接已切换或断开");
        const row = await this.normalizeMessage(message, true);
        if (!this.isCurrentClient(client, generation)) throw new Error("WhatsApp 连接已切换或断开");
        if (isSystemNotice(row)) continue;
        if (["image", "video"].includes(row.type) && message.hasMedia) {
          try { row.media = await this.downloadMediaPayload(message, 2); } catch (error) { row.mediaError = safeError(error).message; }
        }
        normalized.push(row);
      }
      return normalized;
    } catch (error) {
      if (!this.isCurrentClient(client, generation)) throw error;
      const nativeError = safeError(error).message;
      const rows = await client.pupPage.evaluate(async ({ chatId, limit }) => {
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
      if (!this.isCurrentClient(client, generation)) throw new Error("WhatsApp 连接已切换或断开");
      this.emit("sync-error", new Error(`会话 ${chatId} 已使用兼容读取：${nativeError}`));
      const normalized = [];
      for (const row of rows) {
        if (!this.isCurrentClient(client, generation)) throw new Error("WhatsApp 连接已切换或断开");
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
    if (this.historySyncJob?.client === this.client && this.historySyncJob.generation === this.generation) return this.historySyncJob.promise;
    const job = { client: this.client, generation: this.generation, promise: this.performHistorySync() };
    this.historySyncJob = job;
    try { return await job.promise; }
    finally { if (this.historySyncJob === job) this.historySyncJob = null; }
  }

  async performHistorySync() {
    if (!this.client) throw new Error("WhatsApp 尚未启动");
    const client = this.client;
    const generation = this.generation;
    const configured = Number(this.getSettings().historySyncLimit);
    const limit = Number.isFinite(configured) && configured > 0 ? Math.min(Math.floor(configured), 50000) : 0;
    const chats = await this.getChatSummaries();
    if (!this.isCurrentClient(client, generation)) throw new Error("历史同步已中止：WhatsApp 连接已切换或断开");
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
      if (!this.isCurrentClient(client, generation)) throw new Error("历史同步已中止：WhatsApp 连接已切换或断开");
      try {
        const messages = await this.fetchMessagesForChat(chat.chatId, limit);
        if (!this.isCurrentClient(client, generation)) throw new Error("历史同步已中止：WhatsApp 连接已切换或断开");
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
        if (!this.isCurrentClient(client, generation)) throw error;
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

  async logout({ clear = true } = {}) {
    const client = this.client;
    if (clear) this.clearAccount("logout");
    else this.generation += 1;
    this.client = null;
    this.connectedClient = null;
    try {
      if (client) await client.logout();
    } finally {
      if (client) { try { await client.destroy(); } catch (_) {} }
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
    const hadRegistry = fs.existsSync(this.registryPath);
    if (this.persistence) {
      try { registry = this.persistence.listWhatsAppAccounts(); } catch (error) { throw new Error(`读取数据库中的 WhatsApp 账号失败：${error.message}`); }
      if (Array.isArray(registry) && registry.length) {
        fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf8");
        return registry;
      }
    }
    try {
      if (hadRegistry) registry = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
    } catch (_) {}
    if (!Array.isArray(registry) || (!registry.length && !hadRegistry)) {
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
    if (!status?.accountId || !this.sessions.has(status.accountId)) return;
    const meta = this.registry.find((item) => item.id === status.accountId);
    if (!meta) return;
    const snapshot = {
      lastStatus: String(status.status || "offline"),
      statusMessage: String(status.message || ""),
      account: status.account || null,
      lastAccount: status.lastAccount || meta.lastAccount || meta.account || null,
      sync: status.sync?.finishedAt ? status.sync : null,
      ...(status.status === "ready" ? { lastConnectedAt: Date.now() } : {})
    };
    const signature = JSON.stringify(snapshot);
    if (this.persistedStatus.get(status.accountId) === signature) return;
    this.persistedStatus.set(status.accountId, signature);
    Object.assign(meta, snapshot);
    try {
      if (this.persistence) this.persistence.updateWhatsAppAccount(status.accountId, snapshot);
      fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2), "utf8");
    } catch (error) { this.emit("session-error", safeError(error)); }
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
      lastAccount: meta.lastAccount || meta.account || null,
      backupSyncIntervalMs: this.backupSyncIntervalMs,
      autoStart
    });
    for (const event of ["account-cleared", "history", "history-complete", "message", "outbound", "ack", "session-error", "sync-error"]) {
      session.on(event, (payload) => {
        if (this.sessions.get(meta.id) === session && !session.retired) this.emit(event, payload);
      });
    }
    session.on("status", (status) => {
      if (this.sessions.get(meta.id) !== session || session.retired) return;
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
    const id = `account_${randomUUID().replace(/-/g, "")}`;
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

  getSessionIdentity(accountId) {
    return this.sessions.get(String(accountId))?.getIdentity() || "";
  }

  async connectAccount(accountId) {
    return this.getSession(accountId).initialize();
  }

  async removeAccount(accountId) {
    const session = this.getSession(accountId);
    const meta = this.registry.find((item) => item.id === String(accountId));
    // Detach before notifying consumers or awaiting browser teardown. Any late
    // message/history callbacks from this client must be unable to refill data.
    session.retired = true;
    this.sessions.delete(String(accountId));
    try {
      this.emit("account-cleared", {
        accountId: String(accountId),
        reason: "removed",
        ...((session.lastAccount?.id || session.state.account?.id) ? { previousAccountId: session.lastAccount?.id || session.state.account?.id } : {})
      });
    } catch (error) {
      session.retired = false;
      this.sessions.set(String(accountId), session);
      throw error;
    }
    this.persistedStatus.delete(String(accountId));
    this.registry = this.registry.filter((item) => item.id !== String(accountId));
    this.saveRegistry();
    this.emit("status", this.getStatus());
    try { await session.logout({ clear: false }); }
    catch (error) { this.emit("session-error", safeError(error)); }
    if (session.authStore?.delete) await session.authStore.delete({ session: `RemoteAuth-${session.clientId}` });
    if (meta?.clientId && /^[a-zA-Z0-9_-]+$/.test(meta.clientId)) {
      const names = [`session-${meta.clientId}`, `RemoteAuth-${meta.clientId}`, `RemoteAuth-${meta.clientId}.zip`, `wwebjs_temp_session_${meta.clientId}`];
      for (const name of names) {
        const authPath = path.resolve(this.authDir, name);
        if (path.dirname(authPath) !== this.authDir || path.basename(authPath) !== name) throw new Error("WhatsApp 登录缓存路径无效");
        fs.rmSync(authPath, { recursive: true, force: true });
      }
    }
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
