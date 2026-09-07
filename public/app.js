const state = {
  view: "inbox",
  status: null,
  conversations: [],
  selectedChatId: "",
  active: null,
  filter: "all",
  search: "",
  quotes: [],
  quoteFilter: "pending",
  quoteDrafts: {},
  exchangeRates: { rates: { EUR: 0.13, USD: 0.14, GBP: 0.11 }, date: "", source: "本地备用汇率", fallback: true },
  settings: null,
  refreshTimer: null,
  translationBusy: false,
  translationPending: new Set(),
  translationFailed: new Set(),
  onboardingPrompted: new Set(),
  pendingAttachments: [],
  inspectorTab: "overview",
  activityFilter: "all",
  inspectorCache: new Map(),
  inspectorRequest: null,
  memoryOrganizeRequests: new Set()
};
const TRANSLATION_VERSION = 3;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const supplierImageUrl = (value) => /^https?:\/\//i.test(String(value || "")) ? `/api/supplier-image?url=${encodeURIComponent(value)}` : "";
const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
};

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  $("#toastStack").appendChild(item);
  setTimeout(() => item.remove(), 3600);
}

function time(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function relativeTime(value) {
  const delta = Date.now() - Number(value || 0);
  if (delta < 60000) return "刚刚";
  if (delta < 3600000) return `${Math.floor(delta / 60000)}分钟前`;
  if (delta < 86400000) return time(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function avatarText(name) {
  return String(name || "客").trim().slice(0, 1).toUpperCase();
}

function availableAgents() {
  return state.status?.agents || [];
}

function agentById(agentId) {
  return availableAgents().find((agent) => agent.id === agentId) || null;
}

function accountDisplayName(accountId) {
  const account = (state.status?.session?.accounts || []).find((item) => item.accountId === accountId);
  return account?.account?.name || account?.label || accountId;
}

function showView(view) {
  state.view = view;
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}View`));
  $$(".nav-button[data-view]").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  if (view === "quotes") loadQuotes();
  if (view === "settings") loadSettings();
  if (view === "insights") renderAccountStyles();
}

async function loadStatus() {
  const payload = await api("/api/status");
  state.status = payload;
  renderStatus();
  return payload;
}

function renderStatus() {
  const payload = state.status;
  if (!payload) return;
  const session = payload.session || {};
  const connected = Number(session.readyCount || 0) > 0;
  const accounts = session.accounts || [];
  const pill = $("#connectionButton");
  pill.className = `connection-pill ${session.status || "offline"}`;
  $("#connectionText").textContent = connected ? `${session.readyCount} 个账号在线` : ({ qr: "等待扫码", starting: "正在启动", syncing: "同步历史中", authenticated: "登录成功", error: "连接异常" }[session.status] || "WhatsApp 未连接");
  $("#aiDot").className = payload.ai?.ok ? "ok" : "bad";
  $("#aiStatusText").textContent = payload.ai?.ok ? `本地模型 · ${payload.ai.model || "在线"}` : "本地模型离线";
  $("#metricAi").textContent = payload.ai?.ok ? "运行中" : "离线";
  $("#metricAiDetail").textContent = `${payload.ai?.provider || "—"} · ${payload.ai?.model || "—"}`;
  $("#metricMessages").textContent = payload.stats?.messages || 0;
  $("#metricHuman").textContent = payload.stats?.humanNeeded || 0;
  $("#metricQuotes").textContent = payload.stats?.pendingQuotes || 0;
  $("#navQuoteBadge").textContent = payload.stats?.pendingQuotes || 0;
  $("#navQuoteBadge").classList.toggle("hidden", !(payload.stats?.pendingQuotes > 0));
  $("#syncButton").disabled = !connected;
  $("#accountSummary").textContent = `${accounts.length} 个账号 · ${session.readyCount || 0} 个在线`;
  $("#connectionDetail").innerHTML = `<strong>聚合收件箱</strong> · 每个号码绑定一个可复用智能体，并保留自己的登录、开关和消息队列。`;
  const stateNames = { ready: "已连接", qr: "等待扫码", syncing: "同步中", starting: "启动中", authenticated: "已认证", offline: "离线", error: "异常" };
  $("#accountList").innerHTML = accounts.map((account) => {
    const sync = account.sync || {};
    const percent = sync.total ? Math.round((sync.completed || 0) / sync.total * 100) : 0;
    const name = account.account?.name || account.label || account.accountId;
    const accountIdText = account.account?.id || account.message || "尚未登录";
    const qr = account.qrDataUrl ? `<img class="account-qr" src="${account.qrDataUrl}" alt="${escapeHtml(name)} 登录二维码"><div class="account-qr-hint">手机 WhatsApp → 已关联设备 → 关联设备</div>` : "";
    const progress = account.status === "syncing" || sync.total ? `<div class="account-progress"><i style="width:${percent}%"></i></div><div class="account-qr-hint">${escapeHtml(sync.mode || "历史同步")} · ${sync.completed || 0}/${sync.total || 0} 会话 · ${sync.imported || 0} 条</div>` : "";
    const connectAction = ["offline", "error"].includes(account.status) ? `<button data-account-action="connect" data-account-id="${escapeHtml(account.accountId)}">重新连接</button>` : "";
    const readAction = account.status === "ready" ? `<button class="sync" data-account-action="read-records" data-account-id="${escapeHtml(account.accountId)}">读取记录</button>` : "";
    const style = account.style || {};
    const persona = style.persona || {};
    const automation = account.automation || {};
    const automationNames = { off: "已关闭", idle: "等待消息", preparing: "准备中", running: "回复中", pausing: "暂停中", waiting_connection: "等待连接", waiting_style: "等待智能体配置" };
    const queueStatus = automation.current
      ? `<span>正在回复 <b>${escapeHtml(automation.current.contactName)}</b></span><span>下一位 <b>${escapeHtml(automation.next?.contactName || "暂无")}</b></span>`
      : `<span>${automation.pendingCount ? `待回复 <b>${Number(automation.pendingCount)} 位客户</b>` : "当前没有待回复客户"}</span>`;
    const automationMini = `<div class="account-automation-mini"><div class="account-automation-row"><div><strong>智能体接管</strong><span>${escapeHtml(automationNames[automation.status] || "已关闭")} · 队列 ${Number(automation.pendingCount || 0)}</span></div><label class="account-ai-switch" title="${persona.completed ? "开启后按队列顺序自动回复" : "请先完善智能体资料"}"><input type="checkbox" data-account-automation data-account-id="${escapeHtml(account.accountId)}" ${automation.enabled ? "checked" : ""} ${account.status === "ready" && (persona.completed || automation.enabled) ? "" : "disabled"}><i></i></label></div><div class="account-queue-mini">${queueStatus}</div></div>`;
    const agentMini = `<div class="account-profile-mini ${persona.completed ? "complete" : "incomplete"}"><div><strong>智能体 · ${escapeHtml(style.agentName || "未配置")}</strong><span>${persona.completed ? `${escapeHtml(persona.tone)} · ${escapeHtml(persona.personality)}${style.sharedAccountCount > 1 ? ` · ${style.sharedAccountCount} 个号复用` : ""}` : "请补充业务、语气和性格后再开启接管"}</span></div><button data-account-action="configure-profile" data-account-id="${escapeHtml(account.accountId)}">管理智能体</button></div>`;
    return `<article class="account-card"><div class="account-card-head"><span class="account-icon">W</span><span class="account-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(accountIdText)}</span></span><span class="account-state ${escapeHtml(account.status)}">${escapeHtml(stateNames[account.status] || account.status)}</span></div>${progress}${qr}${agentMini}${automationMini}<div class="account-actions">${connectAction}${readAction}<button class="remove" data-account-action="remove" data-account-id="${escapeHtml(account.accountId)}">退出并移除</button></div></article>`;
  }).join("") || `<div class="list-empty">还没有 WhatsApp 账号</div>`;
  renderAccountQueues();
  renderAccountStyles();
  const needsSetup = accounts.find((account) => account.status === "ready" && !account.style?.persona?.completed && !state.onboardingPrompted.has(account.accountId));
  if (needsSetup && $("#modal").classList.contains("hidden")) {
    state.onboardingPrompted.add(needsSetup.accountId);
    setTimeout(() => openAccountProfile(needsSetup.accountId), 180);
  }
}

