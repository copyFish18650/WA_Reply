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

function isAlbumFollowUp(message, context = []) {
  const body = String(message?.body || "").trim().toLowerCase();
  if (!/^(?:right )?now[.!?]*$|^(?:yes|sure|ok(?:ay)?|please|send it|show me)[.!?]*$/i.test(body)) return false;
  return context.some((item) => item.direction === "outbound" && /photo album|albums?|share.*photo/i.test(String(item.body || "")));
}

module.exports = {
  MANOS_LEAD_WELCOME,
  MANOS_ALBUM_FOLLOW_UP,
  NEW_CUSTOMER_WELCOME,
  isSystemChatId,
  isSystemConversation,
  isSystemNotice,
  isManosLead,
  isManosMarker,
  isGreeting,
  isAlbumFollowUp
};
