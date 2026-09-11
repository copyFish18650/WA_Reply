const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { normalizeQuotationNotes, quotationNoteText } = require("./quotation-notes");

// Same logical canvas, 2x export scale, columns, colors and spacing as
// manos/src/views/ChatOrder.vue::generateQuotationBlob.
const SCALE = 2;
const CANVAS_WIDTH = 985;
const SINGLE_ITEM_HEIGHT = 456;
const ROW_HEIGHT = 110;
const WIDTH = CANVAS_WIDTH * SCALE;
const MANOS_LOGO_PATH = path.join(__dirname, "assets", "Manos_logo.png");
const FORMAT_VERSION = "manos-chat-order-multi-v2";

let logoDataUrl = "";

function xml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function languageOf(quote) {
  const selected = String(quote.replyLanguage || "auto").toLowerCase().split("-")[0];
  return selected === "auto"
    ? String(quote.customerLanguage || "en").toLowerCase().split("-")[0]
    : selected;
}

function currencySymbol(currency) {
  return ({ GBP: "£", EUR: "€", USD: "$", AUD: "A$" })[String(currency || "").toUpperCase()] || "£";
}

function amount(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "0";
  return numeric.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function dateLabel(timestamp) {
  const date = new Date(timestamp || Date.now());
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function localizedFact(value, language) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value[language] || value.en || value.zh || "");
}

function wrapLines(value, maxUnits, maxLines = 4) {
  const source = String(value || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const units = (text) => [...text].reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 2 : 1), 0);
  const words = /\s/.test(source) ? source.split(" ") : [...source];
  const separator = /\s/.test(source) ? " " : "";
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line}${separator}${word}` : word;
    if (line && units(candidate) > maxUnits) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.join(separator).length < source.length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.…]+$/, "")}…`;
  }
  return lines.slice(0, maxLines);
}

function centeredTextLines(lines, x, centerY, lineHeight, attributes = "") {
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  return lines.map((line, index) => `<text x="${x}" y="${startY + index * lineHeight}" ${attributes}>${xml(line)}</text>`).join("");
}

function resolveLocalMedia(mediaDir, mediaUrl) {
  const value = String(mediaUrl || "");
  if (!value.startsWith("/media/")) return "";
  const relative = decodeURIComponent(value.slice("/media/".length)).replace(/^[/\\]+/, "");
  const root = path.resolve(mediaDir);
  const candidate = path.resolve(root, relative);
  return candidate.startsWith(`${root}${path.sep}`) && fs.existsSync(candidate) ? candidate : "";
}

async function imageDataUrl(source, width, height) {
  if (!source || !fs.existsSync(source)) return "";
  try {
    const buffer = await sharp(source)
      .rotate()
      .resize(width, height, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 }, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } catch (_) {
    return "";
  }
}

async function productImageData(mediaDir, quote) {
  const direct = resolveLocalMedia(mediaDir, quote.imageMediaUrl);
  const messagePath = String(quote.sourceMediaPath || "");
  const source = direct || (messagePath && fs.existsSync(messagePath) ? messagePath : "");
  return imageDataUrl(source, 468, 188);
}

async function manosLogoData() {
  if (logoDataUrl) return logoDataUrl;
  logoDataUrl = await imageDataUrl(MANOS_LOGO_PATH, 240, 240);
  return logoDataUrl;
}

function quotationItems(quote) {
  const items = Array.isArray(quote.quotationItems) && quote.quotationItems.length ? quote.quotationItems : [quote];
  return items.map((item) => ({ ...item, quantity: Math.max(1, Number(item.quantity || 1)) }));
}

function quotationHash(quote, items) {
  return crypto.createHash("sha256").update(JSON.stringify({
    format: FORMAT_VERSION,
    id: quote.id,
    currency: quote.currency,
    items: items.map((item) => ({
      id: item.id,
      image: item.imageMediaUrl || "",
      price: item.suggestedPrice,
      outOfStock: Boolean(item.outOfStock),
      quantity: item.quantity,
      facts: item.productFacts || null,
      notes: normalizeQuotationNotes(item.quotationNotes, item.productFacts)
    }))
  })).digest("hex").slice(0, 12);
}