function renderAccountQueues() {
  const board = $("#accountQueueBoard");
  if (!board) return;
  const accounts = state.status?.session?.accounts || [];
  const agents = availableAgents();
  if (!accounts.length) {
    board.innerHTML = `<div class="quote-empty">扫码接入 WhatsApp 后，可为每个号码选择一个智能体。</div>`;
    return;
  }
  const statusNames = { off: "智能体已关闭", idle: "智能体在线 · 等待消息", preparing: "正在理解上下文", running: "正在回复", pausing: "当前完成后暂停", waiting_connection: "等待 WhatsApp 连接", waiting_style: "等待智能体配置" };
  board.innerHTML = accounts.map((account) => {
    const automation = account.automation || {};
    const style = account.style || {};
    const persona = style.persona || {};
    const agent = agentById(style.agentId) || style;
    const name = account.account?.name || account.label || account.accountId;
    const current = automation.current;
    const next = automation.next;
    const items = automation.items || [];
    const queueItems = items.length ? items.slice(0, 6).map((item, index) => `<div class="queue-person"><span>${index + 1}</span><div><strong>${escapeHtml(item.contactName)}</strong><small>${escapeHtml(item.preview)}</small></div><time>${escapeHtml(relativeTime(item.createdAt))}${item.messageCount > 1 ? ` · 合并 ${item.messageCount} 条` : ""}</time></div>`).join("") : `<div class="queue-empty">暂无等待中的客户消息</div>`;
    const last = automation.lastProcessedAt ? `最近完成：${escapeHtml(automation.lastContactName || "客户")} · ${escapeHtml(relativeTime(automation.lastProcessedAt))}` : "尚未执行过自动回复";
    const options = agents.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === style.agentId ? "selected" : ""}>${escapeHtml(item.name)}${item.accountCount > 1 ? ` · ${item.accountCount} 个号复用` : ""}</option>`).join("");
    return `<article class="account-queue-card ${automation.enabled ? "enabled" : "disabled"}" data-queue-account="${escapeHtml(account.accountId)}">
      <div class="queue-card-head"><div class="queue-card-identity"><span class="account-icon">W</span><div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(account.account?.id || account.accountId)} · ${account.status === "ready" ? "WhatsApp 在线" : "等待连接"}</span></div></div><div class="queue-master-control"><span><b>${escapeHtml(statusNames[automation.status] || "智能体已关闭")}</b><small>${persona.completed ? `${Number(automation.pendingCount || 0)} 位等待 · ${Number(automation.rawMessageCount || 0)} 条消息` : "请先完善绑定智能体"}</small></span><label class="account-ai-switch large" title="智能体接管总开关"><input type="checkbox" data-account-automation data-account-id="${escapeHtml(account.accountId)}" ${automation.enabled ? "checked" : ""} ${account.status === "ready" && (persona.completed || automation.enabled) ? "" : "disabled"}><i></i></label></div></div>
      <div class="agent-assignment"><span class="agent-avatar">${escapeHtml(avatarText(agent.name || "智能体"))}</span><div class="agent-assignment-copy"><span>当前智能体</span><strong>${escapeHtml(agent.name || "未配置智能体")}</strong><small>${escapeHtml(agent.description || persona.business || "尚未补充业务说明")}</small></div><label><span>更换 / 复用</span><select data-agent-binding data-account-id="${escapeHtml(account.accountId)}" ${agents.length ? "" : "disabled"}>${options}</select></label></div>
      <div class="queue-flow"><div class="queue-now ${current ? "active" : ""}"><span>正在回复</span><strong>${escapeHtml(current?.contactName || (automation.enabled ? "等待新消息" : "开关未开启"))}</strong><p>${escapeHtml(current?.preview || "开启后会从队列第一位开始")}</p></div><div class="queue-arrow">→</div><div class="queue-next"><span>下一位</span><strong>${escapeHtml(next?.contactName || "暂无")}</strong><p>${escapeHtml(next?.preview || "队列已处理完")}</p></div></div>
      <div class="queue-list-head"><span>等待队列</span><small>${automation.mergedCount ? `已智能合并 ${Number(automation.mergedCount)} 条连续消息` : last}</small></div><div class="queue-people">${queueItems}</div>
      ${automation.lastError ? `<p class="queue-error">${escapeHtml(automation.lastError)}</p>` : ""}
      <div class="queue-card-actions"><button data-account-action="edit-agent" data-account-id="${escapeHtml(account.accountId)}">编辑智能体</button><button data-account-action="clone-agent" data-account-id="${escapeHtml(account.accountId)}">复制为独立智能体</button><button data-account-action="read-records" data-account-id="${escapeHtml(account.accountId)}" ${account.status === "ready" ? "" : "disabled"}>读取记录并学习</button></div>
    </article>`;
  }).join("");
}

function renderAccountStyles() {
  const board = $("#accountStyleBoard");
  if (!board) return;
  const agents = availableAgents();
  const accounts = state.status?.session?.accounts || [];
  if (!agents.length) {
    board.innerHTML = `<div class="quote-empty">还没有智能体。新建一个后，可配置人物、业务、语气、性格和回复规则。</div>`;
    return;
  }
  const styleNames = { ready: "可使用", analyzing: "正在学习", needs_input: "待完善", error: "学习失败", pending: "待完善" };
  board.innerHTML = agents.map((agent) => {
    const persona = agent.persona || {};
    const boundNames = (agent.accountIds || []).map(accountDisplayName);
    const enabledRules = (agent.rules || []).filter((rule) => rule.enabled !== false).length;
    const gender = ({ female: "女性形象", male: "男性形象", neutral: "中性形象" })[persona.gender] || "形象未设定";
    return `<article class="style-card agent-card" data-agent-id="${escapeHtml(agent.id)}"><div class="style-card-head"><div class="style-card-identity"><span class="agent-avatar">${escapeHtml(avatarText(agent.name))}</span><div><strong>${escapeHtml(agent.name)}</strong><span>${escapeHtml(agent.description || "可复用销售智能体")}</span></div></div><span class="style-state ${escapeHtml(agent.status || "pending")}">${escapeHtml(styleNames[agent.status] || "待完善")}</span></div><div class="agent-chip-row"><span>${escapeHtml(gender)}</span><span>${escapeHtml(persona.tone || "语气未设定")}</span><span>${enabledRules} 条规则</span><span>${Number(agent.sampleCount || 0)} 条历史样本</span></div><div class="agent-card-content"><div><span>业务与角色</span><p>${escapeHtml(persona.business || "尚未填写主营业务")}</p></div><div><span>回复风格</span><p>${escapeHtml(agent.summary || persona.personality || "尚未形成回复风格")}</p></div></div><div class="agent-bound-row"><span>已绑定</span><div>${boundNames.length ? boundNames.map((name) => `<b>${escapeHtml(name)}</b>`).join("") : `<small>暂未绑定账号</small>`}</div></div><div class="style-card-actions agent-card-actions"><button class="reanalyze" data-agent-action="clone" type="button">复制</button><button class="agent-delete" data-agent-action="delete" type="button" ${agent.accountCount ? "disabled" : ""}>删除</button><button class="save-style" data-agent-action="edit" type="button">编辑智能体</button></div></article>`;
  }).join("");
}

async function loadConversations() {
  const params = new URLSearchParams({ filter: state.filter });
  if (state.search) params.set("q", state.search);
  const payload = await api(`/api/conversations?${params}`);
  state.conversations = payload.conversations || [];
  renderConversations();
  if (state.selectedChatId && !state.active) await selectConversation(state.selectedChatId);
}

function renderConversations() {
  $("#conversationCount").textContent = `${state.conversations.length} 个客户`;
  const list = $("#conversationList");
  if (!state.conversations.length) {
    list.innerHTML = `<div class="list-empty">暂无会话<br><small>扫码连接后会自动出现 WhatsApp 客户</small></div>`;
    return;
  }
  list.innerHTML = state.conversations.map((contact) => {
    const flags = [
      contact.queuedMessages ? `<span class="mini-tag queued">排队 ${Number(contact.queuedMessages)}</span>` : "",
      contact.pendingQuotes ? `<span class="mini-tag">待报价</span>` : "",
      (contact.needsHuman || contact.mode === "human") ? `<span class="mini-tag">待跟进</span>` : ""
    ].filter(Boolean).join("");
    return `<button class="conversation-item ${state.selectedChatId === contact.chatId ? "active" : ""}" data-chat-id="${escapeHtml(contact.chatId)}">
      <span class="avatar">${escapeHtml(avatarText(contact.profileName))}</span>
      <span class="conversation-copy"><span class="conversation-name-row"><strong>${escapeHtml(contact.profileName)}</strong><time>${escapeHtml(relativeTime(contact.lastMessageAt))}</time></span><span class="conversation-preview"><span class="account-mini">${escapeHtml(contact.accountName || "账号")}</span><span class="message-preview">${escapeHtml(contact.lastMessagePreview || "暂无消息")}</span>${flags}</span></span>
      ${contact.unread ? `<span class="unread-dot">${contact.unread > 99 ? "99+" : contact.unread}</span>` : ""}
    </button>`;
  }).join("");
  $$(".conversation-item", list).forEach((button) => button.addEventListener("click", () => selectConversation(button.dataset.chatId)));
}

async function selectConversation(chatId) {
  if (state.selectedChatId && state.selectedChatId !== chatId) clearAttachment();
  if (state.selectedChatId !== chatId) state.translationFailed.clear();
  state.selectedChatId = chatId;
  renderConversations();
  const payload = await api(`/api/conversations/${encodeURIComponent(chatId)}/messages?limit=200`);
  state.active = payload;
  renderActiveConversation();
  await loadConversations();
}

function needsChineseTranslation(text) {
  const value = String(text || "").trim();
  if (!value || !/[A-Za-z]{2}/.test(value) || /^(?:https?:\/\/|www\.)\S+$/i.test(value)) return false;
  const hanCount = (value.match(/[\p{Script=Han}]/gu) || []).length;
  const latinCount = (value.match(/[A-Za-z]/g) || []).length;
  return latinCount > Math.max(3, hanCount * 1.5);
}

function translatableMessageText(message) {
  if (!message || !["text", "image", "video"].includes(message.type)) return "";
  const body = String(message.body || "").trim();
  if (["image", "video"].includes(message.type)
    && /^(?:\[(?:客户发送|历史|发送)?(?:图片|视频|image|video)\]|(?:图片|视频|image|video))$/i.test(body)) return "";
  return needsChineseTranslation(body) ? body : "";
}

function translationMarkup(message) {
  if (!translatableMessageText(message)) return "";
  const translation = Number(message.metadata?.translationVersion || 0) >= TRANSLATION_VERSION
    ? String(message.metadata?.zhTranslation || "").trim()
    : "";
  const label = ["image", "video"].includes(message.type) ? "媒体文字 · 中文" : "中文";
  if (translation) return `<div class="message-translation"><span>${label}</span><div>${escapeHtml(translation).replace(/\n/g, "<br>")}</div></div>`;
  const key = `${state.selectedChatId}::${message.id}`;
  if (state.translationFailed.has(key)) {
    return `<div class="message-translation pending"><span>${label}</span><button data-retry-translation="${escapeHtml(message.id)}" type="button">翻译失败，点击重试</button></div>`;
  }
  return `<div class="message-translation pending"><span>${label}</span><div>仅翻译文字说明，本地翻译生成中…</div></div>`;
}

async function queueMessageTranslations(messages) {
  if (state.translationBusy || !state.selectedChatId) return;
  const chatId = state.selectedChatId;
  const missing = [...messages].reverse().filter((message) => {
    const key = `${chatId}::${message.id}`;
    return Boolean(translatableMessageText(message))
      && Number(message.metadata?.translationVersion || 0) < TRANSLATION_VERSION && !state.translationFailed.has(key);
  }).slice(0, 6);
  if (!missing.length) return;
  state.translationBusy = true;
  missing.forEach((message) => state.translationPending.add(`${chatId}::${message.id}`));
  try {
    const payload = await api(`/api/conversations/${encodeURIComponent(chatId)}/translations`, {
      method: "POST",
      body: JSON.stringify({ messageIds: missing.map((message) => message.id) })
    });
    if (state.selectedChatId === chatId && state.active) {
      const translated = new Map((payload.messages || []).map((message) => [message.id, message]));
      state.active.messages = state.active.messages.map((message) => translated.get(message.id) || message);
      renderMessages(state.active.messages);
    }
  } catch (error) {
    missing.forEach((message) => state.translationFailed.add(`${chatId}::${message.id}`));
    if (state.selectedChatId === chatId && state.active) renderMessages(state.active.messages);
  } finally {
    missing.forEach((message) => state.translationPending.delete(`${chatId}::${message.id}`));
    state.translationBusy = false;
    if (state.selectedChatId === chatId && state.active) setTimeout(() => queueMessageTranslations(state.active.messages), 80);
  }
}

function renderActiveConversation() {
  const data = state.active;
  if (!data?.contact) {
    $("#emptyChat").classList.remove("hidden");
    $("#activeChat").classList.add("hidden");
    $("#emptyInspector").classList.remove("hidden");
    $("#activeInspector").classList.add("hidden");
    return;
  }
  const contact = data.contact;
  $("#emptyChat").classList.add("hidden");
  $("#activeChat").classList.remove("hidden");
  $("#emptyInspector").classList.add("hidden");
  $("#activeInspector").classList.remove("hidden");
  ["#activeAvatar", "#inspectorAvatar"].forEach((id) => $(id).textContent = avatarText(contact.profileName));
  $("#activeName").textContent = contact.profileName;
  $("#activeAccountName").textContent = contact.accountName || "账号";
  $("#activePhone").textContent = contact.phone || contact.providerChatId?.replace(/@.+$/, "") || "—";
  $("#inspectorName").textContent = contact.profileName;
  $("#inspectorPhone").textContent = contact.phone || contact.providerChatId?.replace(/@.+$/, "") || "—";
  $("#inspectorAccount").textContent = contact.accountName || contact.accountId || "—";
  $("#customerLabels").innerHTML = (contact.labels || []).map((label) => `<span>${escapeHtml(label)}</span>`).join("") || `<span>WhatsApp</span>`;
  const manualLock = contact.mode === "human";
  const temporaryHandoff = contact.needsHuman && !manualLock;
  const accountAutomation = (state.status?.session?.accounts || []).find((account) => account.accountId === contact.accountId)?.automation || {};
  $("#modeToggle").checked = manualLock;
  $("#modeLabel").textContent = manualLock ? "人工持续接管" : temporaryHandoff ? "本条待人工" : accountAutomation.enabled ? "会话自动" : "账号 AI 已关";
  $("#modeToggle").closest(".mode-toggle").classList.toggle("account-off", !manualLock && !accountAutomation.enabled);
  $("#modeStatusTag").textContent = manualLock ? "人工持续接管" : temporaryHandoff ? "当前问题待人工" : accountAutomation.enabled ? "AI 自动" : "排队暂停";
  $("#modeStatusTag").classList.toggle("human", manualLock || temporaryHandoff);
  const handoffMessage = temporaryHandoff ? data.messages.find((message) => message.id === contact.handoffMessageId) : null;
  const handoffPreview = String(handoffMessage?.body || "当前问题").replace(/\s+/g, " ").slice(0, 36);
  $("#sendHint").textContent = temporaryHandoff
    ? `将回复待人工问题：${handoffPreview}${handoffMessage?.body?.length > 36 ? "…" : ""}；发送后恢复自动`
    : manualLock ? "发送后解除持续人工并恢复自动" : "人工回复会作为高可信记忆（报价除外）";
  $("#handoffReason").textContent = contact.escalationReason || "";
  $("#handoffReason").classList.toggle("hidden", !contact.escalationReason);
  $("#historyCount").textContent = `${data.messages.length} 条`;
  const pending = (data.quotes || []).filter((quote) => ["pending", "approved"].includes(quote.status));
  $("#contactQuoteCount").textContent = `${pending.length} 条`;
  $("#contactQuotes").innerHTML = pending.length ? pending.map((quote) => `<div class="contact-quote"><strong><span>#${quote.id}</span><span>${Number(quote.suggestedPrice || 0) > 0 ? `${escapeHtml(quote.currency)} ${Number(quote.suggestedPrice).toFixed(2)}` : "待询问工厂"}</span></strong><p>${escapeHtml(quote.error || quote.draftReply)}</p><button data-review-quote="${quote.id}">审核并编辑</button></div>`).join("") : `<div class="small-copy">暂无待审报价</div>`;
  $$('[data-review-quote]', $("#contactQuotes")).forEach((button) => button.addEventListener("click", () => { showView("quotes"); state.quoteFilter = "all"; $("#quoteFilter").value = "all"; loadQuotes(button.dataset.reviewQuote); }));
  renderMessages(data.messages || []);
  showInspectorTab(state.inspectorTab);
}

