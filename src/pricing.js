const axios = require("axios");

const QUOTE_CURRENCIES = ["EUR", "USD", "GBP"];
const SHIPPING_OPTIONS_CNY = [90, 150, 180, 300];
const FALLBACK_RATES = Object.freeze({ EUR: 0.13, USD: 0.14, GBP: 0.11 });

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeProfitRate(value) {
  return Math.min(0.8, Math.max(0.7, number(value, 0.75)));
}

function calculateFinalQuote({ basePriceCny, shippingCny, profitRate, currency, rates }) {
  const base = Math.max(0, number(basePriceCny));
  const shipping = SHIPPING_OPTIONS_CNY.includes(number(shippingCny)) ? number(shippingCny) : 90;
  const profit = normalizeProfitRate(profitRate);
  const targetCurrency = QUOTE_CURRENCIES.includes(String(currency || "").toUpperCase())
    ? String(currency).toUpperCase()
    : "USD";
  const exchangeRate = Math.max(0, number(rates?.[targetCurrency], FALLBACK_RATES[targetCurrency]));
  const profitCny = Math.round(base * profit * 100) / 100;
  const subtotalCny = Math.round((base + shipping + profitCny) * 100) / 100;
  const finalPrice = Math.round(subtotalCny * exchangeRate);
  return {
    basePriceCny: base,
    shippingCny: shipping,
    profitRate: profit,
    profitCny,
    subtotalCny,
    currency: targetCurrency,
    exchangeRate,
    suggestedPrice: finalPrice
  };
}

class CurrencyPricing {
  constructor() {
    this.cached = null;
    this.cacheUntil = 0;
  }

  async getRates() {
    if (this.cached && Date.now() < this.cacheUntil) return this.cached;
    try {
      const response = await axios.get("https://api.frankfurter.dev/v2/rates", {
        params: { base: "CNY", quotes: QUOTE_CURRENCIES.join(",") },
        timeout: 10000,
        headers: { Accept: "application/json" }
      });
      const rows = Array.isArray(response.data) ? response.data : [];
      const rates = {};
      let date = "";
      for (const row of rows) {
        if (QUOTE_CURRENCIES.includes(row.quote) && number(row.rate) > 0) rates[row.quote] = number(row.rate);
        if (row.date) date = String(row.date);
      }
      if (QUOTE_CURRENCIES.some((code) => !(rates[code] > 0))) throw new Error("汇率响应不完整");
      this.cached = { rates, date, source: "Frankfurter", fallback: false };
      this.cacheUntil = Date.now() + 6 * 60 * 60 * 1000;
    } catch (error) {
      this.cached = {
        rates: { ...FALLBACK_RATES },
        date: new Date().toISOString().slice(0, 10),
        source: "本地备用汇率",
        fallback: true,
        error: error.message
      };
      this.cacheUntil = Date.now() + 10 * 60 * 1000;
    }
    return this.cached;
  }
}

module.exports = {
  CurrencyPricing,
  calculateFinalQuote,
  QUOTE_CURRENCIES,
  SHIPPING_OPTIONS_CNY,
  FALLBACK_RATES
};
