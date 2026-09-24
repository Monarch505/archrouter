"use strict";
/*
 * requestLog.js — in-memory ring buffer of recent requests for the dashboard.
 */

class RequestLog {
  constructor(max = 500) {
    this.max = max;
    this.entries = [];
    this.listeners = [];
    this.usageTotal = { requests: 0, ok: 0, error: 0, rotated: 0 };
  }

  push(entry) {
    const e = {
      id: entry.id || `req_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      ts: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.usageTotal.requests += 1;
    if (entry.status >= 200 && entry.status < 400) this.usageTotal.ok += 1;
    else this.usageTotal.error += 1;
    if (entry.rotated) this.usageTotal.rotated += 1;
    for (const l of this.listeners) l(e);
    return e;
  }

  recent(limit = 50) {
    return this.entries.slice(-limit).reverse();
  }

  onEntry(fn) {
    this.listeners.push(fn);
  }
}

module.exports = { RequestLog };
