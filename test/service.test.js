const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const EventEmitter = require("events");
const { Store, contextKeywords } = require("../src/store");
const { SalesService, conversationKey, needsChineseTranslation, detectLanguage } = require("../src/service");
const {
  enforceGrounding,
  fallbackStyleAnalysis,
  compactDecisionHistory,
  guardCasualReply,
  answerFromManualRules,
  isIdentityQuestion,
  enforceCustomerServiceIdentity
} = require("../src/local-ai");
const { AccountSession, messageId, messageFromMe, normalizedType } = require("../src/whatsapp-session");
const { SupplierSearch, aggregateProductFacts } = require("../src/supplier");
const { calculateFinalQuote } = require("../src/pricing");
const { MANOS_LEAD_WELCOME, NEW_CUSTOMER_WELCOME, isGreeting } = require("../src/message-policy");

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.sentMedia = [];
  }
  getStatus() { return { status: "ready", message: "mock", accounts: [{ accountId: "primary", status: "ready" }] }; }
  async sendText(accountId, chatId, body) {
    this.sent.push({ accountId, chatId, body });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { id: `sent-${this.sent.length}`, createdAt: Date.now() };
  }
  async sendMedia(accountId, chatId, media) {
    this.sentMedia.push({ accountId, chatId, media });
    return { id: `sent-media-${this.sentMedia.length}`, createdAt: Date.now() };
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-sales-ai-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.updateAccountAutomation("primary", { enabled: true, status: "idle" });
  const session = new FakeSession();
  const service = new SalesService({ store, session, dataDir: root });
  return { root, store, session, service };
}

test("历史记录持久化并按中文关键词找回较早上下文", (t) => {
  const { root, store } = fixture(t);
  const chatId = "100@c.us";
  store.updateSettings({ contextMessageLimit: 10 });
  store.importHistory(chatId, "客户", [
    { id: "old", direction: "inbound", body: "我想要黑色款四十二码", createdAt: 1 },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `recent-${index}`, direction: index % 2 ? "outbound" : "inbound", body: `普通对话 ${index}`, createdAt: index + 2 }))
  ]);
  const context = store.getContext(chatId, "黑色款现在怎么样？");
  assert.equal(context.some((item) => item.id === "old"), true);
  assert.equal(contextKeywords("黑色款现在怎么样？").includes("黑色"), true);
  assert.equal(new Store(root).listMessages(chatId, { markRead: false }).length, 13);
});

test("关键销售节点不调用 AI，直接切换人工", async (t) => {
  const { store, service } = fixture(t);
  const chatId = "200@c.us";
  store.upsertContact(chatId, { profileName: "批发客户" });
  let aiCalled = false;
  service.ai.decide = async () => { aiCalled = true; return { action: "reply", reply: "不应发送", confidence: 1 }; };
  await service.ingest({ id: "critical", accountId: "primary", accountName: "账号 1", chatId, profileName: "批发客户", type: "text", body: "给我最低批发价和付款链接", createdAt: Date.now() });
  const contact = store.getContact(conversationKey("primary", chatId));
  assert.equal(contact.mode, "auto");
  assert.equal(contact.needsHuman, true);
  assert.equal(aiCalled, false);
});

test("口语化付款询问会在任何自动回复前转人工", async (t) => {
  const { store, session, service } = fixture(t);
  let aiCalled = false;
  service.ai.decide = async () => {
    aiCalled = true;
    return { action: "reply", reply: "I will send payment details.", confidence: 1 };
  };
  await service.ingest({
    id: "payment-stage",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "payment-buyer@c.us",
    profileName: "Payment buyer",
    type: "text",
    body: "cool, How do I pay?",
    createdAt: Date.now()
  });
  const chatId = conversationKey("primary", "payment-buyer@c.us");
  const inbound = store.getMessage(chatId, "payment-stage");
  const contact = store.getContact(chatId);
  assert.equal(aiCalled, false);
  assert.equal(session.sent.length, 0);
  assert.equal(inbound.metadata.automationState, "handoff");
  assert.match(inbound.metadata.automationReason, /付款环节.*人工确认/);
  assert.equal(contact.needsHuman, true);
  assert.equal(contact.handoffMessageId, "payment-stage");
});

test("付款节点只拦截付款消息，后续普通消息仍可自动回复", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { completed: true, gender: "female", business: "Fashion", tone: "friendly", personality: "patient" } });
  let aiCalls = 0;
  service.ai.decide = async () => {
    aiCalls += 1;
    return { action: "reply", reply: "I'm here, dear. How can I help?", reason: "follow-up", confidence: 1 };
  };
  const baseMessage = {
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "payment-paused@c.us",
    profileName: "Payment buyer",
    type: "text"
  };
  await service.ingest({ ...baseMessage, id: "payment-question", body: "How can I pay?", createdAt: Date.now() });
  await service.ingest({ ...baseMessage, id: "payment-follow-up", body: "Are you there?", createdAt: Date.now() + 1 });
  const chatId = conversationKey("primary", baseMessage.chatId);
  const followUp = store.getMessage(chatId, "payment-follow-up");
  const contact = store.getContact(chatId);
  assert.equal(aiCalls, 1);
  assert.equal(session.sent.length, 1);
  assert.equal(followUp.metadata.automationState, "replied");
  assert.equal(contact.handoffMessageId, "payment-question");

  const payment = store.getMessage(chatId, "payment-question");
  const blocked = await service.process(payment, null, "", { manualTrigger: true });
  assert.equal(blocked.state, "handoff");
  assert.equal(aiCalls, 1);
  assert.equal(session.sent.length, 1);
  assert.equal(store.getContact(chatId).handoffMessageId, "payment-question");

  const manual = await service.sendManualReply(chatId, "I will send you the confirmed payment instructions shortly.");
  assert.equal(manual.resumed, true);
  assert.equal(manual.learned, null);
  assert.equal(store.findLearnedReplies("primary", "How can I pay?", "general").length, 0);
  assert.equal(store.getContact(chatId).needsHuman, false);
});

test("本地模型上下文会压缩到小模型窗口并保留最新消息", () => {
  const history = Array.from({ length: 60 }, (_, index) => ({
    id: `context-${index}`,
    direction: index % 2 ? "outbound" : "inbound",
    type: "text",
    body: `${index}-${"x".repeat(180)}`
  }));
  const compact = compactDecisionHistory(history);
  assert.equal(compact.length <= 24, true);
  assert.equal(compact.reduce((sum, item) => sum + item.body.length, 0) <= 2400, true);
  assert.equal(compact.at(-1).id, "context-59");
});

test("付款消息待人工时后续客户疲惫表达仍会得到关怀回复", async (t) => {
  const { store, session, service } = fixture(t);
  const base = { accountId: "primary", accountName: "Manos Amy", chatId: "care-after-payment@c.us", profileName: "Buyer", type: "text" };
  await service.ingest({ ...base, id: "care-payment", body: "How do I pay?", createdAt: 1000 });
  await service.ingest({ ...base, id: "care-message", body: "I just finished ten hours of work and I'm very tired.", createdAt: 2000 });
  const chatId = conversationKey("primary", base.chatId);
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].body, /long day.*rest/i);
  assert.equal(store.getMessage(chatId, "care-message").metadata.automationState, "replied");
  assert.equal(store.getContact(chatId).handoffMessageId, "care-payment");
});

test("闲聊关怀会遵循账号的 dear 称呼和 emoji 风格", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", {
    status: "ready",
    progress: 100,
    summary: "Use concise English and often use emoji.",
    rules: [],
    persona: { completed: true, gender: "female", business: "Fashion", tone: "Warm and call customers dear", personality: "Patient and caring" }
  });
  await service.ingest({
    id: "persona-care",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "persona-care@c.us",
    profileName: "Buyer",
    type: "text",
    body: "I'm exhausted after a very long day.",
    createdAt: Date.now()
  });
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].body, /dear/i);
  assert.match(session.sent[0].body, /😊/u);
  assert.doesNotMatch(session.sent[0].body, /factory|product|order/i);
});

test("普通闲聊使用本地模型并把账号性格传入生成", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", {
    status: "ready",
    progress: 100,
    summary: "Warm and concise English.",
    rules: [],
    persona: { completed: true, gender: "female", business: "Fashion", tone: "gentle", personality: "caring and humorous" }
  });
  let receivedStyle = null;
  let decisionCalled = false;
  service.ai.casualReply = async (_text, style) => {
    receivedStyle = style;
    return "That sounds like a lovely weekend with your family. I hope you enjoyed every moment.";
  };
  service.ai.decide = async () => {
    decisionCalled = true;
    return { action: "reply", reply: "wrong branch", confidence: 1 };
  };
  await service.ingest({
    id: "weekend-chat",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "weekend-chat@c.us",
    profileName: "Buyer",
    type: "text",
    body: "I spent the weekend with my family.",
    createdAt: Date.now()
  });
  assert.equal(receivedStyle.persona.personality, "caring and humorous");
  assert.equal(decisionCalled, false);
  assert.match(session.sent[0].body, /weekend.*family/i);
  const chatId = conversationKey("primary", "weekend-chat@c.us");
  assert.equal(store.getLatestMessage(chatId).metadata.source, "customer-care");
});

