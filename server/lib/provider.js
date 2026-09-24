"use strict";
/*
 * provider.js — opencode provider core (port of 9router module 78223 semantics
 * incl. v6.3–v6.12: exact 7 headers, 403-innerOpenCode branch, 60s cooldown /
 * 3min episode guard, force-stream discipline, OC_EMBED gate).
 *
 * Identity is held as instance state:
 *   - rotateIdentity()  -> new stable session + user IDs (constructor + on limit)
 *   - buildHeaders()    -> the exact headers opencode.exe sends
 *   - parseError()      -> 429/403 with limit marker rotates identity, reports
 *                          poolScoped so caller rotates egress; 403-in-OpenCode
 *                          without limit marker starts cooldown instead of retry spam
 */

const Identifier = require("./identifier.js");

const LIMIT_RE = /limit|rate|quota|exhausted|capacity|too many|retry/i;

class OpenCodeProvider {
  constructor({ baseUrl, release, uaSuffix, client, project } = {}) {
    this.baseUrl = baseUrl || "https://opencode.ai";
    this.release = release || "1.18.31";
    this.uaSuffix = uaSuffix || "ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";
    this.client = client || "cli";
    this.project = project || "global";
    // 403-cooldown state (v6.5): consecutive forbiddens + episode window.
    this.forbiddenStreak = 0;
    this.cooldownUntil = 0;
    this.episodeStart = 0;
    this.rotateIdentity();
  }

  rotateIdentity() {
    this.ocSession = Identifier.descending("session");
    this.ocUser = Identifier.ascending("user");
    return { session: this.ocSession, user: this.ocUser };
  }

  identity() {
    return { session: this.ocSession, user: this.ocUser };
  }

  buildUrl(isMessagesEndpoint = false) {
    return isMessagesEndpoint
      ? `${this.baseUrl}/zen/v1/messages`
      : `${this.baseUrl}/zen/v1/chat/completions`;
  }

  buildUrlFor(kind) {
    if (kind === "responses") return `${this.baseUrl}/zen/v1/responses`;
    if (kind === "systemone") return `${this.baseUrl}/zen/v1/systemone`;
    if (kind === "messages") return this.buildUrl(true);
    return this.buildUrl(false);
  }

  userAgent() {
    return `opencode/${this.release}${this.uaSuffix ? " " + this.uaSuffix : ""}`;
  }

  buildHeaders(accept = "text/event-stream") {
    return {
      "Content-Type": "application/json",
      Authorization: "Bearer public",
      "x-opencode-client": this.client,
      "User-Agent": this.userAgent(),
      "x-opencode-session": this.ocSession,
      "x-opencode-request": this.ocUser,
      "x-opencode-project": this.project,
      Accept: accept,
    };
  }

  inCooldown(now = Date.now()) {
    return now < this.cooldownUntil;
  }

  cooldownRemainingMs(now = Date.now()) {
    return Math.max(0, this.cooldownUntil - now);
  }

  parseError(status, bodyText, opts = {}) {
    const s = status || 0;
    const d = String(bodyText || "");
    const cooldownMs = opts.forbiddenCooldownMs ?? 60000;
    const episodeMs = opts.episodeWindowMs ?? 180000;
    const now = Date.now();
    // Prefer the inner error message from opencode's JSON error envelope.
    let msg = d.slice(0, 300);
    try {
      const parsed = JSON.parse(d);
      if (parsed.error?.message) msg = parsed.error.message;
      else if (parsed.error?.error?.message) msg = parsed.error.error.message;
    } catch {}
    if ((s === 429 || s === 403) && LIMIT_RE.test(d)) {
      this.forbiddenStreak = 0; // limit-hit resets the 403 streak; identity rotates instead
      this.rotateIdentity();
      return { status: s, message: msg, poolScoped: { reason: "ip-limit" } };
    }
    if (s === 403) {
      // 403 inner-OpenCode WITHOUT limit marker: v6.5 escalation.
      // #1 → egress-refresh ONLY (new IP, identity kept — cheap, often enough).
      // #2+ consecutive (same 3-min episode) → rotateIdentity + identity-refresh
      //   + 60s cooldown (with streak backoff); in-cooldown hits → no-spin.
      if (this.inCooldown(now)) {
        return { status: s, message: msg, noRetry: true, waitMs: this.cooldownRemainingMs(now) };
      }
      if (!this.episodeStart || now - this.episodeStart > episodeMs) {
        this.episodeStart = now;
        this.forbiddenStreak = 0;
      }
      this.forbiddenStreak += 1;
      if (this.forbiddenStreak === 1) {
        return { status: s, message: msg, poolScoped: { reason: "forbidden-egress" } };
      }
      const extra = Math.min(this.forbiddenStreak - 2, 3) * 30000;
      this.cooldownUntil = now + cooldownMs + extra;
      this.rotateIdentity();
      return {
        status: s,
        message: msg,
        poolScoped: { reason: "forbidden-identity" },
        cooldownMs: this.cooldownUntil - now,
        waitMs: this.cooldownUntil - now,
      };
    }
    return null;
  }
}

module.exports = { OpenCodeProvider, LIMIT_RE };
