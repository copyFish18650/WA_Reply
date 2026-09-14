const PRIORITIES = { reply: 0, translation: 1, style: 2, background: 3, memory: 4 };

class InferenceQueue {
  constructor() {
    this.pending = [];
    this.active = null;
    this.sequence = 0;
  }

  status() {
    return {
      busy: Boolean(this.active),
      active: this.active ? { kind: this.active.kind, startedAt: this.active.startedAt } : null,
      queued: this.pending.length
    };
  }

  run(task, kind = "reply") {
    return new Promise((resolve, reject) => {
      const job = { task, kind, priority: PRIORITIES[kind] ?? 0, sequence: this.sequence++, resolve, reject };
      this.pending.push(job);
      if (this.active && this.active.priority > job.priority && ["background", "memory", "style"].includes(this.active.kind)) {
        this.active.preempted = true;
        this.active.controller.abort();
      }
      this.drain();
    });
  }

  drain() {
    if (this.active || !this.pending.length) return;
    this.pending.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
    const job = this.pending.shift();
    this.active = job;
    job.controller = new AbortController();
    job.preempted = false;
    job.startedAt = Date.now();
    // Only the HTTP request runs here. Saving results and sending messages happen
    // after the promise resolves, so preempted work cannot send duplicate replies.
    Promise.resolve().then(() => job.task(job.controller.signal)).then(job.resolve, (error) => {
      if (job.preempted && (error.code === "ERR_CANCELED" || error.name === "AbortError")) {
        this.pending.push(job);
      } else {
        job.reject(error);
      }
    }).finally(() => {
      this.active = null;
      this.drain();
    });
  }
}

const queues = new Map();
function inferenceQueue(baseUrl) {
  const key = new URL(baseUrl).origin;
  if (!queues.has(key)) queues.set(key, new InferenceQueue());
  return queues.get(key);
}

function inferenceTimeout(kind) {
  const name = kind === "reply" ? "LOCAL_AI_REPLY_TIMEOUT_MS"
    : ["translation", "background"].includes(kind) ? "LOCAL_AI_TRANSLATION_TIMEOUT_MS"
      : "LOCAL_AI_MEMORY_TIMEOUT_MS";
  const fallback = kind === "reply" ? 300000 : ["translation", "background"].includes(kind) ? 180000 : 600000;
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? Math.min(Math.max(configured, 1000), 1800000) : fallback;
}

module.exports = { InferenceQueue, inferenceQueue, inferenceTimeout };