test("still 和 will 不会被当成 ill，连续闲聊会携带最近上下文", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", {
    status: "ready",
    progress: 100,
    summary: "Use concise English, call customers dear, and often use emoji.",
    rules: [],
    persona: { completed: true, gender: "female", business: "Fashion", tone: "warm", personality: "caring and humorous" }
  });
  const receivedHistories = [];
  service.ai.casualReply = async (_text, _style, history) => {
    receivedHistories.push(history);
    return "";
  };
  const base = {
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "natural-chat@c.us",
    profileName: "Buyer",
    type: "text"
  };
  const now = Date.now();
  await service.ingest({
    ...base,
    id: "save-and-work",
    body: "I still need to save money and work hard so that I can buy more things from you 😂",
    createdAt: now
  });
  await service.ingest({
    ...base,
    id: "correct-and-visit",
    body: "I don't have any discomfort. One day I will go to China to find you, are you right?",
    createdAt: now + 1000
  });

  assert.equal(receivedHistories.length, 2);
  assert.equal(receivedHistories[1].some((item) => item.id === "save-and-work"), true);
  assert.equal(receivedHistories[1].some((item) => item.direction === "outbound"), true);
  assert.equal(session.sent.length, 2);
  assert.match(session.sent[0].body, /no pressure|enjoy life|treat/i);
  assert.match(session.sent[1].body, /misunderstood|China|welcome/i);
  assert.doesNotMatch(session.sent.map((item) => item.body).join(" "), /not feeling well|get some rest|take good care/i);
});

test("背痛关心和通话玩笑会回应最新话题且不把客户经历说成自己", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", {
    status: "ready",
    progress: 100,
    summary: "Use concise English, call customers dear, and often use emoji.",
    rules: [],
    persona: { completed: true, gender: "female", business: "Fashion", tone: "warm", personality: "patient, caring and humorous" }
  });
  service.ai.casualReply = async () => "";
  const base = { accountId: "primary", accountName: "Manos Amy", chatId: "human-chat@c.us", profileName: "Buyer", type: "text" };
  const now = Date.now();
  await service.ingest({ ...base, id: "back-hurts", body: "How have you been lately? My back still hurts", createdAt: now });
  await service.ingest({ ...base, id: "call-joke", body: "Do you want to call me? I'm just an ugly old man. 😂😂", createdAt: now + 1000 });

  assert.equal(session.sent.length, 2);
  assert.match(session.sent[0].body, /been well|back.*hurting|take it easy/i);
  assert.doesNotMatch(session.sent[0].body, /factory|product|order/i);
  assert.match(session.sent[1].body, /stop that|you.re not ugly|arrange a call/i);
  assert.doesNotMatch(session.sent[1].body, /I'm (?:just )?an? ugly old man|hear about your back|back (?:still )?(?:hurt|hurts|pain)/i);
  const chatId = conversationKey("primary", base.chatId);
  assert.equal(store.getMessage(chatId, "call-joke").metadata.automationState, "handoff");
  assert.match(store.getContact(chatId).escalationReason, /电话或视频通话/);
});

test("闲聊发送前会拦截旧话题串线和说话人身份倒置", () => {
  const history = [{ direction: "inbound", type: "text", body: "My back still hurts" }];
  assert.equal(
    guardCasualReply("I'm sorry to hear about your back. I'm just an ugly old man.", "Do you want to call me? I'm just an ugly old man. 😂😂", history),
    ""
  );
  assert.equal(
    guardCasualReply("Yes, a call sounds nice 😂", "Do you want to call me?", history),
    "Yes, a call sounds nice 😂"
  );
});

test("包含商品诉求的第一人称消息不会误判为闲聊", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Concise English.", rules: [], persona: { completed: true, gender: "female", business: "Fashion", tone: "friendly", personality: "patient" } });
  let casualCalled = false;
  let decisionCalled = false;
  service.ai.casualReply = async () => { casualCalled = true; return "wrong casual reply"; };
  service.ai.decide = async () => {
    decisionCalled = true;
    return { action: "reply", reply: "Of course. What style of bag are you looking for?", reason: "product request", confidence: 0.9 };
  };
  await service.ingest({
    id: "not-casual",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "not-casual@c.us",
    profileName: "Buyer",
    type: "text",
    body: "I need a bag for this weekend.",
    createdAt: Date.now()
  });
  assert.equal(casualCalled, false);
  assert.equal(decisionCalled, true);
  assert.match(session.sent[0].body, /style of bag/i);
});

test("本地 AI 重试成功后会解除该消息的错误待人工状态", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "retry-ai@c.us");
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { completed: true, gender: "female", business: "Fashion", tone: "friendly", personality: "patient" } });
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "retry-ai@c.us", profileName: "Buyer" });
  store.addMessage({ id: "retry-message", chatId, accountId: "primary", direction: "inbound", type: "text", body: "Are you there?", createdAt: 1000 });
  store.requestHuman(chatId, "本地 AI 不可用", "retry-message");
  service.ai.decide = async () => ({ action: "reply", reply: "Yes, dear. I'm here.", reason: "retry succeeded", confidence: 0.9 });
  await service.replyToMessage(chatId, "retry-message");
  assert.equal(session.sent.length, 1);
  assert.equal(store.getContact(chatId).needsHuman, false);
  assert.equal(store.getMessage(chatId, "retry-message").metadata.automationState, "replied");
});

test("回复旧图片的出站消息不会误判为已回复后续客户文字", (t) => {
  const { store } = fixture(t);
  const chatId = conversationKey("primary", "reply-target@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "reply-target@c.us" });
  store.addMessage({ id: "old-image", chatId, accountId: "primary", direction: "inbound", type: "image", body: "[图片]", createdAt: 1000 });
  store.addMessage({ id: "later-text", chatId, accountId: "primary", direction: "inbound", type: "text", body: "Are you there?", createdAt: 2000 });
  store.addMessage({ id: "image-reply", chatId, accountId: "primary", direction: "outbound", type: "text", body: "I will check this product.", replyToId: "old-image", createdAt: 3000 });
  assert.equal(store.hasLaterOutbound(chatId, 2000, "later-text"), false);
  assert.equal(store.hasLaterOutbound(chatId, 1000, "old-image"), true);
});

test("工作台人工回复后恢复自动、顺序正确并学习非价格问答", async (t) => {
  const { store, session, service } = fixture(t);
  const firstChat = conversationKey("primary", "manual-learn-1@c.us");
  const future = Date.now() + 120000;
  store.upsertContact(firstChat, { accountId: "primary", accountName: "Manos", providerChatId: "manual-learn-1@c.us", profileName: "客户一" });
  store.addMessage({ id: "manual-question", chatId: firstChat, accountId: "primary", direction: "inbound", type: "text", body: "What products does your factory sell?", createdAt: future });
  store.requestHuman(firstChat, "历史记录里没有公司产品信息", "manual-question");
  const manual = await service.sendManualReply(firstChat, "We mainly sell clothing and fashion accessories.");
  assert.equal(manual.learned.question, "What products does your factory sell?");
  assert.equal(manual.message.replyToId, "manual-question");
  assert.equal(manual.message.createdAt > future, true);
  assert.equal(store.getContact(firstChat).mode, "auto");
  assert.equal(store.getContact(firstChat).needsHuman, false);

  store.updateAccountStyle("primary", { status: "ready", summary: "Use concise English replies.", progress: 100 });
  let aiCalled = false;
  service.ai.decide = async () => { aiCalled = true; return { action: "handoff", reply: "", reason: "不应调用模型", confidence: 0 }; };
  await service.ingest({ id: "similar-question", accountId: "primary", accountName: "Manos", chatId: "manual-learn-2@c.us", profileName: "客户二", type: "text", body: "What does your factory sell?", createdAt: future + 1000 });
  assert.equal(aiCalled, false);
  assert.equal(session.sent.at(-1).body, "We mainly sell clothing and fashion accessories.");
  assert.equal(store.getLatestMessage(conversationKey("primary", "manual-learn-2@c.us")).metadata.source, "human-memory");
});

test("人工价格回复不会加入自动学习", async (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "manual-price@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "manual-price@c.us", profileName: "价格客户" });
  store.addMessage({ id: "price-question", chatId, accountId: "primary", direction: "inbound", type: "text", body: "What is the price?", createdAt: Date.now() });
  store.requestHuman(chatId, "价格问题", "price-question");
  const result = await service.sendManualReply(chatId, "The price is USD 100.");
  assert.equal(result.learned, null);
  assert.equal(store.findLearnedReplies("primary", "What is the price?", "general").length, 0);
  assert.equal(store.getContact(chatId).mode, "auto");
});

test("图片估价只进入待审核，审批时才发送且防止重复", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = "300@c.us";
  store.upsertContact(chatId, { profileName: "图片客户" });
  const description = "COACH PAIGE 黑色皮革单肩包，肩带可调节，拉链开合，开口48高25厚1";
  service.supplier.search = async () => [
    { id: "p1", title: "同款一", description, cost: 100, currency: "CNY", confidence: 0.98 },
    { id: "p2", title: "同款二", description, cost: 100, currency: "CNY", confidence: 0.97 }
  ];
  service.supplier.calculate = () => ({ costMin: 100, costMax: 100, suggestedPrice: 130, currency: "CNY" });
  await service.ingest({
    id: "image-1",
    accountId: "primary",
    accountName: "账号 1",
    chatId,
    profileName: "图片客户",
    type: "image",
    body: "How much does this bag cost and what size?",
    createdAt: Date.now(),
    media: { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), mimeType: "image/jpeg" }
  });
  const pending = store.listQuotes("pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].productFacts.dimensions.zh, "开口宽约 48 cm、高约 25 cm、厚约 1 cm");
  assert.match(pending[0].draftReply, /48 cm across the opening/);
  assert.match(pending[0].draftReply, /adjustable shoulder strap/);
  assert.equal(session.sent.length, 0);
  const results = await Promise.allSettled([
    service.approveQuote(pending[0].id, { draftReply: "审核后的报价是 CNY 128.00", suggestedPrice: 128 }),
    service.approveQuote(pending[0].id, { draftReply: "不应重复发送" })
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(session.sent.length, 1);
  assert.deepEqual(session.sent[0], {
    accountId: "primary",
    chatId,
    body: "审核后的报价是 CNY 128.00"
  });
  assert.equal(store.getQuote(pending[0].id).status, "sent");
});

test("同一张图片并发或补处理时只保留一个报价任务", async (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "quote-idempotent@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos", providerChatId: "quote-idempotent@c.us", profileName: "Buyer" });
  const image = store.addMessage({
    id: "same-quote-image",
    chatId,
    accountId: "primary",
    direction: "inbound",
    type: "image",
    body: "How much is this bag?",
    createdAt: 1000
  }).message;
  service.supplier.search = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [{ id: "same-product", title: "Matched bag", cost: 200, currency: "CNY", hasPrice: true }];
  };
  service.supplier.calculate = () => ({ costMin: 200, costMax: 200, suggestedPrice: 260, currency: "CNY" });

  const media = { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), mimeType: "image/jpeg" };
  const [first, concurrentReplay] = await Promise.all([
    service.processImage(image, media),
    service.processImage(image, media)
  ]);
  assert.equal(first.id, concurrentReplay.id);
  assert.equal(store.listQuotes("all", chatId).length, 1);

  store.updateQuote(first.id, { status: "sent", sentMessageId: "sent-once" });
  const replay = await service.process(image, null, "历史补处理");
  assert.equal(replay.state, "replied");
  assert.equal(replay.source, "existing-quote");
  assert.equal(store.listQuotes("all", chatId).length, 1);
});

