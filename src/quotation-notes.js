function cleanText(value, maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function noteId(prefix, value, index) {
  const slug = cleanText(value, 60).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${prefix}_${slug || index + 1}`;
}

function defaultQuotationNotes(productFacts = {}) {
  productFacts = productFacts || {};
  const notes = [];
  for (const [key, fact] of [["color", productFacts.color], ["material", productFacts.material]]) {
    if (!fact?.en && !fact?.zh) continue;
    notes.push({ id: key, en: cleanText(fact.en || fact.zh), zh: cleanText(fact.zh || fact.en) });
  }
  for (const [index, feature] of (Array.isArray(productFacts.features) ? productFacts.features : []).entries()) {
    if (!feature?.en && !feature?.zh) continue;
    notes.push({
      id: cleanText(feature.id, 60) || noteId("feature", feature.en || feature.zh, index),
      en: cleanText(feature.en || feature.zh),
      zh: cleanText(feature.zh || feature.en)
    });
  }
  notes.push({ id: "shipping_included", en: "Shipping included", zh: "含运费" });
  return notes;
}

function normalizeQuotationNotes(value, productFacts = {}) {
  if (!Array.isArray(value)) return defaultQuotationNotes(productFacts);
  const seen = new Set();
  return value.slice(0, 12).map((note, index) => {
    if (typeof note === "string") {
      const text = cleanText(note);
      return { id: noteId("note", text, index), en: text, zh: text };
    }
    const en = cleanText(note?.en || note?.text || note?.zh);
    const zh = cleanText(note?.zh || note?.translation || note?.en || note?.text);
    const id = cleanText(note?.id, 60) || noteId("note", en || zh, index);
    return { id, en, zh };
  }).filter((note) => {
    if ((!note.en && !note.zh) || seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
}

function quotationNoteText(note, language = "en") {
  if (!note) return "";
  return cleanText(note[language] || note.en || note.zh);
}

module.exports = { defaultQuotationNotes, normalizeQuotationNotes, quotationNoteText };