async function quotationRowMarkup(item, index, mediaDir, language) {
  const rowY = 246 + index * ROW_HEIGHT;
  const centerY = rowY + ROW_HEIGHT / 2 + 5;
  const productImage = await productImageData(mediaDir, item);
  const dimensions = localizedFact(item.productFacts?.dimensions, language);
  const outOfStock = Boolean(item.outOfStock);
  const notes = outOfStock
    ? (language === "zh" ? "缺货" : "Out of stock")
    : normalizeQuotationNotes(item.quotationNotes, item.productFacts)
      .map((note) => quotationNoteText(note, language))
      .filter(Boolean)
      .join(" · ");
  const sizeLines = wrapLines(dimensions, 13, 4);
  const noteLines = wrapLines(notes, 20, 4);
  const quantity = Math.max(1, Number(item.quantity || 1));
  const unitPrice = outOfStock ? 0 : Number(item.suggestedPrice || 0);
  const rowTotal = unitPrice * quantity;
  const productMarkup = productImage
    ? `<image href="${productImage}" x="28" y="${rowY + 8}" width="234" height="94" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  return `
    <rect x="20" y="${rowY}" width="945" height="110" fill="${index % 2 === 0 ? "#fff" : "#fafaf7"}" stroke="#c9a84c" stroke-width="0.5"/>
    <path d="M270 ${rowY}V${rowY + 110}M400 ${rowY}V${rowY + 110}M510 ${rowY}V${rowY + 110}M640 ${rowY}V${rowY + 110}M755 ${rowY}V${rowY + 110}" stroke="#c9a84c" stroke-width="0.5"/>
    ${productMarkup}
    ${centeredTextLines(sizeLines, 335, centerY, 20, 'class="cell"')}
    <text x="455" y="${centerY + 5}" class="cell">${xml(quantity)}</text>
    <text x="575" y="${centerY + 5}" class="cell">${outOfStock ? "" : xml(amount(unitPrice))}</text>
    <text x="697.5" y="${centerY + 5}" class="cell">${outOfStock ? "" : xml(amount(rowTotal))}</text>
    ${centeredTextLines(noteLines, 860, centerY, 20, 'class="cell"')}`;
}

async function generateQuotationImage({ quote, mediaDir, force = false }) {
  const items = quotationItems(quote);
  const itemCount = items.length;
  const canvasHeight = SINGLE_ITEM_HEIGHT + (itemCount - 1) * ROW_HEIGHT;
  const height = canvasHeight * SCALE;
  const currency = String(quote.currency || items[0]?.currency || "GBP").toUpperCase();
  const symbol = currencySymbol(currency);
  const availableItems = items.filter((item) => !item.outOfStock);
  const total = availableItems.reduce((sum, item) => sum + Number(item.suggestedPrice || 0) * Math.max(1, Number(item.quantity || 1)), 0);
  const hash = quotationHash(quote, items);
  const filename = `manos-quotation-${String(quote.id).padStart(4, "0")}-${hash}.png`;
  const outputDir = path.join(mediaDir, "quotations");
  const outputPath = path.join(outputDir, filename);
  const mediaUrl = `/media/quotations/${encodeURIComponent(filename)}`;
  if (!force && fs.existsSync(outputPath)) {
    return { buffer: fs.readFileSync(outputPath), filename, outputPath, mediaUrl, mimeType: "image/png", width: WIDTH, height, itemCount, total, currency };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const logo = await manosLogoData();
  const language = languageOf(quote);
  const createdAt = Number(items[0]?.createdAt || quote.createdAt || Date.now());
  const validAt = createdAt + 30 * 24 * 60 * 60 * 1000;
  const totalY = 246 + itemCount * ROW_HEIGHT;
  const rowMarkup = (await Promise.all(items.map((item, index) => quotationRowMarkup(item, index, mediaDir, language)))).join("");
  const logoMarkup = logo
    ? `<image href="${logo}" x="40" y="-10" width="120" height="120" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="40" y="58" class="logo-fallback">MANOS</text>`;

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${CANVAS_WIDTH} ${canvasHeight}">
    <defs>
      <linearGradient id="header" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#08090A"/><stop offset="0.5" stop-color="#121417"/><stop offset="1" stop-color="#08090A"/></linearGradient>
      <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.08"/><stop offset="0.4" stop-color="#fff" stop-opacity="0.02"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <radialGradient id="glow" cx="90%" cy="50%" r="25%"><stop offset="0" stop-color="#c9a84c" stop-opacity="0.12"/><stop offset="0.6" stop-color="#c9a84c" stop-opacity="0.04"/><stop offset="1" stop-color="#c9a84c" stop-opacity="0"/></radialGradient>
      <filter id="priceShadow" x="-30%" y="-40%" width="160%" height="200%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#c9a84c" flood-opacity="0.4"/></filter>
      <style>
        text { font-family: Arial, "Microsoft YaHei", "Noto Sans", sans-serif; fill: #1a1a1a; }
        .logo-fallback { fill: #fff; font-size: 24px; font-weight: 700; }
        .meta-label { fill: #8c8c8c; font-size: 10px; text-anchor: middle; }
        .meta-value { fill: #1a1a1a; font-size: 12px; font-weight: 700; text-anchor: middle; }
        .table-head { fill: #7a6440; font-size: 13px; font-weight: 700; text-anchor: middle; }
        .cell { fill: #1a1a1a; font-size: 16px; font-weight: 700; text-anchor: middle; }
        .header-title { fill: rgba(255,255,255,0.95); }
        .header-currency { fill: #c9a84c; }
        .amount { fill: #fff; }
      </style>
    </defs>

    <rect width="985" height="${canvasHeight}" fill="#fafaf7"/>
    <rect width="985" height="100" fill="url(#header)"/>
    <rect width="985" height="100" fill="url(#sheen)"/>
    <path d="M394 0L246 100M443 0L295 100M690 0L837 100" stroke="#c9a84c" stroke-width="0.8" stroke-opacity="0.13"/>
    <rect width="985" height="100" fill="url(#glow)"/>
    ${logoMarkup}
    <text x="945" y="38" class="header-title" text-anchor="end" font-size="13" font-weight="600">PRICING DETAILS</text>
    <text x="945" y="62" class="header-currency" text-anchor="end" font-size="18" font-weight="700">${xml(currency)}</text>
    <path d="M900 75H945M900 79H945" stroke="#c9a84c" stroke-width="1"/>
    <path d="M24 99.5H961" stroke="#c9a84c" stroke-opacity="0.55"/>

    <rect x="20" y="116" width="945" height="70" rx="10" fill="#fff"/>
    <path d="M335 130V172M650 130V172" stroke="#e8e4dc"/>
    <circle cx="177.5" cy="138" r="14" fill="#f5f0e6"/><text x="177.5" y="142" text-anchor="middle" font-size="12">📅</text>
    <text x="177.5" y="160" class="meta-label">Date</text><text x="177.5" y="174" class="meta-value">${xml(dateLabel(createdAt))}</text>
    <circle cx="492.5" cy="138" r="14" fill="#f5f0e6"/><text x="492.5" y="142" text-anchor="middle" font-size="12">💷</text>
    <text x="492.5" y="160" class="meta-label">Currency</text><text x="492.5" y="174" class="meta-value">${xml(`${currency} (${symbol})`)}</text>
    <circle cx="807.5" cy="138" r="14" fill="#f5f0e6"/><text x="807.5" y="142" text-anchor="middle" font-size="12">✨</text>
    <text x="807.5" y="160" class="meta-label">Valid Until</text><text x="807.5" y="174" class="meta-value">${xml(dateLabel(validAt))}</text>

    <rect x="20" y="202" width="945" height="44" fill="#f5f0e6" stroke="#c9a84c" stroke-width="0.5"/>
    <path d="M270 202V246M400 202V246M510 202V246M640 202V246M755 202V246" stroke="#c9a84c" stroke-width="0.5"/>
    <text x="145" y="229" class="table-head">Product Image</text>
    <text x="335" y="229" class="table-head">Size</text>
    <text x="455" y="229" class="table-head">Quantity</text>
    <text x="575" y="229" class="table-head">${xml(`Unit Price (${symbol}/pc)`)}</text>
    <text x="697.5" y="229" class="table-head">${xml(`Total (${symbol})`)}</text>
    <text x="860" y="229" class="table-head">Notes</text>
    ${rowMarkup}

    <rect x="20" y="${totalY}" width="945" height="80" fill="#f5f0e6"/>
    <path d="M20 ${totalY}H965" stroke="#c9a84c" stroke-width="2"/>
    <text x="44" y="${totalY + 47}" font-size="20" font-weight="700">TOTAL</text>
    <path d="M810 ${totalY + 14}V${totalY + 66}" stroke="#d4c8a8"/>
    <rect x="830" y="${totalY + 18}" width="125" height="44" rx="22" fill="#c9a84c" filter="url(#priceShadow)"/>
    <text x="892.5" y="${totalY + 46}" class="amount" text-anchor="middle" font-size="18" font-weight="700">${availableItems.length ? xml(`${symbol}${amount(total)}`) : "—"}</text>
  </svg>`;

  const buffer = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false }).toBuffer();
  fs.writeFileSync(outputPath, buffer);
  return { buffer, filename, outputPath, mediaUrl, mimeType: "image/png", width: WIDTH, height, itemCount, total, currency };
}

module.exports = { generateQuotationImage, languageOf, resolveLocalMedia };