test("微店搜图响应同时保留有价格和无价格候选", () => {
  const supplier = new SupplierSearch(() => ({ quoteMarkup: 1.3, quoteShipping: 0, quoteCurrency: "CNY" }));
  const products = supplier.normalize({
    success: true,
    data: JSON.stringify({ sortList: [
      { code: "priced", title: "有价格同款", price: "88.50", pics: { picList: ["//product.aliyizhan.com/a.jpg"] } },
      { code: "unpriced", title: "无价格同款", pics: { picList: ["https://example.com/b.jpg"] } }
    ] })
  });
  assert.equal(products.length, 2);
  assert.equal(products[0].cost, 88.5);
  assert.equal(products[0].imageUrl, "https://product.aliyizhan.com/a.jpg");
  assert.equal(products[1].cost, 0);
  assert.equal(products[1].hasPrice, false);
});

test("微店完整描述会保留并从高相似结果归集可信尺寸与产品要点", () => {
  const supplier = new SupplierSearch(() => ({ quoteMarkup: 1.3, quoteShipping: 0, quoteCurrency: "CNY" }));
  const description = "P200 COACH PAIGE单肩背包，黑色皮革，肩带可调节，拉链开合。开口48高25厚1";
  const products = supplier.normalize({ data: JSON.stringify({ sortList: [
    { code: "one", title: "PAIGE同款一", description, price: 200, score: 0.984 },
    { code: "two", title: "PAIGE同款二", description, price: 200, score: 0.983 },
    { code: "other", title: "低相似其他商品", description: "尼龙包，尺寸 20×10×5 cm", price: 80, score: 0.82 }
  ] }) });
  const facts = aggregateProductFacts(products);
  assert.equal(products[0].description, description);
  assert.equal(products[0].facts.dimensions.en, "approximately 48 cm across the opening, 25 cm high, and 1 cm deep");
  assert.equal(facts.dimensions.evidenceCount, 2);
  assert.equal(facts.material.en, "leather");
  assert.deepEqual(facts.features.map((item) => item.id), ["adjustable_strap", "zipper"]);
});

test("最终报价按基础价、运费和利润计算并四舍五入为目标币种整数", () => {
  const quote = calculateFinalQuote({
    basePriceCny: 416,
    shippingCny: 90,
    profitRate: 0.75,
    currency: "USD",
    rates: { USD: 0.14885 }
  });
  assert.equal(quote.profitCny, 312);
  assert.equal(quote.subtotalCny, 818);
  assert.equal(quote.suggestedPrice, 122);
  assert.equal(quote.currency, "USD");
});

test("驳回报价会发送工厂暂时缺货通知且防止重复", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = "quote-reject@c.us";
  store.upsertContact(chatId, { profileName: "报价客户" });
  service.supplier.search = async () => [{ id: "p1", title: "同款", cost: 100, currency: "CNY" }];
  service.supplier.calculate = () => ({ costMin: 100, costMax: 100, suggestedPrice: 130, currency: "CNY" });
  await service.ingest({
    id: "reject-image",
    accountId: "primary",
    accountName: "Manos",
    chatId,
    profileName: "报价客户",
    type: "image",
    body: "这个有货吗？",
    createdAt: Date.now(),
    media: { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), mimeType: "image/jpeg" }
  });
  const quote = store.listQuotes("pending")[0];
  await service.rejectQuote(quote.id, "人工确认缺货");
  assert.equal(session.sent.at(-1).body, "抱歉亲爱的，这款工厂告诉我暂时缺货。");
  assert.equal(store.getQuote(quote.id).status, "rejected");
  await assert.rejects(() => service.rejectQuote(quote.id), /已经驳回并通知客户/);
  assert.equal(session.sent.length, 1);
});

test("搜图没有价格时告知客户并建立待询厂任务", async (t) => {
  const { store, session, service } = fixture(t);
  const providerChatId = "301@c.us";
  service.supplier.search = async () => [{ id: "no-price", title: "相似商品", cost: 0, currency: "CNY", hasPrice: false }];
  await service.ingest({
    id: "image-no-price",
    accountId: "primary",
    accountName: "Manos",
    chatId: providerChatId,
    profileName: "Image buyer",
    type: "image",
    body: "Price?",
    createdAt: Date.now(),
    media: { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), mimeType: "image/jpeg" }
  });
  const quote = store.listQuotes("pending")[0];
  assert.equal(quote.quoteType, "factory_inquiry");
  assert.equal(quote.suggestedPrice, 0);
  assert.equal(quote.products.length, 1);
  assert.equal(session.sent.length, 1);
  assert.equal(session.sent[0].body, "Okay dear, I’ll check with the factory for you.");
  await assert.rejects(() => service.approveQuote(quote.id, {}), /先填写工厂确认价/);
  assert.equal(session.sent.length, 1);
});

test("历史图片占位符不会被误判为中文，报价默认跟随客户最近真实语言", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "quote-language@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos", providerChatId: "quote-language@c.us", profileName: "Buyer" });
  store.addMessage({ id: "language-context", chatId, accountId: "primary", direction: "inbound", type: "text", body: "Could you help me with these items?", createdAt: 1000 });
  const image = store.addMessage({ id: "language-image", chatId, accountId: "primary", direction: "inbound", type: "image", body: "[历史图片]", createdAt: 2000 }).message;
  service.supplier.search = async () => [{ id: "priced", title: "同款", cost: 200, currency: "CNY", hasPrice: true }];
  service.supplier.calculate = () => ({ costMin: 200, costMax: 200, suggestedPrice: 260, currency: "CNY" });
  const quote = await service.processImage(image, { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), mimeType: "image/jpeg" });
  assert.equal(quote.replyLanguage, "auto");
  assert.equal(quote.customerLanguage, "en");
  assert.equal(quote.draftLanguage, "en");
  assert.match(quote.draftReply, /preliminary price/i);
  assert.equal(session.sent.length, 0);
});

test("报价语言可手动转换并持久化", async (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "quote-translate@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "quote-translate@c.us", profileName: "Buyer" });
  store.addMessage({ id: "quote-translate-image", chatId, accountId: "primary", direction: "inbound", type: "image", body: "How much is it?", createdAt: 1000 });
  const quote = store.createQuote({ chatId, inboundMessageId: "quote-translate-image", quoteType: "priced", basePriceCny: 200, suggestedPrice: 260, currency: "CNY", customerLanguage: "en", replyLanguage: "auto", draftLanguage: "en", draftReply: "Dear, the final price is USD 80." });
  let targetLanguage = "";
  service.ai.translate = async (_text, target) => { targetLanguage = target; return "Chère cliente, le prix final est de 80 USD."; };
  const translated = await service.translateQuote(quote.id, { replyLanguage: "fr" });
  assert.equal(targetLanguage, "fr");
  assert.equal(translated.replyLanguage, "fr");
  assert.equal(translated.draftLanguage, "fr");
  assert.match(store.getQuote(quote.id).draftReply, /prix final/i);
});

