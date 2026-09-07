const fs = require("fs");
const path = require("path");
const { isSystemConversation } = require("./message-policy");

const DEFAULT_SETTINGS = {
  localAiProvider: "llama.cpp",
  localAiBaseUrl: "http://127.0.0.1:11435",
  localAiModel: "Qwen3.5-9B-Q4_K_M",
  supplierSearchUrl: "https://api.gxhy1688.com/personProduct/getImgSearchResultV2.action",
  supplierApiKey: "",
  quoteMarkup: 1.3,
  quoteShipping: 0,
  quoteCurrency: "CNY",
  contextMessageLimit: 60,
  historySyncLimit: 0,
  catchUpWindowMinutes: 180,
  businessName: "Manos",
  businessGuidelines: "Manos 是公司名。ManosID-- 后面的内容只是广告询盘和商品来源标记，不是客户姓名，禁止原样回复。回复准确、简洁、友好；不要承诺未经确认的价格、库存、交期、退款或折扣。",
  ignoreGroups: true
};

function emptyState() {
  return {
    version: 17,
    nextQuoteId: 1,
    contacts: {},
    messages: [],
    quotes: [],
    accountStyles: {},
    agents: {},
    accountAgentBindings: {},
    accountAutomation: {},
    learnedReplies: [],
    customerMemories: [],
    conversationMemories: {},
    settings: { ...DEFAULT_SETTINGS }
  };
}

function defaultConversationMemory(chatId = "") {
  return {
    chatId: String(chatId || ""),
    status: "idle",
    progress: 0,
    progressLabel: "尚未整理长期记忆",
    currentScene: "",
    historySummary: "",
    processedThroughMessageId: "",
    processedThroughAt: 0,
    latestMessageAt: 0,
    messageCount: 0,
    extractedCount: 0,
    error: "",
    manuallyEdited: false,
    createdAt: 0,
    updatedAt: 0
  };
}

function defaultAccountPersona() {
  return {
    gender: "",
    business: "",
    tone: "",
    personality: "",
    completed: false,
    updatedAt: 0
  };
}