function showInspectorTab(tab = "overview", force = false) {
  const next = ["overview", "memory", "activity"].includes(tab) ? tab : "overview";
  state.inspectorTab = next;
  $$('[data-inspector-tab]').forEach((button) => button.classList.toggle("active", button.dataset.inspectorTab === next));
  $$('[data-inspector-panel]').forEach((panel) => panel.classList.toggle("hidden", panel.dataset.inspectorPanel !== next));
  if (next !== "overview" && state.selectedChatId) {
    loadInspectorInsights(force).then((payload) => {
      if (next === "memory" && payload) maybeStartMemoryOrganization(payload);
    });
  }
}

async function loadInspectorInsights(force = false) {
  const chatId = state.selectedChatId;
  if (!chatId) return;
  const cached = state.inspectorCache.get(chatId);
  if (!force && cached && Date.now() - cached.loadedAt < 15000) {
    renderInspectorInsights(cached.payload);
    return cached.payload;
  }
  if (state.inspectorRequest?.chatId === chatId) return state.inspectorRequest.promise;
  const promise = api(`/api/conversations/${encodeURIComponent(chatId)}/insights?limit=80`)
    .then((payload) => {
      state.inspectorCache.set(chatId, { payload, loadedAt: Date.now() });
      if (state.selectedChatId === chatId) renderInspectorInsights(payload);
      return payload;
    })
    .catch((error) => {
      if (state.selectedChatId === chatId) {
        const target = state.inspectorTab === "memory" ? $("#customerMemoryList") : $("#activityList");
        if (target) target.innerHTML = `<div class="inspector-loading">${escapeHtml(error.message)}</div>`;
      }
      return null;
    })
    .finally(() => {
      if (state.inspectorRequest?.chatId === chatId) state.inspectorRequest = null;
    });
  state.inspectorRequest = { chatId, promise };
  return promise;
}

function renderInspectorInsights(payload) {
  renderMemoryPanel(payload);
  renderActivityPanel(payload);
}

function renderMemoryPanel(payload) {
  const summary = payload.memorySummary || {};
  const signals = payload.signals || {};
  const context = payload.context || {};
  const progress = Math.max(0, Math.min(100, Number(summary.progress) || 0));
  const statusNames = { idle: "尚未整理", dirty: "有新消息", organizing: "正在整理…", ready: "已整理", error: "整理失败" };
  const status = statusNames[summary.status] || "尚未整理";
  $("#memoryStatus").innerHTML = `<span>${escapeHtml(status)}</span><b>${progress}%</b>`;
  $("#memoryStatus").className = `memory-status ${escapeHtml(summary.status || "idle")}`;
  $("#memoryProgressBar").style.width = `${progress}%`;
  $("#memoryProgressLabel").textContent = summary.error || summary.progressLabel || "点击整理记忆，使用本地模型读取历史会话";
  const organizeButton = $("#organizeMemory");
  organizeButton.disabled = summary.status === "organizing";
  organizeButton.textContent = summary.status === "organizing" ? "整理中…" : summary.currentScene ? "重新整理" : "整理记忆";
  if (summary.status !== "organizing") state.memoryOrganizeRequests.delete(state.selectedChatId);
  const currentScene = $("#memoryCurrentScene");
  const historySummary = $("#memoryHistorySummary");
  if (document.activeElement !== currentScene) currentScene.value = summary.currentScene || "";
  if (document.activeElement !== historySummary) historySummary.value = summary.historySummary || "";
  $("#memorySummaryMeta").textContent = summary.updatedAt
    ? `${summary.manuallyEdited ? "含人工修改 · " : ""}${relativeTime(summary.updatedAt)}更新 · 已读 ${Number(summary.messageCount) || 0} 条`
    : "整理后可直接编辑";
  $("#memoryRuntime").innerHTML = [
    [context.messageCount || 0, "本次上下文消息"],
    [context.relatedOlderCount || 0, "翻阅到的较早记录"],
    [context.customMemoryCount || 0, "启用的客户记忆"],
    [context.learnedCount || 0, "相关人工经验"]
  ].map(([value, label]) => `<div><strong>${Number(value)}</strong><span>${label}</span></div>`).join("");
  const signalItems = [
    signals.stage ? { text: signals.stage, className: "stage" } : null,
    signals.languageName ? { text: `常用 ${signals.languageName}`, className: "" } : null,
    ...(signals.topics || []).map((text) => ({ text, className: "" }))
  ].filter(Boolean);
  $("#memorySignals").innerHTML = signalItems.map((item) => `<span class="${item.className}">${escapeHtml(item.text)}</span>`).join("") || `<span>尚无足够对话线索</span>`;
  const typeNames = { requirement: "客户需求", preference: "偏好", identity: "客户资料", relationship: "关系信息", logistics: "物流信息", event: "故事事件", note: "客服备注" };
  const memories = payload.memories || [];
  $("#customerMemoryCount").textContent = String(memories.length);
  $("#customerMemoryList").innerHTML = memories.length ? memories.map((memory) => `<article class="customer-memory ${memory.enabled === false ? "disabled" : ""} ${memory.pinned ? "pinned" : ""}" data-memory-id="${escapeHtml(memory.id)}" data-pinned="${memory.pinned ? "true" : "false"}">
    <div class="customer-memory-head"><select data-memory-type aria-label="记忆类型">${Object.entries(typeNames).map(([value, label]) => `<option value="${value}" ${memory.type === value ? "selected" : ""}>${label}</option>`).join("")}</select><span class="memory-source-tag ${escapeHtml(memory.source || "human")}">${memory.source === "ai" ? "自动整理" : memory.source === "human-edited" ? "人工校正" : "人工记忆"}</span><label><input data-memory-enabled type="checkbox" ${memory.enabled === false ? "" : "checked"}>用于 AI</label></div>
    <textarea data-memory-text rows="2" maxlength="500">${escapeHtml(memory.text)}</textarea>
    ${(memory.sourceMessages || []).length ? `<details class="memory-sources"><summary>查看来源原文 · ${memory.sourceMessages.length} 条</summary>${memory.sourceMessages.map((source) => `<div><b>${source.direction === "inbound" ? "客户" : "客服"}</b><span>${escapeHtml(source.body || `[${source.type === "video" ? "视频" : "图片"}]`)}</span><time>${relativeTime(source.createdAt)}</time></div>`).join("")}</details>` : ""}
    <div class="customer-memory-actions"><small>${relativeTime(memory.updatedAt)}更新${memory.source === "ai" ? ` · 可信度 ${Math.round((Number(memory.confidence) || 0) * 100)}%` : ""}</small><div><button data-memory-action="pin" class="memory-pin" type="button">${memory.pinned ? "取消置顶" : "置顶"}</button><button data-memory-action="save" type="button">保存</button><button data-memory-action="delete" class="delete" type="button">删除</button></div></div>
  </article>`).join("") : `<div class="inspector-loading">还没有重要记忆。点击“整理记忆”，本地模型会从有依据的历史消息中提炼。</div>`;
  const learned = payload.learned || [];
  $("#learnedMemoryCount").textContent = String(learned.length);
  $("#learnedMemoryList").innerHTML = learned.length ? learned.map((item) => `<article class="learned-memory"><b>问：${escapeHtml(item.question)}</b><span>答：${escapeHtml(item.answer)}</span><small>${item.chatId === state.selectedChatId ? "来自本客户人工回复" : "来自同账号人工经验"}${item.score ? ` · 相关度 ${item.score}` : ""}</small></article>`).join("") : `<div class="inspector-loading">暂无与最近问题相关的人工回复经验</div>`;
}

function maybeStartMemoryOrganization(payload) {
  const summary = payload.memorySummary || {};
  if (!["idle", "dirty"].includes(summary.status || "idle")) return;
  startMemoryOrganization(false);
}

async function startMemoryOrganization(force = true) {
  const chatId = state.selectedChatId;
  if (!chatId || state.memoryOrganizeRequests.has(chatId)) return;
  state.memoryOrganizeRequests.add(chatId);
  try {
    await api(`/api/conversations/${encodeURIComponent(chatId)}/memory/organize`, { method: "POST", body: JSON.stringify({ force }) });
    state.inspectorCache.delete(chatId);
    await loadInspectorInsights(true);
  } catch (error) {
    state.memoryOrganizeRequests.delete(chatId);
    toast(error.message, "error");
  }
}