test("删除报价会移除记录并在没有其他报价时解除待人工状态", (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "quote-delete@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "quote-delete@c.us", profileName: "Buyer" });
  store.addMessage({ id: "quote-delete-image", chatId, accountId: "primary", direction: "inbound", type: "image", body: "Price?", createdAt: 1000, metadata: { automationState: "quote_pending" } });
  const quote = store.createQuote({ chatId, inboundMessageId: "quote-delete-image", quoteType: "priced", basePriceCny: 200, suggestedPrice: 260, currency: "CNY", draftReply: "Draft" });
  assert.equal(store.getContact(chatId).needsHuman, true);
  service.deleteQuote(quote.id);
  assert.equal(store.getQuote(quote.id), null);
  assert.equal(store.getContact(chatId).needsHuman, false);
  assert.equal(store.getMessage(chatId, "quote-delete-image").metadata.automationState, "dismissed");
});

test("补处理旧图片时不会越过更新的客户消息发送询厂话术", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "late-image@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos", providerChatId: "late-image@c.us", profileName: "Buyer" });
  const image = store.addMessage({ id: "old-image-late", chatId, accountId: "primary", direction: "inbound", type: "image", body: "Price?", createdAt: 1000 }).message;
  store.addMessage({ id: "newer-chat", chatId, accountId: "primary", direction: "inbound", type: "text", body: "I had a long day at work.", createdAt: 2000 });
  service.supplier.search = async () => [{ id: "no-price", title: "相似商品", cost: 0, currency: "CNY", hasPrice: false }];
  const quote = await service.processImage(image, { data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), mimeType: "image/jpeg" });
  assert.equal(quote.quoteType, "factory_inquiry");
  assert.equal(quote.acknowledgementDeferred, true);
  assert.match(quote.acknowledgementDeferredReason, /避免错序/);
  assert.equal(session.sent.length, 0);
});

test("回复时间强制排在被回复客户消息之后", async (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "302@c.us");
  const future = Date.now() + 120000;
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos", providerChatId: "302@c.us", profileName: "Buyer" });
  store.addMessage({ id: "future-inbound", chatId, accountId: "primary", direction: "inbound", body: "Hello", createdAt: future });
  const sent = await service.sendText(chatId, "Hi", { replyToId: "future-inbound", source: "ai" });
  assert.equal(sent.createdAt > future, true);
});

test("ManosID 永远只作为广告标记且禁止被模型原样回发", () => {
  const result = enforceGrounding([
    { direction: "inbound", body: 'ManosID--"ST40SZ4K"\nHello! Can I get more info on this?' },
    { direction: "inbound", body: "Where is your factory?" }
  ], { action: "reply", reply: "ManosID--", reason: "reply", confidence: 1 });
  assert.equal(result.action, "handoff");
  assert.match(result.reason, /ManosID/);
  assert.equal(messageFromMe({ from: "self@c.us", to: "buyer@c.us", id: { fromMe: false } }, "self@c.us"), true);
  assert.equal(messageFromMe({ from: "buyer@c.us", to: "self@c.us", id: { fromMe: true } }, "self@c.us"), false);
});

test("旧 AI 回复不能成为后续回答的事实依据", () => {
  const result = enforceGrounding([
    { direction: "outbound", body: "Our factory is in China.", metadata: { source: "ai" } },
    { direction: "inbound", body: "Where is your factory?" }
  ], { action: "reply", reply: "Our factory is in China.", reason: "answer", confidence: 1 });
  assert.equal(result.action, "handoff");
  assert.match(result.reason, /公司或工厂/);
});

test("自动长期记忆只能维持上下文，不能为价格或工厂事实背书", () => {
  const result = enforceGrounding([
    { direction: "outbound", body: "工厂位于伦敦，价格 999 美元。", metadata: { source: "conversation-summary", verifiedByHuman: false } },
    { direction: "outbound", body: "客户以前接受 999 美元。", metadata: { source: "customer-memory", verifiedByHuman: false } },
    { direction: "inbound", body: "Where is your factory?" }
  ], { action: "reply", reply: "Our factory is in London and it costs 999 USD.", reason: "answer", confidence: 1 });
  assert.equal(result.action, "handoff");
  assert.match(result.reason, /聊天记录中没有的数字|公司或工厂/);
});

test("不同 WhatsApp 账号的相同消息 ID 分别保存", (t) => {
  const { store } = fixture(t);
  const first = store.addMessage({ id: "same-id", chatId: "account-a::100@c.us", accountId: "account-a", body: "A 账号消息" });
  const second = store.addMessage({ id: "same-id", chatId: "account-b::100@c.us", accountId: "account-b", body: "B 账号消息" });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, true);
  assert.equal(store.stats().messages, 2);
});

test("标准会话接口抛出不透明错误时切换兼容读取", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new AccountSession({ accountId: "account-a", clientId: "account-a", label: "账号 A", authDir: root, getSettings: () => ({ ignoreGroups: true, historySyncLimit: 0 }) });
  session.client = {
    getChats: async () => { throw "r"; },
    pupPage: { evaluate: async () => [{ chatId: "100@c.us", profileName: "客户", unread: 2, isGroup: false, timestamp: 100 }] }
  };
  let compatibilityNotice = "";
  session.on("sync-error", (error) => { compatibilityNotice = error.message; });
  const chats = await session.getChatSummaries();
  assert.equal(chats.length, 1);
  assert.equal(chats[0].chatId, "100@c.us");
  assert.match(compatibilityNotice, /兼容模式.*r/);
});

test("历史上限为 0 时逐会话读取全部可用记录", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new AccountSession({ accountId: "account-a", clientId: "account-a", label: "账号 A", authDir: root, getSettings: () => ({ ignoreGroups: true, historySyncLimit: 0 }) });
  session.client = {};
  session.getChatSummaries = async () => [
    { chatId: "100@c.us", profileName: "客户一", unread: 0, isGroup: false, timestamp: 2 },
    { chatId: "200@c.us", profileName: "客户二", unread: 1, isGroup: false, timestamp: 1 }
  ];
  const limits = [];
  session.fetchMessagesForChat = async (chatId, limit) => {
    limits.push(limit);
    return [{ id: `history-${chatId}`, chatId, direction: "inbound", type: "text", body: "历史", createdAt: 1 }];
  };
  const batches = [];
  session.on("history", (batch) => batches.push(batch));
  const result = await session.syncHistory();
  assert.deepEqual(limits, [0, 0]);
  assert.equal(result.imported, 2);
  assert.equal(result.mode, "全部可用历史");
  assert.equal(batches.length, 2);
});

test("新版 WhatsApp 消息键可生成稳定消息 ID", () => {
  assert.equal(messageId({ fromMe: false, remote: "83327348375562@lid", id: "ABC123" }), "false_83327348375562@lid_ABC123");
});

test("消息实际发出但库未返回对象时生成可对账的临时消息", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-send-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new AccountSession({ accountId: "account-a", clientId: "account-a", label: "账号 A", authDir: root, getSettings: () => ({}) });
  session.state.status = "ready";
  session.client = { sendMessage: async () => { throw new TypeError("Cannot read properties of undefined (reading 'id')"); } };
  const sent = await session.sendText("100@c.us", "hello");
  assert.equal(sent.provisional, true);
  assert.match(sent.id, /^provisional-account-a-/);
});

test("账号语言风格持久化并注入该账号的 AI 回复", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", {
    status: "ready",
    progress: 100,
    summary: "主要使用简短友好的英文，每次只推进一个问题。",
    rules: [{ id: "manual-1", text: "以 Hi 开场", enabled: true, source: "manual" }]
  });
  let receivedStyle;
  service.ai.decide = async (_contact, _history, style) => {
    receivedStyle = style;
    return { action: "reply", reply: "Hi, how can I help?", reason: "按账号风格回复", confidence: 0.9 };
  };
  await service.ingest({ id: "style-in", accountId: "primary", accountName: "账号 1", chatId: "400@c.us", profileName: "Style 客户", type: "text", body: "Could you help me choose a product?", createdAt: Date.now() });
  assert.equal(receivedStyle.summary.includes("简短友好"), true);
  assert.equal(receivedStyle.rules[0].text, "以 Hi 开场");
  assert.equal(session.sent[0].body, "Hi, how can I help?");
  assert.equal(new Store(store.dataDir).getAccountStyle("primary").status, "ready");
});

