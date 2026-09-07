const assert = require("node:assert/strict");
const { LocalAI } = require("../src/local-ai");

(async () => {
  const ai = new LocalAI(() => ({
    localAiProvider: "llama.cpp",
    localAiBaseUrl: "http://127.0.0.1:11435",
    localAiModel: "Qwen3.5-9B-Q4_K_M",
    businessName: "测试店铺",
    businessGuidelines: "只依据聊天记录回答。"
  }));
  const health = await ai.health();
  assert.equal(health.ok, true, `本地模型不可用：${health.error || "unknown"}`);

  const grounded = await ai.decide({}, [
    { direction: "outbound", type: "text", body: "这款帆布包有黑色和米白色。" },
    { direction: "inbound", type: "text", body: "有哪些颜色？" }
  ]);
  const guarded = await ai.decide({}, [
    { direction: "outbound", type: "text", body: "这款是基础款帆布包。" },
    { direction: "inbound", type: "text", body: "尺寸多大？" }
  ]);
  const casual = await ai.casualReply("I spent the weekend with my family and had a lovely time.", {
    summary: "Use concise English, call customers dear, and often use emoji.",
    rules: [],
    persona: { completed: true, gender: "female", tone: "warm and gentle", personality: "patient, caring and cheerful" }
  });
  const correction = await ai.casualReply(
    "I don't have any discomfort. One day I will go to China to find you, are you right?",
    {
      summary: "Use concise English, call customers dear, and often use emoji.",
      rules: [],
      persona: { completed: true, gender: "female", tone: "warm and gentle", personality: "patient, caring and cheerful" }
    },
    [
      { direction: "inbound", type: "text", body: "I still need to save money and work hard so that I can buy more things from you 😂" },
      { direction: "outbound", type: "text", body: "I'm sorry you're not feeling well, dear. Please take good care of yourself and get some rest ❤️" }
    ]
  );

  assert.equal(guarded.action, "handoff", "无尺寸证据时必须转人工");
  assert.match(casual, /family|weekend|lovely|glad|happy|wonderful/i, "闲聊回复必须回应客户刚说的内容");
  assert.doesNotMatch(casual, /factory|product|order|price|payment/i, "闲聊不能突然转向销售或询厂");
  assert.doesNotMatch(correction, /not feeling well|\bsick\b|\bill\b|\bunwell\b|get some rest|take (?:good )?care/i, "客户已纠正没有不适时不能再次套用生病模板");
  console.log(JSON.stringify({ health, grounded, guarded, casual, correction }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
