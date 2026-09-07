const fs = require("fs");
const path = require("path");
const axios = require("axios");

function value(...items) {
  return items.find((item) => item !== undefined && item !== null && String(item) !== "");
}

function number(input) {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  const match = String(input || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function parseNestedJson(input, depth = 0) {
  if (depth > 5 || typeof input !== "string") return input;
  const text = input.trim();
  if (!text || !((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) return input;
  try { return parseNestedJson(JSON.parse(text), depth + 1); } catch (_) { return input; }
}

function normalizeUrl(input) {
  const url = String(input || "").replace(/`/g, "").trim();
  return url.startsWith("//") ? `https:${url}` : url;
}

function cleanText(input) {
  if (input === undefined || input === null) return "";
  if (Array.isArray(input)) return input.map(cleanText).filter(Boolean).join("；");
  if (typeof input === "object") {
    return Object.entries(input)
      .filter(([, item]) => ["string", "number"].includes(typeof item))
      .map(([key, item]) => `${key}: ${item}`)
      .join("；");
  }
  return String(input).replace(/\s+/g, " ").trim();
}

function productDescription(item) {
  const details = [
    item?.description,
    item?.brief,
    item?.detail,
    item?.details,
    item?.specification,
    item?.specifications,
    item?.spec,
    item?.size,
    item?.dimensions,
    item?.sourceDesc
  ].map(cleanText).filter(Boolean);
  return [...new Set(details)].join("；").slice(0, 1800);
}

function validDimension(values) {
  return values.length >= 2 && values.every((item) => item > 0 && item <= 300);
}

function dimensionFact(text) {
  const source = cleanText(text).replace(/厘米/gi, "cm");
  if (!source) return null;
  let match = source.match(/开口(?:宽)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm)?\s*[，,;；\s]*高\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm)?\s*[，,;；\s]*(?:厚|深|底宽)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm)?/i);
  if (match) {
    const values = [Number(match[1]), Number(match[3]), Number(match[5])];
    if (validDimension(values)) return { kind: "opening_height_depth", values, unit: "cm" };
  }
  match = source.match(/(?:长|长度)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm)?\s*[，,;；\s]*(?:宽|宽度)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm)?\s*[，,;；\s]*(?:高|高度|厚|厚度|深|深度)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(cm)?/i);
  if (match) {
    const values = [Number(match[1]), Number(match[3]), Number(match[5])];
    if (validDimension(values)) return { kind: "length_width_height", values, unit: "cm" };
  }
  match = source.match(/(?:尺寸|大小|规格|size|dimensions?)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?\s*(cm|mm|in(?:ch(?:es)?)?)?/i);
  if (match) {
    const values = [match[1], match[2], match[3]].filter(Boolean).map(Number);
    if (validDimension(values)) return { kind: "dimensions", values, unit: String(match[4] || "cm").toLowerCase() };
  }
  return null;
}

function factLabels(fact) {
  if (!fact) return { zh: "", en: "" };
  const values = fact.values.map((item) => Number.isInteger(item) ? String(item) : String(item));
  const unit = fact.unit === "inch" || fact.unit === "inches" ? "in" : fact.unit;
  if (fact.kind === "opening_height_depth" && values.length === 3) {
    return {
      zh: `开口宽约 ${values[0]} ${unit}、高约 ${values[1]} ${unit}、厚约 ${values[2]} ${unit}`,
      en: `approximately ${values[0]} ${unit} across the opening, ${values[1]} ${unit} high, and ${values[2]} ${unit} deep`
    };
  }
  const joined = values.join(" × ");
  return { zh: `约 ${joined} ${unit}`, en: `approximately ${joined} ${unit}` };
}

function extractProductFacts(text) {
  const source = cleanText(text);
  const dimensions = dimensionFact(source);
  const labels = factLabels(dimensions);
  const material = /皮革|真皮|牛皮|羊皮|leather/i.test(source) ? { zh: "皮革", en: "leather" }
    : /帆布|canvas/i.test(source) ? { zh: "帆布", en: "canvas" }
      : /尼龙|nylon/i.test(source) ? { zh: "尼龙", en: "nylon" } : null;
  const color = /黑色|black/i.test(source) ? { zh: "黑色", en: "black" }
    : /白色|white/i.test(source) ? { zh: "白色", en: "white" }
      : /棕色|brown/i.test(source) ? { zh: "棕色", en: "brown" }
        : /红色|red/i.test(source) ? { zh: "红色", en: "red" } : null;
  const features = [];
  if (/肩带可调节|可调(?:节)?肩带|adjustable (?:shoulder )?strap/i.test(source)) features.push({ id: "adjustable_strap", zh: "肩带可调节", en: "an adjustable shoulder strap" });
  if (/拉链开合|拉链闭合|zipper (?:closure|closing)|zip closure/i.test(source)) features.push({ id: "zipper", zh: "拉链开合", en: "a zipper closure" });
  return { dimensions: dimensions ? { ...dimensions, ...labels } : null, material, color, features };
}

function aggregateProductFacts(products = []) {
  const ranked = products.filter(Boolean).slice(0, 8);
  if (!ranked.length) return { dimensions: null, material: null, color: null, features: [], evidenceCount: 0 };
  const maxConfidence = Math.max(0, ...ranked.map((item) => number(item.confidence)));
  const closeMatches = (maxConfidence > 0
    ? ranked.filter((item) => number(item.confidence) >= Math.max(0.75, maxConfidence - 0.08))
    : ranked.slice(0, 4)).slice(0, 6);
  const candidates = closeMatches.length ? closeMatches : ranked.slice(0, 3);
  const facts = candidates.map((product) => product.facts || extractProductFacts(`${product.title || ""} ${product.description || ""}`));
  const pick = (items, key) => {
    const counts = new Map();
    for (const item of items.filter(Boolean)) {
      const id = key(item);
      const current = counts.get(id) || { item, count: 0 };
      current.count += 1;
      counts.set(id, current);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count)[0] || null;
  };
  const dimensionVote = pick(facts.map((item) => item.dimensions), (item) => `${item.kind}:${item.values.join("x")}:${item.unit}`);
  const materialVote = pick(facts.map((item) => item.material), (item) => item.en);
  const colorVote = pick(facts.map((item) => item.color), (item) => item.en);
  const featureVotes = new Map();
  for (const fact of facts) for (const feature of fact.features || []) {
    const vote = featureVotes.get(feature.id) || { item: feature, count: 0 };
    vote.count += 1;
    featureVotes.set(feature.id, vote);
  }
  const minimumEvidence = candidates.length > 1 ? 2 : 1;
  return {
    dimensions: dimensionVote && dimensionVote.count >= minimumEvidence ? { ...dimensionVote.item, evidenceCount: dimensionVote.count } : null,
    material: materialVote && materialVote.count >= minimumEvidence ? { ...materialVote.item, evidenceCount: materialVote.count } : null,
    color: colorVote && colorVote.count >= minimumEvidence ? { ...colorVote.item, evidenceCount: colorVote.count } : null,
    features: [...featureVotes.values()].filter((item) => item.count >= minimumEvidence).map((item) => ({ ...item.item, evidenceCount: item.count })),
    evidenceCount: candidates.length
  };
}

function candidateList(payload) {
  const root = parseNestedJson(payload);
  const data = parseNestedJson(root?.data);
  const result = parseNestedJson(root?.result);
  const nestedResult = parseNestedJson(data?.result);
  const candidates = [
    root, data, result, nestedResult,
    root?.products, root?.items, root?.matches, root?.rows, root?.list, root?.sortList,
    data?.products, data?.items, data?.matches, data?.rows, data?.list, data?.sortList,
    result?.products, result?.items, result?.matches, result?.rows, result?.list, result?.sortList,
    nestedResult?.products, nestedResult?.items, nestedResult?.rows, nestedResult?.list, nestedResult?.sortList
  ];
  return candidates.find(Array.isArray) || [];
}

class SupplierSearch {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  config() {
    const saved = this.getConfig();
    return {
      url: process.env.SUPPLIER_IMAGE_SEARCH_URL || saved.supplierSearchUrl || "",
      apiKey: process.env.SUPPLIER_IMAGE_SEARCH_API_KEY || saved.supplierApiKey || "",
      markup: number(saved.quoteMarkup) || 1.3,
      shipping: number(saved.quoteShipping),
      currency: saved.quoteCurrency || "CNY"
    };
  }

  async search(localPath, mimeType) {
    const config = this.config();
    if (!config.url) throw new Error("尚未配置共享货源搜图接口");
    const gx1688 = /(?:gx1688|personProduct\/getImgSearchResultV2)/i.test(config.url);
    let body;
    let headers;
    if (gx1688) {
      body = new FormData();
      body.append("file", new Blob([fs.readFileSync(localPath)], { type: mimeType || "image/jpeg" }), path.basename(localPath));
      headers = {
        Accept: "*/*",
        Cookie: "SameSite=None",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}`, "X-API-Key": config.apiKey } : {})
      };
    } else {
      body = {
        image_base64: fs.readFileSync(localPath).toString("base64"),
        mime_type: mimeType || "image/jpeg",
        source: "whatsapp-web"
      };
      headers = {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}`, "X-API-Key": config.apiKey } : {})
      };
    }
    const response = await axios.post(config.url, body, {
      timeout: 120000,
      maxBodyLength: 20 * 1024 * 1024,
      maxContentLength: 20 * 1024 * 1024,
      headers
    });
    return this.normalize(response.data);
  }

  normalize(payload) {
    const source = candidateList(payload);
    return source.slice(0, 12).map((item, index) => {
      const pictures = Array.isArray(item?.picList)
        ? item.picList
        : Array.isArray(item?.pics?.picList)
          ? item.pics.picList
          : Array.isArray(item?.pics)
            ? item.pics
            : [];
      const imageUrls = pictures.map((picture) => normalizeUrl(typeof picture === "string" ? picture : value(picture?.url, picture?.pictureUrl, picture?.src, ""))).filter(Boolean);
      const cost = number(value(item.cost, item.price, item.parentPrice, item.retailPrice, item.unit_price, item.wholesale_price, item.salePrice));
      const description = productDescription(item);
      return {
      id: String(value(item.code, item.productId, item.pid, item.id, item.product_id, item.itemId, index + 1)),
      title: String(value(item.title, item.name, item.description, item.product_name, `匹配商品 ${index + 1}`)),
      description,
      facts: extractProductFacts(`${value(item.title, item.name, "")} ${description}`),
      cost,
      currency: String(value(item.currency, item.currency_code, "CNY")),
      confidence: number(value(item.confidence, item.score, item.similarity, 0)),
      url: normalizeUrl(value(item.url, item.product_url, item.detailUrl, item.goodsUrl, "")),
      imageUrl: normalizeUrl(value(item.image_url, item.image, item.picUrl, item?.pics?.pictureUrl, item?.pics?.url, imageUrls[0], "")),
      imageUrls,
      hasPrice: cost > 0,
      source: "weidian"
    };
    }).filter((item) => item.cost > 0 || item.title || item.imageUrl);
  }

  calculate(products) {
    const config = this.config();
    const costs = products.map((item) => item.cost).filter((item) => item > 0).sort((a, b) => a - b);
    if (!costs.length) return { costMin: 0, costMax: 0, suggestedPrice: 0, currency: config.currency };
    const middle = Math.floor(costs.length / 2);
    const median = costs.length % 2 ? costs[middle] : (costs[middle - 1] + costs[middle]) / 2;
    return {
      costMin: costs[0],
      costMax: costs[costs.length - 1],
      suggestedPrice: Math.ceil((median * config.markup + config.shipping) * 100) / 100,
      currency: config.currency
    };
  }
}

module.exports = { SupplierSearch, number, extractProductFacts, aggregateProductFacts };