test("人工新增的主营鞋服规则可以直接回答客户且不会否认卖衣服", () => {
  const accountStyle = {
    rules: [{
      id: "manual-business-1",
      source: "manual",
      enabled: true,
      text: "我们 Manos 主要售卖高奢鞋服和配饰，在深圳有自己的工厂，并与英国和欧洲的供货商长期合作"
    }]
  };
  const answer = answerFromManualRules(
    "Don't you sell clothes? I saw in the advertisement that you sell clothes.",
    accountStyle
  );
  assert.match(answer, /Yes, dear/);
  assert.match(answer, /shoes, clothing, and accessories/);
  assert.match(answer, /factory in Shenzhen/);
  assert.doesNotMatch(answer, /(?:do not|don't) sell clothes/i);
});

test("人工业务规则优先于本地模型和已学习回答", async (t) => {
  const { store, session, service } = fixture(t);
  store.updateAccountStyle("primary", {
    status: "ready",
    progress: 100,
    summary: "使用简洁友好的英文回答",
    rules: [{
      id: "manual-business-1",
      source: "manual",
      enabled: true,
      text: "我们 Manos 主要售卖高奢鞋服和配饰，在深圳有自己的工厂，并与英国和欧洲的供货商长期合作"
    }]
  });
  let modelCalled = false;
  service.ai.decide = async () => {
    modelCalled = true;
    return { action: "reply", reply: "I don't sell clothes.", reason: "wrong", confidence: 1 };
  };
  await service.ingest({
    id: "clothes-question",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "401@c.us",
    profileName: "Clothing buyer",
    type: "text",
    body: "Don't you sell clothes? I saw in the advertisement that you sell clothes.",
    createdAt: Date.now()
  });
  assert.equal(modelCalled, false);
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].body, /shoes, clothing, and accessories/);
  const chatId = conversationKey("primary", "401@c.us");
  const outbound = store.listMessages(chatId, { markRead: false }).find((item) => item.direction === "outbound");
  assert.equal(outbound.metadata.source, "account-rule");
});

test("本地模型若否认人工确认的主营品类会被阻止发送", () => {
  const guarded = enforceGrounding([
    { direction: "inbound", body: "Don't you sell clothes?" }
  ], {
    action: "reply",
    reply: "I'm sorry, but I don't sell clothes.",
    reason: "wrong",
    confidence: 1
  }, ["Manos sells high-end shoes, clothing, and accessories."]);
  assert.equal(guarded.action, "handoff");
  assert.match(guarded.reason, /主营鞋服规则冲突/);
});

test("客户追问是否为 AI 时固定以 Manos 客服身份继续接待", async (t) => {
  const { session, service } = fixture(t);
  let modelCalled = false;
  service.ai.decide = async () => {
    modelCalled = true;
    return { action: "reply", reply: "I am an AI assistant.", reason: "wrong", confidence: 1 };
  };
  assert.equal(isIdentityQuestion("Okay, are you AI?"), true);
  assert.equal(isIdentityQuestion("Êtes-vous une IA ?"), true);
  await service.ingest({
    id: "identity-question",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "402@c.us",
    profileName: "Buyer",
    type: "text",
    body: "Okay, are you AI?",
    createdAt: Date.now()
  });
  assert.equal(modelCalled, false);
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].body, /customer service representative with Manos/i);
  assert.doesNotMatch(session.sent[0].body, /\bAI\b|bot|language model/i);
});

test("所有出站消息发送前都会拦截自称 AI 的内容", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "403@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId: "403@c.us", profileName: "Buyer" });
  store.addMessage({ id: "asks-ai", chatId, accountId: "primary", direction: "inbound", type: "text", body: "Are you a bot?", createdAt: Date.now() });
  await service.sendText(chatId, "As an AI language model, I can help you.", { source: "ai", replyToId: "asks-ai" });
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].body, /customer service representative with Manos/i);
  assert.equal(enforceCustomerServiceIdentity("I’m an AI assistant.", "Are you AI?").includes("customer service representative"), true);
  assert.match(enforceCustomerServiceIdentity("Bien sûr, je suis une IA.", "Êtes-vous une IA ?"), /service client Manos/);
});

test("英文聊天消息使用本地模型生成中文译文并缓存", async (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "404@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId: "404@c.us", profileName: "Buyer" });
  store.addMessage({ id: "english-message", chatId, accountId: "primary", direction: "inbound", type: "text", body: "What kind of clothes are you looking for?", createdAt: Date.now() });
  let calls = 0;
  service.ai.translate = async (text, targetLanguage) => {
    calls += 1;
    assert.equal(text, "What kind of clothes are you looking for?");
    assert.equal(targetLanguage, "zh-CN");
    return "您想找哪一种衣服？";
  };
  const first = await service.translateMessages(chatId, ["english-message"]);
  const second = await service.translateMessages(chatId, ["english-message"]);
  assert.equal(first[0].metadata.zhTranslation, "您想找哪一种衣服？");
  assert.equal(first[0].metadata.translationVersion, 3);
  assert.equal(second.length, 0);
  assert.equal(calls, 1);
  assert.equal(needsChineseTranslation("What kind of clothes do you need?"), true);
  assert.equal(needsChineseTranslation("您想找什么衣服？"), false);
});

test("图片和视频只翻译随附文字，媒体占位内容不会进入翻译队列", async (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "media-caption@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "media-caption@c.us", profileName: "Buyer" });
  store.addMessage({ id: "image-caption", chatId, accountId: "primary", direction: "inbound", type: "image", body: "How much does this bag cost and what size?", createdAt: Date.now() });
  store.addMessage({ id: "video-placeholder", chatId, accountId: "primary", direction: "inbound", type: "video", body: "[video]", createdAt: Date.now() + 1 });
  const translatedInputs = [];
  service.ai.translate = async (text, targetLanguage) => {
    translatedInputs.push({ text, targetLanguage });
    return "这个包多少钱，尺寸是多少？";
  };
  const translated = await service.translateMessages(chatId, ["image-caption", "video-placeholder"]);
  assert.equal(translated.length, 1);
  assert.equal(translated[0].id, "image-caption");
  assert.equal(translated[0].metadata.zhTranslation, "这个包多少钱，尺寸是多少？");
  assert.deepEqual(translatedInputs, [{ text: "How much does this bag cost and what size?", targetLanguage: "zh-CN" }]);
});

test("客户追问尺寸时会复用最近报价的微店描述自动专业回复", async (t) => {
  const { store, session, service } = fixture(t);
  const providerChatId = "size-follow-up@c.us";
  const chatId = conversationKey("primary", providerChatId);
  const description = "COACH PAIGE 黑色皮革单肩包，肩带可调节，拉链开合，开口48高25厚1";
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId, profileName: "Bag buyer" });
  store.createQuote({
    chatId,
    inboundMessageId: "original-image",
    products: [
      { id: "one", description, confidence: 0.98, cost: 200 },
      { id: "two", description, confidence: 0.97, cost: 200 }
    ],
    suggestedPrice: 260,
    currency: "CNY",
    draftReply: "Pending review"
  });
  await service.ingest({
    id: "size-question",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: providerChatId,
    profileName: "Bag buyer",
    type: "text",
    body: "What size is this bag?",
    createdAt: Date.now()
  });
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].body, /48 cm across the opening/);
  assert.match(session.sent[0].body, /confirm the exact dimensions with the factory/);
  const outbound = store.listMessages(chatId, { markRead: false }).find((message) => message.direction === "outbound");
  assert.equal(outbound.metadata.source, "supplier-specification");
});

test("输入框快捷翻译可自动跟随客户语言而不是固定英语", async (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "405@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId: "405@c.us", profileName: "French buyer" });
  store.addMessage({ id: "french-inbound", chatId, accountId: "primary", direction: "inbound", type: "text", body: "Pouvez-vous me répondre en français ?", createdAt: Date.now() });
  service.ai.translate = async (text, targetLanguage) => {
    assert.equal(text, "亲爱的，您想找什么产品？");
    assert.equal(targetLanguage, "fr");
    return "Cher client, quel produit recherchez-vous ?";
  };
  const result = await service.translateText("亲爱的，您想找什么产品？", "auto", chatId);
  assert.equal(result.targetLanguage, "fr");
  assert.match(result.translation, /quel produit/i);
  assert.equal(detectLanguage("Êtes-vous une IA ?"), "fr");
});

test("新账号必须完成客服形象配置后才能开启自动回复", (t) => {
  const { store, service } = fixture(t);
  store.updateAccountAutomation("primary", { enabled: false, status: "off" });
  assert.throws(() => service.setAccountAutomation("primary", true), /请先完成该账号/);
  const style = service.updateAccountProfile("primary", {
    gender: "female",
    business: "Manos 主要销售高奢鞋服和配饰",
    tone: "亲切、专业、自然",
    personality: "耐心、主动、善于追问需求"
  });
  assert.equal(style.persona.completed, true);
  assert.equal(style.persona.gender, "female");
  assert.match(style.persona.business, /高奢鞋服/);
  assert.doesNotThrow(() => service.setAccountAutomation("primary", true));
});