async function saveMemorySummary() {
  const chatId = state.selectedChatId;
  if (!chatId) return;
  const button = $("#saveMemorySummary");
  button.disabled = true;
  try {
    await api(`/api/conversations/${encodeURIComponent(chatId)}/memory/summary`, {
      method: "PATCH",
      body: JSON.stringify({ currentScene: $("#memoryCurrentScene").value, historySummary: $("#memoryHistorySummary").value })
    });
    state.inspectorCache.delete(chatId);
    await loadInspectorInsights(true);
    toast("故事连续性已保存，后续回复会参考它");
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

function activityTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? time(value) : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function renderActivityPanel(payload) {
  const all = payload.activities || [];
  const rows = state.activityFilter === "all" ? all : all.filter((item) => item.category === state.activityFilter);
  $("#activityCount").textContent = String(rows.length);
  const badgeNames = { ai: "AI 自动", human: "人工", "human-memory": "人工记忆", queued: "排队中", processing: "生成中", replied: "已回复", handoff: "需人工", quote_pending: "报价待审", superseded: "已合并", failed: "失败", "quote-review": "审核报价", "quote-rejected": "缺货通知", "customer-memory": "客户记忆" };
  $("#activityList").innerHTML = rows.length ? rows.map((item) => `<article class="activity-item ${escapeHtml(item.direction || "")} ${escapeHtml(item.category || "")}"><div class="activity-item-head"><b>${escapeHtml(item.title)}</b><time>${activityTime(item.createdAt)}</time></div>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}${item.badge ? `<em>${escapeHtml(badgeNames[item.badge] || item.badge)}</em>` : ""}</article>`).join("") : `<div class="inspector-loading">这个分类暂时没有动态</div>`;
}

async function saveCustomerMemory(event) {
  event.preventDefault();
  if (!state.selectedChatId) return;
  const text = $("#memoryText").value.trim();
  if (!text) return;
  const button = $("#memoryForm button[type=submit]");
  button.disabled = true;
  try {
    await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/memories`, { method: "POST", body: JSON.stringify({ type: $("#memoryType").value, text }) });
    $("#memoryText").value = "";
    state.inspectorCache.delete(state.selectedChatId);
    await loadInspectorInsights(true);
    toast("客户记忆已保存，后续本地 AI 回复会参考它");
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

async function handleMemoryAction(event) {
  const button = event.target.closest("[data-memory-action]");
  if (!button || !state.selectedChatId) return;
  const card = button.closest("[data-memory-id]");
  const memoryId = card?.dataset.memoryId;
  if (!memoryId) return;
  button.disabled = true;
  try {
    if (button.dataset.memoryAction === "delete") {
      await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/memories/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
      toast("客户记忆已删除");
    } else if (button.dataset.memoryAction === "pin") {
      await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/memories/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: card.dataset.pinned !== "true" })
      });
      toast(card.dataset.pinned === "true" ? "已取消置顶" : "重要记忆已置顶");
    } else {
      await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/memories/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        body: JSON.stringify({ text: $("[data-memory-text]", card).value, type: $("[data-memory-type]", card).value, enabled: $("[data-memory-enabled]", card).checked })
      });
      toast("客户记忆已更新");
    }
    state.inspectorCache.delete(state.selectedChatId);
    await loadInspectorInsights(true);
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
}

function renderMessages(messages) {
  const list = $("#messageList");
  let day = "";
  const html = [];
  const messageById = new Map(messages.map((message) => [String(message.id), message]));
  for (const [index, message] of messages.entries()) {
    const nextDay = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(message.createdAt));
    if (nextDay !== day) { day = nextDay; html.push(`<div class="day-divider"><span>${escapeHtml(day)}</span></div>`); }
    const sourceLabel = ({ ai: "AI", "identity-policy": "客服身份", "customer-care": "关怀回复", "account-rule": "账号规则", "human-memory": "人工记忆", "quote-review": "审核报价", "quote-rejected": "缺货通知", "lead-welcome": "询盘欢迎", "new-customer-welcome": "新客欢迎", "album-follow-up": "相册跟进", "factory-inquiry": "询问工厂", "supplier-specification": "货源规格" })[message.metadata?.source];
    const source = sourceLabel ? `<span class="source-badge">${sourceLabel}</span>` : "";
    const automationState = message.metadata?.automationState || "";
    const automationLabel = ({ queued: "排队中", processing: "生成中", replied: "已回复", handoff: "需人工", quote_pending: "报价待审", dismissed: "报价已删除", superseded: "已合并", failed: "失败" })[automationState] || "";
    const automation = automationLabel ? `<span class="automation-badge ${escapeHtml(automationState)}" title="${escapeHtml(message.metadata?.automationReason || "")}">${automationLabel}</span>` : "";
    const hasLaterOutbound = messages.slice(index + 1).some((item) => item.direction === "outbound" && (!item.replyToId || item.replyToId === message.id));
    const hasUsableContent = message.type === "text" || (message.type === "image" && Boolean(message.mediaUrl));
    const canAiReply = message.direction === "inbound" && hasUsableContent && !hasLaterOutbound && !["processing", "replied", "quote_pending"].includes(automationState);
    const replyButton = canAiReply ? `<button class="ai-reply-button" data-ai-reply="${escapeHtml(message.id)}" title="让本地 AI 结合本会话历史生成并发送回复">↩ AI 回复</button>` : "";
    const media = message.mediaUrl && /^\/media\//.test(message.mediaUrl)
      ? message.type === "video"
        ? `<video src="${escapeHtml(message.mediaUrl)}" controls preload="metadata" playsinline aria-label="聊天视频"></video>`
        : `<img src="${escapeHtml(message.mediaUrl)}" alt="聊天图片" loading="lazy">`
      : ["image", "video"].includes(message.type)
        ? `<button class="media-recover" data-load-media="${escapeHtml(message.id)}" data-media-kind="${message.type}"><span>${message.type === "video" ? "▶" : "▧"}</span><b>${message.type === "video" ? "视频" : "图片"}尚未加载</b><small>点击从 WhatsApp 重新读取</small></button>`
        : "";
    const replyTarget = message.replyToId ? messageById.get(String(message.replyToId)) : null;
    const replyPreviewText = replyTarget
      ? `${replyTarget.type === "image" ? "[图片] " : replyTarget.type === "video" ? "[视频] " : ""}${String(replyTarget.body || "").trim()}`.trim()
      : "";
    const replyReference = replyPreviewText
      ? `<div class="reply-reference" title="${escapeHtml(replyPreviewText)}"><b>回复</b>${escapeHtml(replyPreviewText.length > 70 ? `${replyPreviewText.slice(0, 70)}…` : replyPreviewText)}</div>`
      : "";
    html.push(`<div class="message-row ${message.direction}"><div class="message-bubble">${replyReference}${media}<div>${escapeHtml(message.body).replace(/\n/g, "<br>")}</div>${translationMarkup(message)}<div class="message-meta">${source}${automation}<span>${time(message.createdAt)}</span>${message.direction === "outbound" ? `<span>${message.status === "read" ? "✓✓" : "✓"}</span>` : ""}</div>${replyButton ? `<div class="message-ai-actions">${replyButton}</div>` : ""}</div></div>`);
  }
  list.innerHTML = html.join("") || `<div class="list-empty">暂无消息</div>`;
  $$('[data-ai-reply]', list).forEach((button) => button.addEventListener("click", () => replyWithAi(button.dataset.aiReply, button)));
  $$('[data-load-media]', list).forEach((button) => button.addEventListener("click", () => recoverMessageMedia(button.dataset.loadMedia, button)));
  $$('[data-retry-translation]', list).forEach((button) => button.addEventListener("click", () => {
    state.translationFailed.delete(`${state.selectedChatId}::${button.dataset.retryTranslation}`);
    renderMessages(state.active?.messages || []);
  }));
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  queueMessageTranslations(messages);
}

async function recoverMessageMedia(messageId, button) {
  if (!state.selectedChatId || !messageId) return;
  const mediaName = button.dataset.mediaKind === "video" ? "视频" : "图片";
  button.disabled = true;
  button.querySelector("b").textContent = `正在读取${mediaName}…`;
  try {
    await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/messages/${encodeURIComponent(messageId)}/media`, { method: "POST" });
    await selectConversation(state.selectedChatId);
    toast(`${mediaName}已加载`);
  } catch (error) {
    button.disabled = false;
    button.querySelector("b").textContent = "重新读取失败";
    button.querySelector("small").textContent = error.message;
    toast(error.message, "error");
  }
}

async function replyWithAi(messageId, button) {
  if (!state.selectedChatId || !messageId) return;
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const response = await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/ai-reply`, {
      method: "POST",
      body: JSON.stringify({ messageId })
    });
    const result = response.result || {};
    if (result.state === "replied") toast("本地 AI 已发送回复");
    else if (result.state === "quote_pending") toast("商品图片已进入报价审核");
    else if (result.state === "handoff") toast(result.reason || "该问题需要人工处理，未自动发送", "error");
    else toast(result.reason || "该消息已处理");
    await selectConversation(state.selectedChatId);
  } catch (error) {
    toast(error.message, "error");
    button.disabled = false;
    button.textContent = "↩ AI 回复";
  }
}

async function sendMessage() {
  const input = $("#messageInput");
  const body = input.value.trim();
  const attachments = [...state.pendingAttachments];
  if ((!body && !attachments.length) || !state.selectedChatId) return;
  $("#sendButton").disabled = true;
  try {
    const payload = attachments.length
      ? await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/media`, {
          method: "POST",
          body: JSON.stringify({
            items: attachments.map(({ data, mimeType, filename }) => ({ data, mimeType, filename })),
            caption: body
          })
        })
      : await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/messages`, { method: "POST", body: JSON.stringify({ body }) });
    if (attachments.length && payload.failed) {
      const sentCount = Number(payload.messages?.length || 0);
      removeSentAttachments(sentCount);
      if (sentCount) input.value = "";
      toast(`已发送 ${sentCount}/${attachments.length} 个，第 ${Number(payload.failed.index) + 1} 个失败：${payload.failed.message}`, "error");
    } else {
      input.value = "";
      clearAttachments();
      toast(attachments.length ? `${payload.messages?.length || attachments.length} 个附件已按顺序发送` : payload.learned ? "人工回复已发送并加入本地问答记忆，后续相似问题可自动回复" : payload.resumed ? "人工回复已发送，会话已恢复自动；价格内容不会自动学习" : "人工回复已发送");
    }
    await selectConversation(state.selectedChatId);
  } catch (error) { toast(error.message, "error"); }
  finally { $("#sendButton").disabled = false; }
}

function readableFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function clearAttachments() {
  state.pendingAttachments.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
  state.pendingAttachments = [];
  const input = $("#attachmentInput");
  if (input) input.value = "";
  renderAttachmentPreview();
}

function clearAttachment() {
  clearAttachments();
}

function removeSentAttachments(count) {
  const sent = state.pendingAttachments.splice(0, Math.max(0, Number(count) || 0));
  sent.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
  renderAttachmentPreview();
}

function removeAttachment(id) {
  const index = state.pendingAttachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [removed] = state.pendingAttachments.splice(index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  const preview = $("#attachmentPreview");
  if (!preview) return;
  if (!state.pendingAttachments.length) {
    preview.innerHTML = "";
    preview.classList.add("hidden");
    return;
  }
  const totalSize = state.pendingAttachments.reduce((sum, item) => sum + Number(item.size || 0), 0);
  preview.innerHTML = `<div class="attachment-preview-head"><b>待发送 ${state.pendingAttachments.length} 个</b><span>合计 ${readableFileSize(totalSize)} · 按从左到右顺序发送</span><button type="button" data-clear-attachments>全部移除</button></div><div class="attachment-preview-strip">${state.pendingAttachments.map((item, index) => {
    const isVideo = item.mimeType.startsWith("video/");
    return `<article class="attachment-item" title="第 ${index + 1} 个发送"><span class="attachment-order">${index + 1}</span>${isVideo ? `<video src="${escapeHtml(item.previewUrl)}" muted playsinline preload="metadata"></video>` : `<img src="${escapeHtml(item.previewUrl)}" alt="附件预览">`}<div class="attachment-info"><b>${escapeHtml(item.filename)}</b><small>${isVideo ? "视频" : "图片"} · ${readableFileSize(item.size)}</small></div><button type="button" data-remove-attachment="${escapeHtml(item.id)}" aria-label="移除 ${escapeHtml(item.filename)}">×</button></article>`;
  }).join("")}</div>`;
  preview.classList.remove("hidden");
  preview.querySelector("[data-clear-attachments]")?.addEventListener("click", clearAttachments);
  preview.querySelectorAll("[data-remove-attachment]").forEach((button) => button.addEventListener("click", () => removeAttachment(button.dataset.removeAttachment)));
}

function attachmentMimeType(file) {
  const direct = String(file?.type || "").toLowerCase().split(";")[0];
  if (direct) return direct;
  const extension = String(file?.name || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v" })[extension] || "";
}

function transferredFiles(transfer) {
  const files = [...(transfer?.files || [])];
  if (files.length) return files;
  return [...(transfer?.items || [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
}

function handleMediaTransfer(event, source = "粘贴") {
  const files = transferredFiles(event.clipboardData || event.dataTransfer);
  if (!files.length) return false;
  event.preventDefault();
  const mediaFiles = files.filter((item) => /^(?:image|video)\//.test(attachmentMimeType(item)));
  if (!mediaFiles.length) {
    toast("剪贴板或拖入内容不是支持的图片/视频", "error");
    return true;
  }
  readAttachments(mediaFiles, source);
  if (mediaFiles.length < files.length) toast(`已忽略 ${files.length - mediaFiles.length} 个非图片/视频文件`);
  return true;
}

async function pasteAttachmentFromClipboard() {
  const button = $("#pasteAttachmentButton");
  button.disabled = true;
  try {
    if (!navigator.clipboard?.read) throw new Error("当前浏览器不支持直接读取剪贴板");
    const clipboardItems = await navigator.clipboard.read();
    const files = [];
    for (const item of clipboardItems) {
      const mimeType = (item.types || []).find((type) => /^(?:image|video)\//.test(type));
      if (!mimeType) continue;
      const blob = await item.getType(mimeType);
      const extension = ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-m4v": ".m4v" })[mimeType] || "";
      files.push(new File([blob], `剪贴板${mimeType.startsWith("video/") ? "视频" : "图片"}-${Date.now()}-${files.length + 1}${extension}`, { type: mimeType }));
    }
    if (!files.length) throw new Error("剪贴板中没有图片或视频");
    await readAttachments(files, "从剪贴板读取");
  } catch (error) {
    $("#messageInput").focus();
    toast(`${error.message}；也可在输入框按 Ctrl+V 或把文件拖进来`, "error");
  } finally {
    button.disabled = false;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name || "附件"}`));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