function defaultAccountAutomation(accountId) {
  return {
    accountId: String(accountId || ""),
    enabled: false,
    status: "off",
    current: null,
    lastProcessedAt: 0,
    lastContactName: "",
    lastError: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function defaultAccountStyle(accountId) {
  return {
    accountId: String(accountId || ""),
    status: "pending",
    summary: "",
    rules: [],
    persona: defaultAccountPersona(),
    sampleCount: 0,
    progress: 0,
    progressLabel: "等待读取历史语言风格",
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function normalizeAccountStyle(current, patch = {}, accountId = "") {
  const next = { ...current, ...patch, accountId: String(accountId || current.accountId || ""), updatedAt: Date.now() };
  if (patch.rules !== undefined) {
    next.rules = (Array.isArray(patch.rules) ? patch.rules : [])
      .map((rule, index) => typeof rule === "string" ? { id: `rule-${Date.now()}-${index}`, text: rule, enabled: true, source: "manual" } : rule)
      .map((rule, index) => ({
        id: String(rule.id || `rule-${Date.now()}-${index}`),
        text: String(rule.text || "").trim().slice(0, 500),
        enabled: rule.enabled !== false,
        source: rule.source === "analysis" ? "analysis" : "manual"
      }))
      .filter((rule) => rule.text)
      .slice(0, 30);
  }
  if (patch.persona !== undefined) {
    const persona = { ...defaultAccountPersona(), ...(current.persona || {}), ...(patch.persona || {}) };
    persona.gender = ["female", "male", "neutral"].includes(persona.gender) ? persona.gender : "";
    persona.business = String(persona.business || "").trim().slice(0, 2000);
    persona.tone = String(persona.tone || "").trim().slice(0, 200);
    persona.personality = String(persona.personality || "").trim().slice(0, 500);
    persona.completed = Boolean(persona.gender && persona.business && persona.tone && persona.personality);
    persona.updatedAt = Date.now();
    next.persona = persona;
  }
  next.summary = String(next.summary || "").trim().slice(0, 4000);
  next.progress = Math.max(0, Math.min(100, number(next.progress)));
  return next;
}

function defaultAgent(agentId, name = "新智能体", style = {}) {
  const normalized = normalizeAccountStyle(defaultAccountStyle(""), style, "");
  delete normalized.accountId;
  return {
    ...normalized,
    id: String(agentId || ""),
    name: String(name || "新智能体").trim().slice(0, 80) || "新智能体",
    description: String(style.description || "").trim().slice(0, 300),
    createdAt: number(style.createdAt, Date.now()),
    updatedAt: number(style.updatedAt, Date.now())
  };
}

function providerChatIdFrom(value) {
  return String(value || "").split("::").at(-1);
}

function phoneFrom(value) {
  return providerChatIdFrom(value).replace(/@.+$/, "");
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function contextKeywords(value) {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  const hanRuns = text.match(/[\p{Script=Han}]{2,}/gu) || [];
  const bigrams = [];
  for (const run of hanRuns) {
    for (let index = 0; index < run.length - 1; index += 1) bigrams.push(run.slice(index, index + 2));
  }
  return [...new Set([...words, ...bigrams])].slice(0, 32);
}

function detectedLanguage(value) {
  const text = String(value || "").toLowerCase();
  if (/[\u0600-\u06ff]/u.test(text)) return "ar";
  if (/[\u0400-\u04ff]/u.test(text)) return "ru";
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  if (/[\p{Script=Han}]/u.test(text)) return "zh";
  if (/\b(?:bonjour|merci|vous|êtes|peux|répondre|français|cher|chère|quel|quelle)\b/iu.test(text)) return "fr";
  if (/\b(?:hola|gracias|usted|ustedes|puedes|español|querido|qué|cuál)\b/iu.test(text)) return "es";
  if (/\b(?:hallo|danke|bitte|welche|welcher|sind|möchte|deutsch)\b/iu.test(text)) return "de";
  if (/\b(?:buongiorno|grazie|prego|quale|italiano|vorrei)\b/iu.test(text)) return "it";
  if (/\b(?:olá|obrigad[oa]|você|qual|português|gostaria)\b/iu.test(text)) return "pt";
  return "en";
}

function isMediaPlaceholder(value) {
  return /^\s*(?:\[(?:客户发送|历史|发送)?(?:图片|视频|image|video)\]|(?:图片|视频|image|video))\s*$/i.test(String(value || ""));
}

class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, "state.json");
    this.batchDepth = 0;
    this.dirty = false;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.state = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return emptyState();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const state = {
        ...emptyState(),
        ...parsed,
        contacts: parsed.contacts || {},
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
        accountStyles: parsed.accountStyles || {},
        agents: parsed.agents || {},
        accountAgentBindings: parsed.accountAgentBindings || {},
        accountAutomation: parsed.accountAutomation || {},
        learnedReplies: Array.isArray(parsed.learnedReplies) ? parsed.learnedReplies : [],
        customerMemories: Array.isArray(parsed.customerMemories) ? parsed.customerMemories : [],
        conversationMemories: parsed.conversationMemories || {},
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) }
      };
      if (Number(parsed.version || 0) < 3) {
        const keyMap = new Map();
        const contacts = {};
        for (const [oldKey, contact] of Object.entries(state.contacts)) {
          const accountId = contact.accountId || (contact.isDemo ? "demo" : "primary");
          const providerChatId = contact.providerChatId || contact.chatId || oldKey;
          const conversationId = oldKey.includes("::") ? oldKey : `${accountId}::${providerChatId}`;
          keyMap.set(oldKey, conversationId);
          contacts[conversationId] = {
            ...contact,
            chatId: conversationId,
            conversationId,
            accountId,
            accountName: contact.accountName || (accountId === "demo" ? "演示账号" : "主账号"),
            providerChatId,
            phone: contact.phone || phoneFrom(providerChatId)
          };
        }
        state.contacts = contacts;
        state.messages = state.messages.map((message) => ({
          ...message,
          chatId: keyMap.get(message.chatId) || (String(message.chatId).includes("::") ? message.chatId : `primary::${message.chatId}`)
        }));
        state.quotes = state.quotes.map((quote) => ({
          ...quote,
          chatId: keyMap.get(quote.chatId) || (String(quote.chatId).includes("::") ? quote.chatId : `primary::${quote.chatId}`)
        }));
        state.version = 3;
        state.settings.historySyncLimit = 0;
      }
      if (Number(parsed.version || 0) < 4) state.version = 4;
      if (Number(parsed.version || 0) < 5) {
        state.messages = state.messages
          .filter((message) => message.id !== "@c.us" && !/(?:notification|protocol|ciphertext)/i.test(String(message.type || "")))
          .map((message) => {
            const body = String(message.body || "");
            if (body.length <= 1000 || message.type === "text") return message;
            return { ...message, body: message.type === "image" ? "[历史图片]" : `[${message.type || "历史消息"}]` };
          });
        for (const contact of Object.values(state.contacts)) {
          const latest = state.messages.filter((message) => message.chatId === contact.chatId).sort((a, b) => b.createdAt - a.createdAt)[0];
          contact.lastMessageAt = latest?.createdAt || 0;
          contact.lastMessagePreview = latest?.body || "";
        }
        state.version = 5;
      }
      if (Number(parsed.version || 0) < 6) {
        for (const contact of Object.values(state.contacts)) {
          contact.isSystem = isSystemConversation(contact);
        }
        state.version = 6;
      }
      if (Number(parsed.version || 0) < 7) {
        state.accountAutomation = {};
        for (const message of state.messages) {
          if (message.metadata?.automationState === "processing") {
            message.metadata = { ...message.metadata, automationState: "queued", automationReason: "服务重启后重新排队" };
          }
        }
        state.version = 7;
      }
      if (Number(parsed.version || 0) < 8) {
        if (!String(state.settings.supplierSearchUrl || "").trim()) {
          state.settings.supplierSearchUrl = DEFAULT_SETTINGS.supplierSearchUrl;
        }
        if (!String(state.settings.businessName || "").trim() || state.settings.businessName === "我们的店铺") {
          state.settings.businessName = "Manos";
        }
        if (!String(state.settings.businessGuidelines || "").includes("Manos 是公司名")) {
          state.settings.businessGuidelines = `Manos 是公司名。ManosID-- 后面的内容只是广告询盘和商品来源标记，不是客户姓名，禁止原样回复。${String(state.settings.businessGuidelines || "").trim()}`;
        }
        for (const outbound of state.messages.filter((message) => message.direction === "outbound" && message.replyToId)) {
          const replied = state.messages.find((message) => message.chatId === outbound.chatId && message.id === outbound.replyToId);
          if (replied && number(outbound.createdAt) <= number(replied.createdAt)) outbound.createdAt = number(replied.createdAt) + 1;
        }
        state.version = 8;
      }
      if (Number(parsed.version || 0) < 9) {
        state.quotes = state.quotes.map((quote) => ({
          ...quote,
          basePriceCny: number(quote.basePriceCny ?? (quote.currency === "CNY" ? quote.suggestedPrice : 0)),
          shippingCny: [90, 150, 180, 300].includes(number(quote.shippingCny)) ? number(quote.shippingCny) : 90,
          profitRate: Math.min(0.8, Math.max(0.7, number(quote.profitRate, 0.75))),
          exchangeRate: number(quote.exchangeRate),
          rateDate: String(quote.rateDate || "")
        }));
        state.version = 9;
      }
      if (Number(parsed.version || 0) < 10) {
        state.learnedReplies = Array.isArray(state.learnedReplies) ? state.learnedReplies : [];
        for (const contact of Object.values(state.contacts)) {
          if (contact.mode === "human" && contact.escalationReason && contact.escalationReason !== "管理员手动接管") {
            contact.mode = "auto";
          }
        }
        state.version = 10;
      }
      if (Number(parsed.version || 0) < 11) {
        for (const contact of Object.values(state.contacts)) {
          if (!contact.needsHuman || contact.handoffMessageId) continue;
          const pending = state.messages
            .filter((message) => message.chatId === contact.chatId && message.direction === "inbound" && message.metadata?.automationState === "handoff")
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          contact.handoffMessageId = pending?.id || "";
        }
        state.version = 11;
      }
      if (Number(parsed.version || 0) < 12) {
        for (const style of Object.values(state.accountStyles)) {
          style.persona = { ...defaultAccountPersona(), ...(style.persona || {}) };
        }
        state.version = 12;
      }
      if (Number(parsed.version || 0) < 13) {
        for (const [accountId, automation] of Object.entries(state.accountAutomation)) {
          const persona = state.accountStyles[accountId]?.persona;
          if (persona?.completed) continue;
          automation.enabled = false;
          automation.status = "off";
          automation.current = null;
        }
        state.version = 13;
      }
      if (Number(parsed.version || 0) < 14) {
        state.customerMemories = Array.isArray(state.customerMemories) ? state.customerMemories : [];
        state.version = 14;
      }
      if (Number(parsed.version || 0) < 15) {
        state.quotes = state.quotes.map((quote) => ({ ...quote, productFacts: quote.productFacts || null }));
        state.version = 15;
      }
      if (Number(parsed.version || 0) < 16) {
        state.agents = state.agents || {};
        state.accountAgentBindings = state.accountAgentBindings || {};
        let index = 0;
        for (const [accountId, style] of Object.entries(state.accountStyles)) {
          index += 1;
          const agentId = `agent_${String(accountId).replace(/[^a-z0-9_-]/gi, "_")}`;
          if (!state.agents[agentId]) state.agents[agentId] = defaultAgent(agentId, `智能体 ${index}`, style);
          state.accountAgentBindings[accountId] = agentId;
        }
        state.version = 16;
      }
      if (Number(parsed.version || 0) < 17) {
        state.conversationMemories = state.conversationMemories || {};
        state.customerMemories = state.customerMemories.map((memory) => ({
          ...memory,
          pinned: Boolean(memory.pinned),
          confidence: Number(memory.confidence || (memory.source === "ai" ? 0.7 : 1)),
          sourceMessageIds: Array.isArray(memory.sourceMessageIds) ? memory.sourceMessageIds.map(String).slice(0, 12) : []
        }));
        state.version = 17;
      }
      if (Number(parsed.version || 0) < 17) fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
      return state;
    } catch (error) {
      if (fs.existsSync(this.filePath)) {
        try { fs.copyFileSync(this.filePath, `${this.filePath}.invalid-${Date.now()}`); } catch (_) {}
      }
      return emptyState();
    }
  }

  save() {
    if (this.batchDepth > 0) {
      this.dirty = true;
      return;
    }
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), "utf8");
    try {
      fs.renameSync(tempPath, this.filePath);
    } catch (_) {
      fs.copyFileSync(tempPath, this.filePath);
      fs.unlinkSync(tempPath);
    }
  }

  batch(callback) {
    this.batchDepth += 1;
    try {
      return callback();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.dirty) {
        this.dirty = false;
        this.save();
      }
    }
  }

  importHistory(chatId, profileName, messages, unread = 0) {
    let inserted = 0;
    this.batch(() => {
      this.upsertContact(chatId, { profileName: profileName || chatId });
      for (const message of messages || []) {
        const result = this.addMessage({ ...message, chatId, status: "history" });
        if (result.inserted) inserted += 1;
      }
      this.upsertContact(chatId, { unread: number(unread) });
    });
    return inserted;
  }

  getSettings() {
    return { ...this.state.settings, supplierApiKey: undefined };
  }

  getRuntimeSettings() {
    return { ...this.state.settings };
  }

  updateSettings(patch = {}) {
    const allowed = [
      "localAiProvider", "localAiBaseUrl", "localAiModel", "supplierSearchUrl",
      "supplierApiKey", "quoteMarkup", "quoteShipping", "quoteCurrency",
      "contextMessageLimit", "historySyncLimit", "catchUpWindowMinutes", "businessName", "businessGuidelines", "ignoreGroups"
    ];
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (key === "supplierApiKey" && String(patch[key] || "").trim() === "") continue;
      this.state.settings[key] = patch[key];
    }
    this.save();
    return this.getSettings();
  }

  upsertContact(chatId, patch = {}) {
    const id = String(chatId || "").trim();
    if (!id) throw new Error("chatId 不能为空");
    const now = Date.now();
    const existing = this.state.contacts[id] || {
      chatId: id,
      conversationId: id,
      accountId: patch.accountId || "primary",
      accountName: patch.accountName || "主账号",
      providerChatId: patch.providerChatId || providerChatIdFrom(id),
      phone: phoneFrom(patch.providerChatId || id),
      profileName: phoneFrom(patch.providerChatId || id),
      mode: "auto",
      needsHuman: false,
      escalationReason: "",
      unread: 0,
      labels: [],
      isDemo: false,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: 0,
      lastMessagePreview: ""
    };
    const next = { ...existing, ...patch, chatId: id, conversationId: id, updatedAt: now };
    next.isSystem = Boolean(patch.isSystem ?? (existing.isSystem || isSystemConversation(next)));
    this.state.contacts[id] = next;
    this.save();
    return { ...next };
  }

  getContact(chatId) {
    const row = this.state.contacts[String(chatId || "")];
    return row ? { ...row } : null;
  }

  listContacts(query = "", filter = "all") {
    const q = String(query || "").trim().toLowerCase();
    const pendingByChat = this.state.quotes.reduce((map, quote) => {
      if (["pending", "approved"].includes(quote.status)) map[quote.chatId] = (map[quote.chatId] || 0) + 1;
      return map;
    }, {});
    const queuedByChat = this.state.messages.reduce((map, message) => {
      if (["queued", "processing"].includes(message.metadata?.automationState)) map[message.chatId] = (map[message.chatId] || 0) + 1;
      return map;
    }, {});
    return Object.values(this.state.contacts)
      .map((contact) => ({ ...contact, pendingQuotes: pendingByChat[contact.chatId] || 0, queuedMessages: queuedByChat[contact.chatId] || 0 }))
      .filter((contact) => !contact.isSystem && !isSystemConversation(contact))
      .filter((contact) => !q || `${contact.profileName} ${contact.phone} ${contact.lastMessagePreview}`.toLowerCase().includes(q))
      .filter((contact) => {
        if (filter === "unread") return contact.unread > 0;
        if (filter === "human") return contact.needsHuman || contact.mode === "human";
        if (filter === "quote") return contact.pendingQuotes > 0;
        return true;
      })
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  }

  addMessage(message) {
    const id = String(message.id || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const chatId = String(message.chatId || "");
    const duplicate = this.state.messages.find((item) => item.id === id && item.chatId === chatId);
    if (duplicate) {
      const mediaPatch = {
        direction: message.direction === "outbound" ? "outbound" : "inbound",
        type: message.type || duplicate.type,
        body: String(message.body || duplicate.body || ""),
        accountId: String(message.accountId || duplicate.accountId || "primary"),
        accountName: String(message.accountName || duplicate.accountName || "主账号"),
        providerChatId: String(message.providerChatId || duplicate.providerChatId || providerChatIdFrom(message.chatId)),
        ...(message.mediaUrl ? { mediaUrl: String(message.mediaUrl) } : {}),
        ...(message.localMediaPath ? { localMediaPath: String(message.localMediaPath) } : {}),
        ...(message.mimeType ? { mimeType: String(message.mimeType) } : {})
      };
      Object.assign(duplicate, mediaPatch, { updatedAt: Date.now() });
      this.save();
      return { inserted: false, updated: true, message: { ...duplicate } };
    }
    const now = Date.now();
    const row = {
      id,
      chatId,
      accountId: String(message.accountId || "primary"),
      accountName: String(message.accountName || "主账号"),
      providerChatId: String(message.providerChatId || providerChatIdFrom(message.chatId)),
      direction: message.direction === "outbound" ? "outbound" : "inbound",
      type: message.type || "text",
      body: String(message.body || ""),
      mediaUrl: String(message.mediaUrl || ""),
      localMediaPath: String(message.localMediaPath || ""),
      mimeType: String(message.mimeType || ""),
      status: message.status || (message.direction === "outbound" ? "sent" : "received"),
      replyToId: String(message.replyToId || ""),
      metadata: message.metadata || {},
      createdAt: number(message.createdAt, now),
      updatedAt: now
    };
    this.state.messages.push(row);
    this.markConversationMemoryDirty(row.chatId, row, { save: false });
    const current = this.state.contacts[row.chatId] || {};
    this.state.contacts[row.chatId] = {
      chatId: row.chatId,
      conversationId: row.chatId,
      accountId: current.accountId || message.accountId || "primary",
      accountName: current.accountName || message.accountName || "主账号",
      providerChatId: current.providerChatId || message.providerChatId || providerChatIdFrom(row.chatId),
      phone: current.phone || phoneFrom(message.providerChatId || row.chatId),
      profileName: current.profileName || phoneFrom(message.providerChatId || row.chatId),
      mode: current.mode || "auto",
      needsHuman: Boolean(current.needsHuman),
      escalationReason: current.escalationReason || "",
      handoffMessageId: current.handoffMessageId || "",
      unread: row.direction === "inbound" && row.status !== "history" ? number(current.unread) + 1 : number(current.unread),
      labels: current.labels || [],
      isDemo: Boolean(current.isDemo),
      isSystem: Boolean(current.isSystem || isSystemConversation({ ...current, ...message })),
      createdAt: current.createdAt || now,
      updatedAt: now,
      lastMessageAt: Math.max(number(current.lastMessageAt), row.createdAt),
      lastMessagePreview: row.body || (row.type === "image" ? "[图片]" : `[${row.type}]`)
    };
    this.save();
    return { inserted: true, message: { ...row } };
  }

  updateMessage(id, patch = {}, selector = {}) {
    const row = this.state.messages.find((item) => item.id === String(id)
      && (!selector.chatId || item.chatId === String(selector.chatId))
      && (!selector.accountId || item.accountId === String(selector.accountId)));
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: Date.now() });
    this.save();
    return { ...row };
  }

  getMessage(chatId, id) {
    const row = this.state.messages.find((item) => item.chatId === String(chatId) && item.id === String(id));
    return row ? { ...row, metadata: { ...(row.metadata || {}) } } : null;
  }

  getLatestMessage(chatId) {
    const row = this.state.messages
      .filter((item) => item.chatId === String(chatId))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return row ? { ...row, metadata: { ...(row.metadata || {}) } } : null;
  }

  getLatestInboundForReply(chatId) {
    const latest = this.getLatestMessage(chatId);
    if (latest?.direction === "inbound") return latest;
    if (latest?.direction === "outbound" && latest.metadata?.source === "ai" && latest.replyToId) {
      return this.getMessage(chatId, latest.replyToId);
    }
    return null;
  }

  learnManualReply(data = {}) {
    const question = String(data.question || "").trim();
    const answer = String(data.answer || "").trim();
    const accountId = String(data.accountId || "").trim();
    if (!question || !answer || !accountId) return null;
    const normalized = question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const duplicate = this.state.learnedReplies.find((item) => item.accountId === accountId && item.normalizedQuestion === normalized);
    const now = Date.now();
    const row = {
      id: duplicate?.id || `learned-${now}-${Math.random().toString(16).slice(2)}`,
      accountId,
      chatId: String(data.chatId || ""),
      question,
      normalizedQuestion: normalized,
      answer,
      intent: String(data.intent || "general"),
      keywords: contextKeywords(question),
      sourceMessageId: String(data.sourceMessageId || ""),
      replyMessageId: String(data.replyMessageId || ""),
      useCount: number(duplicate?.useCount),
      createdAt: duplicate?.createdAt || now,
      updatedAt: now
    };
    if (duplicate) Object.assign(duplicate, row);
    else this.state.learnedReplies.push(row);
    this.state.learnedReplies = this.state.learnedReplies.slice(-500);
    this.save();
    return { ...row };
  }

  findLearnedReplies(accountId, text, intent = "general", limit = 4) {
    const keywords = contextKeywords(text);
    return this.state.learnedReplies
      .filter((item) => item.accountId === String(accountId || ""))
      .map((item) => {
        const itemKeywords = new Set(item.keywords || contextKeywords(item.question));
        const overlap = keywords.filter((word) => itemKeywords.has(word)).length;
        const intentScore = intent !== "general" && item.intent === intent ? 4 : 0;
        const exactScore = item.normalizedQuestion === String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() ? 8 : 0;
        return { ...item, score: exactScore + intentScore + overlap };
      })
      .filter((item) => item.score >= 2)
      .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
      .slice(0, Math.min(Math.max(number(limit, 4), 1), 10));
  }

  listLearnedReplies(accountId, limit = 20) {
    return this.state.learnedReplies
      .filter((item) => item.accountId === String(accountId || ""))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.min(Math.max(number(limit, 20), 1), 100))
      .map((item) => ({ ...item, keywords: [...(item.keywords || [])] }));
  }

  listCustomerMemories(chatId, options = {}) {
    const includeDisabled = options.includeDisabled !== false;
    const limit = Math.min(Math.max(number(options.limit, 60), 1), 100);
    return this.state.customerMemories
      .filter((item) => item.chatId === String(chatId) && (includeDisabled || item.enabled !== false))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((item) => ({ ...item }));
  }

  createCustomerMemory(chatId, data = {}) {
    const id = String(chatId || "");
    if (!this.state.contacts[id]) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const text = String(data.text || "").trim().slice(0, 500);
    if (!text) throw Object.assign(new Error("记忆内容不能为空"), { statusCode: 400 });
    if (this.listCustomerMemories(id, { limit: 100 }).length >= 60) throw Object.assign(new Error("每个客户最多保存 60 条记忆，请先整理旧内容"), { statusCode: 409 });
    const types = new Set(["requirement", "preference", "identity", "relationship", "logistics", "event", "note"]);
    const now = Date.now();
    const row = {
      id: `memory-${now}-${Math.random().toString(16).slice(2)}`,
      chatId: id,
      accountId: this.state.contacts[id].accountId || "primary",
      type: types.has(data.type) ? data.type : "note",
      text,
      enabled: data.enabled !== false,
      source: String(data.source || "human"),
      pinned: Boolean(data.pinned),
      confidence: Math.max(0, Math.min(1, Number(data.confidence ?? (data.source === "ai" ? 0.7 : 1)))),
      sourceMessageIds: Array.isArray(data.sourceMessageIds) ? data.sourceMessageIds.map(String).filter(Boolean).slice(0, 12) : [],
      createdAt: now,
      updatedAt: now
    };
    this.state.customerMemories.push(row);
    this.state.customerMemories = this.state.customerMemories.slice(-3000);
    this.save();
    return { ...row };
  }

  updateCustomerMemory(chatId, memoryId, patch = {}) {
    const row = this.state.customerMemories.find((item) => item.chatId === String(chatId) && item.id === String(memoryId));
    if (!row) throw Object.assign(new Error("客户记忆不存在"), { statusCode: 404 });
    if (patch.text !== undefined) {
      const text = String(patch.text || "").trim().slice(0, 500);
      if (!text) throw Object.assign(new Error("记忆内容不能为空"), { statusCode: 400 });
      if (text !== row.text && row.source === "ai") {
        row.source = "human-edited";
        row.confidence = 1;
      }
      row.text = text;
    }
    if (patch.type !== undefined && ["requirement", "preference", "identity", "relationship", "logistics", "event", "note"].includes(patch.type)) row.type = patch.type;
    if (patch.enabled !== undefined) row.enabled = Boolean(patch.enabled);
    if (patch.pinned !== undefined) row.pinned = Boolean(patch.pinned);
    row.updatedAt = Date.now();
    this.save();
    return { ...row };
  }

  deleteCustomerMemory(chatId, memoryId) {
    const index = this.state.customerMemories.findIndex((item) => item.chatId === String(chatId) && item.id === String(memoryId));
    if (index < 0) throw Object.assign(new Error("客户记忆不存在"), { statusCode: 404 });
    const [removed] = this.state.customerMemories.splice(index, 1);
    this.save();
    return { ...removed };
  }

  getConversationMemory(chatId) {
    const id = String(chatId || "");
    return { ...defaultConversationMemory(id), ...(this.state.conversationMemories[id] || {}), chatId: id };
  }

  updateConversationMemory(chatId, patch = {}) {
    const id = String(chatId || "");
    if (!this.state.contacts[id]) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const current = this.getConversationMemory(id);
    const now = Date.now();
    const next = {
      ...current,
      ...patch,
      chatId: id,
      status: ["idle", "dirty", "organizing", "ready", "error"].includes(patch.status) ? patch.status : current.status,
      progress: Math.max(0, Math.min(100, Number(patch.progress ?? current.progress) || 0)),
      currentScene: String(patch.currentScene ?? current.currentScene).trim().slice(0, 2000),
      historySummary: String(patch.historySummary ?? current.historySummary).trim().slice(0, 6000),
      createdAt: current.createdAt || now,
      updatedAt: now
    };
    this.state.conversationMemories[id] = next;
    this.save();
    return { ...next };
  }

  markConversationMemoryDirty(chatId, message = {}, options = {}) {
    const id = String(chatId || "");
    if (!id) return null;
    const current = this.getConversationMemory(id);
    const latestMessageAt = Math.max(Number(current.latestMessageAt) || 0, Number(message.createdAt) || 0);
    const hasSummary = Boolean(current.currentScene || current.historySummary || current.updatedAt);
    const status = current.status === "organizing" ? "organizing" : hasSummary ? "dirty" : "idle";
    const next = {
      ...current,
      status,
      progressLabel: status === "organizing" ? current.progressLabel : hasSummary ? "有新消息，等待增量整理" : current.progressLabel,
      latestMessageAt,
      messageCount: Math.max(Number(current.messageCount) || 0, Number(current.messageCount || 0) + 1)
    };
    this.state.conversationMemories[id] = next;
    if (options.save !== false) this.save();
    return { ...next };
  }

  replaceAutoCustomerMemories(chatId, items = []) {
    const id = String(chatId || "");
    if (!this.state.contacts[id]) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const keep = this.state.customerMemories.filter((memory) => memory.chatId !== id || memory.source !== "ai" || memory.pinned);
    const existingText = new Set(keep.filter((memory) => memory.chatId === id).map((memory) => String(memory.text || "").toLowerCase().replace(/\s+/g, " ").trim()));
    const now = Date.now();
    const allowedTypes = new Set(["requirement", "preference", "identity", "relationship", "logistics", "event", "note"]);
    const automatic = [];
    for (const [index, item] of (Array.isArray(items) ? items : []).slice(0, 20).entries()) {
      const text = String(item?.text || "").trim().slice(0, 500);
      const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
      if (!text || existingText.has(normalized)) continue;
      existingText.add(normalized);
      automatic.push({
        id: `memory-ai-${now}-${index}-${Math.random().toString(16).slice(2, 8)}`,
        chatId: id,
        accountId: this.state.contacts[id].accountId || "primary",
        type: allowedTypes.has(item.type) ? item.type : "note",
        text,
        enabled: true,
        source: "ai",
        pinned: false,
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.7)),
        sourceMessageIds: Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds.map(String).filter(Boolean).slice(0, 12) : [],
        createdAt: now + index,
        updatedAt: now + index
      });
    }
    this.state.customerMemories = [...keep, ...automatic].slice(-3000);
    this.save();
    return this.listCustomerMemories(id, { includeDisabled: true, limit: 60 });
  }

  hasLaterOutbound(chatId, createdAt, messageId = "") {
    const targetId = String(messageId || "");
    return this.state.messages.some((item) => item.chatId === String(chatId)
      && item.direction === "outbound"
      && item.createdAt > number(createdAt)
      && (!targetId || !item.replyToId || item.replyToId === targetId));
  }

  hasLaterInbound(chatId, createdAt, messageId = "") {
    return this.state.messages.some((item) => item.chatId === String(chatId)
      && item.direction === "inbound"
      && item.id !== String(messageId || "")
      && item.createdAt > number(createdAt));
  }

  listCatchUpCandidates(accountId, cutoff = 0) {
    const id = String(accountId || "");
    const latestByChat = new Map();
    for (const message of this.state.messages) {
      if (!(message.accountId === id || message.chatId.startsWith(`${id}::`))) continue;
      const previous = latestByChat.get(message.chatId);
      if (!previous || message.createdAt > previous.createdAt) latestByChat.set(message.chatId, message);
    }
    return [...latestByChat.values()]
      .filter((message) => message.direction === "inbound"
        && message.createdAt >= number(cutoff)
        && ["text", "image", "video"].includes(message.type)
        && !message.metadata?.automationState)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((message) => ({ ...message, metadata: { ...(message.metadata || {}) } }));
  }

  reconcileProvisionalOutbound(chatId, message) {
    const cutoff = number(message.createdAt, Date.now()) - 45000;
    const row = [...this.state.messages].reverse().find((item) => item.chatId === String(chatId)
      && item.direction === "outbound"
      && item.metadata?.provisional
      && item.body === String(message.body || "")
      && item.createdAt >= cutoff);
    if (!row) return null;
    row.id = String(message.id || row.id);
    row.status = message.status || "sent";
    row.createdAt = number(message.createdAt, row.createdAt);
    row.updatedAt = Date.now();
    row.metadata = { ...(row.metadata || {}), provisional: false, reconciled: true };
    this.save();
    return { ...row };
  }

  findRecentOutbound(chatId, body, around = Date.now()) {
    const target = number(around, Date.now());
    const row = [...this.state.messages].reverse().find((item) => item.chatId === String(chatId)
      && item.direction === "outbound"
      && item.body === String(body || "")
      && Math.abs(item.createdAt - target) <= 20000);
    return row ? { ...row } : null;
  }

  listAccountOutbound(accountId, limit = 240) {
    const id = String(accountId || "");
    const max = Math.min(Math.max(number(limit, 240), 20), 500);
    const seen = new Set();
    return this.state.messages
      .filter((item) => item.direction === "outbound"
        && (item.accountId === id || item.chatId.startsWith(`${id}::`))
        && item.body.trim()
        && !/ManosID\s*--/i.test(item.body)
        && (!item.metadata?.source || item.metadata.source === "human"))
      .sort((a, b) => b.createdAt - a.createdAt)
      .filter((item) => {
        const key = item.body.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, max)
      .reverse()
      .map((item) => ({ ...item }));
  }

  getAccountStyle(accountId) {
    const id = String(accountId || "");
    const agentId = String(this.state.accountAgentBindings[id] || "");
    const agent = agentId ? this.state.agents[agentId] : null;
    const row = this.state.accountStyles[id];
    const fallback = defaultAccountStyle(id);
    const source = agent || row;
    const style = source ? { ...fallback, ...source, accountId: id, persona: { ...fallback.persona, ...(source.persona || {}) }, rules: (source.rules || []).map((rule) => ({ ...rule })) } : fallback;
    if (agent) {
      style.agentId = agent.id;
      style.agentName = agent.name;
      style.agentDescription = agent.description || "";
      style.sharedAccountCount = Object.values(this.state.accountAgentBindings).filter((value) => value === agent.id).length;
    }
    return style;
  }

  listAccountStyles() {
    return Object.keys(this.state.accountStyles).map((accountId) => this.getAccountStyle(accountId));
  }

  updateAccountStyle(accountId, patch = {}) {
    const id = String(accountId || "").trim();
    if (!id) throw new Error("accountId 不能为空");
    const agent = this.ensureAccountAgent(id);
    const next = normalizeAccountStyle(agent, patch, id);
    const nextAgent = { ...agent, ...next, id: agent.id, name: agent.name, description: agent.description || "", updatedAt: Date.now() };
    delete nextAgent.accountId;
    this.state.agents[agent.id] = nextAgent;
    for (const [boundAccountId, boundAgentId] of Object.entries(this.state.accountAgentBindings)) {
      if (boundAgentId === agent.id) this.state.accountStyles[boundAccountId] = { ...next, accountId: boundAccountId, agentId: agent.id };
    }
    this.save();
    return this.getAccountStyle(id);
  }

  ensureAccountAgent(accountId, preferredName = "") {
    const id = String(accountId || "").trim();
    if (!id) throw new Error("accountId 不能为空");
    const boundId = String(this.state.accountAgentBindings[id] || "");
    if (boundId && this.state.agents[boundId]) {
      const agent = this.state.agents[boundId];
      if (preferredName && /^(?:智能体\s*\d*|新智能体)$/u.test(String(agent.name || ""))) {
        agent.name = String(preferredName).trim().slice(0, 80);
        agent.updatedAt = Date.now();
        this.save();
      }
      return this.getAgent(boundId);
    }
    const baseId = `agent_${id.replace(/[^a-z0-9_-]/gi, "_")}`;
    let agentId = baseId;
    let suffix = 2;
    while (this.state.agents[agentId]) agentId = `${baseId}_${suffix++}`;
    const existingStyle = this.state.accountStyles[id] || defaultAccountStyle(id);
    const agent = defaultAgent(agentId, preferredName || "新智能体", existingStyle);
    this.state.agents[agentId] = agent;
    this.state.accountAgentBindings[id] = agentId;
    this.state.accountStyles[id] = { ...existingStyle, accountId: id, agentId };
    this.save();
    return this.getAgent(agentId);
  }

  getAgent(agentId) {
    const id = String(agentId || "").trim();
    const row = this.state.agents[id];
    if (!row) return null;
    const normalized = defaultAgent(id, row.name, row);
    const accountIds = Object.entries(this.state.accountAgentBindings).filter(([, value]) => value === id).map(([accountId]) => accountId);
    return { ...normalized, accountIds, accountCount: accountIds.length };
  }

  listAgents() {
    return Object.keys(this.state.agents).map((id) => this.getAgent(id)).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  createAgent(input = {}) {
    const source = input.copyFromAgentId ? this.getAgent(input.copyFromAgentId) : null;
    const id = `agent_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const name = String(input.name || (source ? `${source.name} 副本` : "新智能体")).trim();
    const seed = source ? { ...source, description: source.description || "" } : input;
    const agent = defaultAgent(id, name, seed);
    agent.description = String(input.description ?? seed.description ?? "").trim().slice(0, 300);
    this.state.agents[id] = agent;
    this.save();
    return this.getAgent(id);
  }

  updateAgent(agentId, patch = {}) {
    const current = this.getAgent(agentId);
    if (!current) throw Object.assign(new Error("智能体不存在"), { statusCode: 404 });
    const stylePatch = { ...patch };
    delete stylePatch.name;
    delete stylePatch.description;
    delete stylePatch.accountIds;
    delete stylePatch.accountCount;
    const normalized = normalizeAccountStyle(current, stylePatch, "");
    delete normalized.accountId;
    const next = {
      ...current,
      ...normalized,
      id: current.id,
      name: String(patch.name ?? current.name).trim().slice(0, 80) || current.name,
      description: String(patch.description ?? current.description ?? "").trim().slice(0, 300),
      updatedAt: Date.now()
    };
    delete next.accountIds;
    delete next.accountCount;
    this.state.agents[current.id] = next;
    for (const [accountId, boundAgentId] of Object.entries(this.state.accountAgentBindings)) {
      if (boundAgentId === current.id) this.state.accountStyles[accountId] = { ...next, accountId, agentId: current.id };
    }
    this.save();
    return this.getAgent(current.id);
  }

  bindAccountAgent(accountId, agentId) {
    const account = String(accountId || "").trim();
    const agent = this.getAgent(agentId);
    if (!account) throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
    if (!agent) throw Object.assign(new Error("智能体不存在"), { statusCode: 404 });
    this.state.accountAgentBindings[account] = agent.id;
    this.state.accountStyles[account] = { ...agent, accountId: account, agentId: agent.id };
    if (!agent.persona?.completed && this.state.accountAutomation[account]?.enabled) {
      this.state.accountAutomation[account] = { ...this.state.accountAutomation[account], enabled: false, status: "off", current: null, updatedAt: Date.now() };
    }
    this.save();
    return this.getAccountStyle(account);
  }

  deleteAgent(agentId) {
    const agent = this.getAgent(agentId);
    if (!agent) throw Object.assign(new Error("智能体不存在"), { statusCode: 404 });
    if (agent.accountCount) throw Object.assign(new Error(`该智能体正被 ${agent.accountCount} 个账号使用，请先更换这些账号的智能体`), { statusCode: 409 });
    delete this.state.agents[agent.id];
    this.save();
    return agent;
  }

  getAccountAutomation(accountId) {
    const id = String(accountId || "");
    const row = this.state.accountAutomation[id];
    return row ? { ...row, current: row.current ? { ...row.current } : null } : defaultAccountAutomation(id);
  }

  updateAccountAutomation(accountId, patch = {}) {
    const id = String(accountId || "").trim();
    if (!id) throw new Error("accountId 不能为空");
    const current = this.state.accountAutomation[id] || defaultAccountAutomation(id);
    const next = { ...current, ...patch, accountId: id, updatedAt: Date.now() };
    if (patch.current !== undefined) next.current = patch.current ? { ...patch.current } : null;
    next.enabled = Boolean(next.enabled);
    this.state.accountAutomation[id] = next;
    this.save();
    return this.getAccountAutomation(id);
  }

  recoverProcessingMessages() {
    let changed = false;
    this.batch(() => {
      for (const message of this.state.messages) {
        if (message.metadata?.automationState !== "processing") continue;
        message.metadata = { ...message.metadata, automationState: "queued", automationReason: "服务重启后重新排队" };
        message.updatedAt = Date.now();
        changed = true;
      }
      for (const automation of Object.values(this.state.accountAutomation)) {
        if (automation.current || automation.status === "running") changed = true;
        automation.current = null;
        automation.status = automation.enabled ? "idle" : "off";
        automation.updatedAt = Date.now();
      }
      if (changed) this.save();
    });
    return changed;
  }

  listQueuedMessages(accountId) {
    const id = String(accountId || "");
    return this.state.messages
      .filter((message) => (message.accountId === id || message.chatId.startsWith(`${id}::`))
        && message.direction === "inbound"
        && message.metadata?.automationState === "queued"
        && !isSystemConversation(this.state.contacts[message.chatId] || message))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((message) => ({ ...message, metadata: { ...(message.metadata || {}) } }));
  }

  listMessages(chatId, options = {}) {
    const limit = Math.min(Math.max(number(options.limit, 100), 1), 500);
    const before = number(options.before, Number.MAX_SAFE_INTEGER);
    const rows = this.state.messages
      .filter((item) => item.chatId === String(chatId) && item.createdAt < before)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .reverse();
    if (options.markRead !== false) {
      const contact = this.state.contacts[String(chatId)];
      if (contact && contact.unread) {
        contact.unread = 0;
        contact.updatedAt = Date.now();
        this.save();
      }
    }
    return rows.map((row) => ({ ...row }));
  }

  getContext(chatId, currentText = "") {
    const limit = Math.min(Math.max(number(this.state.settings.contextMessageLimit, 60), 10), 200);
    const all = this.state.messages
      .filter((item) => item.chatId === String(chatId) && ["text", "image"].includes(item.type))
      .sort((a, b) => a.createdAt - b.createdAt);
    const recent = all.slice(-limit);
    const recentIds = new Set(recent.map((item) => item.id));
    const keywords = contextKeywords(currentText);
    const olderRelevant = keywords.length ? all.slice(0, -limit || undefined)
      .map((item) => ({ item, score: keywords.reduce((sum, word) => sum + (item.body.toLowerCase().includes(word) ? 1 : 0), 0) }))
      .filter((entry) => entry.score > 0 && !recentIds.has(entry.item.id))
      .sort((a, b) => b.score - a.score || b.item.createdAt - a.item.createdAt)
      .slice(0, 16)
      .map((entry) => entry.item) : [];
    return [...olderRelevant, ...recent].sort((a, b) => a.createdAt - b.createdAt).map((row) => ({ ...row }));
  }

  setConversationMode(chatId, mode, reason = "") {
    const normalized = mode === "human" ? "human" : "auto";
    return this.upsertContact(chatId, {
      mode: normalized,
      needsHuman: normalized === "human",
      escalationReason: normalized === "human" ? reason : "",
      handoffMessageId: ""
    });
  }

  requestHuman(chatId, reason = "需要人工处理", messageId = "") {
    const contact = this.state.contacts[String(chatId)];
    if (!contact) return null;
    return this.upsertContact(chatId, {
      mode: contact.mode === "human" && contact.escalationReason === "管理员手动接管" ? "human" : "auto",
      needsHuman: true,
      escalationReason: String(reason || "需要人工处理"),
      handoffMessageId: String(messageId || contact.handoffMessageId || "")
    });
  }

  resolveHuman(chatId) {
    const contact = this.state.contacts[String(chatId)];
    if (!contact) return null;
    return this.upsertContact(chatId, { mode: "auto", needsHuman: false, escalationReason: "", handoffMessageId: "" });
  }

  getQuoteByInboundMessage(chatId, inboundMessageId) {
    const conversationId = String(chatId || "");
    const messageId = String(inboundMessageId || "");
    if (!conversationId || !messageId) return null;
    const statusPriority = { sent: 4, rejected: 3, approved: 2, pending: 1 };
    const row = this.state.quotes
      .filter((quote) => quote.chatId === conversationId && quote.inboundMessageId === messageId)
      .sort((a, b) => {
        const priority = (statusPriority[b.status] || 0) - (statusPriority[a.status] || 0);
        return priority || Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
      })[0];
    return row ? this.quoteWithLanguage(row) : null;
  }

  createQuote(data) {
    const existing = this.getQuoteByInboundMessage(data.chatId, data.inboundMessageId);
    if (existing) return { ...existing, reusedExisting: true };
    const now = Date.now();
    const row = {
      id: this.state.nextQuoteId++,
      chatId: String(data.chatId || ""),
      inboundMessageId: String(data.inboundMessageId || ""),
      imageMediaUrl: String(data.imageMediaUrl || ""),
      quoteType: data.quoteType === "factory_inquiry" ? "factory_inquiry" : "priced",
      supplier: String(data.supplier || "微店共享货源"),
      searchStatus: String(data.searchStatus || "completed"),
      products: Array.isArray(data.products) ? data.products : [],
      productFacts: data.productFacts || null,
      costMin: number(data.costMin),
      costMax: number(data.costMax),
      suggestedPrice: number(data.suggestedPrice),
      currency: String(data.currency || this.state.settings.quoteCurrency || "CNY"),
      basePriceCny: number(data.basePriceCny ?? data.suggestedPrice),
      shippingCny: number(data.shippingCny || 90),
      profitRate: number(data.profitRate || 0.75),
      exchangeRate: number(data.exchangeRate),
      rateDate: String(data.rateDate || ""),
      draftReply: String(data.draftReply || ""),
      acknowledgement: String(data.acknowledgement || ""),
      acknowledgementSentMessageId: String(data.acknowledgementSentMessageId || ""),
      acknowledgementDeferred: Boolean(data.acknowledgementDeferred),
      acknowledgementDeferredReason: String(data.acknowledgementDeferredReason || ""),
      replyLanguage: String(data.replyLanguage || "auto"),
      customerLanguage: String(data.customerLanguage || this.inferCustomerLanguage(data.chatId, data.inboundMessageId) || "en"),
      draftLanguage: String(data.draftLanguage || ""),
      status: "pending",
      reviewerNote: "",
      error: String(data.error || ""),
      createdAt: now,
      updatedAt: now
    };
    this.state.quotes.push(row);
    const contact = this.state.contacts[row.chatId];
    if (contact) {
      contact.needsHuman = true;
      contact.escalationReason = "图片报价待审核";
      contact.handoffMessageId = row.inboundMessageId;
      contact.updatedAt = now;
    }
    this.save();
    return { ...row };
  }

  getQuote(id) {
    const row = this.state.quotes.find((item) => item.id === Number(id));
    return row ? this.quoteWithLanguage(row) : null;
  }

  inferCustomerLanguage(chatId, messageId = "") {
    const conversationId = String(chatId);
    const targetId = String(messageId || "");
    const targetIndex = targetId
      ? this.state.messages.findIndex((item) => item.chatId === conversationId && item.id === targetId)
      : this.state.messages.length - 1;
    for (let index = targetIndex >= 0 ? targetIndex : this.state.messages.length - 1; index >= 0; index -= 1) {
      const item = this.state.messages[index];
      if (item.chatId !== conversationId || item.direction !== "inbound" || !String(item.body || "").trim() || isMediaPlaceholder(item.body)) continue;
      return detectedLanguage(item.body);
    }
    return "en";
  }

  quoteWithLanguage(row) {
    return {
      ...row,
      replyLanguage: String(row.replyLanguage || "auto"),
      customerLanguage: String(row.customerLanguage || this.inferCustomerLanguage(row.chatId, row.inboundMessageId) || "en"),
      draftLanguage: String(row.draftLanguage || detectedLanguage(row.draftReply || ""))
    };
  }

  listQuotes(status = "all", chatId = "") {
    return this.state.quotes
      .filter((quote) => (!status || status === "all" || quote.status === status) && (!chatId || quote.chatId === chatId))
      .filter((quote) => chatId || !isSystemConversation(this.state.contacts[quote.chatId] || quote.chatId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => this.quoteWithLanguage(row));
  }

  updateQuote(id, patch = {}) {
    const row = this.state.quotes.find((item) => item.id === Number(id));
    if (!row) return null;
    const allowed = ["suggestedPrice", "currency", "basePriceCny", "shippingCny", "profitRate", "exchangeRate", "rateDate", "draftReply", "reviewerNote", "status", "sentMessageId", "rejectionReply", "rejectedMessageId", "error", "acknowledgementSentMessageId", "acknowledgementDeferred", "acknowledgementDeferredReason", "replyLanguage", "customerLanguage", "draftLanguage", "imageMediaUrl", "quoteType", "supplier", "searchStatus", "products", "productFacts", "costMin", "costMax", "acknowledgement"];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) row[key] = patch[key];
    row.updatedAt = Date.now();
    this.save();
    return this.quoteWithLanguage(row);
  }

  deleteQuote(id) {
    const index = this.state.quotes.findIndex((item) => item.id === Number(id));
    if (index < 0) return null;
    const [removed] = this.state.quotes.splice(index, 1);
    const linked = this.state.quotes.filter((quote) => quote.chatId === removed.chatId && quote.inboundMessageId === removed.inboundMessageId);
    const message = this.state.messages.find((item) => item.chatId === removed.chatId && item.id === removed.inboundMessageId);
    if (message?.metadata?.automationState === "quote_pending") {
      const handled = linked.some((quote) => ["sent", "rejected"].includes(quote.status));
      const stillPending = linked.some((quote) => ["pending", "approved"].includes(quote.status));
      message.metadata = {
        ...(message.metadata || {}),
        automationState: handled ? "replied" : stillPending ? "quote_pending" : "dismissed",
        automationReason: handled
          ? "该图片报价已经处理，重复审核记录已删除"
          : stillPending
            ? "图片报价仍在等待审核"
            : "报价记录已由人工删除",
        automationAt: Date.now()
      };
      message.updatedAt = Date.now();
    }
    this.save();
    return this.quoteWithLanguage(removed);
  }

  stats() {
    const contacts = Object.values(this.state.contacts).filter((contact) => !contact.isSystem && !isSystemConversation(contact));
    const contactIds = new Set(contacts.map((contact) => contact.chatId));
    return {
      conversations: contacts.length,
      unread: contacts.reduce((sum, item) => sum + number(item.unread), 0),
      humanNeeded: contacts.filter((item) => item.needsHuman || item.mode === "human").length,
      pendingQuotes: this.state.quotes.filter((item) => item.status === "pending" && contactIds.has(item.chatId)).length,
      messages: this.state.messages.filter((item) => contactIds.has(item.chatId)).length
    };
  }
}

module.exports = { Store, DEFAULT_SETTINGS, contextKeywords };