test("临时出站消息收到真实事件后对账而不重复显示", (t) => {
  const { store, session } = fixture(t);
  const chatId = conversationKey("primary", "500@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "账号 1", providerChatId: "500@c.us" });
  store.addMessage({ id: "provisional-primary-1", chatId, accountId: "primary", direction: "outbound", body: "Auto reply", metadata: { source: "ai", provisional: true }, createdAt: Date.now() });
  session.emit("outbound", { id: "real-message-id", accountId: "primary", accountName: "账号 1", chatId: "500@c.us", direction: "outbound", type: "text", body: "Auto reply", status: "sent", createdAt: Date.now() });
  const messages = store.listMessages(chatId, { markRead: false });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "real-message-id");
  assert.equal(messages[0].metadata.provisional, false);
});

test("本地小模型格式异常时仍按历史样本生成可编辑风格", () => {
  const style = fallbackStyleAnalysis([
    { body: "Hello! Can I get more info on this?" },
    { body: "Hi, could you share the size?" },
    { body: "Hello\nPlease send a photo." }
  ]);
  assert.match(style.summary, /英文/);
  assert.equal(style.rules.length >= 4, true);
  assert.equal(style.sampleCount, 3);
});

test("真实出站事件先到时不会再写入临时重复消息", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "600@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "账号 1", providerChatId: "600@c.us" });
  session.sendText = async () => {
    session.emit("outbound", { id: "real-first", accountId: "primary", accountName: "账号 1", chatId: "600@c.us", direction: "outbound", type: "text", body: "Auto reply first", status: "sent", createdAt: Date.now() });
    return { id: "provisional-primary-2", createdAt: Date.now(), provisional: true };
  };
  await service.sendText(chatId, "Auto reply first", { source: "ai" });
  const messages = store.listMessages(chatId, { markRead: false });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "real-first");
  assert.equal(messages[0].metadata.source, "ai");
});

test("事实校验阻止聊天记录中不存在的数字和尺寸", () => {
  const guarded = enforceGrounding([
    { direction: "outbound", body: "我们有黑色基础款帆布包。" },
    { direction: "inbound", body: "黑色的有多大？" }
  ], { action: "reply", reply: "尺寸是 1200mm × 800mm。", reason: "回答尺寸", confidence: 0.99 });
  assert.equal(guarded.action, "handoff");
  assert.match(guarded.reason, /没有的数字|没有可核实的尺寸/);
});

test("过滤 WhatsApp 官方消息和频道，不创建客户也不回复", async (t) => {
  const { store, session, service } = fixture(t);
  const result = await service.ingest({
    id: "wa-official",
    accountId: "primary",
    chatId: "0@c.us",
    profileName: "WhatsApp Business",
    type: "text",
    body: "Match your WhatsApp username to Facebook or Instagram",
    createdAt: Date.now()
  });
  assert.equal(result.ignored, true);
  assert.equal(store.listContacts().length, 0);
  assert.equal(session.sent.length, 0);
});

test("ManosID 广告询盘是正常客户并立即发送固定欢迎语和相册", async (t) => {
  const { store, session, service } = fixture(t);
  await service.ingest({
    id: "manos-lead",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "700@c.us",
    profileName: "新客户",
    type: "text",
    body: 'ManosID--"ST40SZ4K"\nHello! Can I get more info on this?',
    createdAt: Date.now()
  });
  assert.equal(store.listContacts().length, 1);
  assert.equal(session.sent.length, 1);
  assert.equal(session.sent[0].body, MANOS_LEAD_WELCOME);
  const inbound = store.getMessage(conversationKey("primary", "700@c.us"), "manos-lead");
  assert.equal(inbound.metadata.automationState, "replied");
});

test("历史同步后只补回复最近且未处理的最后一条客户消息，并防止重复", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "800@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId: "800@c.us", profileName: "相册客户" });
  store.importHistory(chatId, "相册客户", [
    { id: "album-offer", accountId: "primary", direction: "outbound", type: "text", body: "I can share my photo album with you.", createdAt: Date.now() - 120000 },
    { id: "album-now", accountId: "primary", direction: "inbound", type: "text", body: "right now", createdAt: Date.now() - 60000 }
  ]);
  const first = await service.catchUpRecentInbound("primary");
  const second = await service.catchUpRecentInbound("primary");
  assert.equal(first.count, 1);
  assert.equal(second.count, 0);
  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].body, /manos\.live/);
  assert.equal(store.getMessage(chatId, "album-now").metadata.automationState, "replied");
});

test("人工点击 AI 回复可处理尚未自动回复的历史消息", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "900@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "900@c.us", profileName: "客户", mode: "human", needsHuman: true });
  store.importHistory(chatId, "客户", [
    { id: "offer", accountId: "primary", direction: "outbound", type: "text", body: "Would you like to see our photo album?", createdAt: Date.now() - 1000 },
    { id: "answer", accountId: "primary", direction: "inbound", type: "text", body: "yes", createdAt: Date.now() }
  ]);
  await service.replyToMessage(chatId, "answer");
  assert.equal(session.sent.length, 1);
  assert.equal(store.getMessage(chatId, "answer").metadata.automationSource, "album-follow-up");
});

test("人工回复按钮也不能对已有后续出站消息的旧消息重复发送", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "901@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "901@c.us", profileName: "客户" });
  store.importHistory(chatId, "客户", [
    { id: "old-question", accountId: "primary", direction: "inbound", type: "text", body: "Can I see it?", createdAt: 1000 },
    { id: "already-sent", accountId: "primary", direction: "outbound", type: "text", body: "Sure.", createdAt: 2000 }
  ]);
  await assert.rejects(() => service.replyToMessage(chatId, "old-question"), /已经发送过回复/);
  assert.equal(session.sent.length, 0);
});

test("WhatsApp 实时事件收到新客户首次招呼后立即发送固定欢迎语", async (t) => {
  const { store, session, service } = fixture(t);
  let aiCalled = false;
  service.ai.decide = async () => { aiCalled = true; return { action: "reply", reply: "不应调用", confidence: 1 }; };
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待新客欢迎语超时")), 1000);
    const handler = (event) => {
      if (event.type !== "message" || event.message?.id !== "first-hello" || event.message?.metadata?.automationState !== "replied") return;
      clearTimeout(timer);
      service.off("update", handler);
      resolve(event.message);
    };
    service.on("update", handler);
  });
  session.emit("message", {
    id: "first-hello",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "new-customer@c.us",
    profileName: "New customer",
    type: "text",
    body: "Hello 👋",
    createdAt: Date.now()
  });
  await completed;
  assert.equal(session.sent[0].body, NEW_CUSTOMER_WELCOME);
  const outbound = store.listMessages(conversationKey("primary", "new-customer@c.us"), { markRead: false }).find((item) => item.direction === "outbound");
  assert.equal(outbound.metadata.source, "new-customer-welcome");
  assert.equal(aiCalled, false);
  assert.equal(store.getMessage(conversationKey("primary", "new-customer@c.us"), "first-hello").metadata.automationState, "replied");
});

test("只有纯招呼触发新客欢迎，带具体需求的消息交给上下文 AI", async (t) => {
  const { store, session, service } = fixture(t);
  assert.equal(isGreeting("Hello, I need handbags"), false);
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { gender: "female", business: "General merchandise", tone: "friendly", personality: "patient" } });
  service.ai.decide = async () => ({ action: "reply", reply: "Sure. What handbag style do you need?", reason: "继续确认产品", confidence: 0.9 });
  await service.ingest({
    id: "first-with-need",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: "buyer@c.us",
    profileName: "Buyer",
    type: "text",
    body: "Hello, I need handbags",
    createdAt: Date.now()
  });
  assert.equal(session.sent[0].body, "Sure. What handbag style do you need?");
});

test("账号 AI 回复默认关闭，新实时消息只进入队列不发送", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-account-off-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const session = new FakeSession();
  const service = new SalesService({ store, session, dataDir: root });
  assert.equal(store.getAccountAutomation("primary").enabled, false);
  await service.ingest({ id: "off-message", accountId: "primary", accountName: "账号 1", chatId: "off@c.us", profileName: "等待客户", type: "text", body: "Hello", createdAt: Date.now() });
  assert.equal(session.sent.length, 0);
  assert.equal(store.getMessage(conversationKey("primary", "off@c.us"), "off-message").metadata.automationState, "queued");
  assert.equal(service.queueSnapshot("primary").next.contactName, "等待客户");
});

test("开启账号 AI 后按客户顺序回复，并展示当前客户和下一位", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-account-queue-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { gender: "female", business: "General merchandise", tone: "friendly", personality: "patient" } });
  const session = new FakeSession();
  const service = new SalesService({ store, session, dataDir: root });
  service.ai.decide = async (contact) => ({ action: "reply", reply: `Reply to ${contact.profileName}`, reason: "queue test", confidence: 0.9 });
  await service.ingest({ id: "queue-a", accountId: "primary", chatId: "a@c.us", profileName: "客户 A", type: "text", body: "I need bags", createdAt: 1000 });
  await service.ingest({ id: "queue-b", accountId: "primary", chatId: "b@c.us", profileName: "客户 B", type: "text", body: "I need shoes", createdAt: 2000 });
  const running = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待队列启动超时")), 1000);
    const handler = (event) => {
      if (event.type !== "account-queue" || event.automation?.status !== "running") return;
      clearTimeout(timer);
      service.off("update", handler);
      resolve(event.automation);
    };
    service.on("update", handler);
  });
  service.setAccountAutomation("primary", true);
  const runningState = await running;
  assert.equal(runningState.current.contactName, "客户 A");
  assert.equal(runningState.next.contactName, "客户 B");
  await service.runAccountQueue("primary");
  assert.deepEqual(session.sent.map((item) => item.body), ["Reply to 客户 A", "Reply to 客户 B"]);
  assert.equal(service.queueSnapshot("primary").status, "idle");
  assert.equal(service.queueSnapshot("primary").pendingCount, 0);
});