async function readAttachments(files, source = "选择") {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);
  const maxCount = 10;
  const maxBytes = 35 * 1024 * 1024;
  const available = Math.max(0, maxCount - state.pendingAttachments.length);
  const candidates = [...files].slice(0, available);
  let totalBytes = state.pendingAttachments.reduce((sum, item) => sum + Number(item.size || 0), 0);
  let added = 0;
  let skipped = Math.max(0, files.length - candidates.length);
  for (const file of candidates) {
    const mimeType = attachmentMimeType(file);
    if (!allowed.has(mimeType) || !file.size || totalBytes + file.size > maxBytes) {
      skipped += 1;
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const previewUrl = URL.createObjectURL(file);
      state.pendingAttachments.push({
        id: `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        data: dataUrl.replace(/^data:[^;]+;base64,/i, ""),
        mimeType,
        filename: file.name || `${mimeType.startsWith("video/") ? "粘贴视频" : "粘贴图片"}-${Date.now()}${mimeType === "video/mp4" ? ".mp4" : ".png"}`,
        size: file.size,
        previewUrl
      });
      totalBytes += file.size;
      added += 1;
    } catch (_error) {
      skipped += 1;
    }
  }
  renderAttachmentPreview();
  $("#attachmentInput").value = "";
  $("#messageInput").focus();
  if (added) toast(`${added} 个附件已${source}，当前共 ${state.pendingAttachments.length} 个`);
  if (skipped) toast(`有 ${skipped} 个文件未加入；单批最多 10 个且合计不超过 35 MB`, "error");
}

async function translateComposer() {
  const input = $("#messageInput");
  const button = $("#translateComposer");
  const language = $("#replyLanguage").value;
  const original = input.value.trim();
  if (!original) return;
  button.disabled = true;
  button.textContent = "翻译中";
  input.classList.add("translating");
  try {
    const payload = await api("/api/translate", {
      method: "POST",
      body: JSON.stringify({ text: original, targetLanguage: language, chatId: state.selectedChatId })
    });
    if (input.value.trim() !== original) {
      toast("翻译已完成，但输入内容已变化，因此没有自动替换", "error");
      return;
    }
    input.value = payload.translation || original;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    const names = { en: "英语", fr: "法语", es: "西班牙语", de: "德语", it: "意大利语", pt: "葡萄牙语", ar: "阿拉伯语", ru: "俄语", ja: "日语", ko: "韩语" };
    toast(`已用本地模型替换为${names[payload.targetLanguage] || "客户语言"}，可检查后发送`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    input.classList.remove("translating");
    button.disabled = false;
    button.textContent = "中→EN";
  }
}

async function loadQuotes(focusId = "") {
  const [payload, exchangeRates] = await Promise.all([
    api(`/api/quotes?status=${encodeURIComponent(state.quoteFilter)}`),
    api("/api/exchange-rates")
  ]);
  state.quotes = payload.quotes || [];
  state.exchangeRates = exchangeRates;
  renderQuotes();
  if (focusId) requestAnimationFrame(() => document.querySelector(`[data-quote-card="${focusId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
}

function quoteStatusText(status) {
  return ({ pending: "待审核", approved: "发送失败/待重试", sent: "已发送", rejected: "已驳回" })[status] || status;
}

const quoteCurrencies = ["EUR", "USD", "GBP"];
const shippingOptions = [90, 150, 180, 300];
const quoteLanguages = ["zh", "en", "fr", "es", "de", "it", "pt", "ar", "ru", "ja", "ko"];
const quoteLanguageNames = { zh: "中文", en: "英语", fr: "法语", es: "西班牙语", de: "德语", it: "意大利语", pt: "葡萄牙语", ar: "阿拉伯语", ru: "俄语", ja: "日语", ko: "韩语" };

function clampProfitRate(value) {
  return Math.min(0.8, Math.max(0.7, Number(value) || 0.75));
}

function calculateQuote(basePriceCny, shippingCny, profitRate, currency) {
  const base = Math.max(0, Number(basePriceCny) || 0);
  const shipping = shippingOptions.includes(Number(shippingCny)) ? Number(shippingCny) : 90;
  const profit = clampProfitRate(profitRate);
  const targetCurrency = quoteCurrencies.includes(currency) ? currency : "USD";
  const exchangeRate = Number(state.exchangeRates?.rates?.[targetCurrency]) || 0;
  if (!(base > 0)) {
    return { basePriceCny: 0, shippingCny: shipping, profitRate: profit, profitCny: 0, subtotalCny: 0, currency: targetCurrency, exchangeRate, suggestedPrice: 0, rateDate: state.exchangeRates?.date || "" };
  }
  const profitCny = Math.round(base * profit * 100) / 100;
  const subtotalCny = Math.round((base + shipping + profitCny) * 100) / 100;
  return {
    basePriceCny: base,
    shippingCny: shipping,
    profitRate: profit,
    profitCny,
    subtotalCny,
    currency: targetCurrency,
    exchangeRate,
    suggestedPrice: Math.round(subtotalCny * exchangeRate),
    rateDate: state.exchangeRates?.date || ""
  };
}

function replaceQuoteAmount(text, currency, price) {
  const replacement = `${currency} ${Math.round(price)}`;
  const current = String(text || "").trim();
  if (/\b(?:CNY|EUR|USD|GBP)\s+\d+(?:\.\d+)?/i.test(current)) {
    return current.replace(/\b(?:CNY|EUR|USD|GBP)\s+\d+(?:\.\d+)?/i, replacement);
  }
  return `Dear, the final price for this product is about ${replacement}. How many pieces do you need?`;
}

function quoteFactDetails(facts, language = "en") {
  const details = [];
  if (facts?.color && facts?.material) details.push(language === "zh" ? `${facts.color.zh}${facts.material.zh}` : `${facts.color.en} ${facts.material.en}`);
  else if (facts?.color) details.push(facts.color[language]);
  else if (facts?.material) details.push(facts.material[language]);
  details.push(...(facts?.features || []).map((item) => item[language]).filter(Boolean));
  return details.filter(Boolean);
}

function finalQuoteReply(language, currency, price, facts = {}) {
  const amount = `${currency} ${Math.round(price)}`;
  if (language === "zh") {
    const size = facts?.dimensions ? `根据多个高度相似的货源描述，这款商品的参考尺寸是${facts.dimensions.zh}。` : "";
    const details = quoteFactDetails(facts, "zh");
    return `亲爱的，${size}${details.length ? `相似货源还一致标注了${details.join("、")}。` : ""}包含所选运费后的最终报价约为 ${amount}。${facts?.dimensions ? "不同批次可能有轻微差异，下单前我会再确认准确尺寸和规格。" : "最终以数量和规格确认为准。"}请问您需要多少件？`;
  }
  const size = facts?.dimensions ? `based on several closely matched supplier listings, the reference size is ${facts.dimensions.en}. ` : "";
  const details = quoteFactDetails(facts, "en");
  const description = details.length ? `${size ? "The" : "the"} matching descriptions also consistently indicate ${details.join(", ")}. ` : "";
  const finalLead = size || details.length ? "The final" : "the final";
  return `Dear, ${size}${description}${finalLead} price for this product, including the selected shipping fee, is about ${amount}. ${facts?.dimensions ? "Measurements can vary slightly by batch, so I will confirm the exact dimensions and specifications before the order." : "The final confirmation depends on quantity and specifications."} How many pieces do you need?`;
}

function factoryInquiryDraft(language) {
  return language === "zh" ? "好的亲爱的，我会询问一下工厂。" : "Okay dear, I’ll check with the factory for you.";
}

function quoteEditorValues(quote) {
  const saved = state.quoteDrafts[quote.id] || {};
  const basePriceCny = saved.basePriceCny ?? quote.basePriceCny ?? (quote.currency === "CNY" ? quote.suggestedPrice : 0);
  const shippingCny = saved.shippingCny ?? quote.shippingCny ?? 90;
  const profitRate = saved.profitRate ?? quote.profitRate ?? 0.75;
  const currency = quoteCurrencies.includes(saved.currency) ? saved.currency : (quoteCurrencies.includes(quote.currency) ? quote.currency : "USD");
  const calculation = calculateQuote(basePriceCny, shippingCny, profitRate, currency);
  const replyLanguage = ["auto", ...quoteLanguages].includes(saved.replyLanguage) ? saved.replyLanguage : (["auto", ...quoteLanguages].includes(quote.replyLanguage) ? quote.replyLanguage : "auto");
  const customerLanguage = quoteLanguages.includes(quote.customerLanguage) ? quote.customerLanguage : "en";
  const effectiveLanguage = replyLanguage === "auto" ? customerLanguage : replyLanguage;
  let draftReply = saved.draftReply ?? (Number(calculation.basePriceCny) > 0
    ? Number(quote.exchangeRate) > 0
      ? replaceQuoteAmount(quote.draftReply, calculation.currency, calculation.suggestedPrice)
      : finalQuoteReply(effectiveLanguage === "zh" ? "zh" : "en", calculation.currency, calculation.suggestedPrice, quote.productFacts)
    : quote.draftReply || factoryInquiryDraft(effectiveLanguage));
  let draftLanguage = saved.draftLanguage || quote.draftLanguage || detectQuoteDraftLanguage(draftReply);
  if (["pending", "approved"].includes(quote.status)
    && Number(calculation.basePriceCny) > 0
    && !saved.draftReply
    && ["zh", "en"].includes(effectiveLanguage)
    && draftLanguage !== effectiveLanguage) {
    draftReply = finalQuoteReply(effectiveLanguage, calculation.currency, calculation.suggestedPrice, quote.productFacts);
    draftLanguage = effectiveLanguage;
  }
  if (["pending", "approved"].includes(quote.status)
    && !(Number(calculation.basePriceCny) > 0)
    && !saved.draftReply
    && ["zh", "en"].includes(effectiveLanguage)
    && draftLanguage !== effectiveLanguage) {
    draftReply = factoryInquiryDraft(effectiveLanguage);
    draftLanguage = effectiveLanguage;
  }
  return {
    ...calculation,
    replyLanguage,
    customerLanguage,
    effectiveLanguage,
    draftLanguage,
    draftReply,
    reviewerNote: saved.reviewerNote ?? (quote.reviewerNote || "")
  };
}

function detectQuoteDraftLanguage(text) {
  const value = String(text || "").toLowerCase();
  if (/[\u0600-\u06ff]/u.test(value)) return "ar";
  if (/[\u0400-\u04ff]/u.test(value)) return "ru";
  if (/[\u3040-\u30ff]/u.test(value)) return "ja";
  if (/[\uac00-\ud7af]/u.test(value)) return "ko";
  if (/[\p{Script=Han}]/u.test(value)) return "zh";
  if (/\b(?:bonjour|merci|vous|votre|chère|prix)\b/iu.test(value)) return "fr";
  if (/\b(?:hola|gracias|usted|precio|querida)\b/iu.test(value)) return "es";
  if (/\b(?:hallo|danke|preis|bitte)\b/iu.test(value)) return "de";
  if (/\b(?:buongiorno|grazie|prezzo)\b/iu.test(value)) return "it";
  if (/\b(?:olá|obrigad[oa]|preço)\b/iu.test(value)) return "pt";
  return "en";
}

function quoteLanguageOptions(selected, customerLanguage) {
  const autoName = quoteLanguageNames[customerLanguage] || "英语";
  return `<option value="auto" ${selected === "auto" ? "selected" : ""}>自动·客户语言（${autoName}）</option>${quoteLanguages.map((code) => `<option value="${code}" ${selected === code ? "selected" : ""}>${quoteLanguageNames[code]}</option>`).join("")}`;
}

function currencyOptions(selected) {
  return quoteCurrencies.map((code) => `<option value="${code}" ${selected === code ? "selected" : ""}>${({ EUR: "欧元 EUR", USD: "美元 USD", GBP: "英镑 GBP" })[code]}</option>`).join("");
}

function shippingSelectOptions(selected) {
  return shippingOptions.map((price) => `<option value="${price}" ${Number(selected) === price ? "selected" : ""}>CNY ${price}</option>`).join("");
}

function renderQuotes() {
  const board = $("#quoteBoard");
  if (!state.quotes.length) { board.innerHTML = `<div class="quote-empty">当前筛选下没有报价</div>`; return; }
  board.innerHTML = state.quotes.map((quote) => {
    const editable = ["pending", "approved"].includes(quote.status);
    const editor = quoteEditorValues(quote);
    const legacySent = quote.status === "sent" && !(Number(quote.exchangeRate) > 0);
    if (legacySent) editor.draftReply = quote.draftReply;
    const image = quote.imageMediaUrl && /^\/media\//.test(quote.imageMediaUrl) ? `<img class="quote-image" src="${escapeHtml(quote.imageMediaUrl)}" alt="询价图片">` : `<div class="quote-image">图片待加载</div>`;
    const quoteContact = state.conversations.find((item) => item.chatId === quote.chatId);
    const priced = Number(editor.basePriceCny || 0) > 0;
    const allProducts = quote.products || [];
    const productFacts = quote.productFacts || {};
    const inquiryStatus = quote.acknowledgementSentMessageId
      ? "已告知客户：好的亲爱的，我会询问一下工厂"
      : quote.acknowledgementDeferred
        ? "待人工询厂；为避免越过客户后续消息，未自动发送询厂话术"
        : "待人工询厂";
    const products = allProducts.slice(0, 8);
    const productCards = products.length ? products.map((product) => {
      const productImageUrl = supplierImageUrl(product.imageUrl);
      const productImage = productImageUrl ? `<img src="${escapeHtml(productImageUrl)}" alt="搜图候选" loading="lazy">` : `<span class="product-image-empty">无图</span>`;
      const candidatePrice = Number(product.suggestedPrice || 0);
      const productFact = product.facts?.dimensions?.zh ? `规格：${product.facts.dimensions.zh}` : "";
      const description = String(product.description || "").trim();
      return `<article class="supplier-product">${productImage}<div><strong>${escapeHtml(product.title || "微店同款")}</strong><span>${Number(product.cost || 0) > 0 ? `货源价 ${escapeHtml(product.currency || "CNY")} ${Number(product.cost).toFixed(2)}` : "未提供价格"}</span>${productFact ? `<p class="supplier-product-fact">${escapeHtml(productFact)}</p>` : ""}${description ? `<p class="supplier-product-description" title="${escapeHtml(description)}">${escapeHtml(description)}</p>` : ""}</div>${candidatePrice > 0 && editable ? `<button data-use-product-price="${candidatePrice}">设为基础价 CNY ${candidatePrice.toFixed(2)}</button>` : ""}</article>`;
    }).join("") : `<div class="supplier-empty">共享货源没有返回相似商品</div>`;
    return `<article class="quote-card" data-quote-card="${quote.id}">
      ${image}
      <div class="quote-summary"><h3>${quote.quoteType === "factory_inquiry" ? "询厂任务" : "报价"} #${quote.id}</h3><p>${escapeHtml(quoteContact?.profileName || quote.chatId.split("::").at(-1).replace(/@.+$/, ""))} · ${escapeHtml(quoteContact?.accountName || "账号")} · ${relativeTime(quote.createdAt)}</p><div class="price ${priced ? "" : "missing"}">${priced ? `${escapeHtml(legacySent ? quote.currency : editor.currency)} ${legacySent ? Number(quote.suggestedPrice) : editor.suggestedPrice}` : "暂无货源价"}</div><p data-quote-formula>${priced ? `${legacySent ? `历史实际发送 ${escapeHtml(quote.currency)} ${Number(quote.suggestedPrice)}；新版试算：` : ""}CNY ${editor.basePriceCny} + 运费 ${editor.shippingCny} + 利润 ${editor.profitCny} = CNY ${editor.subtotalCny}` : escapeHtml(inquiryStatus)}</p>${productFacts.dimensions?.zh ? `<p class="quote-facts"><b>货源规格归集</b>${escapeHtml(productFacts.dimensions.zh)} · ${Number(productFacts.dimensions.evidenceCount || 1)} 条高相似结果一致</p>` : ""}<p data-rate-label>1 CNY = ${editor.exchangeRate} ${escapeHtml(editor.currency)} · ${escapeHtml(state.exchangeRates.source || "实时汇率")}${state.exchangeRates.fallback ? "（备用）" : ""}</p><p>${escapeHtml(quote.supplier || "微店共享货源")} · ${allProducts.length} 个候选</p>${quote.error ? `<p class="quote-error">${escapeHtml(quote.error)}</p>` : ""}</div>
      <div class="quote-editor" data-draft-language="${escapeHtml(editor.draftLanguage)}"><div class="quote-calculator"><label>基础价（CNY）<input data-field="basePriceCny" data-calc-field type="number" min="0" step="0.01" value="${editor.basePriceCny}" ${editable ? "" : "disabled"}></label><label>运费类型<select data-field="shippingCny" data-calc-field ${editable ? "" : "disabled"}>${shippingSelectOptions(editor.shippingCny)}</select></label><label>利润率（70%–80%）<input data-field="profitPercent" data-calc-field type="number" min="70" max="80" step="1" value="${Math.round(editor.profitRate * 100)}" ${editable ? "" : "disabled"}></label><label>报价币种<select data-field="currency" data-calc-field ${editable ? "" : "disabled"}>${currencyOptions(editor.currency)}</select></label><label>回复语言<select data-field="replyLanguage" data-quote-language ${editable ? "" : "disabled"}>${quoteLanguageOptions(editor.replyLanguage, editor.customerLanguage)}</select></label><label class="final-price-field">最终报价（四舍五入）<input data-field="suggestedPrice" type="number" value="${editor.suggestedPrice}" readonly></label></div><textarea data-field="draftReply" rows="3" ${editable ? "" : "disabled"}>${escapeHtml(editor.draftReply)}</textarea><input data-field="reviewerNote" placeholder="审核备注（客户不可见）" value="${escapeHtml(editor.reviewerNote)}" ${editable ? "" : "disabled"}></div>
      <div class="quote-actions">${editable ? `<button class="search" data-quote-action="search">重新搜图</button><button class="save" data-quote-action="save">保存修改</button><button class="approve" data-quote-action="approve">审核并发送</button><button class="reject" data-quote-action="reject">驳回</button>` : `<div class="quote-status">${escapeHtml(quoteStatusText(quote.status))}</div>`}<button class="delete" data-quote-action="delete">删除报价</button></div>
      <div class="supplier-results"><div class="supplier-results-head"><strong>微店搜图结果</strong><span>${priced ? "选择候选基础价后，再选择运费、利润和币种" : "无价格，已转人工询厂"}</span></div><div class="supplier-product-list">${productCards}</div></div>
    </article>`;
  }).join("");
  $$('[data-field]', board).forEach((field) => field.addEventListener("input", () => {
    const card = field.closest("[data-quote-card]");
    if (field.hasAttribute("data-calc-field")) recalculateQuoteCard(card);
    state.quoteDrafts[card.dataset.quoteCard] = quotePatch(card);
  }));
  $$('[data-quote-action]', board).forEach((button) => button.addEventListener("click", () => handleQuoteAction(button.closest("[data-quote-card]"), button.dataset.quoteAction)));
  $$('[data-quote-language]', board).forEach((select) => select.addEventListener("change", () => translateQuoteLanguage(select.closest("[data-quote-card]"), select)));
  $$('[data-use-product-price]', board).forEach((button) => button.addEventListener("click", () => {
    const card = button.closest("[data-quote-card]");
    const nextPrice = Number(button.dataset.useProductPrice);
    card.querySelector('[data-field="basePriceCny"]').value = nextPrice;
    recalculateQuoteCard(card);
    toast("已带入候选基础价，并重新计算最终报价");
  }));
}

function recalculateQuoteCard(card) {
  const calculation = calculateQuote(
    $("[data-field='basePriceCny']", card).value,
    $("[data-field='shippingCny']", card).value,
    Number($("[data-field='profitPercent']", card).value) / 100,
    $("[data-field='currency']", card).value
  );
  $("[data-field='suggestedPrice']", card).value = calculation.suggestedPrice;
  const priceLabel = $(".quote-summary .price", card);
  priceLabel.classList.toggle("missing", !(calculation.basePriceCny > 0));
  priceLabel.textContent = calculation.basePriceCny > 0 ? `${calculation.currency} ${calculation.suggestedPrice}` : "暂无货源价";
  if (calculation.basePriceCny > 0) $("[data-quote-formula]", card).textContent = `CNY ${calculation.basePriceCny} + 运费 ${calculation.shippingCny} + 利润 ${calculation.profitCny} = CNY ${calculation.subtotalCny}`;
  $("[data-rate-label]", card).textContent = `1 CNY = ${calculation.exchangeRate} ${calculation.currency} · ${state.exchangeRates.source || "实时汇率"}${state.exchangeRates.fallback ? "（备用）" : ""}`;
  const reply = $("[data-field='draftReply']", card);
  if (calculation.basePriceCny > 0) reply.value = replaceQuoteAmount(reply.value, calculation.currency, calculation.suggestedPrice);
  state.quoteDrafts[card.dataset.quoteCard] = quotePatch(card);
}

function quotePatch(card) {
  const draftReply = $("[data-field='draftReply']", card).value.trim();
  return {
    suggestedPrice: Number($("[data-field='suggestedPrice']", card).value),
    currency: $("[data-field='currency']", card).value.trim(),
    basePriceCny: Number($("[data-field='basePriceCny']", card).value),
    shippingCny: Number($("[data-field='shippingCny']", card).value),
    profitRate: Number($("[data-field='profitPercent']", card).value) / 100,
    exchangeRate: Number(state.exchangeRates?.rates?.[$("[data-field='currency']", card).value]) || 0,
    rateDate: state.exchangeRates?.date || "",
    replyLanguage: $("[data-field='replyLanguage']", card).value,
    draftLanguage: detectQuoteDraftLanguage(draftReply),
    draftReply,
    reviewerNote: $("[data-field='reviewerNote']", card).value.trim()
  };
}

async function translateQuoteLanguage(card, select) {
  const id = card.dataset.quoteCard;
  select.disabled = true;
  card.classList.add("language-busy");
  try {
    const payload = await api(`/api/quotes/${id}/language`, { method: "POST", body: JSON.stringify(quotePatch(card)) });
    delete state.quoteDrafts[id];
    const language = payload.quote.replyLanguage === "auto" ? payload.quote.customerLanguage : payload.quote.replyLanguage;
    toast(`报价 #${id} 已转换为${quoteLanguageNames[language] || "客户语言"}，尚未发送`);
    await loadQuotes(id);
  } catch (error) {
    select.disabled = false;
    card.classList.remove("language-busy");
    toast(error.message, "error");
  }
}

async function handleQuoteAction(card, action) {
  const id = card.dataset.quoteCard;
  const patch = quotePatch(card);
  try {
    if (action === "search") {
      await api(`/api/quotes/${id}/search`, { method: "POST" });
      toast(`报价 #${id} 已重新完成微店搜图`);
    } else if (action === "save") {
      await api(`/api/quotes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast(`报价 #${id} 已保存，尚未发送`);
    } else if (action === "approve") {
      const confirmed = await confirmModal("审核并发送报价", `确认将报价 #${id} 发送给客户？发送后不可撤回。`);
      if (!confirmed) return;
      await api(`/api/quotes/${id}/approve`, { method: "POST", body: JSON.stringify(patch) });
      toast(`报价 #${id} 已审核并发送`);
    } else if (action === "reject") {
      const confirmed = await confirmModal("驳回并通知缺货", `确认驳回报价 #${id}？系统会立即告诉客户：抱歉亲爱的，这款工厂告诉我暂时缺货。`);
      if (!confirmed) return;
      await api(`/api/quotes/${id}/reject`, { method: "POST", body: JSON.stringify({ reviewerNote: patch.reviewerNote }) });
      toast(`报价 #${id} 已驳回，并已通知客户暂时缺货`);
    } else if (action === "delete") {
      const confirmed = await confirmModal("删除报价记录", `确认删除报价 #${id}？这只会删除工作台中的报价记录，已经发送到 WhatsApp 的消息不会被撤回。`);
      if (!confirmed) return;
      await api(`/api/quotes/${id}`, { method: "DELETE" });
      toast(`报价 #${id} 已删除`);
    }
    delete state.quoteDrafts[id];
    await Promise.all([loadQuotes(), loadConversations(), loadStatus()]);
    if (state.selectedChatId) await selectConversation(state.selectedChatId);
  } catch (error) { toast(error.message, "error"); }
}

function confirmModal(title, copy) {
  return new Promise((resolve) => {
    $("#modalBody").innerHTML = `<h2 class="modal-title">${escapeHtml(title)}</h2><p class="modal-copy">${escapeHtml(copy)}</p><div class="modal-actions"><button class="ghost-button" data-modal-value="false">取消</button><button class="primary-button" data-modal-value="true">确认</button></div>`;
    $("#modal").classList.remove("hidden");
    const finish = (value) => { $("#modal").classList.add("hidden"); resolve(value); };
    $$('[data-modal-value]', $("#modalBody")).forEach((button) => button.addEventListener("click", () => finish(button.dataset.modalValue === "true"), { once: true }));
    $("#modalClose").onclick = () => finish(false);
  });
}

async function loadSettings() {
  const payload = await api("/api/settings");
  state.settings = payload.settings;
  const form = $("#settingsForm");
  for (const [key, value] of Object.entries(payload.settings || {})) {
    const input = form.elements[key];
    if (!input || value === undefined) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (input.type !== "password") input.value = value;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.ignoreGroups = form.elements.ignoreGroups.checked;
  ["contextMessageLimit", "historySyncLimit", "quoteMarkup"].forEach((key) => payload[key] = Number(payload[key]));
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
    $("#settingsHint").textContent = "已保存到本机";
    toast("设置已保存");
    await loadStatus();
  } catch (error) { toast(error.message, "error"); }
}

function openConnection() {
  $("#connectionPopover").classList.remove("hidden");
}

function agentRuleRow(rule = {}) {
  return `<div class="style-rule" data-agent-rule data-rule-id="${escapeHtml(rule.id || `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`)}" data-rule-source="${escapeHtml(rule.source || "manual")}"><input data-rule-enabled type="checkbox" ${rule.enabled === false ? "" : "checked"} aria-label="启用规则"><input data-rule-text value="${escapeHtml(rule.text || "")}" placeholder="例如：客户闲聊时先回应情绪，再自然推进需求"><button data-agent-rule-remove type="button" title="删除规则">×</button></div>`;
}

function openAgentEditor(agentId, options = {}) {
  $("#connectionPopover").classList.add("hidden");
  const agent = agentById(agentId);
  if (!agent) return toast("智能体不存在，请刷新后重试", "error");
  const persona = agent.persona || {};
  const boundNames = (agent.accountIds || []).map(accountDisplayName);
  const selected = (value) => persona.gender === value ? "selected" : "";
  const rules = (agent.rules || []).map(agentRuleRow).join("");
  const sharedNotice = agent.accountCount > 1 ? `修改会同步应用到 ${agent.accountCount} 个账号：${boundNames.join("、")}` : boundNames.length ? `当前绑定账号：${boundNames.join("、")}` : "这个智能体目前没有绑定账号";
  $(".modal-card").classList.add("agent-modal-card");
  $("#modalBody").innerHTML = `
    <div class="profile-onboarding agent-editor-modal">
      <span class="eyebrow">AGENT PROFILE</span>
      <h2 class="modal-title">编辑 ${escapeHtml(agent.name)}</h2>
      <p class="modal-copy">人物、业务知识、语气和历史风格统一保存在这里。${escapeHtml(sharedNotice)}</p>
      <form id="agentEditForm" class="profile-form agent-form">
        <label>智能体名称<input name="name" required value="${escapeHtml(agent.name)}" placeholder="例如：Amy · 欧美零售顾问"></label>
        <label>一句话定位<input name="description" value="${escapeHtml(agent.description || "")}" placeholder="例如：亲切耐心的鞋服销售顾问"></label>
        <label>客服性别 / 对外形象<select name="gender" required><option value="">请选择</option><option value="female" ${selected("female")}>女性客服</option><option value="male" ${selected("male")}>男性客服</option><option value="neutral" ${selected("neutral")}>中性客服形象</option></select></label>
        <label>回复语气<input name="tone" required value="${escapeHtml(persona.tone || "亲切、专业、自然")}" placeholder="例如：亲切、自然、有分寸"></label>
        <label class="wide">主营业务与事实边界<textarea name="business" required rows="4" placeholder="明确销售什么、公司定位、不能编造的事实…">${escapeHtml(persona.business || "")}</textarea></label>
        <label class="wide">客服性格<input name="personality" required value="${escapeHtml(persona.personality || "耐心、主动、善于追问客户需求")}" placeholder="例如：耐心、主动、简洁、有销售推进意识"></label>
        <label class="wide">从历史会话总结的表达方式<textarea name="summary" rows="4" placeholder="例如：跟随客户语言，先回应情绪，再简洁回答；每次只推进一个问题。">${escapeHtml(agent.summary || "")}</textarea></label>
        <div class="wide agent-rule-editor"><div class="style-rules-head"><span>补充规则与可复用知识</span><button data-agent-rule-add type="button">＋ 新增规则</button></div><div data-agent-rule-list class="style-rules">${rules || `<div class="small-copy" data-empty-agent-rules>暂无规则，可按需要新增</div>`}</div></div>
        <div class="modal-actions wide"><button class="ghost-button" type="button" data-agent-cancel>取消</button><button class="primary-button" type="submit">保存智能体</button></div>
      </form>
    </div>`;
  $("#modal").classList.remove("hidden");
  const close = () => { $("#modal").classList.add("hidden"); $(".modal-card").classList.remove("agent-modal-card"); };
  $("#modalClose").onclick = close;
  $("[data-agent-cancel]").addEventListener("click", close);
  $("[data-agent-rule-add]").addEventListener("click", () => {
    $("[data-empty-agent-rules]")?.remove();
    const list = $("[data-agent-rule-list]");
    list.insertAdjacentHTML("beforeend", agentRuleRow());
    $$('[data-rule-text]', list).at(-1)?.focus();
  });
  $("[data-agent-rule-list]").addEventListener("click", (event) => event.target.closest("[data-agent-rule-remove]")?.closest("[data-agent-rule]")?.remove());
  $("#agentEditForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
      name: data.name,
      description: data.description,
      summary: data.summary,
      status: data.summary ? "ready" : "needs_input",
      progress: data.summary ? 100 : Number(agent.progress || 0),
      progressLabel: data.summary ? "智能体设定已保存" : "可从账号历史记录继续学习",
      persona: { gender: data.gender, business: data.business, tone: data.tone, personality: data.personality },
      rules: $$('[data-agent-rule]', form).map((row) => ({ id: row.dataset.ruleId, source: row.dataset.ruleSource || "manual", enabled: $("[data-rule-enabled]", row).checked, text: $("[data-rule-text]", row).value.trim() })).filter((rule) => rule.text)
    };
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: "PUT", body: JSON.stringify(payload) });
      await loadStatus();
      close();
      toast(agent.accountCount > 1 ? `智能体已保存，并同步到 ${agent.accountCount} 个账号` : "智能体已保存并生效");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });
}

function openAccountProfile(accountId) {
  const account = (state.status?.session?.accounts || []).find((item) => item.accountId === accountId);
  if (!account?.style?.agentId) return toast("该账号还没有绑定智能体", "error");
  openAgentEditor(account.style.agentId, { accountId });
}

function openAccountStyle(accountId) {
  openAccountProfile(accountId);
}

function openCreateAgent() {
  const options = availableAgents().map((agent) => `<option value="${escapeHtml(agent.id)}">复制 ${escapeHtml(agent.name)} 的完整设定</option>`).join("");
  $(".modal-card").classList.remove("agent-modal-card");
  $("#modalBody").innerHTML = `<span class="eyebrow">NEW AGENT</span><h2 class="modal-title">新建智能体</h2><p class="modal-copy">可以从空白开始，也可以复制成熟智能体后只调整名称或业务。</p><form id="createAgentForm" class="profile-form"><label class="wide">智能体名称<input name="name" required placeholder="例如：Dora · 法语女装顾问"></label><label class="wide">创建方式<select name="copyFromAgentId"><option value="">空白智能体</option>${options}</select></label><label class="wide">一句话定位<input name="description" placeholder="例如：自然热情的法语零售顾问"></label><div class="modal-actions wide"><button class="ghost-button" data-create-agent-cancel type="button">取消</button><button class="primary-button" type="submit">创建并配置</button></div></form>`;
  $("#modal").classList.remove("hidden");
  const close = () => $("#modal").classList.add("hidden");
  $("#modalClose").onclick = close;
  $("[data-create-agent-cancel]").addEventListener("click", close);
  $("#createAgentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const result = await api("/api/agents", { method: "POST", body: JSON.stringify(data) });
      close();
      await loadStatus();
      toast("智能体已创建，继续完善后即可绑定账号");
      openAgentEditor(result.agent.id);
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  });
}

