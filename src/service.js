const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const {
  LocalAI,
  answerFromManualRules,
  isIdentityQuestion,
  customerServiceIdentityReply,
  enforceCustomerServiceIdentity
} = require("./local-ai");
const { SupplierSearch, aggregateProductFacts } = require("./supplier");
const { contextKeywords } = require("./store");
const { calculateFinalQuote, QUOTE_CURRENCIES, SHIPPING_OPTIONS_CNY } = require("./pricing");
const {
  MANOS_LEAD_WELCOME,
  MANOS_ALBUM_FOLLOW_UP,
  NEW_CUSTOMER_WELCOME,
  isSystemConversation,
  isManosLead,
  isGreeting,
  isAlbumFollowUp
} = require("./message-policy");

const HUMAN_TRIGGERS = [
  { pattern: /多少钱|价格|报价|单价|最低价|折扣|优惠|便宜|批发价|代理价|price|cost|quote|discount|best price/i, reason: "价格或折扣承诺", alwaysHuman: true },
  { pattern: /付款|支付|收款|打款|转账|付款码|收款码|支付链接|付款链接|银行账户|银行卡|支付宝|微信支付|银联|怎么付|如何付|怎样付|\bpay\b|paying|payment|checkout|bank\s*(?:details?|account|transfer)|wire\s*transfer|payment\s*(?:link|method|details?|instructions?)|paypal|stripe|iban|swift|crypto|usdt|bitcoin|alipay|wechat\s*pay|cash\s*app|western\s*union/i, reason: "已进入付款环节，支付方式、链接和收款信息必须由人工确认", alwaysHuman: true },
  { pattern: /投诉|差评|欺骗|骗子|法律|律师|起诉|报警|退款|退货|赔偿|complain|lawyer|legal|fraud|refund|compensation/i, reason: "高风险售后或法律问题", alwaysHuman: true },
  { pattern: /库存|现货|交期|什么时候发|定制|改款|inventory|stock|delivery|custom/i, reason: "库存、交期或定制问题", alwaysHuman: false },
  { pattern: /人工|真人|经理|老板|human agent|manager/i, reason: "客户要求人工", alwaysHuman: true }
];
const TRANSLATION_VERSION = 3;
const QUOTE_REPLY_LANGUAGES = ["auto", "zh", "en", "fr", "es", "de", "it", "pt", "ar", "ru", "ja", "ko"];

function isPriceQuestion(text) {
  return HUMAN_TRIGGERS[0].pattern.test(String(text || ""));
}

function isPaymentQuestion(text) {
  return HUMAN_TRIGGERS[1].pattern.test(String(text || ""));
}

const CASUAL_BUSINESS_TERMS = /多少钱|价格|报价|折扣|付款|支付|订单|订购|库存|现货|交期|发货|运费|物流|产品|商品|鞋|衣服|服装|包|配饰|尺码|尺寸|材质|相册|目录|工厂|定制|price|cost|quote|discount|payment|\bpay\b|order|stock|delivery|shipping|product|item|shoe|clothes|clothing|apparel|bag|accessor|size|dimension|material|album|catalog|factory|custom/i;

function stylePreferences(accountStyle = {}) {
  const rules = (accountStyle.rules || []).filter((rule) => rule.enabled !== false).map((rule) => rule.text);
  const description = [accountStyle.summary, accountStyle.persona?.tone, accountStyle.persona?.personality, ...rules].filter(Boolean).join(" ");
  const avoidsEmoji = /很少使用\s*emoji|不用\s*emoji|不使用\s*emoji|avoid\s+emoji|no\s+emoji/i.test(description);
  return {
    useDear: /亲爱的|\bdear\b|ch[èe]r|querid|car[oa]|liebe/i.test(description),
    useEmoji: !avoidsEmoji && /经常使用\s*emoji|常用\s*emoji|喜欢.*emoji|often.*emoji|frequent.*emoji/i.test(description)
  };
}