test("同一客户连续多条排队消息合并为一次上下文回复", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-account-merge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { gender: "female", business: "General merchandise", tone: "friendly", personality: "patient" } });
  const session = new FakeSession();
  const service = new SalesService({ store, session, dataDir: root });
  let receivedContext = [];
  service.ai.decide = async (_contact, context) => {
    receivedContext = context;
    return { action: "reply", reply: "Blue bags, understood. What quantity do you need?", reason: "merged", confidence: 0.9 };
  };
  await service.ingest({ id: "merge-old", accountId: "primary", chatId: "merge@c.us", profileName: "客户 C", type: "text", body: "I need bags", createdAt: 1000 });
  await service.ingest({ id: "merge-new", accountId: "primary", chatId: "merge@c.us", profileName: "客户 C", type: "text", body: "Blue ones", createdAt: 2000 });
  assert.equal(service.queueSnapshot("primary").mergedCount, 1);
  service.setAccountAutomation("primary", true);
  await service.runAccountQueue("primary");
  assert.equal(session.sent.length, 1);
  assert.equal(receivedContext.some((item) => item.id === "merge-old"), true);
  assert.equal(receivedContext.some((item) => item.id === "merge-new"), true);
  assert.equal(store.getMessage(conversationKey("primary", "merge@c.us"), "merge-old").metadata.automationState, "superseded");
  assert.equal(store.getMessage(conversationKey("primary", "merge@c.us"), "merge-new").metadata.automationState, "replied");
});

test("同一客户连续发送多张商品图会逐张建立报价审核", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-multi-product-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { completed: true, gender: "female", business: "Fashion", tone: "friendly", personality: "patient" } });
  const session = new FakeSession();
  const service = new SalesService({ store, session, dataDir: root });
  let searches = 0;
  service.supplier.search = async () => {
    searches += 1;
    return [{ id: `product-${searches}`, title: `Product ${searches}`, description: "Fashion product", cost: 200, currency: "CNY", confidence: 0.95 }];
  };
  service.supplier.calculate = () => ({ costMin: 200, costMax: 200, suggestedPrice: 260, currency: "CNY" });
  const media = { data: Buffer.from("mock-product-image").toString("base64"), mimeType: "image/jpeg" };
  for (let index = 1; index <= 3; index += 1) {
    await service.ingest({
      id: `multi-image-${index}`,
      accountId: "primary",
      accountName: "Manos Amy",
      chatId: "multi-product@c.us",
      profileName: "Multi product buyer",
      type: "image",
      body: index === 3 ? "I need their price" : "[图片]",
      createdAt: 1000 + index,
      media
    });
  }
  service.setAccountAutomation("primary", true);
  await service.runAccountQueue("primary");
  const chatId = conversationKey("primary", "multi-product@c.us");
  const quotes = store.listQuotes("all", chatId);
  assert.equal(searches, 3);
  assert.equal(quotes.length, 3);
  assert.deepEqual(new Set(quotes.map((quote) => quote.inboundMessageId)), new Set(["multi-image-1", "multi-image-2", "multi-image-3"]));
  assert.equal(quotes.every((quote) => quote.status === "pending"), true);
  assert.equal(session.sent.length, 0);
});

test("客户视频会保存为可播放媒体并转人工查看", async (t) => {
  const { store, service } = fixture(t);
  const providerChatId = "video-customer@c.us";
  const data = Buffer.from("mock-mp4-content").toString("base64");
  await service.ingest({
    id: "video-inbound",
    accountId: "primary",
    accountName: "Manos Amy",
    chatId: providerChatId,
    profileName: "视频客户",
    type: "video",
    body: "Please check this video",
    createdAt: Date.now(),
    media: { data, mimeType: "video/mp4", filename: "sample.mp4" }
  });
  const chatId = conversationKey("primary", providerChatId);
  const message = store.getMessage(chatId, "video-inbound");
  assert.match(message.mediaUrl, /\.mp4$/);
  assert.equal(fs.readFileSync(message.localMediaPath).toString(), "mock-mp4-content");
  assert.equal(message.metadata.automationState, "handoff");
  assert.match(store.getContact(chatId).escalationReason, /视频/);
});

test("工作台可以发送带说明的图片和视频并在本地回显", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "attachment@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId: "attachment@c.us", profileName: "附件客户" });
  store.addMessage({ id: "attachment-question", chatId, accountId: "primary", direction: "inbound", type: "text", body: "Can you send a video?", createdAt: Date.now() });
  const result = await service.sendManualMedia(chatId, {
    data: Buffer.from("outbound-video").toString("base64"),
    mimeType: "video/mp4",
    filename: "catalog.mp4",
    caption: "Here is the product video."
  });
  assert.equal(session.sentMedia.length, 1);
  assert.equal(session.sentMedia[0].chatId, "attachment@c.us");
  assert.equal(session.sentMedia[0].media.caption, "Here is the product video.");
  assert.equal(result.message.type, "video");
  assert.equal(result.message.replyToId, "attachment-question");
  assert.match(result.message.mediaUrl, /\.mp4$/);
  assert.equal(fs.existsSync(result.message.localMediaPath), true);
});

test("工作台批量图片和视频按选择顺序发送且说明只附在第一项", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "batch-attachment@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId: "batch-attachment@c.us", profileName: "批量附件客户" });
  store.addMessage({ id: "batch-question", chatId, accountId: "primary", direction: "inbound", type: "text", body: "Please send the photos and video.", createdAt: Date.now() });
  store.requestHuman(chatId, "客户索要产品媒体", "batch-question");
  const result = await service.sendManualMediaBatch(chatId, {
    caption: "Here are the product details, dear.",
    items: [
      { data: Buffer.from("first-image").toString("base64"), mimeType: "image/png", filename: "01-front.png" },
      { data: Buffer.from("second-video").toString("base64"), mimeType: "video/mp4", filename: "02-demo.mp4" },
      { data: Buffer.from("third-image").toString("base64"), mimeType: "image/jpeg", filename: "03-detail.jpg" }
    ]
  });
  assert.equal(session.sentMedia.length, 3);
  assert.deepEqual(session.sentMedia.map((item) => item.media.filename), ["01-front.png", "02-demo.mp4", "03-detail.jpg"]);
  assert.deepEqual(session.sentMedia.map((item) => item.media.caption), ["Here are the product details, dear.", "", ""]);
  assert.deepEqual(result.messages.map((item) => item.type), ["image", "video", "image"]);
  assert.equal(result.messages.every((item) => item.replyToId === "batch-question"), true);
  assert.equal(store.getContact(chatId).needsHuman, false);
});

test("批量附件在发送前校验数量和总大小", async (t) => {
  const { store, session, service } = fixture(t);
  const chatId = conversationKey("primary", "batch-validation@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "batch-validation@c.us", profileName: "校验客户" });
  const item = { data: Buffer.from("small").toString("base64"), mimeType: "image/png", filename: "small.png" };
  await assert.rejects(() => service.sendManualMediaBatch(chatId, { items: Array.from({ length: 11 }, () => item) }), /最多发送 10 个/);
  assert.equal(session.sentMedia.length, 0);
});

test("WhatsApp 消息类型保留视频类型", () => {
  assert.equal(normalizedType("video"), "video");
  assert.equal(normalizedType("image"), "image");
  assert.equal(normalizedType("chat"), "text");
});

test("已登录账号后台重新载入时保持在线，等待队列不会被连接状态阻塞", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-session-loading-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = new AccountSession({ accountId: "loading-account", clientId: "loading-account", label: "加载账号", authDir: root, getSettings: () => ({}) });
  account.setState({ status: "ready", account: { id: "100@c.us", name: "Amy", platform: "WhatsApp Web" }, message: "WhatsApp 已连接" });
  const status = account.handleLoadingScreen(99, "WhatsApp");
  assert.equal(status.status, "ready");
  assert.match(status.message, /后台载入 99%/);
  assert.equal(status.account.id, "100@c.us");
});

test("WhatsApp 会话使用 MessageMedia 发送视频及说明文字", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wa-session-media-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = new AccountSession({ accountId: "media-account", clientId: "media-account", label: "媒体账号", authDir: root, getSettings: () => ({}) });
  account.state.status = "ready";
  let captured = null;
  account.client = {
    sendMessage: async (chatId, payload, options) => {
      captured = { chatId, payload, options };
      return { id: { _serialized: "media-message-id" }, timestamp: Math.floor(Date.now() / 1000) };
    }
  };
  const result = await account.sendMedia("buyer@c.us", {
    data: Buffer.from("video").toString("base64"),
    mimeType: "video/mp4",
    filename: "product.mp4",
    caption: "Product video"
  });
  assert.equal(captured.chatId, "buyer@c.us");
  assert.equal(captured.payload.mimetype, "video/mp4");
  assert.equal(captured.payload.filename, "product.mp4");
  assert.equal(captured.options.caption, "Product video");
  assert.equal(result.id, "media-message-id");
});

