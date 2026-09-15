const SYSTEM_MESSAGE_TYPES = /^(?:notification|protocol|ciphertext|e2e_notification|gp2)$/i;

const MANOS_ALBUM_LINKS = "https://www.manos.live ; www.manos-world.com ; https://linktr.ee/ManosVip";

const MANOS_LEAD_WELCOME = `Hi! Thanks for reaching out

${MANOS_ALBUM_LINKS}

Here are some of our photo albums. Dear, you can take a look and see if any of them are of interest to you.

What kind of product are you looking for?`;

const MANOS_ALBUM_FOLLOW_UP = `Of course, dear. You can view our photo albums here:

${MANOS_ALBUM_LINKS}

What kind of product are you looking for?`;

const NEW_CUSTOMER_WELCOME = "Hi! Thanks for reaching out. What kind of product are you looking for?";

function providerChatId(value) {
  return String(value?.providerChatId || value?.chatId || value || "").split("::").at(-1).toLowerCase();
}

function isSystemChatId(value) {
  const id = providerChatId(value);
  return id === "0@c.us"
    || id === "status@broadcast"
    || id.endsWith("@newsletter")
    || id.endsWith("@broadcast");
}

function isSystemConversation(value = {}) {
  if (isSystemChatId(value)) return true;
  if (isSystemNotice(value)) return true;
  const identity = String(value.profileName || "").trim().toLowerCase();
  const body = String(value.body || value.lastMessagePreview || "");
  return /^(?:whatsapp|whatsapp business)$/.test(identity)
    && /whatsapp username|facebook or instagram|consistent brand|official account|security code/i.test(body);
}

function isManosLead(value) {
  const body = String(value?.body ?? value ?? "");
  return /Manos\s*ID\s*[-–—]{1,2}\s*["“”']?[A-Z0-9_-]+["“”']?/i.test(body)
    && /(?:hello|hi)[\s\S]{0,80}(?:more info|information|details)/i.test(body);
}

function isSystemNotice(value = {}) {
  const type = String(value.type || "").toLowerCase();
  if (SYSTEM_MESSAGE_TYPES.test(type)) return true;
  const body = String(value.body || "").trim();
  return type === "notification_template" && (!body || body === "[notification_template]");
}

function isManosMarker(value) {
  const body = String(value?.body ?? value ?? "").trim();
  return /^Manos\s*ID\s*[-–—]{1,2}\s*["“”']?[A-Z0-9_-]+["“”']?\s*[.!。！]?$/i.test(body);
}

function isGreeting(value) {
  const body = String(value?.body ?? value ?? "").trim();
  if (!body || body.length > 60 || /\n/.test(body)) return false;
  return /^(?:(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))(?:\s+(?:dear|there))?|hola|bonjour|ciao|ol[áa]|你好|您好|嗨|哈喽|在吗|مرحبا|السلام عليكم)[\s!！,.，。?？~～👋😊🙂]*$/iu.test(body);
}

function isSpamMessage(value = {}) {
  const body = String(value?.body ?? value ?? "")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) return false;

  const verificationRequest = /(?:验证|核实|认证|确认|查询)(?:您?的?)?(?:账号|帐号|帳號|账户|帳戶)|(?:点击|按下|选择)[\s\S]{0,32}(?:验证(?:账号|帐号|帳號)|START|开始)|(?:verify|confirm|validate|authenticate)[\s\S]{0,32}(?:whatsapp\s*)?(?:account|identity)/i.test(body);
  const threatSignals = [
    /(?:不同|多个|异常|频繁)[\s\S]{0,24}(?:IP|网络|登录)|unusual[\s\S]{0,20}login/i,
    /数据泄露|非法行为|data\s*(?:leak|breach)|illegal\s*activity/i,
    /高风险(?:账号|帐号|帳號)|自动注销|(?:账号|帐号|帳號)(?:将被|即将)?(?:注销|封禁|停用)|high[-\s]?risk|(?:suspend|deactivat|terminat)[a-z]*[\s\S]{0,24}(?:account)?/i,
    /(?:24|4|48)\s*(?:小时|hours?)/i
  ].filter((pattern) => pattern.test(body)).length;
  const impersonatesWhatsApp = /WhatsApp[\s\S]{0,32}(?:安全|官方|客服|账号|帐号|帳號|账户|帳戶|security|support|account)|(?:WhatsApp\s*)?(?:安全检测中心|安全中心)|security\s*(?:check|detection)?\s*cent(?:er|re)/i.test(body);

  // Require multiple phishing signals so ordinary customers discussing their own
  // WhatsApp account or login are not hidden.
  return verificationRequest && (impersonatesWhatsApp || threatSignals >= 2);
}

module.exports = {
  MANOS_ALBUM_LINKS,
  MANOS_LEAD_WELCOME,
  MANOS_ALBUM_FOLLOW_UP,
  NEW_CUSTOMER_WELCOME,
  isSystemChatId,
  isSystemConversation,
  isSystemNotice,
  isSpamMessage,
  isManosLead,
  isManosMarker,
  isGreeting
};