function careIntent(text) {
  const value = String(text || "");
  if (/累|疲惫|疲劳|辛苦了一天|加班|很困|休息|\btired\b|exhausted|long day|worked?\s+(?:for\s+)?\d+\s*hours?|fatigu[ée]|épuis[ée]|cansad[oa]|agotad[oa]|müde|stanco|stanca|cansado/i.test(value)) return "fatigue";
  if (/生病|不舒服|感冒|发烧|头疼|肚子疼|\bsick\b|\bunwell\b|not feeling well|\bill\b|malade|enferm[oa]|krank|malato|doente/i.test(value)) return "unwell";
  if (/谢谢|感谢|多谢|\bthanks?\b|thank you|merci|gracias|danke|grazie|obrigad[oa]/i.test(value)) return "thanks";
  if (/抱歉|不好意思|回复晚了|\bsorry\b|apologi|désolé|pardon|lo siento|perdón|entschuldigung|scusa|desculpe/i.test(value)) return "apology";
  if (/你好吗|最近怎么样|how are you|how(?:'s| is) your day|comment allez-vous|cómo estás|wie geht es dir|come stai|como você está/i.test(value)) return "how_are_you";
  if (/晚安|早点休息|good night|bonne nuit|buenas noches|gute nacht|buona notte|boa noite/i.test(value)) return "good_night";
  if (/开心|高兴|好消息|太好了|\bhappy\b|good news|great day|heureu|content|feliz|glücklich|froh/i.test(value)) return "happy";
  return "";
}

function localizedCareReply(intent, language, preferences) {
  const dear = preferences.useDear;
  const emoji = preferences.useEmoji;
  const replies = {
    en: {
      fatigue: `That sounds like a very long day${dear ? ", dear" : ""}. Please get some rest and take good care of yourself${emoji ? " 😊" : "."}`,
      unwell: `I'm sorry you're not feeling well${dear ? ", dear" : ""}. Please take good care of yourself and get some rest${emoji ? " ❤️" : "."}`,
      thanks: `You're very welcome${dear ? ", dear" : ""}${emoji ? " 😊" : "."}`,
      apology: `No worries at all${dear ? ", dear" : ""}. Take your time${emoji ? " 😊" : "."}`,
      how_are_you: `I'm doing well, thank you for asking${dear ? ", dear" : ""}. I hope you're having a good day too${emoji ? " 😊" : "."}`,
      good_night: `Good night${dear ? ", dear" : ""}. Have a peaceful and restful night${emoji ? " 🌙" : "."}`,
      happy: `That's lovely to hear${dear ? ", dear" : ""}! I'm happy for you${emoji ? " 😊" : "."}`,
      generic: `I understand${dear ? ", dear" : ""}. Thank you for sharing that with me${emoji ? " 😊" : "."}`
    },
    zh: {
      fatigue: `听起来今天真的很辛苦${dear ? "，亲爱的" : ""}。先好好休息，也要照顾好自己${emoji ? " 😊" : "。"}`,
      unwell: `听到您不舒服我很担心${dear ? "，亲爱的" : ""}。请先照顾好自己，好好休息${emoji ? " ❤️" : "。"}`,
      thanks: `不用客气${dear ? "，亲爱的" : ""}${emoji ? " 😊" : "。"}`,
      apology: `完全没关系${dear ? "，亲爱的" : ""}，您慢慢来就好${emoji ? " 😊" : "。"}`,
      how_are_you: `我很好，谢谢您的关心${dear ? "，亲爱的" : ""}。也希望您今天一切顺利${emoji ? " 😊" : "。"}`,
      good_night: `晚安${dear ? "，亲爱的" : ""}，希望您今晚睡个好觉${emoji ? " 🌙" : "。"}`,
      happy: `听到这个真好${dear ? "，亲爱的" : ""}！我也替您开心${emoji ? " 😊" : "。"}`,
      generic: `我明白了${dear ? "，亲爱的" : ""}，谢谢您愿意和我分享${emoji ? " 😊" : "。"}`
    },
    fr: {
      fatigue: `Cela a dû être une très longue journée${dear ? ", chère cliente" : ""}. Reposez-vous bien et prenez soin de vous${emoji ? " 😊" : "."}`,
      unwell: `Je suis désolée que vous ne vous sentiez pas bien${dear ? ", chère cliente" : ""}. Prenez bien soin de vous et reposez-vous${emoji ? " ❤️" : "."}`,
      thanks: `Avec plaisir${dear ? ", chère cliente" : ""}${emoji ? " 😊" : "."}`,
      apology: `Ne vous inquiétez pas${dear ? ", chère cliente" : ""}. Prenez votre temps${emoji ? " 😊" : "."}`,
      how_are_you: `Je vais bien, merci de demander${dear ? ", chère cliente" : ""}. J'espère que votre journée se passe bien aussi${emoji ? " 😊" : "."}`,
      good_night: `Bonne nuit${dear ? ", chère cliente" : ""}. Je vous souhaite une nuit paisible et reposante${emoji ? " 🌙" : "."}`,
      happy: `C'est un plaisir à entendre${dear ? ", chère cliente" : ""} ! Je suis heureuse pour vous${emoji ? " 😊" : "."}`,
      generic: `Je comprends${dear ? ", chère cliente" : ""}. Merci de me l'avoir confié${emoji ? " 😊" : "."}`
    },
    es: {
      fatigue: `Parece que ha sido un día muy largo${dear ? ", querida" : ""}. Descansa bien y cuídate mucho${emoji ? " 😊" : "."}`,
      unwell: `Siento que no te encuentres bien${dear ? ", querida" : ""}. Cuídate mucho y descansa${emoji ? " ❤️" : "."}`,
      thanks: `De nada${dear ? ", querida" : ""}${emoji ? " 😊" : "."}`,
      apology: `No te preocupes${dear ? ", querida" : ""}. Tómate tu tiempo${emoji ? " 😊" : "."}`,
      how_are_you: `Estoy bien, gracias por preguntar${dear ? ", querida" : ""}. Espero que tú también estés teniendo un buen día${emoji ? " 😊" : "."}`,
      good_night: `Buenas noches${dear ? ", querida" : ""}. Que tengas una noche tranquila y descanses bien${emoji ? " 🌙" : "."}`,
      happy: `¡Qué alegría saberlo${dear ? ", querida" : ""}! Me alegro mucho por ti${emoji ? " 😊" : "."}`,
      generic: `Entiendo${dear ? ", querida" : ""}. Gracias por compartirlo conmigo${emoji ? " 😊" : "."}`
    }
  };
  return (replies[language] || replies.en)[intent] || "";
}

function customerCareReply(text, accountStyle = {}) {
  const intent = careIntent(text);
  if (!intent) return "";
  return localizedCareReply(intent, detectLanguage(text), stylePreferences(accountStyle));
}

function casualFallbackReply(text, accountStyle = {}, context = []) {
  const value = String(text || "").trim();
  const language = detectLanguage(value);
  const preferences = stylePreferences(accountStyle);
  const dear = preferences.useDear ? ", dear" : "";
  const smile = preferences.useEmoji ? " 😊" : "";
  const laugh = preferences.useEmoji ? " 😂" : "";
  const heart = preferences.useEmoji ? " ❤️" : "";
  const mentionedLongShift = (Array.isArray(context) ? context : [])
    .some((item) => item?.direction === "inbound" && /(?:ten|10)\s+hours?|十个小时/i.test(String(item.body || "")));

  if (language === "en") {
    if (/\b(?:call|phone|video chat)\b/i.test(value) && /\b(?:ugly|old man|old woman|too old)\b/i.test(value)) {
      return `Haha, stop that—you’re not ugly${dear}${laugh}. We can arrange a call; let me check my schedule and I’ll tell you when I’m free.`;
    }
    if (/\b(?:call|phone|video chat)\b/i.test(value)) {
      return `A call sounds nice${dear}${smile}. Let me check when I'm free and I'll get back to you with a good time.`;
    }
    if (/\bback\b.{0,30}\b(?:hurt|hurts|pain|sore)|\b(?:hurt|hurts|pain|sore)\b.{0,30}\bback\b/i.test(value)) {
      return `I've been well${dear}, thanks for asking. But your back is still hurting? ${mentionedLongShift ? "Those ten-hour workdays really are too much—" : ""}please take it easy tonight${heart}.`;
    }
    if (/(?:don't|do not) have (?:any )?(?:discomfort|pain|problem)|(?:not|never) (?:sick|unwell)/i.test(value)
      && /china|visit|meet|find you/i.test(value)) {
      return `Ah, I understand now${dear}—I misunderstood you${smile}. If you come to China one day, I'd be very happy to welcome you.`;
    }
    if (/save money|work hard|buy more things/i.test(value)) {
      return `Haha, no pressure${dear}${laugh}. Work hard, but remember to enjoy life too—you deserve a little treat now and then.`;
    }
    if (/\bweather\b/i.test(value)) {
      return `I haven't checked the weather yet${dear}${smile}. How is it where you are?`;
    }
  }
  if (language === "zh") {
    if (/打电话|通话|视频/.test(value) && /丑|老男人|老女人|年纪大/.test(value)) {
      return `哈哈，别这么说自己${preferences.useDear ? "，亲爱的" : ""}${laugh}，年龄可不会让一个人变丑。通话听起来不错，我确认一下时间再告诉你。`;
    }
    if (/背|腰/.test(value) && /疼|痛|酸/.test(value)) {
      return `我最近挺好的${preferences.useDear ? "，亲爱的" : ""}，谢谢你问我。倒是你的背还疼让我有点担心，今晚别太勉强自己，好好放松一下${heart}。`;
    }
    if (/没有.*(?:不舒服|生病)|并没有.*(?:不舒服|生病)/.test(value) && /中国|见你|找你|看你/.test(value)) {
      return `啊，我明白了${preferences.useDear ? "，亲爱的" : ""}，刚才是我理解错了${smile}。以后来中国的话，我会很开心欢迎你。`;
    }
    if (/存钱|努力工作|努力赚钱|多买/.test(value)) {
      return `哈哈，不着急${preferences.useDear ? "，亲爱的" : ""}${laugh}。努力工作的同时也要记得享受生活，偶尔奖励一下自己。`;
    }
  }
  return localizedCareReply("generic", language, preferences);
}

function isCasualMessage(text) {
  const value = String(text || "").trim();
  if (!value || CASUAL_BUSINESS_TERMS.test(value)) return false;
  return /我(?:今天|刚|最近|现在|感觉|觉得|心情|工作|生活|家人|朋友)|聊聊天|早上好|下午好|晚上好|晚安|谢谢|抱歉|开心|难过|伤心|生病|不舒服|累|疲惫|存钱|努力工作|努力赚钱|来中国|去中国|见你|找你|打电话|通话|视频|背疼|腰疼|\b(?:i(?:'m| am| just| feel| felt| was| have| had|'ve| still| don't| do not| will)|my (?:day|work|family|friend|weekend)|today|yesterday|tonight|good morning|good evening|good night|thanks?|sorry|happy|sad|lonely|busy|tired|sick|unwell|weekend|save money|work hard|visit you|meet you|go to china|come to china|weather where you|how have you been|call me|phone me|video chat|back (?:still )?(?:hurt|hurts|pain|sore)|ugly old|old man|old woman)\b|\b(?:je suis|j'ai|ma journée|merci|désolé|fatigué|enfermo|estoy|mi día|gracias|cansado|ich bin|mein tag|danke|müde|sono|la mia giornata|grazie|estou|meu dia|obrigado)\b/i.test(value);
}

function isCallRequest(text) {
  return /\b(?:call|phone|video chat)\b|打电话|通话|视频/i.test(String(text || ""));
}

function prefersContextualCasualReply(text) {
  const value = String(text || "");
  return isCallRequest(value)
    || /\bback\b.{0,30}\b(?:hurt|hurts|pain|sore)|\b(?:hurt|hurts|pain|sore)\b.{0,30}\bback\b|背.{0,20}(?:疼|痛|酸)|腰.{0,20}(?:疼|痛|酸)/i.test(value);
}

function manualKnowledgeIntent(text) {
  const value = String(text || "").toLowerCase();
  if (/在哪里|地址|位置|where.*(?:factory|company)|factory.*where|located/i.test(value)) return "company_location";
  if (/卖什么|生产什么|主营|产品|服装|衣服|factory.*(?:sell|make|produce)|what.*(?:sell|product)|clothes|clothing|manufactur/i.test(value)) return "company_products";
  if (/相册|目录|款式|album|catalog|collection/i.test(value)) return "catalog";
  if (/材质|面料|material|fabric/i.test(value)) return "material";
  if (/库存|现货|inventory|stock/i.test(value)) return "stock";
  if (/交期|发货|运输|delivery|shipping|dispatch/i.test(value)) return "delivery";
  if (/定制|印.*logo|改款|custom|logo/i.test(value)) return "customization";
  if (/退款|退货|售后|refund|return|after.?sales/i.test(value)) return "after_sales";
  return "general";
}

function extension(mimeType) {
  const normalized = String(mimeType || "").toLowerCase().split(";")[0].trim();
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-m4v": ".m4v"
  })[normalized] || ".bin";
}

function conversationKey(accountId, providerChatId) {
  return `${String(accountId || "primary")}::${String(providerChatId || "")}`;
}

function needsChineseTranslation(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 5000 || !/[A-Za-z]{2}/.test(value)) return false;
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(value)) return false;
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

function isSizeQuestion(text) {
  return /尺码|尺寸|多大|大小|长宽高|开口多宽|厚度|size|dimensions?|measurements?|how (?:big|large|wide|tall|deep)/i.test(String(text || ""));
}

function detectLanguage(text) {
  const value = String(text || "").toLowerCase();
  if (/[\u0600-\u06ff]/u.test(value)) return "ar";
  if (/[\u0400-\u04ff]/u.test(value)) return "ru";
  if (/[\u3040-\u30ff]/u.test(value)) return "ja";
  if (/[\uac00-\ud7af]/u.test(value)) return "ko";
  if (/[\p{Script=Han}]/u.test(value)) return "zh";
  if (/\b(?:bonjour|merci|vous|êtes|peux|répondre|français|cher|chère|quel|quelle)\b/iu.test(value)) return "fr";
  if (/\b(?:hola|gracias|usted|ustedes|puedes|español|querido|qué|cuál)\b/iu.test(value)) return "es";
  if (/\b(?:hallo|danke|bitte|welche|welcher|sind|möchte|deutsch)\b/iu.test(value)) return "de";
  if (/\b(?:buongiorno|grazie|prego|quale|italiano|vorrei)\b/iu.test(value)) return "it";
  if (/\b(?:olá|obrigad[oa]|você|qual|português|gostaria)\b/iu.test(value)) return "pt";
  return "en";
}

const LANGUAGE_NAMES = { zh: "中文", en: "英语", fr: "法语", es: "西班牙语", de: "德语", it: "意大利语", pt: "葡萄牙语", ar: "阿拉伯语", ru: "俄语", ja: "日语", ko: "韩语" };
const CUSTOMER_TOPICS = [
  [/鞋|运动鞋|靴|sneaker|shoe|boot/i, "鞋类"],
  [/衣服|服装|外套|裙|裤|clothes|clothing|apparel|dress|jacket|shirt|pants/i, "服装"],
  [/包|手袋|背包|handbag|bag|backpack/i, "箱包"],
  [/手表|腕表|watch/i, "腕表"],
  [/首饰|项链|戒指|耳环|jewelry|jewellery|necklace|ring|earring/i, "首饰"],
  [/尺码|尺寸|size|dimension/i, "尺码规格"],
  [/颜色|黑色|白色|蓝色|红色|color|colour|black|white|blue|red/i, "颜色偏好"],
  [/批发|数量|多少件|wholesale|quantity|pieces|pcs/i, "批量采购"],
  [/定制|印.*logo|custom|logo/i, "定制需求"],
  [/运输|运费|物流|shipping|delivery|freight/i, "物流"],
  [/价格|报价|多少钱|price|quote|cost/i, "价格关注"]
];

function inferCustomerSignals(messages, quotes, contact) {
  const inbound = messages.filter((item) => item.direction === "inbound" && item.type === "text" && item.body);
  const sample = inbound.slice(-30);
  const languageCounts = sample.reduce((counts, item) => {
    const language = detectLanguage(item.body);
    counts[language] = (counts[language] || 0) + 1;
    return counts;
  }, {});
  const language = Object.entries(languageCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "en";
  const combined = inbound.slice(-80).map((item) => item.body).join("\n");
  const topics = CUSTOMER_TOPICS.filter(([pattern]) => pattern.test(combined)).map(([, label]) => label).slice(0, 6);
  const pendingQuote = quotes.some((quote) => ["pending", "approved"].includes(quote.status));
  const latest = messages.at(-1);
  const stage = pendingQuote ? "报价待审核"
    : contact.needsHuman || contact.mode === "human" ? "等待人工处理"
      : latest?.direction === "inbound" ? "等待回复客户"
        : latest ? "等待客户回复" : "新会话";
  return {
    language,
    languageName: LANGUAGE_NAMES[language] || language.toUpperCase(),
    topics,
    stage,
    inboundCount: inbound.length,
    outboundCount: messages.filter((item) => item.direction === "outbound").length,
    mediaCount: messages.filter((item) => ["image", "video"].includes(item.type)).length,
    lastActiveAt: latest?.createdAt || contact.updatedAt || contact.createdAt || 0
  };
}

function factoryPriceAcknowledgement(message, language = "") {
  const useChinese = language ? language === "zh" : /[\p{Script=Han}]/u.test(String(message?.body || ""));
  return useChinese
    ? "好的亲爱的，我会询问一下工厂。"
    : "Okay dear, I’ll check with the factory for you.";
}

function stockOutReply(message) {
  return /[\p{Script=Han}]/u.test(String(message?.body || ""))
    ? "抱歉亲爱的，这款工厂告诉我暂时缺货。"
    : "Sorry dear, the factory told me this item is temporarily out of stock.";
}

function factsDescription(facts, language = "en") {
  const details = [];
  if (facts?.color && facts?.material) details.push(language === "zh" ? `${facts.color.zh}${facts.material.zh}` : `${facts.color.en} ${facts.material.en}`);
  else if (facts?.color) details.push(facts.color[language]);
  else if (facts?.material) details.push(facts.material[language]);
  details.push(...(facts?.features || []).map((item) => item[language]).filter(Boolean));
  return details.filter(Boolean);
}

function pricedQuoteDraft(message, estimate, facts = {}, language = "") {
  const isChinese = language ? language === "zh" : /[\p{Script=Han}]/u.test(String(message?.body || ""));
  const price = `${estimate.currency} ${estimate.suggestedPrice.toFixed(2)}`;
  if (isChinese) {
    const size = facts?.dimensions ? `根据多个高度相似的货源描述，这款商品的参考尺寸是${facts.dimensions.zh}。` : "";
    const details = factsDescription(facts, "zh");
    const description = details.length ? `相似货源还一致标注了${details.join("、")}。` : "";
    const caveat = facts?.dimensions ? "不同批次可能有轻微差异，下单前我会再确认准确尺寸和规格。" : "最终价格需要结合数量、规格和物流确认。";
    return `亲爱的，${size}${description}包含货源成本的初步参考价约为 ${price}。${caveat}请问您预计需要多少件？`;
  }
  const size = facts?.dimensions ? `based on several closely matched supplier listings, the reference size is ${facts.dimensions.en}. ` : "";
  const details = factsDescription(facts, "en");
  const description = details.length ? `${size ? "The" : "the"} matching descriptions also consistently indicate ${details.join(", ")}. ` : "";
  const caveat = facts?.dimensions
    ? "Supplier descriptions can vary slightly by batch, so I will confirm the exact measurements and specifications before the order."
    : "The final price depends on quantity, specifications and shipping.";
  return `Dear, ${size}${description}${size || description ? "The" : "the"} preliminary price including the supplier cost is about ${price}. ${caveat} How many pieces do you need?`;
}

function supplierSizeReply(message, facts) {
  if (!facts?.dimensions) return "";
  const isChinese = /[\p{Script=Han}]/u.test(String(message?.body || ""));
  const details = factsDescription(facts, isChinese ? "zh" : "en");
  if (isChinese) {
    return `亲爱的，根据多个高度相似的微店货源描述，这款商品的参考尺寸是${facts.dimensions.zh}。${details.length ? `相似结果还一致标注了${details.join("、")}。` : ""}不同批次可能有轻微差异，下单前我会再向工厂确认准确尺寸。您还想确认哪一处的尺寸？`;
  }
  return `Dear, based on several closely matched supplier listings, the reference size is ${facts.dimensions.en}. ${details.length ? `The matching results also consistently indicate ${details.join(", ")}. ` : ""}Measurements can vary slightly by batch, so I will confirm the exact dimensions with the factory before the order. Is there a particular measurement you would like me to verify?`;
}

class SalesService extends EventEmitter {
  constructor({ store, session, dataDir }) {
    super();
    this.store = store;
    this.session = session;
    this.dataDir = path.resolve(dataDir);
    this.mediaDir = path.join(this.dataDir, "media");
    fs.mkdirSync(this.mediaDir, { recursive: true });
    this.ai = new LocalAI(() => this.store.getRuntimeSettings());
    this.supplier = new SupplierSearch(() => this.store.getRuntimeSettings());
    this.queues = new Map();
    this.accountQueueJobs = new Map();
    this.approvals = new Set();
    this.styleJobs = new Map();
    this.translationJobs = new Map();
    this.memoryJobs = new Map();
    this.memoryTimers = new Map();
    this.store.recoverProcessingMessages();
    this.bindSession();
  }

  publish(type, payload = {}) {
    this.emit("update", { type, timestamp: Date.now(), ...payload });
  }

  bindSession() {
    this.session.on("status", (status) => {
      this.publish("session", { status });
      for (const account of status.accounts || []) {
        if (account.status === "ready" && this.store.getAccountAutomation(account.accountId).enabled) {
          this.runAccountQueue(account.accountId).catch((error) => this.publish("error", { accountId: account.accountId, message: error.message }));
        }
      }
    });
    this.session.on("history", ({ accountId, accountName, chatId, profileName, messages, unread }) => {
      if (isSystemConversation({ chatId, profileName, body: messages?.at(-1)?.body })) return;
      const conversationId = conversationKey(accountId, chatId);
      this.store.upsertContact(conversationId, {
        accountId,
        accountName,
        providerChatId: chatId,
        profileName,
        phone: chatId.replace(/@.+$/, "")
      });
      const normalized = messages.map((message) => {
        const row = {
          ...message,
          chatId: conversationId,
          accountId,
          accountName,
          providerChatId: chatId
        };
        if (message.media?.data) Object.assign(row, this.persistMedia(message, message.media));
        delete row.media;
        return row;
      });
      const inserted = this.store.importHistory(conversationId, profileName, normalized, unread);
      if (inserted) this.publish("history", { chatId: conversationId, accountId, inserted });
    });
    this.session.on("history-complete", ({ accountId }) => {
      this.ensureAccountStyle(accountId)
        .then(() => this.store.getAccountAutomation(accountId).enabled ? this.catchUpRecentInbound(accountId) : null)
        .catch((error) => this.publish("error", { accountId, message: `历史断点续回失败：${error.message}` }));
    });
    this.session.on("message", (message) => {
      this.ingest(message).catch((error) => {
        const chatId = conversationKey(message.accountId, message.chatId);
        this.store.requestHuman(chatId, `自动处理失败：${error.message}`, message.id);
        this.publish("error", { chatId, accountId: message.accountId, message: error.message });
      });
    });
    this.session.on("outbound", (message) => {
      const providerChatId = message.chatId;
      const conversationId = conversationKey(message.accountId, providerChatId);
      this.store.upsertContact(conversationId, {
        accountId: message.accountId,
        accountName: message.accountName,
        providerChatId,
        profileName: message.profileName || providerChatId,
        phone: providerChatId.replace(/@.+$/, "")
      });
      const normalized = { ...message, chatId: conversationId };
      if (message.media?.data) Object.assign(normalized, this.persistMedia(message, message.media));
      delete normalized.media;
      const reconciled = this.store.reconcileProvisionalOutbound(conversationId, normalized);
      if (reconciled) {
        this.publish("message", { chatId: conversationId, accountId: message.accountId, message: reconciled });
        this.scheduleConversationMemory(conversationId);
        return;
      }
      const result = this.store.addMessage({ ...normalized, providerChatId });
      if (result.inserted) {
        this.publish("message", { chatId: conversationId, accountId: message.accountId, message: result.message });
        this.scheduleConversationMemory(conversationId);
      }
    });
    this.session.on("ack", ({ accountId, id, ack }) => {
      const names = { 0: "queued", 1: "sent", 2: "delivered", 3: "read", 4: "played" };
      if (this.store.updateMessage(id, { status: names[ack] || "sent" }, { accountId })) this.publish("ack", { accountId, id, ack });
    });
    this.session.on("session-error", (error) => this.publish("error", { message: error.message }));
    this.session.on("sync-error", (error) => this.publish("sync-error", { message: error.message }));
  }

  enqueue(chatId, task) {
    const previous = this.queues.get(chatId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task).finally(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId);
    });
    this.queues.set(chatId, next);
    return next;
  }

  accountIsReady(accountId) {
    return (this.session.getStatus().accounts || []).some((account) => account.accountId === String(accountId) && account.status === "ready");
  }

  queueSnapshot(accountId) {
    const raw = this.store.listQueuedMessages(accountId);
    const grouped = new Map();
    for (const message of raw) {
      const existing = grouped.get(message.chatId);
      if (!existing) {
        grouped.set(message.chatId, { message, messageCount: 1 });
      } else {
        existing.messageCount += 1;
        if (message.createdAt >= existing.message.createdAt) existing.message = message;
      }
    }
    const items = [...grouped.values()]
      .map(({ message, messageCount }) => {
        const contact = this.store.getContact(message.chatId);
        return {
          id: message.id,
          chatId: message.chatId,
          contactName: contact?.profileName || contact?.phone || message.providerChatId,
          preview: message.body || (message.type === "image" ? "[图片]" : `[${message.type}]`),
          type: message.type,
          createdAt: message.createdAt,
          messageCount
        };
      })
      .sort((a, b) => a.createdAt - b.createdAt);
    const automation = this.store.getAccountAutomation(accountId);
    const waitingItems = automation.current ? items.filter((item) => item.id !== automation.current.id) : items;
    return {
      ...automation,
      pendingCount: waitingItems.length,
      rawMessageCount: raw.length,
      mergedCount: Math.max(0, raw.length - items.length),
      next: waitingItems[0] || null,
      items: waitingItems.slice(0, 20)
    };
  }

  publishAccountQueue(accountId) {
    const automation = this.queueSnapshot(accountId);
    this.publish("account-queue", { accountId, automation });
    return automation;
  }

  queueMessage(message, reason = "等待账号 AI 开关开启") {
    const updated = this.updateAutomation(message, "queued", {
      automationReason: reason,
      automationSource: "account-queue",
      queuedAt: message.metadata?.queuedAt || Date.now()
    });
    this.publishAccountQueue(message.accountId);
    return updated;
  }

  prepareNextQueuedMessage(accountId) {
    const raw = this.store.listQueuedMessages(accountId);
    const latestTextByChat = new Map();
    const candidates = [];
    for (const message of raw) {
      if (message.type !== "text") {
        candidates.push(message);
        continue;
      }
      const later = latestTextByChat.get(message.chatId);
      if (!later || message.createdAt > later.createdAt) latestTextByChat.set(message.chatId, message);
    }
    for (const message of raw) {
      if (message.type !== "text") continue;
      const latest = latestTextByChat.get(message.chatId);
      if (latest?.id !== message.id) {
        this.updateAutomation(message, "superseded", {
          automationReason: "已合并到该客户更新的消息中",
          automationSource: "account-queue"
        });
        continue;
      }
      if (this.store.hasLaterOutbound(message.chatId, message.createdAt, message.id)) {
        this.updateAutomation(message, "superseded", {
          automationReason: "该消息之后已有人工或系统回复",
          automationSource: "account-queue"
        });
        latestTextByChat.delete(message.chatId);
      }
    }
    return [...candidates, ...latestTextByChat.values()].sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  }

  async runAccountQueue(accountId) {
    const id = String(accountId || "");
    if (this.accountQueueJobs.has(id)) return this.accountQueueJobs.get(id);
    const job = (async () => {
      let automation = this.store.getAccountAutomation(id);
      if (!automation.enabled) return this.queueSnapshot(id);
      if (!this.accountIsReady(id)) {
        this.store.updateAccountAutomation(id, { status: "waiting_connection", current: null, lastError: "WhatsApp 账号尚未连接" });
        return this.publishAccountQueue(id);
      }
      this.store.updateAccountAutomation(id, { status: "preparing", current: null, lastError: "" });
      this.publishAccountQueue(id);
      while (this.store.getAccountAutomation(id).enabled) {
        const message = this.prepareNextQueuedMessage(id);
        if (!message) break;
        const contact = this.store.getContact(message.chatId);
        const current = {
          id: message.id,
          chatId: message.chatId,
          contactName: contact?.profileName || contact?.phone || message.providerChatId,
          preview: message.body || (message.type === "image" ? "[图片]" : `[${message.type}]`),
          createdAt: message.createdAt
        };
        this.store.updateAccountAutomation(id, { status: "running", current, lastError: "" });
        this.publishAccountQueue(id);
        try {
          const mediaError = ["image", "video"].includes(message.type) && (!message.localMediaPath || !fs.existsSync(message.localMediaPath))
            ? "排队媒体缺少本地文件，将尝试从 WhatsApp 重新读取"
            : "";
          await this.enqueue(message.chatId, () => this.processAndRecord(message, null, mediaError, { accountQueue: true }));
          this.store.updateAccountAutomation(id, { lastProcessedAt: Date.now(), lastContactName: current.contactName, lastError: "" });
        } catch (error) {
          this.store.updateAccountAutomation(id, { lastError: error.message });
          this.publish("error", { accountId: id, chatId: message.chatId, message: `队列回复失败：${error.message}` });
        }
      }
      automation = this.store.getAccountAutomation(id);
      this.store.updateAccountAutomation(id, { status: automation.enabled ? "idle" : "off", current: null });
      return this.publishAccountQueue(id);
    })().finally(() => this.accountQueueJobs.delete(id));
    this.accountQueueJobs.set(id, job);
    return job;
  }

  setAccountAutomation(accountId, enabled) {
    const id = String(accountId || "");
    if (enabled && !this.store.getAccountStyle(id).persona?.completed) {
      throw Object.assign(new Error("请先完成该账号的客服身份、业务、语气和性格配置"), { statusCode: 409 });
    }
    const current = this.store.getAccountAutomation(id);
    const next = this.store.updateAccountAutomation(id, {
      enabled: Boolean(enabled),
      status: enabled ? (this.accountIsReady(id) ? "preparing" : "waiting_connection") : (current.current ? "pausing" : "off"),
      ...(enabled ? { lastError: "" } : {})
    });
    this.publishAccountQueue(id);
    if (next.enabled) this.runAccountQueue(id).catch((error) => this.publish("error", { accountId: id, message: error.message }));
    return this.queueSnapshot(id);
  }

  async readAccountRecords(accountId) {
    const id = String(accountId || "");
    if (!this.accountIsReady(id)) throw Object.assign(new Error("请先连接该 WhatsApp 账号"), { statusCode: 409 });
    const sync = await this.session.syncHistory(id);
    const style = await this.analyzeAccountStyle(id, { force: true });
    this.publishAccountQueue(id);
    return { sync, style, automation: this.queueSnapshot(id) };
  }

  styleProgress(accountId, patch) {
    const style = this.store.updateAccountStyle(accountId, patch);
    this.publish("account-style", { accountId, style });
    return style;
  }

  async analyzeAccountStyle(accountId, options = {}) {
    const id = String(accountId || "");
    if (!id) throw Object.assign(new Error("账号不存在"), { statusCode: 404 });
    if (this.styleJobs.has(id)) return this.styleJobs.get(id);
    const current = this.store.getAccountStyle(id);
    if (!options.force && current.status === "ready" && current.summary) return current;
    const job = (async () => {
      this.styleProgress(id, { status: "analyzing", progress: 8, progressLabel: "正在整理该账号的历史回复…", error: "" });
      const samples = this.store.listAccountOutbound(id, 300);
      this.styleProgress(id, { status: "analyzing", progress: 32, progressLabel: `已提取 ${samples.length} 条历史回复，正在分析表达习惯…`, sampleCount: samples.length });
      if (!samples.length) {
        return this.styleProgress(id, {
          status: "needs_input",
          progress: 100,
          progressLabel: "没有读取到该账号发出的历史消息，请手动填写风格描述",
          summary: current.summary || "",
          sampleCount: 0
        });
      }
      this.styleProgress(id, { status: "analyzing", progress: 58, progressLabel: "本地模型正在总结语言、语气和销售节奏…" });
      const analyzed = await this.ai.analyzeStyle(samples);
      this.styleProgress(id, { status: "analyzing", progress: 88, progressLabel: "正在生成可编辑的风格规则…" });
      const preservedManualRules = (this.store.getAccountStyle(id).rules || []).filter((rule) => rule.source === "manual");
      const analysisRules = analyzed.rules.map((text, index) => ({ id: `analysis-${Date.now()}-${index}`, text, enabled: true, source: "analysis" }));
      return this.styleProgress(id, {
        status: "ready",
        progress: 100,
        progressLabel: `已基于 ${analyzed.sampleCount} 条历史回复完成分析`,
        summary: analyzed.summary,
        rules: [...analysisRules, ...preservedManualRules],
        sampleCount: analyzed.sampleCount,
        error: "",
        analyzedAt: Date.now()
      });
    })().catch((error) => {
      this.styleProgress(id, { status: "error", progress: 100, progressLabel: "语言风格分析失败", error: error.message });
      throw error;
    }).finally(() => this.styleJobs.delete(id));
    this.styleJobs.set(id, job);
    return job;
  }

  async ensureAccountStyle(accountId) {
    const current = this.store.getAccountStyle(accountId);
    if (current.status === "ready" && current.summary) return current;
    if (["needs_input", "error"].includes(current.status)) return current;
    return this.analyzeAccountStyle(accountId);
  }

  updateAccountStyle(accountId, patch = {}) {
    const summary = String(patch.summary || "").trim();
    const rules = Array.isArray(patch.rules) ? patch.rules : [];
    const style = this.store.updateAccountStyle(accountId, {
      summary,
      rules,
      status: summary ? "ready" : "needs_input",
      progress: 100,
      progressLabel: summary ? "人工编辑的语言风格已生效" : "请填写语言风格描述",
      error: "",
      editedAt: Date.now()
    });
    this.publish("account-style", { accountId, style });
    return style;
  }

  updateAccountProfile(accountId, patch = {}) {
    const persona = {
      gender: String(patch.gender || ""),
      business: String(patch.business || "").trim(),
      tone: String(patch.tone || "").trim(),
      personality: String(patch.personality || "").trim()
    };
    if (!persona.gender || !persona.business || !persona.tone || !persona.personality) {
      throw Object.assign(new Error("请完整填写客服性别/称谓、主营业务、语气和性格"), { statusCode: 400 });
    }
    const style = this.store.updateAccountStyle(accountId, { persona });
    this.publish("account-profile", { accountId, style });
    return style;
  }

  createAgent(input = {}) {
    const agent = this.store.createAgent(input);
    this.publish("agent", { action: "created", agent });
    return agent;
  }

  updateAgent(agentId, patch = {}) {
    const agent = this.store.updateAgent(agentId, patch);
    this.publish("agent", { action: "updated", agent });
    for (const accountId of agent.accountIds || []) {
      this.publish("account-style", { accountId, style: this.store.getAccountStyle(accountId) });
    }
    return agent;
  }

  cloneAgent(agentId, name = "") {
    const source = this.store.getAgent(agentId);
    if (!source) throw Object.assign(new Error("智能体不存在"), { statusCode: 404 });
    return this.createAgent({ copyFromAgentId: agentId, name: String(name || `${source.name} 副本`) });
  }

  bindAccountAgent(accountId, agentId) {
    const style = this.store.bindAccountAgent(accountId, agentId);
    this.publish("account-agent", { accountId, agentId, style });
    this.publishAccountQueue(accountId);
    return style;
  }

  deleteAgent(agentId) {
    const agent = this.store.deleteAgent(agentId);
    this.publish("agent", { action: "deleted", agentId: agent.id });
    return agent;
  }

  getConversationInsights(chatId, activityLimit = 80) {
    const contact = this.store.getContact(chatId);
    if (!contact) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const messages = this.store.listMessages(chatId, { limit: 500, markRead: false });
    const quotes = this.store.listQuotes("all", chatId);
    const memories = this.store.listCustomerMemories(chatId, { includeDisabled: true, limit: 60 }).map((memory) => ({
      ...memory,
      sourceMessages: (memory.sourceMessageIds || [])
        .map((messageId) => this.store.getMessage(chatId, messageId))
        .filter(Boolean)
        .map((message) => ({
          id: message.id,
          direction: message.direction,
          type: message.type,
          body: message.body,
          createdAt: message.createdAt
        }))
    }));
    const latestInbound = [...messages].reverse().find((item) => item.direction === "inbound" && item.type === "text");
    const related = latestInbound ? this.store.findLearnedReplies(contact.accountId, latestInbound.body, manualKnowledgeIntent(latestInbound.body), 8) : [];
    const direct = this.store.listLearnedReplies(contact.accountId, 30).filter((item) => item.chatId === chatId);
    const learned = [...new Map([...related, ...direct].map((item) => [item.id, item])).values()].slice(0, 8);
    const context = latestInbound ? this.store.getContext(chatId, latestInbound.body) : messages.slice(-Math.min(messages.length, 60));
    const signals = inferCustomerSignals(messages, quotes, contact);
    const activities = [];
    const automationNames = { queued: "已进入回复队列", processing: "本地 AI 正在处理", replied: "自动回复已完成", handoff: "已转人工处理", quote_pending: "报价已进入审核", superseded: "已由后续消息合并", failed: "自动处理失败" };
    for (const message of messages) {
      const mediaName = message.type === "video" ? "视频" : message.type === "image" ? "图片" : "消息";
      activities.push({
        id: `message-${message.id}`,
        category: "message",
        direction: message.direction,
        title: message.direction === "inbound" ? `客户发来${mediaName}` : `已发送${mediaName}`,
        detail: String(message.body || "").replace(/\s+/g, " ").slice(0, 140),
        badge: message.metadata?.source || "",
        createdAt: message.createdAt
      });
      if (message.metadata?.automationState && message.metadata?.automationAt) {
        activities.push({
          id: `automation-${message.id}`,
          category: "automation",
          direction: "system",
          title: automationNames[message.metadata.automationState] || "自动处理状态更新",
          detail: String(message.metadata.automationReason || "").slice(0, 140),
          badge: message.metadata.automationState,
          createdAt: message.metadata.automationAt
        });
      }
    }
    const quoteNames = { pending: "报价等待审核", approved: "报价等待发送", sent: "审核报价已发送", rejected: "报价已驳回并通知缺货" };
    for (const quote of quotes) activities.push({
      id: `quote-${quote.id}`,
      category: "quote",
      direction: "system",
      title: quoteNames[quote.status] || "报价状态更新",
      detail: quote.suggestedPrice > 0 ? `${quote.currency} ${Math.round(quote.suggestedPrice)} · ${quote.supplier}` : `${quote.supplier} · 待询问工厂`,
      badge: `#${quote.id}`,
      createdAt: quote.updatedAt || quote.createdAt
    });
    const memoryNames = { requirement: "客户需求", preference: "客户偏好", identity: "客户资料", relationship: "关系信息", logistics: "物流信息", event: "故事事件", note: "客服备注" };
    for (const memory of memories) activities.push({
      id: `memory-${memory.id}`,
      category: "memory",
      direction: "system",
      title: `${memory.createdAt === memory.updatedAt ? "新增" : "更新"}${memoryNames[memory.type] || "客户记忆"}`,
      detail: memory.text,
      badge: memory.enabled === false ? "已停用" : "已启用",
      createdAt: memory.updatedAt
    });
    const limit = Math.min(Math.max(Number(activityLimit) || 80, 20), 120);
    return {
      memorySummary: this.store.getConversationMemory(chatId),
      memories,
      learned,
      signals,
      context: {
        messageCount: context.length,
        relatedOlderCount: Math.max(0, context.length - Math.min(messages.length, Number(this.store.getRuntimeSettings().contextMessageLimit) || 60)),
        customMemoryCount: memories.filter((item) => item.enabled !== false).length,
        learnedCount: learned.length,
        latestInboundId: latestInbound?.id || ""
      },
      activities: activities.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
    };
  }

  createCustomerMemory(chatId, data = {}) {
    const memory = this.store.createCustomerMemory(chatId, data);
    this.publish("memory", { chatId, accountId: memory.accountId, memory });
    return memory;
  }

  updateCustomerMemory(chatId, memoryId, data = {}) {
    const memory = this.store.updateCustomerMemory(chatId, memoryId, data);
    this.publish("memory", { chatId, accountId: memory.accountId, memory });
    return memory;
  }

  deleteCustomerMemory(chatId, memoryId) {
    const memory = this.store.deleteCustomerMemory(chatId, memoryId);
    this.publish("memory", { chatId, accountId: memory.accountId, memoryId: memory.id, deleted: true });
    return memory;
  }

  memoryContextForAI(chatId, limit = 12) {
    const summary = this.store.getConversationMemory(chatId);
    const rows = [];
    const continuity = [summary.currentScene ? `当前场景：${summary.currentScene}` : "", summary.historySummary ? `历史摘要：${summary.historySummary}` : ""].filter(Boolean).join("\n");
    if (continuity) {
      rows.push({
        id: `conversation-summary-${chatId}`,
        direction: "outbound",
        type: "text",
        body: continuity,
        metadata: { source: "conversation-summary", verifiedByHuman: false }
      });
    }
    const memories = this.store.listCustomerMemories(chatId, { includeDisabled: false, limit: 60 }).slice(0, Math.max(1, Number(limit) || 12));
    for (const item of [...memories].reverse()) {
      rows.push({
        id: item.id,
        direction: "outbound",
        type: "text",
        body: item.text,
        metadata: {
          source: "customer-memory",
          memoryType: item.type,
          memorySource: item.source,
          verifiedByHuman: item.source !== "ai"
        }
      });
    }
    return rows;
  }

  async organizeConversationMemory(chatId, options = {}) {
    const contact = this.store.getContact(chatId);
    if (!contact) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const messages = this.store.listMessages(chatId, { limit: 500, markRead: false });
    const previous = this.store.getConversationMemory(chatId);
    const latest = messages.at(-1) || null;
    if (!options.force && previous.status === "ready" && Number(previous.processedThroughAt) >= Number(latest?.createdAt || 0)) return previous;

    const update = (patch) => {
      const memorySummary = this.store.updateConversationMemory(chatId, patch);
      this.publish("memory-summary", { chatId, accountId: contact.accountId, memorySummary });
      return memorySummary;
    };
    update({ status: "organizing", progress: 12, progressLabel: "正在读取历史会话…", error: "" });
    if (!messages.length) return update({ status: "ready", progress: 100, progressLabel: "暂无聊天记录", currentScene: "暂无可整理的会话。", historySummary: "暂无历史会话。", messageCount: 0, extractedCount: 0 });

    try {
      update({ status: "organizing", progress: 38, progressLabel: `正在用本地模型理解 ${messages.length} 条消息…` });
      const result = await this.ai.summarizeConversationMemory(contact, messages, previous);
      update({ status: "organizing", progress: 82, progressLabel: "正在归纳重要记忆与来源…" });
      const memories = this.store.replaceAutoCustomerMemories(chatId, result.memories);
      const latestNow = this.store.getLatestMessage(chatId);
      const receivedNewMessage = Number(latestNow?.createdAt || 0) > Number(latest?.createdAt || 0);
      const automaticCount = memories.filter((memory) => memory.source === "ai").length;
      const finalSummary = update({
        status: receivedNewMessage ? "dirty" : "ready",
        progress: receivedNewMessage ? 96 : 100,
        progressLabel: receivedNewMessage ? "本轮已整理，又收到新消息" : "长期记忆已更新",
        currentScene: result.currentScene,
        historySummary: result.historySummary,
        processedThroughMessageId: latest?.id || "",
        processedThroughAt: latest?.createdAt || 0,
        latestMessageAt: latestNow?.createdAt || latest?.createdAt || 0,
        messageCount: messages.length,
        extractedCount: automaticCount,
        error: ""
      });
      if (receivedNewMessage) this.scheduleConversationMemory(chatId, 15000);
      return finalSummary;
    } catch (error) {
      update({ status: "error", progress: 0, progressLabel: "整理失败，可重新尝试", error: error.message });
      throw error;
    }
  }

  startConversationMemoryOrganization(chatId, options = {}) {
    if (this.memoryJobs.has(chatId)) return { started: false, memorySummary: this.store.getConversationMemory(chatId) };
    const job = this.organizeConversationMemory(chatId, options)
      .catch((error) => this.publish("error", { chatId, message: `长期记忆整理失败：${error.message}` }))
      .finally(() => this.memoryJobs.delete(chatId));
    this.memoryJobs.set(chatId, job);
    return { started: true, memorySummary: this.store.getConversationMemory(chatId) };
  }

  scheduleConversationMemory(chatId, delay = 60000) {
    const summary = this.store.getConversationMemory(chatId);
    if (!summary.currentScene && !summary.historySummary && !summary.updatedAt) return;
    if (this.memoryTimers.has(chatId)) clearTimeout(this.memoryTimers.get(chatId));
    const timer = setTimeout(() => {
      this.memoryTimers.delete(chatId);
      this.startConversationMemoryOrganization(chatId);
    }, Math.max(1000, Number(delay) || 60000));
    timer.unref?.();
    this.memoryTimers.set(chatId, timer);
  }

  updateConversationMemorySummary(chatId, data = {}) {
    const memorySummary = this.store.updateConversationMemory(chatId, {
      currentScene: data.currentScene,
      historySummary: data.historySummary,
      manuallyEdited: true,
      status: "ready",
      progress: 100,
      progressLabel: "人工编辑已保存",
      error: ""
    });
    const contact = this.store.getContact(chatId);
    this.publish("memory-summary", { chatId, accountId: contact?.accountId, memorySummary });
    return memorySummary;
  }

  async ingest(message) {
    if (isSystemConversation(message)) {
      this.publish("message-ignored", { accountId: message.accountId, reason: "WhatsApp 官方或系统消息" });
      return { inserted: false, ignored: true, reason: "system-message" };
    }
    const providerChatId = message.chatId;
    const conversationId = conversationKey(message.accountId, providerChatId);
    this.store.upsertContact(conversationId, {
      accountId: message.accountId || "primary",
      accountName: message.accountName || "主账号",
      providerChatId,
      profileName: message.profileName || providerChatId.replace(/@.+$/, ""),
      phone: providerChatId.replace(/@.+$/, "")
    });
    const result = this.store.addMessage({ ...message, chatId: conversationId, providerChatId, direction: "inbound", status: "received" });
    if (!result.inserted) return result;
    this.publish("message", { chatId: conversationId, accountId: message.accountId, message: result.message });
    let queuedMessage = result.message;
    if (["image", "video"].includes(message.type) && message.media?.data) queuedMessage = this.cacheInboundMedia(queuedMessage, message.media);
    this.queueMessage(queuedMessage, this.store.getAccountAutomation(message.accountId).enabled ? "等待按账号顺序回复" : "账号 AI 回复已关闭");
    this.scheduleConversationMemory(conversationId);
    if (this.store.getAccountAutomation(message.accountId).enabled) await this.runAccountQueue(message.accountId);
    return result;
  }

  cacheInboundMedia(message, media) {
    const fields = this.persistMedia(message, media);
    const updated = this.store.updateMessage(message.id, fields, { chatId: message.chatId });
    return updated || message;
  }

  persistMedia(message, media) {
    const mimeType = media?.mimeType || message.mimeType || (message.type === "video" ? "video/mp4" : "image/jpeg");
    const filename = `${String(message.id).replace(/[^a-zA-Z0-9_-]/g, "_")}${extension(mimeType)}`;
    const localMediaPath = path.join(this.mediaDir, filename);
    fs.writeFileSync(localMediaPath, Buffer.from(media.data, "base64"));
    return { localMediaPath, mediaUrl: `/media/${encodeURIComponent(filename)}`, mimeType };
  }

  async recoverMessageMedia(chatId, messageId) {
    const message = this.store.getMessage(chatId, messageId);
    if (!message) throw Object.assign(new Error("媒体消息不存在"), { statusCode: 404 });
    if (!["image", "video"].includes(message.type)) throw Object.assign(new Error("这不是图片或视频消息"), { statusCode: 400 });
    let updated = message;
    if (!message.localMediaPath || !fs.existsSync(message.localMediaPath)) {
      const media = await this.session.downloadMessageMedia(message.accountId, message.id);
      updated = this.cacheInboundMedia(message, media);
    }
    if (message.type === "image") {
      for (const quote of this.store.listQuotes("all", message.chatId)) {
        if (quote.inboundMessageId !== message.id || quote.imageMediaUrl === updated.mediaUrl) continue;
        const nextQuote = this.store.updateQuote(quote.id, { imageMediaUrl: updated.mediaUrl });
        this.publish("quote", { chatId: message.chatId, quote: nextQuote });
      }
    }
    this.publish("message", { chatId: message.chatId, accountId: message.accountId, message: updated });
    return updated;
  }

  updateAutomation(message, state, patch = {}) {
    const updated = this.store.updateMessage(message.id, {
      metadata: {
        ...(message.metadata || {}),
        automationState: state,
        automationAt: Date.now(),
        ...patch
      }
    }, { chatId: message.chatId });
    if (updated) this.publish("message", { chatId: message.chatId, accountId: message.accountId, message: updated });
    return updated;
  }

  async processAndRecord(message, media, mediaError = "", options = {}) {
    this.updateAutomation(message, "processing", { automationReason: options.catchUp ? "断线后补回复" : "" });
    try {
      const result = await this.process(message, media, mediaError, options) || { state: "ignored", reason: "无需自动处理" };
      this.updateAutomation(message, result.state, {
        automationReason: result.reason || "",
        automationSource: result.source || (options.catchUp ? "catch-up" : options.manualTrigger ? "manual-ai" : options.accountQueue ? "account-queue" : "live")
      });
      if (result.state === "replied") {
        const contact = this.store.getContact(message.chatId);
        if (contact?.mode !== "human" && contact?.needsHuman && contact.handoffMessageId === message.id) {
          const openQuote = this.store.listQuotes("all", message.chatId)
            .filter((quote) => ["pending", "approved"].includes(quote.status))
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          if (openQuote) this.store.requestHuman(message.chatId, "图片报价待审核", openQuote.inboundMessageId);
          else this.store.resolveHuman(message.chatId);
        }
      }
      return result;
    } catch (error) {
      this.updateAutomation(message, "failed", { automationReason: error.message });
      throw error;
    }
  }

  async process(message, media, mediaError = "", options = {}) {
    if (isSystemConversation(message)) return { state: "ignored", reason: "WhatsApp 官方或系统消息" };
    const contact = this.store.getContact(message.chatId);
    if (!contact) return { state: "ignored", reason: "会话不存在" };
    const paymentHandoffPending = contact.needsHuman
      && contact.handoffMessageId
      && contact.escalationReason === HUMAN_TRIGGERS[1].reason;
    if (paymentHandoffPending && message.id === contact.handoffMessageId) {
      return { state: "handoff", reason: contact.escalationReason || "关键节点正在等待人工处理" };
    }
    if (!options.manualTrigger && contact.mode === "human") {
      return { state: "handoff", reason: contact.escalationReason || "当前由人工接管" };
    }
    if (message.type === "video") {
      const reason = "客户发送了视频，请人工查看后回复";
      this.store.requestHuman(message.chatId, reason, message.id);
      this.publish("handoff", { chatId: message.chatId, reason });
      return { state: "handoff", reason };
    }
    if (message.type === "image") {
      const quote = await this.processImage(message, media, mediaError);
      return {
        state: "quote_pending",
        source: quote.quoteType === "factory_inquiry" ? "factory-inquiry" : "image-quote",
        reason: quote.quoteType === "factory_inquiry"
          ? quote.acknowledgementSentMessageId
            ? "共享货源没有可用价格，已告知客户并转人工询厂"
            : "共享货源没有可用价格，已建立询厂任务；为避免错序未越过后续客户消息发送话术"
          : "图片报价已进入待审核"
      };
    }
    const criticalTrigger = HUMAN_TRIGGERS.find((item) => item.alwaysHuman && item.pattern.test(message.body));
    if (criticalTrigger) {
      this.store.requestHuman(message.chatId, criticalTrigger.reason, message.id);
      this.publish("handoff", { chatId: message.chatId, reason: criticalTrigger.reason });
      return { state: "handoff", reason: criticalTrigger.reason };
    }
    if (isManosLead(message)) {
      await this.sendText(message.chatId, MANOS_LEAD_WELCOME, {
        source: "lead-welcome",
        replyToId: message.id,
        metadata: { campaign: "ManosID", fixedWelcome: true }
      });
      return { state: "replied", source: "lead-welcome", reason: "ManosID 正常广告询盘" };
    }
    const context = this.store.getContext(message.chatId, message.body)
      .filter((item) => item.id === message.id || item.createdAt <= message.createdAt);
    const isFirstConversationMessage = context.every((item) => item.id === message.id);
    if (isFirstConversationMessage && isGreeting(message)) {
      await this.sendText(message.chatId, NEW_CUSTOMER_WELCOME, {
        source: "new-customer-welcome",
        replyToId: message.id,
        metadata: { deterministic: true, firstContact: true }
      });
      return { state: "replied", source: "new-customer-welcome", reason: "新客户首次招呼已即时回复" };
    }
    if (isIdentityQuestion(message.body)) {
      await this.sendText(message.chatId, customerServiceIdentityReply(message.body), {
        source: "identity-policy",
        replyToId: message.id,
        metadata: { deterministic: true, identityProtected: true }
      });
      return { state: "replied", source: "identity-policy", reason: "按客服身份规则继续接待客户" };
    }
    const configuredStyle = this.store.getAccountStyle(message.accountId);
    const careReply = customerCareReply(message.body, configuredStyle);
    if (careReply) {
      if (this.store.hasLaterOutbound(message.chatId, message.createdAt, message.id)) {
        return { state: "superseded", reason: "人工已经回复，本次闲聊关怀已取消" };
      }
      await this.sendText(message.chatId, careReply, {
        source: "customer-care",
        replyToId: message.id,
        metadata: { deterministic: true, personaAware: true }
      });
      return { state: "replied", source: "customer-care", reason: "已根据账号性格直接回应客户的闲聊内容" };
    }
    const intent = manualKnowledgeIntent(message.body);
    const learnedReplies = isPriceQuestion(message.body) ? [] : this.store.findLearnedReplies(message.accountId, message.body, intent);
    const trigger = HUMAN_TRIGGERS.find((item) => !item.alwaysHuman && item.pattern.test(message.body));
    if (trigger && !learnedReplies.length) {
      this.store.requestHuman(message.chatId, trigger.reason, message.id);
      this.publish("handoff", { chatId: message.chatId, reason: trigger.reason });
      return { state: "handoff", reason: trigger.reason };
    }
    if (isAlbumFollowUp(message, context)) {
      await this.sendText(message.chatId, MANOS_ALBUM_FOLLOW_UP, {
        source: "album-follow-up",
        replyToId: message.id,
        metadata: { deterministic: true, contextCount: context.length }
      });
      return { state: "replied", source: "album-follow-up", reason: "客户确认立即查看相册" };
    }
    if (isSizeQuestion(message.body)) {
      const sizeReply = await this.replyFromSupplierFacts(message);
      if (sizeReply) return { state: "replied", source: "supplier-specification", reason: "已从多个相似微店货源描述归集尺寸并专业回复" };
    }
    const accountStyle = await this.ensureAccountStyle(message.accountId);
    if (accountStyle.status !== "ready" || !accountStyle.summary) {
      const reason = "服务账号的语言风格尚未完成，请先在 AI 页面确认或填写";
      this.store.requestHuman(message.chatId, reason, message.id);
      this.publish("handoff", { chatId: message.chatId, accountId: message.accountId, reason });
      return { state: "handoff", reason };
    }
    if (isCasualMessage(message.body)) {
      const contextualReply = prefersContextualCasualReply(message.body);
      let generatedByLocalModel = false;
      let casualReply = contextualReply ? casualFallbackReply(message.body, accountStyle, context) : "";
      if (!casualReply) {
        try {
          casualReply = await this.ai.casualReply(message.body, accountStyle, [...this.memoryContextForAI(message.chatId, 8), ...context]);
          generatedByLocalModel = Boolean(casualReply);
        } catch (error) {
          casualReply = "";
        }
      }
      if (!casualReply) {
        casualReply = casualFallbackReply(message.body, accountStyle, context);
      }
      if (this.store.hasLaterOutbound(message.chatId, message.createdAt, message.id)) {
        return { state: "superseded", reason: "人工已经回复，本次闲聊关怀已取消" };
      }
      await this.sendText(message.chatId, casualReply, {
        source: "customer-care",
        replyToId: message.id,
        metadata: { personaAware: true, generatedByLocalModel, contextualReply: !generatedByLocalModel }
      });
      if (isCallRequest(message.body)) {
        const reason = "客户希望电话或视频通话，需要人工确认时间";
        this.store.requestHuman(message.chatId, reason, message.id);
        this.publish("handoff", { chatId: message.chatId, reason });
        return { state: "handoff", source: "customer-care", reason };
      }
      return { state: "replied", source: "customer-care", reason: "本地模型已按账号性格回应客户闲聊" };
    }
    const ruleReply = answerFromManualRules(message.body, accountStyle);
    if (ruleReply) {
      if (this.store.hasLaterOutbound(message.chatId, message.createdAt, message.id)) {
        return { state: "superseded", reason: "人工已经回复，本次账号规则回复已取消" };
      }
      await this.sendText(message.chatId, ruleReply, {
        source: "account-rule",
        replyToId: message.id,
        metadata: { deterministic: true, ruleGrounded: true }
      });
      return { state: "replied", source: "account-rule", reason: "直接使用人工确认的账号业务规则" };
    }
    const trustedLearnedReply = learnedReplies.find((item) => item.score >= 4);
    if (trustedLearnedReply) {
      await this.sendText(message.chatId, trustedLearnedReply.answer, {
        source: "human-memory",
        replyToId: message.id,
        metadata: { learnedReplyId: trustedLearnedReply.id, learnedScore: trustedLearnedReply.score }
      });
      return { state: "replied", source: "human-memory", reason: "复用此前人工确认的相似问答" };
    }
    let decision;
    let usedCustomerMemoryIds = [];
    try {
      const memoryKeywords = contextKeywords(message.body);
      const customerMemories = this.store.listCustomerMemories(message.chatId, { includeDisabled: false, limit: 60 })
        .map((item, index) => ({
          ...item,
          relevance: memoryKeywords.reduce((score, keyword) => score + (item.text.toLowerCase().includes(keyword) ? 1 : 0), 0),
          recency: index
        }))
        .sort((a, b) => b.relevance - a.relevance || a.recency - b.recency)
        .slice(0, 16);
      usedCustomerMemoryIds = customerMemories.map((item) => item.id);
      const learnedContext = learnedReplies.flatMap((item) => [
        { id: `${item.id}-question`, direction: "inbound", type: "text", body: item.question, metadata: { source: "human-knowledge-question", learnedId: item.id } },
        { id: `${item.id}-answer`, direction: "outbound", type: "text", body: item.answer, metadata: { source: "human-knowledge", learnedId: item.id } }
      ]);
      decision = await this.ai.decide(contact, [...this.memoryContextForAI(message.chatId, 16), ...learnedContext, ...context], accountStyle);
    } catch (error) {
      this.store.requestHuman(message.chatId, `本地 AI 不可用：${error.message}`, message.id);
      this.publish("handoff", { chatId: message.chatId, reason: `本地 AI 不可用：${error.message}` });
      return { state: "handoff", reason: `本地 AI 不可用：${error.message}` };
    }
    if (decision.action !== "reply" || decision.confidence < 0.65 || !decision.reply) {
      const reason = decision.reason || "AI 置信度不足";
      this.store.requestHuman(message.chatId, reason, message.id);
      this.publish("handoff", { chatId: message.chatId, reason });
      return { state: "handoff", reason };
    }
    if (this.store.hasLaterOutbound(message.chatId, message.createdAt, message.id)) {
      return { state: "superseded", reason: "人工已经回复，本次 AI 发送已取消" };
    }
    await this.sendText(message.chatId, decision.reply, {
      source: "ai",
      replyToId: message.id,
      metadata: {
        confidence: decision.confidence,
        reason: decision.reason,
        contextCount: context.length,
        learnedReplyIds: learnedReplies.map((item) => item.id),
        customerMemoryIds: usedCustomerMemoryIds
      }
    });
    return { state: "replied", source: "ai", reason: decision.reason || "本地 AI 已回复" };
  }

  async catchUpRecentInbound(accountId) {
    if (!this.store.getAccountAutomation(accountId).enabled) return { accountId, count: 0, paused: true };
    const minutes = Math.min(Math.max(Number(this.store.getRuntimeSettings().catchUpWindowMinutes) || 180, 5), 1440);
    const candidates = this.store.listCatchUpCandidates(accountId, Date.now() - minutes * 60000)
      .filter((message) => {
        const contact = this.store.getContact(message.chatId);
        return contact && !contact.isSystem && !isSystemConversation(contact) && contact.mode === "auto";
      });
    for (const message of candidates) {
      this.queueMessage(message, "断线期间的新消息已加入账号队列");
    }
    if (candidates.length) await this.runAccountQueue(accountId);
    if (candidates.length) this.publish("catch-up", { accountId, count: candidates.length });
    return { accountId, count: candidates.length };
  }

  async replyToMessage(chatId, messageId) {
    const message = this.store.getMessage(chatId, messageId);
    if (!message) throw Object.assign(new Error("客户消息不存在"), { statusCode: 404 });
    if (message.direction !== "inbound") throw Object.assign(new Error("只能对客户发来的消息使用 AI 回复"), { statusCode: 400 });
    if (isSystemConversation({ ...this.store.getContact(chatId), ...message })) throw Object.assign(new Error("已过滤 WhatsApp 官方或系统消息"), { statusCode: 400 });
    if (this.store.hasLaterOutbound(chatId, message.createdAt, message.id)) throw Object.assign(new Error("该消息之后已经发送过回复，请勿重复发送"), { statusCode: 409 });
    if (message.metadata?.automationState === "processing") throw Object.assign(new Error("这条消息正在生成回复"), { statusCode: 409 });
    if (["replied", "quote_pending"].includes(message.metadata?.automationState)) throw Object.assign(new Error("这条消息已经处理，请勿重复发送"), { statusCode: 409 });
    return this.enqueue(chatId, () => this.processAndRecord(message, null, "历史图片无法自动重新下载", { manualTrigger: true }));
  }

  async processImage(message, media, mediaError = "") {
    let localMediaPath = message.localMediaPath || "";
    let mediaUrl = message.mediaUrl || "";
    let mimeType = media?.mimeType || message.mimeType || "image/jpeg";
    let error = mediaError || "";
    let products = [];
    let searchStatus = "completed";
    try {
      if (media?.data) {
        const cached = this.cacheInboundMedia(message, media);
        localMediaPath = cached.localMediaPath;
        mediaUrl = cached.mediaUrl;
        mimeType = cached.mimeType;
      }
      if (!localMediaPath || !fs.existsSync(localMediaPath)) {
        const recovered = await this.recoverMessageMedia(message.chatId, message.id);
        localMediaPath = recovered.localMediaPath;
        mediaUrl = recovered.mediaUrl;
        mimeType = recovered.mimeType || mimeType;
      }
      products = await this.supplier.search(localMediaPath, mimeType);
      searchStatus = products.some((item) => item.cost > 0) ? "priced" : (products.length ? "no_price" : "no_match");
      error = "";
    } catch (searchError) {
      error = searchError.message;
      searchStatus = "error";
    }
    const estimate = this.supplier.calculate(products);
    const pricedProducts = products.map((product) => ({
      ...product,
      suggestedPrice: product.cost > 0 ? this.supplier.calculate([product]).suggestedPrice : 0,
      quoteCurrency: estimate.currency
    }));
    const productFacts = aggregateProductFacts(pricedProducts);
    const customerLanguage = this.store.inferCustomerLanguage(message.chatId, message.id);
    const templateLanguage = customerLanguage === "zh" ? "zh" : "en";
    const template = estimate.suggestedPrice > 0
      ? pricedQuoteDraft(message, estimate, productFacts, templateLanguage)
      : factoryPriceAcknowledgement(message, templateLanguage);
    const localized = await this.localizeQuoteDraft(template, templateLanguage, customerLanguage);
    const acknowledgement = estimate.suggestedPrice > 0 ? "" : localized.text;
    const draftReply = estimate.suggestedPrice > 0 ? localized.text : acknowledgement;
    let quote = this.store.createQuote({
      chatId: message.chatId,
      inboundMessageId: message.id,
      imageMediaUrl: mediaUrl,
      quoteType: estimate.suggestedPrice > 0 ? "priced" : "factory_inquiry",
      supplier: "微店共享货源",
      searchStatus,
      products: pricedProducts,
      productFacts,
      basePriceCny: estimate.suggestedPrice,
      ...estimate,
      draftReply,
      acknowledgement,
      replyLanguage: "auto",
      customerLanguage,
      draftLanguage: localized.language,
      error
    });
    if (quote.quoteType === "factory_inquiry") {
      if (this.store.hasLaterInbound(message.chatId, message.createdAt, message.id)) {
        quote = this.store.updateQuote(quote.id, {
          acknowledgementDeferred: true,
          acknowledgementDeferredReason: "客户之后已有更新消息，为避免错序未自动发送询厂话术"
        });
      } else {
        try {
          const sent = await this.sendText(message.chatId, acknowledgement, {
            source: "factory-inquiry",
            replyToId: message.id,
            metadata: { quoteId: quote.id, supplier: quote.supplier, searchStatus }
          });
          quote = this.store.updateQuote(quote.id, { acknowledgementSentMessageId: sent.id, acknowledgementDeferred: false, acknowledgementDeferredReason: "" });
        } catch (sendError) {
          quote = this.store.updateQuote(quote.id, { error: [error, `告知客户失败：${sendError.message}`].filter(Boolean).join("；") });
        }
      }
    }
    this.publish("quote", { chatId: message.chatId, quote });
    return quote;
  }

  async retryQuoteSearch(id) {
    let quote = this.store.getQuote(id);
    if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
    if (!["pending", "approved"].includes(quote.status)) throw Object.assign(new Error("只有待审核报价可以重新搜图"), { statusCode: 409 });
    let message = this.store.getMessage(quote.chatId, quote.inboundMessageId);
    if (!message) throw Object.assign(new Error("原始图片消息不存在"), { statusCode: 404 });
    message = await this.recoverMessageMedia(quote.chatId, quote.inboundMessageId);
    try {
      const products = await this.supplier.search(message.localMediaPath, message.mimeType);
      const estimate = this.supplier.calculate(products);
      const pricedProducts = products.map((product) => ({
        ...product,
        suggestedPrice: product.cost > 0 ? this.supplier.calculate([product]).suggestedPrice : 0,
        quoteCurrency: estimate.currency
      }));
      const productFacts = aggregateProductFacts(pricedProducts);
      const priced = estimate.suggestedPrice > 0;
      const customerLanguage = quote.customerLanguage || this.store.inferCustomerLanguage(message.chatId, message.id);
      const targetLanguage = quote.replyLanguage && quote.replyLanguage !== "auto" ? quote.replyLanguage : customerLanguage;
      const templateLanguage = targetLanguage === "zh" ? "zh" : "en";
      const template = priced
        ? pricedQuoteDraft(message, estimate, productFacts, templateLanguage)
        : factoryPriceAcknowledgement(message, templateLanguage);
      const localized = await this.localizeQuoteDraft(template, templateLanguage, targetLanguage);
      const acknowledgement = priced ? "" : localized.text;
      quote = this.store.updateQuote(quote.id, {
        imageMediaUrl: message.mediaUrl,
        quoteType: priced ? "priced" : "factory_inquiry",
        supplier: "微店共享货源",
        searchStatus: priced ? "priced" : (products.length ? "no_price" : "no_match"),
        products: pricedProducts,
        productFacts,
        basePriceCny: estimate.suggestedPrice,
        ...estimate,
        draftReply: localized.text,
        acknowledgement,
        customerLanguage,
        draftLanguage: localized.language,
        error: ""
      });
      if (!priced && !quote.acknowledgementSentMessageId) {
        if (this.store.hasLaterInbound(message.chatId, message.createdAt, message.id)) {
          quote = this.store.updateQuote(quote.id, {
            acknowledgementDeferred: true,
            acknowledgementDeferredReason: "客户之后已有更新消息，为避免错序未自动发送询厂话术"
          });
        } else {
          const sent = await this.sendText(message.chatId, acknowledgement, {
            source: "factory-inquiry",
            replyToId: message.id,
            metadata: { quoteId: quote.id, supplier: quote.supplier, searchStatus: quote.searchStatus }
          });
          quote = this.store.updateQuote(quote.id, { acknowledgementSentMessageId: sent.id, acknowledgementDeferred: false, acknowledgementDeferredReason: "" });
        }
      }
      this.publish("quote", { chatId: quote.chatId, quote });
      return quote;
    } catch (error) {
      quote = this.store.updateQuote(quote.id, { searchStatus: "error", error: error.message });
      this.publish("quote", { chatId: quote.chatId, quote });
      throw error;
    }
  }

  async replyFromSupplierFacts(message) {
    let quote = this.store.listQuotes("all", message.chatId)[0];
    if (!quote) return "";
    let facts = quote.productFacts || aggregateProductFacts(quote.products || []);
    if (!facts?.dimensions) {
      try {
        let sourceMessage = this.store.getMessage(quote.chatId, quote.inboundMessageId);
        if (!sourceMessage || sourceMessage.type !== "image") return "";
        sourceMessage = await this.recoverMessageMedia(quote.chatId, quote.inboundMessageId);
        const products = await this.supplier.search(sourceMessage.localMediaPath, sourceMessage.mimeType);
        const estimate = this.supplier.calculate(products);
        const pricedProducts = products.map((product) => ({
          ...product,
          suggestedPrice: product.cost > 0 ? this.supplier.calculate([product]).suggestedPrice : 0,
          quoteCurrency: estimate.currency
        }));
        facts = aggregateProductFacts(pricedProducts);
        quote = this.store.updateQuote(quote.id, { products: pricedProducts, productFacts: facts }) || quote;
        this.publish("quote", { chatId: quote.chatId, quote });
      } catch (_) {
        return "";
      }
    } else if (!quote.productFacts) {
      quote = this.store.updateQuote(quote.id, { productFacts: facts }) || quote;
      this.publish("quote", { chatId: quote.chatId, quote });
    }
    const reply = supplierSizeReply(message, facts);
    if (!reply) return "";
    await this.sendText(message.chatId, reply, {
      source: "supplier-specification",
      replyToId: message.id,
      metadata: { quoteId: quote.id, supplier: quote.supplier, groundedInSupplierDescriptions: true }
    });
    return reply;
  }

  async localizeQuoteDraft(text, sourceLanguage, targetLanguage) {
    const source = String(sourceLanguage || "en").toLowerCase().split("-")[0];
    const target = String(targetLanguage || source).toLowerCase().split("-")[0];
    if (!QUOTE_REPLY_LANGUAGES.includes(target) || target === "auto" || target === source) {
      return { text: String(text || ""), language: source };
    }
    try {
      const translated = await this.ai.translate(text, target);
      if (translated) return { text: translated, language: target };
    } catch (error) {
      // Keep a usable draft if the local translation model is temporarily unavailable.
    }
    return { text: String(text || ""), language: source };
  }

  async translateText(text, targetLanguage = "auto", chatId = "") {
    const input = String(text || "").trim();
    if (!input) throw Object.assign(new Error("翻译内容不能为空"), { statusCode: 400 });
    if (input.length > 5000) throw Object.assign(new Error("单次翻译内容不能超过 5000 个字符"), { statusCode: 400 });
    const supported = new Set(["en", "fr", "es", "de", "it", "pt", "ar", "ru", "ja", "ko"]);
    let resolvedLanguage = String(targetLanguage || "auto").toLowerCase().split("-")[0];
    if (resolvedLanguage === "auto") {
      const context = chatId && this.store.getContact(chatId)
        ? this.store.listMessages(chatId, { limit: 80, markRead: false }).filter((message) => message.direction === "inbound" && message.body).at(-1)?.body
        : "";
      resolvedLanguage = detectLanguage(context || "");
      if (resolvedLanguage === "zh") resolvedLanguage = "en";
    }
    if (!supported.has(resolvedLanguage)) resolvedLanguage = "en";
    const translation = await this.ai.translate(input, resolvedLanguage);
    if (!translation) throw Object.assign(new Error("本地模型没有返回翻译结果"), { statusCode: 502 });
    return { translation, targetLanguage: resolvedLanguage };
  }

  async translateMessages(chatId, messageIds = []) {
    if (!this.store.getContact(chatId)) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const requested = new Set((Array.isArray(messageIds) ? messageIds : []).map(String).slice(0, 8));
    const candidates = this.store.listMessages(chatId, { limit: 200, markRead: false })
      .filter((message) => (!requested.size || requested.has(message.id))
        && Boolean(translatableMessageText(message))
        && Number(message.metadata?.translationVersion || 0) < TRANSLATION_VERSION)
      .slice(-8);
    const translated = [];
    for (const message of candidates) {
      const key = `${chatId}::${message.id}`;
      let job = this.translationJobs.get(key);
      if (!job) {
        job = this.ai.translate(translatableMessageText(message), "zh-CN")
          .then((translation) => {
            if (!translation) return null;
            const updated = this.store.updateMessage(message.id, {
              metadata: {
                ...(message.metadata || {}),
                zhTranslation: translation,
                translationProvider: "local",
                translationVersion: TRANSLATION_VERSION,
                translatedAt: Date.now()
              }
            }, { chatId });
            if (updated) this.publish("translation", { chatId, messageId: message.id });
            return updated;
          })
          .finally(() => this.translationJobs.delete(key));
        this.translationJobs.set(key, job);
      }
      const updated = await job;
      if (updated) translated.push(updated);
    }
    return translated;
  }

  async sendText(chatId, body, options = {}) {
    const rawText = String(body || "").trim();
    const repliedMessage = options.replyToId ? this.store.getMessage(chatId, options.replyToId) : null;
    const text = enforceCustomerServiceIdentity(rawText, repliedMessage?.body);
    if (!text) throw Object.assign(new Error("消息内容不能为空"), { statusCode: 400 });
    const contact = this.store.getContact(chatId);
    if (!contact) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const sent = await this.session.sendText(contact.accountId, contact.providerChatId, text);
    const sourceMetadata = { source: options.source || "human", ...(options.metadata || {}) };
    const latestMessage = this.store.getLatestMessage(chatId);
    const orderedCreatedAt = Math.max(Number(sent.createdAt) || Date.now(), Date.now(), repliedMessage ? Number(repliedMessage.createdAt) + 1 : 0, latestMessage ? Number(latestMessage.createdAt) + 1 : 0);
    const existing = sent.id ? this.store.getMessage(chatId, sent.id) : null;
    if (existing) {
      const reconciled = this.store.updateMessage(existing.id, {
        body: text,
        direction: "outbound",
        status: existing.status || "sent",
        replyToId: options.replyToId || existing.replyToId || "",
        createdAt: orderedCreatedAt,
        metadata: { ...(existing.metadata || {}), ...sourceMetadata, reconciled: true }
      }, { chatId });
      this.publish("message", { chatId, message: reconciled });
      return reconciled;
    }
    if (sent.provisional) {
      const realEvent = this.store.findRecentOutbound(chatId, text, sent.createdAt);
      if (realEvent && !realEvent.metadata?.provisional) {
        const reconciled = this.store.updateMessage(realEvent.id, {
          replyToId: options.replyToId || realEvent.replyToId || "",
          createdAt: orderedCreatedAt,
          metadata: { ...(realEvent.metadata || {}), ...sourceMetadata, reconciled: true }
        }, { chatId });
        this.publish("message", { chatId, message: reconciled });
        return reconciled;
      }
    }
    const row = this.store.addMessage({
      id: sent.id || `out-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      chatId,
      accountId: contact.accountId,
      accountName: contact.accountName,
      providerChatId: contact.providerChatId,
      direction: "outbound",
      type: "text",
      body: text,
      status: "sent",
      replyToId: options.replyToId || "",
      metadata: sourceMetadata,
      createdAt: orderedCreatedAt
    }).message;
    if (sent.provisional) {
      row.metadata = { ...(row.metadata || {}), provisional: true };
      this.store.updateMessage(row.id, { metadata: row.metadata }, { chatId });
    }
    this.publish("message", { chatId, message: row });
    return row;
  }

  async sendManualReply(chatId, body) {
    const contact = this.store.getContact(chatId);
    if (!contact) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const target = contact.needsHuman && contact.handoffMessageId
      ? this.store.getMessage(chatId, contact.handoffMessageId)
      : this.store.getLatestInboundForReply(chatId);
    const sent = await this.sendText(chatId, body, {
      source: "human",
      replyToId: target?.id || "",
      metadata: { manualWorkspaceReply: true, learnedFromMessageId: target?.id || "" }
    });
    let learned = null;
    if (target && !isPriceQuestion(target.body) && !isPriceQuestion(sent.body) && !isPaymentQuestion(target.body) && !isPaymentQuestion(sent.body)) {
      learned = this.store.learnManualReply({
        accountId: contact.accountId,
        chatId,
        question: target.body,
        answer: sent.body,
        intent: manualKnowledgeIntent(target.body),
        sourceMessageId: target.id,
        replyMessageId: sent.id
      });
    }
    if (target) {
      this.updateAutomation(target, "replied", {
        automationReason: learned ? "人工已回复并加入本地问答记忆" : "人工已回复；价格内容不加入自动学习",
        automationSource: "human"
      });
    }
    const hasOpenQuote = this.store.listQuotes("all", chatId).some((quote) => ["pending", "approved"].includes(quote.status));
    const resolvedHandoff = !contact.handoffMessageId || target?.id === contact.handoffMessageId;
    if (!hasOpenQuote && resolvedHandoff) this.store.resolveHuman(chatId);
    this.publish("learning", { chatId, accountId: contact.accountId, learned, resumed: !hasOpenQuote && resolvedHandoff });
    return { message: sent, learned, resumed: !hasOpenQuote && resolvedHandoff };
  }

  async sendManualMedia(chatId, media = {}) {
    const contact = this.store.getContact(chatId);
    if (!contact) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const mimeType = String(media.mimeType || "").toLowerCase().split(";")[0].trim();
    const type = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("video/") ? "video" : "";
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);
    if (!type || !allowed.has(mimeType)) throw Object.assign(new Error("仅支持 JPG、PNG、WEBP、GIF、MP4、WEBM、MOV 或 M4V"), { statusCode: 400 });
    const data = String(media.data || "").replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
    if (!data) throw Object.assign(new Error("附件内容为空"), { statusCode: 400 });
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length) throw Object.assign(new Error("附件内容无效"), { statusCode: 400 });
    if (buffer.length > 35 * 1024 * 1024) throw Object.assign(new Error("附件不能超过 35 MB"), { statusCode: 413 });
    const target = media.replyToId
      ? this.store.getMessage(chatId, media.replyToId)
      : contact.needsHuman && contact.handoffMessageId
        ? this.store.getMessage(chatId, contact.handoffMessageId)
        : this.store.getLatestInboundForReply(chatId);
    const caption = enforceCustomerServiceIdentity(String(media.caption || "").trim(), target?.body);
    const filename = String(media.filename || `${type}${extension(mimeType)}`).replace(/[\\/:*?"<>|]/g, "_").slice(0, 180);
    const sent = await this.session.sendMedia(contact.accountId, contact.providerChatId, { data, mimeType, filename, caption });
    const latestMessage = this.store.getLatestMessage(chatId);
    const createdAt = Math.max(Number(sent.createdAt) || Date.now(), Date.now(), target ? Number(target.createdAt) + 1 : 0, latestMessage ? Number(latestMessage.createdAt) + 1 : 0);
    const body = caption || (type === "video" ? "[发送视频]" : "[发送图片]");
    const sourceMetadata = { source: "human", manualWorkspaceReply: true, attachment: true, filename, provisional: Boolean(sent.provisional) };
    const cachedFields = this.persistMedia({ id: sent.id || `out-media-${Date.now()}`, type, mimeType }, { data, mimeType });
    const existing = sent.id ? this.store.getMessage(chatId, sent.id) : null;
    const row = existing
      ? this.store.updateMessage(existing.id, {
          ...cachedFields,
          type,
          body,
          direction: "outbound",
          status: existing.status || "sent",
          replyToId: target?.id || existing.replyToId || "",
          createdAt,
          metadata: { ...(existing.metadata || {}), ...sourceMetadata, reconciled: true }
        }, { chatId })
      : this.store.addMessage({
          id: sent.id || `out-media-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          chatId,
          accountId: contact.accountId,
          accountName: contact.accountName,
          providerChatId: contact.providerChatId,
          direction: "outbound",
          type,
          body,
          status: "sent",
          replyToId: target?.id || "",
          metadata: sourceMetadata,
          createdAt,
          ...cachedFields
        }).message;
    if (target && !media.deferResolution) this.updateAutomation(target, "replied", { automationReason: "人工已发送附件", automationSource: "human" });
    const hasOpenQuote = this.store.listQuotes("all", chatId).some((quote) => ["pending", "approved"].includes(quote.status));
    const resolvedHandoff = !contact.handoffMessageId || target?.id === contact.handoffMessageId;
    if (!media.deferResolution && !hasOpenQuote && resolvedHandoff) this.store.resolveHuman(chatId);
    this.publish("message", { chatId, accountId: contact.accountId, message: row });
    return { message: row, learned: null, resumed: !media.deferResolution && !hasOpenQuote && resolvedHandoff };
  }

  async sendManualMediaBatch(chatId, batch = {}) {
    const contact = this.store.getContact(chatId);
    if (!contact) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
    const items = Array.isArray(batch.items) ? batch.items : [];
    if (!items.length) throw Object.assign(new Error("请选择至少一个图片或视频"), { statusCode: 400 });
    if (items.length > 10) throw Object.assign(new Error("单次最多发送 10 个图片或视频"), { statusCode: 400 });
    const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v"]);
    let totalBytes = 0;
    const normalized = items.map((item, index) => {
      const mimeType = String(item?.mimeType || "").toLowerCase().split(";")[0].trim();
      if (!allowed.has(mimeType)) throw Object.assign(new Error(`第 ${index + 1} 个附件格式不受支持`), { statusCode: 400 });
      const data = String(item?.data || "").replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
      const bytes = Buffer.from(data, "base64").length;
      if (!data || !bytes) throw Object.assign(new Error(`第 ${index + 1} 个附件内容无效`), { statusCode: 400 });
      totalBytes += bytes;
      return { data, mimeType, filename: item.filename };
    });
    if (totalBytes > 35 * 1024 * 1024) throw Object.assign(new Error("一批附件合计不能超过 35 MB"), { statusCode: 413 });
    const target = contact.needsHuman && contact.handoffMessageId
      ? this.store.getMessage(chatId, contact.handoffMessageId)
      : this.store.getLatestInboundForReply(chatId);
    const messages = [];
    let failed = null;
    for (let index = 0; index < normalized.length; index += 1) {
      try {
        const result = await this.sendManualMedia(chatId, {
          ...normalized[index],
          caption: index === 0 ? String(batch.caption || "") : "",
          replyToId: target?.id || "",
          deferResolution: true
        });
        messages.push(result.message);
      } catch (error) {
        failed = { index, message: error.message || "WhatsApp 发送失败" };
        break;
      }
    }
    if (failed) return { messages, failed, learned: null, resumed: false };
    if (target) this.updateAutomation(target, "replied", { automationReason: `人工已发送 ${messages.length} 个附件`, automationSource: "human" });
    const hasOpenQuote = this.store.listQuotes("all", chatId).some((quote) => ["pending", "approved"].includes(quote.status));
    const resolvedHandoff = !contact.handoffMessageId || target?.id === contact.handoffMessageId;
    if (!hasOpenQuote && resolvedHandoff) this.store.resolveHuman(chatId);
    this.publish("learning", { chatId, accountId: contact.accountId, learned: null, resumed: !hasOpenQuote && resolvedHandoff });
    return { messages, learned: null, resumed: !hasOpenQuote && resolvedHandoff };
  }

  updateQuote(id, patch = {}) {
    const quote = this.store.getQuote(id);
    if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
    if (quote.status === "sent") throw Object.assign(new Error("已发送报价不能编辑"), { statusCode: 409 });
    let price = patch.suggestedPrice === undefined ? quote.suggestedPrice : Number(patch.suggestedPrice);
    if (!Number.isFinite(price) || price < 0) throw Object.assign(new Error("报价金额无效"), { statusCode: 400 });
    const replyLanguage = String(patch.replyLanguage ?? quote.replyLanguage ?? "auto").toLowerCase().split("-")[0];
    if (!QUOTE_REPLY_LANGUAGES.includes(replyLanguage)) throw Object.assign(new Error("不支持该报价回复语言"), { statusCode: 400 });
    const hasFormula = ["basePriceCny", "shippingCny", "profitRate", "exchangeRate"].some((key) => patch[key] !== undefined);
    let formula = {};
    if (hasFormula) {
      const currency = String(patch.currency ?? quote.currency ?? "USD").toUpperCase();
      const shippingCny = Number(patch.shippingCny ?? quote.shippingCny ?? 90);
      const profitRate = Number(patch.profitRate ?? quote.profitRate ?? 0.75);
      const exchangeRate = Number(patch.exchangeRate ?? quote.exchangeRate);
      if (!QUOTE_CURRENCIES.includes(currency)) throw Object.assign(new Error("报价币种只能选择 EUR、USD 或 GBP"), { statusCode: 400 });
      if (!SHIPPING_OPTIONS_CNY.includes(shippingCny)) throw Object.assign(new Error("运费只能选择 CNY 90、150、180 或 300"), { statusCode: 400 });
      if (!(profitRate >= 0.7 && profitRate <= 0.8)) throw Object.assign(new Error("利润率必须在 70% 到 80% 之间"), { statusCode: 400 });
      if (!(exchangeRate > 0)) throw Object.assign(new Error("当前币种汇率无效，请刷新报价页面"), { statusCode: 400 });
      formula = calculateFinalQuote({
        basePriceCny: Number(patch.basePriceCny ?? quote.basePriceCny ?? 0),
        shippingCny,
        profitRate,
        currency,
        rates: { [currency]: exchangeRate }
      });
      formula.rateDate = String(patch.rateDate || quote.rateDate || "");
      price = formula.suggestedPrice;
    }
    const updated = this.store.updateQuote(id, {
      suggestedPrice: price,
      ...(patch.currency !== undefined ? { currency: String(patch.currency) } : {}),
      ...formula,
      ...(patch.draftReply !== undefined ? { draftReply: String(patch.draftReply) } : {}),
      replyLanguage,
      ...(patch.draftLanguage !== undefined ? { draftLanguage: String(patch.draftLanguage) } : {}),
      ...(patch.reviewerNote !== undefined ? { reviewerNote: String(patch.reviewerNote) } : {})
    });
    this.publish("quote", { chatId: updated.chatId, quote: updated });
    return updated;
  }

  async translateQuote(id, patch = {}) {
    let quote = this.store.getQuote(id);
    if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
    if (!["pending", "approved"].includes(quote.status)) throw Object.assign(new Error("只有待审核报价可以转换语言"), { statusCode: 409 });
    const replyLanguage = String(patch.replyLanguage ?? quote.replyLanguage ?? "auto").toLowerCase().split("-")[0];
    if (!QUOTE_REPLY_LANGUAGES.includes(replyLanguage)) throw Object.assign(new Error("不支持该报价回复语言"), { statusCode: 400 });
    const editablePatch = { ...patch, replyLanguage: quote.replyLanguage };
    quote = this.updateQuote(id, editablePatch);
    const targetLanguage = replyLanguage === "auto" ? quote.customerLanguage : replyLanguage;
    if (!targetLanguage || !QUOTE_REPLY_LANGUAGES.includes(targetLanguage) || targetLanguage === "auto") {
      throw Object.assign(new Error("无法识别客户语言，请手动选择"), { statusCode: 400 });
    }
    let draftReply = quote.draftReply;
    let draftLanguage = quote.draftLanguage || detectLanguage(draftReply);
    if (draftLanguage !== targetLanguage) {
      const localized = await this.localizeQuoteDraft(draftReply, draftLanguage, targetLanguage);
      draftReply = localized.text;
      draftLanguage = localized.language;
      if (draftLanguage !== targetLanguage) throw Object.assign(new Error("本地模型暂时无法完成报价语言转换"), { statusCode: 502 });
    }
    quote = this.store.updateQuote(id, { replyLanguage, draftReply, draftLanguage });
    this.publish("quote", { chatId: quote.chatId, quote });
    return quote;
  }

  deleteQuote(id) {
    const quoteId = Number(id);
    if (this.approvals.has(quoteId)) throw Object.assign(new Error("该报价正在处理中，暂时不能删除"), { statusCode: 409 });
    const quote = this.store.getQuote(quoteId);
    if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
    const removed = this.store.deleteQuote(quoteId);
    this.clearHumanFlag(removed.chatId);
    this.publish("quote-deleted", { chatId: removed.chatId, quoteId });
    return removed;
  }

  async approveQuote(id, patch = {}) {
    const quoteId = Number(id);
    if (this.approvals.has(quoteId)) throw Object.assign(new Error("该报价正在审批发送，请勿重复操作"), { statusCode: 409 });
    this.approvals.add(quoteId);
    try {
      let quote = this.store.getQuote(quoteId);
      if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
      if (quote.status === "sent") throw Object.assign(new Error("该报价已经发送"), { statusCode: 409 });
      if (quote.status === "rejected") throw Object.assign(new Error("已驳回报价不能直接发送"), { statusCode: 409 });
      quote = this.updateQuote(quoteId, patch);
      if (quote.quoteType === "factory_inquiry" && !(Number(quote.basePriceCny) > 0)) {
        throw Object.assign(new Error("该商品仍无货源价格，请先填写工厂确认价并修改发送文案"), { statusCode: 400 });
      }
      if (!quote.draftReply.trim()) throw Object.assign(new Error("报价发送文案不能为空"), { statusCode: 400 });
      this.store.updateQuote(quoteId, { status: "approved", error: "" });
      const sent = await this.sendText(quote.chatId, quote.draftReply, {
        source: "quote-review",
        replyToId: quote.inboundMessageId,
        metadata: { quoteId, approvedPrice: quote.suggestedPrice, currency: quote.currency }
      });
      quote = this.store.updateQuote(quoteId, { status: "sent", sentMessageId: sent.id, error: "" });
      this.clearHumanFlag(quote.chatId);
      this.publish("quote", { chatId: quote.chatId, quote });
      return quote;
    } catch (error) {
      const current = this.store.getQuote(quoteId);
      if (current?.status === "approved" && !error.statusCode) this.store.updateQuote(quoteId, { error: `发送失败：${error.message}` });
      throw error;
    } finally {
      this.approvals.delete(quoteId);
    }
  }

  async rejectQuote(id, note = "") {
    const quoteId = Number(id);
    if (this.approvals.has(quoteId)) throw Object.assign(new Error("该报价正在处理中，请勿重复操作"), { statusCode: 409 });
    this.approvals.add(quoteId);
    try {
      let quote = this.store.getQuote(quoteId);
      if (!quote) throw Object.assign(new Error("报价不存在"), { statusCode: 404 });
      if (quote.status === "sent") throw Object.assign(new Error("已发送报价不能驳回"), { statusCode: 409 });
      if (quote.status === "rejected") throw Object.assign(new Error("该报价已经驳回并通知客户"), { statusCode: 409 });
      const inbound = this.store.getMessage(quote.chatId, quote.inboundMessageId);
      const targetLanguage = quote.replyLanguage && quote.replyLanguage !== "auto" ? quote.replyLanguage : quote.customerLanguage;
      const templateLanguage = targetLanguage === "zh" ? "zh" : "en";
      const rejectionTemplate = stockOutReply({ body: templateLanguage === "zh" ? "中文" : "English" });
      const localized = await this.localizeQuoteDraft(rejectionTemplate, templateLanguage, targetLanguage);
      const rejectionReply = localized.text;
      const sent = await this.sendText(quote.chatId, rejectionReply, {
        source: "quote-rejected",
        replyToId: quote.inboundMessageId,
        metadata: { quoteId, reason: "factory_out_of_stock" }
      });
      quote = this.store.updateQuote(quoteId, {
        status: "rejected",
        reviewerNote: String(note || ""),
        rejectionReply,
        rejectedMessageId: sent.id,
        error: ""
      });
      this.clearHumanFlag(quote.chatId);
      this.publish("quote", { chatId: quote.chatId, quote });
      return quote;
    } finally {
      this.approvals.delete(quoteId);
    }
  }

  clearHumanFlag(chatId) {
    const openQuotes = this.store.listQuotes("all", chatId).filter((quote) => ["pending", "approved"].includes(quote.status));
    const contact = this.store.getContact(chatId);
    if (!contact || contact.mode !== "auto") return;
    if (openQuotes.length) this.store.requestHuman(chatId, "图片报价待审核", openQuotes[0].inboundMessageId);
    else this.store.resolveHuman(chatId);
  }

  async status() {
    const session = this.session.getStatus();
    session.accounts = (session.accounts || []).map((account) => {
      const name = account.account?.name || account.label || account.accountId;
      this.store.ensureAccountAgent(account.accountId, `${name} 智能体`);
      return {
        ...account,
        style: this.store.getAccountStyle(account.accountId),
        automation: this.queueSnapshot(account.accountId)
      };
    });
    return {
      session,
      ai: await this.ai.health(),
      agents: this.store.listAgents(),
      supplierConfigured: Boolean(process.env.SUPPLIER_IMAGE_SEARCH_URL || this.store.getRuntimeSettings().supplierSearchUrl),
      stats: this.store.stats()
    };
  }

  async seedDemo() {
    const providerChatId = "8613800000000@c.us";
    const chatId = conversationKey("demo", providerChatId);
    this.store.upsertContact(chatId, { accountId: "demo", accountName: "演示账号", providerChatId, profileName: "示例客户 · Mia", phone: "+86 138 0000 0000", isDemo: true, labels: ["意向客户", "帆布包"] });
    const base = Date.now() - 10 * 60 * 1000;
    const rows = [
      { id: "demo-1", direction: "inbound", body: "你好，之前看的黑色帆布包还有吗？", createdAt: base },
      { id: "demo-2", direction: "outbound", body: "您好，您之前看的是加厚帆布、黑色基础款。具体库存我请同事确认一下。", createdAt: base + 60000 },
      { id: "demo-3", direction: "inbound", body: "如果做 200 个，可以印 logo 吗？", createdAt: base + 120000 }
    ];
    this.store.importHistory(chatId, "示例客户 · Mia", rows.map((row) => ({ ...row, type: "text", chatId, accountId: "demo", accountName: "演示账号", providerChatId })), 1);
    this.store.setConversationMode(chatId, "human", "定制与批量报价需要人工确认");
    this.publish("history", { chatId, inserted: rows.length });
    return chatId;
  }
}

module.exports = { SalesService, HUMAN_TRIGGERS, conversationKey, needsChineseTranslation, detectLanguage };