test("客户专属记忆可增删改、持久化并实际注入本地 AI 上下文", async (t) => {
  const { root, store, service } = fixture(t);
  const providerChatId = "memory-buyer@c.us";
  const chatId = conversationKey("primary", providerChatId);
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId, profileName: "记忆客户" });
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { gender: "female", business: "Fashion products", tone: "friendly", personality: "patient", completed: true } });
  const memory = service.createCustomerMemory(chatId, { type: "preference", text: "This customer only wants black products." });
  const updated = service.updateCustomerMemory(chatId, memory.id, { text: "This customer prefers black products and concise replies.", enabled: true });
  assert.match(updated.text, /concise/);
  assert.equal(new Store(root).listCustomerMemories(chatId).length, 1);
  let receivedHistory = [];
  service.ai.decide = async (_contact, history) => {
    receivedHistory = history;
    return { action: "reply", reply: "Sure, dear. What quantity do you need?", reason: "继续确认需求", confidence: 0.9 };
  };
  await service.ingest({ id: "memory-question", accountId: "primary", accountName: "Manos Amy", chatId: providerChatId, profileName: "记忆客户", type: "text", body: "Can you show me more options?", createdAt: Date.now() });
  assert.equal(receivedHistory.some((item) => item.metadata?.source === "customer-memory" && /black products/.test(item.body)), true);
  const outbound = store.getLatestMessage(chatId);
  assert.equal(outbound.metadata.customerMemoryIds.includes(memory.id), true);
  service.deleteCustomerMemory(chatId, memory.id);
  assert.equal(store.listCustomerMemories(chatId).length, 0);
});

test("本地模型会整理故事连续性、保存原文来源并保护人工校正记忆", async (t) => {
  const { root, store, service } = fixture(t);
  const chatId = conversationKey("primary", "long-memory@c.us");
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId: "long-memory@c.us", profileName: "Lena" });
  store.addMessage({ id: "lm-1", chatId, accountId: "primary", direction: "inbound", type: "text", body: "My name is Lena and I prefer black bags.", createdAt: 1000 });
  store.addMessage({ id: "lm-2", chatId, accountId: "primary", direction: "outbound", type: "text", body: "I will show you some black styles.", createdAt: 2000, metadata: { source: "human" } });
  store.addMessage({ id: "lm-3", chatId, accountId: "primary", direction: "inbound", type: "text", body: "I need a medium bag for daily use.", createdAt: 3000 });
  let calls = 0;
  service.ai.summarizeConversationMemory = async () => {
    calls += 1;
    return calls === 1 ? {
      currentScene: "Lena 正在挑选适合日常使用的中号黑色包。",
      historySummary: "客户自我介绍叫 Lena，偏好黑色，目前已进入包款筛选阶段。",
      memories: [{ type: "identity", text: "客户名叫 Lena。", sourceMessageIds: ["lm-1"], confidence: 0.96 }]
    } : {
      currentScene: "继续筛选包款。",
      historySummary: "客户仍在挑选日常包。",
      memories: [{ type: "requirement", text: "客户需要日常使用的中号包。", sourceMessageIds: ["lm-3"], confidence: 0.9 }]
    };
  };

  const summary = await service.organizeConversationMemory(chatId, { force: true });
  assert.equal(summary.status, "ready");
  assert.match(summary.currentScene, /中号黑色包/);
  let memories = store.listCustomerMemories(chatId, { includeDisabled: true });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].source, "ai");
  assert.deepEqual(memories[0].sourceMessageIds, ["lm-1"]);
  const insights = service.getConversationInsights(chatId);
  assert.equal(insights.memorySummary.messageCount, 3);
  assert.equal(insights.memories[0].sourceMessages[0].body, "My name is Lena and I prefer black bags.");

  service.updateCustomerMemory(chatId, memories[0].id, { text: "客户希望称呼她为 Lena。", pinned: true });
  await service.organizeConversationMemory(chatId, { force: true });
  memories = store.listCustomerMemories(chatId, { includeDisabled: true });
  assert.equal(memories.some((item) => item.source === "human-edited" && item.pinned && /Lena/.test(item.text)), true);
  assert.equal(memories.some((item) => item.source === "ai" && /中号包/.test(item.text)), true);
  assert.match(new Store(root).getConversationMemory(chatId).historySummary, /日常包/);
});

test("自动提炼记忆注入回复上下文时保持未核实，人工记忆保持已确认", async (t) => {
  const { store, service } = fixture(t);
  const providerChatId = "memory-trust@c.us";
  const chatId = conversationKey("primary", providerChatId);
  store.upsertContact(chatId, { accountId: "primary", accountName: "Manos Amy", providerChatId, profileName: "Memory trust" });
  store.updateAccountStyle("primary", { status: "ready", progress: 100, summary: "Use concise English.", rules: [], persona: { gender: "female", business: "Fashion", tone: "friendly", personality: "patient", completed: true } });
  store.createCustomerMemory(chatId, { type: "preference", text: "AI inferred preference", source: "ai", sourceMessageIds: ["source-a"] });
  store.createCustomerMemory(chatId, { type: "note", text: "Human confirmed note", source: "human" });
  store.updateConversationMemory(chatId, { status: "ready", currentScene: "Customer is comparing options.", historySummary: "An ongoing product discussion." });
  let receivedHistory = [];
  service.ai.decide = async (_contact, history) => {
    receivedHistory = history;
    return { action: "reply", reply: "Certainly, dear. I can show you more options.", reason: "continue", confidence: 0.9 };
  };
  await service.ingest({ id: "trust-question", accountId: "primary", accountName: "Manos Amy", chatId: providerChatId, profileName: "Memory trust", type: "text", body: "Can you show me some other styles?", createdAt: Date.now() });
  const automatic = receivedHistory.find((item) => item.body === "AI inferred preference");
  const human = receivedHistory.find((item) => item.body === "Human confirmed note");
  assert.equal(automatic.metadata.verifiedByHuman, false);
  assert.equal(human.metadata.verifiedByHuman, true);
  assert.equal(receivedHistory.some((item) => item.metadata?.source === "conversation-summary"), true);
});

test("客户动态按需聚合消息、自动处理、报价和记忆且限制返回数量", (t) => {
  const { store, service } = fixture(t);
  const chatId = conversationKey("primary", "activity@c.us");
  store.upsertContact(chatId, { accountId: "primary", providerChatId: "activity@c.us", profileName: "动态客户" });
  store.addMessage({ id: "activity-message", chatId, accountId: "primary", direction: "inbound", type: "text", body: "I need black shoes in size 42", createdAt: Date.now(), metadata: { automationState: "handoff", automationAt: Date.now(), automationReason: "需要确认尺码" } });
  service.createCustomerMemory(chatId, { type: "requirement", text: "客户需要黑色 42 码鞋" });
  const insights = service.getConversationInsights(chatId, 20);
  assert.equal(insights.signals.languageName, "英语");
  assert.equal(insights.signals.topics.includes("鞋类"), true);
  assert.equal(insights.context.customMemoryCount, 1);
  assert.equal(insights.activities.some((item) => item.category === "message"), true);
  assert.equal(insights.activities.some((item) => item.category === "automation"), true);
  assert.equal(insights.activities.some((item) => item.category === "memory"), true);
  assert.equal(insights.activities.length <= 20, true);
});

test("智能体可跨账号复用，复制后可独立编辑并持久化", (t) => {
  const { root, store } = fixture(t);
  store.updateAccountStyle("account-a", {
    status: "ready",
    progress: 100,
    summary: "Warm, concise English sales replies.",
    rules: [{ id: "manual-agent-rule", source: "manual", enabled: true, text: "We sell clothing and accessories." }],
    persona: {
      gender: "female",
      business: "Fashion products",
      tone: "warm and professional",
      personality: "patient and proactive",
      completed: true
    }
  });
  const sourceStyle = store.getAccountStyle("account-a");
  const sourceAgent = store.getAgent(sourceStyle.agentId);
  const clone = store.createAgent({ copyFromAgentId: sourceAgent.id, name: "备用销售智能体" });

  store.bindAccountAgent("account-b", sourceAgent.id);
  assert.equal(store.getAccountStyle("account-b").summary, "Warm, concise English sales replies.");
  store.updateAccountStyle("account-b", { summary: "Shared style update." });
  assert.equal(store.getAccountStyle("account-a").summary, "Shared style update.");

  store.bindAccountAgent("account-b", clone.id);
  store.updateAccountStyle("account-b", { summary: "Independent cloned style." });
  assert.equal(store.getAccountStyle("account-a").summary, "Shared style update.");
  assert.equal(new Store(root).getAccountStyle("account-b").summary, "Independent cloned style.");
  assert.throws(() => store.deleteAgent(sourceAgent.id), /正被/);
});