async function readAccountRecords(accountId, button) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    toast("正在读取聊天记录并分析该账号的语言风格…");
    await api(`/api/whatsapp/accounts/${encodeURIComponent(accountId)}/read-records`, { method: "POST", body: "{}" });
    toast("记录读取与语言风格分析完成");
    await Promise.all([loadStatus(), loadConversations()]);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

function scheduleRefresh(event) {
  let update = {};
  try {
    update = JSON.parse(event?.data || "{}");
    if (update.chatId) state.inspectorCache.delete(update.chatId);
  } catch (_) {}
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    try {
      await Promise.all([loadStatus(), loadConversations()]);
      if (state.selectedChatId) {
        const payload = await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/messages?limit=200`);
        state.active = payload;
        renderActiveConversation();
        if (["memory", "activity"].includes(state.inspectorTab) && (!update.chatId || update.chatId === state.selectedChatId)) await loadInspectorInsights(true);
      }
      if (state.view === "quotes") await loadQuotes();
    } catch (_) {}
  }, 250);
}

function bindEvents() {
  $$(".nav-button[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $$("[data-inspector-tab]").forEach((button) => button.addEventListener("click", () => showInspectorTab(button.dataset.inspectorTab)));
  $("#memoryForm").addEventListener("submit", saveCustomerMemory);
  $("#customerMemoryList").addEventListener("click", handleMemoryAction);
  $("#organizeMemory").addEventListener("click", () => startMemoryOrganization(true));
  $("#saveMemorySummary").addEventListener("click", saveMemorySummary);
  $("#rememberLatest").addEventListener("click", () => {
    const latest = [...(state.active?.messages || [])].reverse().find((message) => message.direction === "inbound" && message.type === "text" && message.body);
    if (!latest) return toast("该客户还没有可记住的文字需求", "error");
    $("#memoryType").value = "requirement";
    $("#memoryText").value = latest.body.slice(0, 500);
    $("#memoryText").focus();
    toast("已带入最近一条客户消息，请整理确认后保存");
  });
  $("#activityFilters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-activity-filter]");
    if (!button) return;
    state.activityFilter = button.dataset.activityFilter;
    $$("[data-activity-filter]", $("#activityFilters")).forEach((item) => item.classList.toggle("active", item === button));
    const payload = state.inspectorCache.get(state.selectedChatId)?.payload;
    if (payload) renderActivityPanel(payload);
  });
  $("#connectionButton").addEventListener("click", () => $("#connectionPopover").classList.toggle("hidden"));
  $$('[data-close-popover]').forEach((button) => button.addEventListener("click", () => $("#connectionPopover").classList.add("hidden")));
  $$('[data-open-connection]').forEach((button) => button.addEventListener("click", openConnection));
  $("#addAccountButton").addEventListener("click", async () => {
    try {
      await api("/api/whatsapp/accounts", { method: "POST", body: JSON.stringify({}) });
      await loadStatus();
      openConnection();
      toast("新账号二维码已生成");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#accountList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-account-action]");
    if (!button) return;
    const accountId = button.dataset.accountId;
    const action = button.dataset.accountAction;
    try {
      if (action === "manage-style") {
        openAccountStyle(accountId);
        return;
      } else if (action === "configure-profile") {
        openAccountProfile(accountId);
        return;
      } else if (action === "remove") {
        if (!await confirmModal("退出并移除账号", "确认解除该 WhatsApp Web 登录并从工作台移除？已保存的聊天记录不会删除。")) return;
        await api(`/api/whatsapp/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
        toast("账号已退出并移除");
      } else if (action === "read-records") {
        await readAccountRecords(accountId, button);
        return;
      } else {
        await api(`/api/whatsapp/accounts/${encodeURIComponent(accountId)}/connect`, { method: "POST", body: "{}" });
      }
      await Promise.all([loadStatus(), loadConversations()]);
    } catch (error) { toast(error.message, "error"); }
  });
  $("#accountQueueBoard").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-account-action]");
    if (!button) return;
    const accountId = button.dataset.accountId;
    const account = (state.status?.session?.accounts || []).find((item) => item.accountId === accountId);
    const action = button.dataset.accountAction;
    try {
      if (["manage-style", "configure-profile", "edit-agent"].includes(action)) openAccountProfile(accountId);
      else if (action === "read-records") await readAccountRecords(accountId, button);
      else if (action === "clone-agent") {
        button.disabled = true;
        const cloned = await api(`/api/agents/${encodeURIComponent(account.style.agentId)}/clone`, { method: "POST", body: JSON.stringify({ name: `${account.style.agentName || "智能体"} · ${account.account?.name || account.label || "账号"} 独立版` }) });
        await api(`/api/whatsapp/accounts/${encodeURIComponent(accountId)}/agent`, { method: "PUT", body: JSON.stringify({ agentId: cloned.agent.id }) });
        await loadStatus();
        toast("已复制为该账号的独立智能体，后续编辑不会影响原智能体");
        openAgentEditor(cloned.agent.id, { accountId });
      }
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  });
  document.addEventListener("change", async (event) => {
    const binding = event.target.closest?.("[data-agent-binding]");
    if (binding) {
      const previous = (state.status?.session?.accounts || []).find((item) => item.accountId === binding.dataset.accountId)?.style?.agentId || "";
      binding.disabled = true;
      try {
        await api(`/api/whatsapp/accounts/${encodeURIComponent(binding.dataset.accountId)}/agent`, { method: "PUT", body: JSON.stringify({ agentId: binding.value }) });
        await loadStatus();
        toast("账号已更换智能体；原有聊天记录和队列保持不变");
      } catch (error) {
        binding.value = previous;
        toast(error.message, "error");
      } finally { binding.disabled = false; }
      return;
    }
    const toggle = event.target.closest?.("[data-account-automation]");
    if (!toggle) return;
    const enabled = toggle.checked;
    toggle.disabled = true;
    try {
      await api(`/api/whatsapp/accounts/${encodeURIComponent(toggle.dataset.accountId)}/automation`, {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      });
      toast(enabled ? "智能体已接管该账号，开始按顺序处理回复队列" : "智能体接管已关闭，后续新消息只排队不发送");
      await Promise.all([loadStatus(), loadConversations()]);
      if (state.selectedChatId) await selectConversation(state.selectedChatId);
    } catch (error) {
      toggle.checked = !enabled;
      toast(error.message, "error");
    } finally {
      toggle.disabled = false;
    }
  });
  $("#createAgentButton").addEventListener("click", openCreateAgent);
  $("#accountStyleBoard").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-agent-action]");
    if (!button) return;
    const agentId = button.closest("[data-agent-id]")?.dataset.agentId;
    const action = button.dataset.agentAction;
    if (action === "edit") return openAgentEditor(agentId);
    button.disabled = true;
    try {
      if (action === "clone") {
        const result = await api(`/api/agents/${encodeURIComponent(agentId)}/clone`, { method: "POST", body: "{}" });
        await loadStatus();
        toast("智能体副本已创建，可独立编辑或绑定给其他账号");
        openAgentEditor(result.agent.id);
      } else if (action === "delete") {
        if (!await confirmModal("删除智能体", "确认删除这个未绑定账号的智能体？此操作不会删除聊天记录。")) return;
        await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
        await loadStatus();
        toast("智能体已删除");
      }
    } catch (error) { toast(error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#syncButton").addEventListener("click", async () => {
    try { toast("正在同步历史消息…"); await api("/api/whatsapp/sync", { method: "POST", body: "{}" }); await loadConversations(); toast("历史同步完成"); } catch (error) { toast(error.message, "error"); }
  });
  $("#seedButton").addEventListener("click", async () => {
    try { const payload = await api("/api/dev/seed", { method: "POST", body: "{}" }); await loadConversations(); await selectConversation(payload.chatId); } catch (error) { toast(error.message, "error"); }
  });
  $("#conversationSearch").addEventListener("input", (event) => { state.search = event.target.value; clearTimeout(event.target._timer); event.target._timer = setTimeout(loadConversations, 220); });
  $$("#conversationFilters button").forEach((button) => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    $$("#conversationFilters button").forEach((item) => item.classList.toggle("active", item === button));
    loadConversations();
  }));
  $("#modeToggle").addEventListener("change", async (event) => {
    if (!state.selectedChatId) return;
    const mode = event.target.checked ? "human" : "auto";
    try {
      await api(`/api/conversations/${encodeURIComponent(state.selectedChatId)}/mode`, { method: "PATCH", body: JSON.stringify({ mode }) });
      await selectConversation(state.selectedChatId);
      toast(mode === "human" ? "已切换为人工接管" : "已恢复 AI 自动回复");
    } catch (error) { toast(error.message, "error"); }
  });
  $("#attachmentButton").addEventListener("click", () => $("#attachmentInput").click());
  $("#pasteAttachmentButton").addEventListener("click", pasteAttachmentFromClipboard);
  $("#attachmentInput").addEventListener("change", (event) => {
    const files = [...(event.target.files || [])];
    if (files.length) readAttachments(files);
  });
  const composer = $(".composer");
  document.addEventListener("paste", (event) => {
    if (state.view !== "inbox" || !state.selectedChatId || !$("#modal").classList.contains("hidden")) return;
    handleMediaTransfer(event, "粘贴");
  }, true);
  composer.addEventListener("dragenter", (event) => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault();
    composer.classList.add("dragging");
  });
  composer.addEventListener("dragover", (event) => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    composer.classList.add("dragging");
  });
  composer.addEventListener("dragleave", (event) => {
    if (!composer.contains(event.relatedTarget)) composer.classList.remove("dragging");
  });
  composer.addEventListener("drop", (event) => {
    composer.classList.remove("dragging");
    handleMediaTransfer(event, "拖入");
  });
  $("#sendButton").addEventListener("click", sendMessage);
  $("#translateComposer").addEventListener("click", translateComposer);
  $("#messageInput").addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      translateComposer();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("#openAllQuotes").addEventListener("click", () => showView("quotes"));
  $("#quoteFilter").addEventListener("change", (event) => { state.quoteFilter = event.target.value; loadQuotes(); });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#modal").addEventListener("click", (event) => { if (event.target === event.currentTarget) $("#modalClose").click(); });
}

async function start() {
  bindEvents();
  try {
    await Promise.all([loadStatus(), loadConversations()]);
    const stream = new EventSource("/api/events");
    stream.onmessage = scheduleRefresh;
    stream.onerror = () => {};
    setInterval(() => loadStatus().catch(() => {}), 12000);
  } catch (error) { toast(error.message, "error"); }
}

start();
