"use strict";
/*
 * router.js — core forwarder.
 *
 * Takes an OpenAI-format outbound request, resolves the model (strip oc/ prefix,
 * apply aliases), builds exact opencode headers, optionally routes through a
 * proxy, forwards to opencode.ai, and relays the response back.
 *
 * On 429/403 with a limit marker: rotates identity (+ proxy) and retries,
 * mirroring 9router's bc(a+1) loop with a retry cap. Each attempt is logged.
 */

const { OpenCodeProvider } = require("./provider.js");
const transport = require("./transport.js");
const sse = require("./sse.js");
const logger = require("./logger.js");
const { RequestLog } = require("./requestLog.js");
const { unionWith, enrich, primer, normalizeResponses } = require("./ocEmbed.js");

const JSON_HEADERS = { "Content-Type": "application/json" };

class Router {
  constructor({ config, proxyRouter, modelCache }) {
    this.config = config;
    this.proxyRouter = proxyRouter;
    this.modelCache = modelCache;
    this.provider = new OpenCodeProvider({
      baseUrl: config.baseUrl,
      release: config.release,
      uaSuffix: config.uaSuffix,
      client: config.client,
      project: config.project,
    });
    this.logs = new RequestLog();
    this._warpWarned = false;
  }

  /**
   * Fire-and-forget limit report to the warp pool (:9190/api/report).
   * The pool maps the event to the backend that served it, quarantines it
   * (failover) and resets it in background. Returns a promise that resolves
   * once the pool has ACKed (quarantine is applied synchronously before the
   * pool responds) — callers SHOULD await it before retrying so the next
   * attempt actually lands on the healthy backend. Never rejects.
   */
  reportPoolLimit(reason) {
    try {
      if (this.proxyRouter.mode !== "warp") return Promise.resolve(false);
      const statusUrl = (this.config.proxy?.warp?.statusUrl || "http://127.0.0.1:9190").replace(/\/$/, "");
      const target = transport.parseUrl(statusUrl + "/api/report");
      return transport.doRequest({
        target, method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: reason }),
        timeoutMs: 5000,
      }).then(async (resp) => {
        const t = await resp.text().catch(() => "");
        logger.info(`[router] pool report ${reason} → ${resp.status} ${t.slice(0, 120)}`);
        return resp.status === 202 || resp.status === 200;
      }).catch((e) => { logger.warn(`[router] pool report failed: ${e.message}`); return false; });
    } catch (e) {
      logger.warn(`[router] pool report setup failed: ${e.message}`);
      return Promise.resolve(false);
    }
  }

  /**
   * Collapse a streamed SSE response into one OpenAI non-stream JSON object.
   * Used by force-stream (P0-2): upstream ALWAYS gets stream:true; clients
   * that asked stream:false receive assembled JSON. Never invents content:
   * empty stream → throws (caller maps to 502, not a fake completion).
   */
  static collapseSSE(readable, fallbackModel) {    return new Promise((resolve, reject) => {
      let id = null, model = fallbackModel || null;
      let content = "", finishReason = null, usage = null, chunks = 0;
      const parser = sse.createParser(
        (payload) => {
          let obj;
          try { obj = JSON.parse(payload); } catch { return; }
          chunks += 1;
          if (!id && obj.id) id = obj.id;
          if (obj.model) model = obj.model;
          const choice = obj.choices && obj.choices[0];
          if (choice) {
            if (choice.delta && typeof choice.delta.content === "string") content += choice.delta.content;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            if (choice.message && typeof choice.message.content === "string") content += choice.message.content;
          }
          if (obj.usage) usage = obj.usage;
        },
        () => {}
      );
      readable.on("data", (c) => parser.feed(c));
      readable.on("end", () => {
        parser.end();
        if (chunks === 0) return reject(new Error("empty upstream stream (nothing to collapse)"));
        resolve({
          id: id || `chatcmpl-archrouter-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model || fallbackModel || "unknown",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        });
      });
      readable.on("error", reject);
    });
  }

  /**
   * P1-3 (light responses translator): collapse Responses-API SSE → JSON.
   * Kumpulkan output_text/refusal deltas; objek final diambil dari event
   * terminal (response.completed/incomplete membawa response utuh; response.failed → reject).
   * Putus tanpa terminal → reject (honest-close, tanpa karangan).
   */
  static collapseResponsesSSE(readable) {
    return new Promise((resolve, reject) => {
      let resp = null;
      let text = "";
      let usage = null;
      let events = 0;
      let failed = null;
      const parser = sse.createParser(
        (payload) => {
          let obj;
          try { obj = JSON.parse(payload); } catch { return; }
          events += 1;
          const t = obj.type;
          if (t === "response.output_text.delta" || t === "response.refusal.delta") {
            if (typeof obj.delta === "string") text += obj.delta;
          } else if (t === "response.completed" || t === "response.incomplete") {
            resp = obj.response || resp;
            if (obj.response?.usage) usage = obj.response.usage;
          } else if (t === "response.failed") {
            failed = obj.response?.error?.message || obj.response?.error?.code || "response failed";
          } else if (t === "error") {
            failed = obj.error?.message || obj.message || "upstream error";
          }
        },
        () => {}
      );
      readable.on("data", (c) => parser.feed(c));
      readable.on("end", () => {
        parser.end();
        if (failed) return reject(new Error(failed));
        if (!resp) return reject(new Error("upstream closed without completion (no terminal event)"));
        const out = { ...resp };
        if (typeof out.output_text === "string" || out.output === undefined) {
          out.output_text = text;
        }
        if (usage) out.usage = usage;
        if (events === 0) return reject(new Error("empty upstream stream (nothing to collapse)"));
        resolve(out);
      });
      readable.on("error", reject);
    });
  }

  resolveModel(incoming) {
    let model = String(incoming || "").trim();
    // Combo container: name -> real opencode model (e.g. "ClaudePick" -> "big-pickle").
    const combos = this.config.combos || {};
    // 1) Bare combo name, e.g. "ClaudePick".
    if (combos[model]) {
      model = combos[model];
    }
    // 2) 9router-style id "combo/<Nama>", e.g. "combo/ClaudePick".
    else if (model.startsWith("combo/") && combos[model.slice(6)]) {
      model = combos[model.slice(6)];
    }
    const bare = model.startsWith("oc/") ? model.slice(3) : model;
    if (!bare) throw Object.assign(new Error("model is required"), { status: 400, code: "invalid_request_error" });
    return { original: incoming, model, bare };
  }

  buildError(status, message, code = "invalid_request_error") {
    return {
      status,
      json: {
        error: {
          message,
          type: "invalid_request_error",
          code,
        },
      },
    };
  }

  /**
   * Sanitize incoming messages before forwarding: drop assistant messages that
   * have neither content nor tool_calls (e.g. reasoning models like big-pickle
   * return content:"" so the client echoes an empty assistant message back,
   * which upstream rejects with 400 "Invalid assistant message").
   * Keeps reasoning_content untouched; only filters the invalid assistant turn.
   */
  static sanitizeMessages(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.filter((m) => {
      if (!m || m.role !== "assistant") return true;
      const hasContent = typeof m.content === "string" ? m.content.length > 0 : Array.isArray(m.content) && m.content.length > 0;
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      return hasContent || hasToolCalls;
    });
  }

  /**
   * Forward a request. Returns a response-like object for non-streaming, or a
   * streaming object for streaming.
   *   options: { body, isMessagesEndpoint, kind, timeoutMs, headersExtras }
   *   kind: "chat" (default) | "messages" | "responses" — menentukan URL
   *   upstream (buildUrlFor), Accept header, dan apakah body kena pipeline
   *   chat-specific (stub14/force-stream/enrich/GATE-FALLBACK).
   * Non-stream response: { status, json, raw }
   * Stream response:     { status, stream: () => node Readable, onChunk: (jsonChunk) => void }
   */
  async forward({ body, isMessagesEndpoint = false, kind = "chat", timeoutMs, headersExtras = {}, requireJson = true }) {
    const isResponses = kind === "responses";
    const retries = Math.max(1, this.config.retries || 1);
    const t0 = Date.now();
    let lastError = null;

    // Filter invalid empty assistant messages before any attempt.
    if (Array.isArray(body.messages)) {
      const clean = Router.sanitizeMessages(body.messages);
      if (clean.length !== body.messages.length) {
        body = { ...body, messages: clean };
        logger.warn(`[router] dropped ${body.messages.length - clean.length} empty assistant message(s) before forwarding`);
      }
    }

    // P0-3 OC_EMBED gate: canonical-14 ⊆ tool-names. Union stubs with client
    // tools on OpenAI-shape chat bodies only (never touch Anthropic messages
    // bodies or Responses-API bodies — format tools-nya beda).
    const hadTools = !isResponses && !isMessagesEndpoint && Array.isArray(body.tools) && body.tools.length > 0;
    if (!isResponses && !isMessagesEndpoint) {
      body = { ...body, tools: unionWith(body.tools) };
      if (!hadTools) logger.info("[router] OC_EMBED stub14 attached (thin client, gate-safe)");
    }

    // P0-2 force-stream: upstream gate demands stream:true. Client asked
    // stream:false (or omitted) → send stream:true, collapse SSE to JSON.
    // Berlaku juga utk responses (reference rb() selalu stream:true; event
    // terminal response.completed membawa objek response utuh → collapse).
    const collapse = body.stream !== true;
    const upstreamBody = collapse ? { ...body, stream: true } : body;
    if (collapse) logger.info("[router] force-stream: client stream=false → upstream stream=true + collapse");

    // REFERENCE-SYNC v6.6: absent-only enrich defaults applied to the body
    // that actually goes upstream (reference: ocEnrich di transformRequest,
    // stream_options diverifikasi terhadap stream final — di sini upstream
    // selalu stream:true sehingga include_usage ikut terpasang → usage utuh
    // saat collapse). Tools sudah di-union di atas; enrich idempoten utk tools.
    // P1-2 (primer reasoning, v6.11 scope B): setelah enrich, effort absen →
    // diisi default high (chat: reasoning_effort, responses: reasoning obj).
    let finalBody;
    if (isResponses) {
      finalBody = primer(normalizeResponses(upstreamBody), "responses");
    } else if (isMessagesEndpoint) {
      finalBody = upstreamBody;
    } else {
      finalBody = primer(enrich(upstreamBody), "chat");
    }
    // GATE-FALLBACK: upstream menolak kombinasi stub14-tersuntik + system
    // prompt tertentu (title-agent) dengan 403 FreeTierError, padahal body
    // tanpa tools lolos. Untuk thin client (tools bukan milik klien) kita
    // simpan varian tanpa tools dan otomatis turun kategori saat 403.
    let strippedBody = null;
    if (!isResponses && !isMessagesEndpoint && !hadTools) {
      strippedBody = { ...finalBody };
      delete strippedBody.tools;
      delete strippedBody.tool_choice;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      // P0-4 403-cooldown: wait out the cooldown instead of retry-spamming.
      const waitMs = this.provider.cooldownRemainingMs();
      if (waitMs > 0) {
        logger.warn(`[attempt ${attempt}] 403-cooldown active, waiting ${Math.ceil(waitMs / 1000)}s`);
        this.logs.push({ type: "cooldown", status: 403, model: body.model, proxy: null, rotated: false, attempt, message: `cooldown ${waitMs}ms` });
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 90000)));
      }

      // warp mode: egress via pool SOCKS5 (:11801) using SOCKS5 handshake
      // (transport proxyStyle "socks5", wired in Fase 3e).
      const proxy = this.proxyRouter.nextProxy();
      const proxyStyle = this.proxyRouter.mode === "upstream" ? "forward"
        : this.proxyRouter.mode === "warp" ? "socks5" : "tunnel";
      const headers = { ...this.provider.buildHeaders(isResponses ? "*/*" : undefined), ...headersExtras };
      const url = isResponses ? this.provider.buildUrlFor("responses")
        : isMessagesEndpoint ? this.provider.buildUrl(true)
        : this.provider.buildUrl(false);
      const proxyLabel = proxy ? proxy.replace(/^https?:\/\//, "") : "direct";
      const pathLabel = isResponses ? "/zen/v1/responses" : isMessagesEndpoint ? "/zen/v1/messages" : "/zen/v1/chat/completions";

      logger.info(
        `[attempt ${attempt}/${retries}] POST ${pathLabel}` +
        ` model=${body.model} proxy=${proxyLabel} session=${this.provider.ocSession}`
      );

      try {
        const resp = await transport.doRequest({
          target: transport.parseUrl(url),
          method: "POST",
          headers,
          body: JSON.stringify(finalBody),
          proxy,
          proxyStyle,
          timeoutMs: timeoutMs ?? this.config.requestTimeoutMs ?? 120000,
        });

        if (resp.status >= 200 && resp.status < 300) {
          if (finalBody.stream === true && !collapse) {
            return {
              status: resp.status,
              stream: () => resp.stream(),
              onChunk: null,
              provider: this.provider,
              proxy,
              latencyMs: Date.now() - t0,
            };
          }
          if (collapse) {
            // force-stream collapse: assemble SSE → single JSON for the client.
            try {
              const json = isResponses
                ? await Router.collapseResponsesSSE(resp.stream())
                : await Router.collapseSSE(resp.stream(), body.model);
              return { status: 200, raw: JSON.stringify(json), json, provider: this.provider, proxy, latencyMs: Date.now() - t0, collapsed: true };
            } catch (e) {
              lastError = { status: 502, message: `collapse failed: ${e.message}` };
              logger.error(`[attempt ${attempt}] collapse failed: ${e.message}`);
              if (attempt < retries) continue;
              throw Object.assign(new Error(lastError.message), { status: 502, code: "collapse_error" });
            }
          }
          const raw = await resp.text();
          let json = null;
          if (requireJson) {
            try { json = JSON.parse(raw); }
            catch { json = null; }
          }
          // 2xx with HTML (bot/challenge page) or unparseable JSON: treat as a
          // retryable transient, rotate identity and try again.
          const ct = (resp.headers["content-type"] || "").toLowerCase();
          if (requireJson && (!json || ct.includes("text/html"))) {
            lastError = { status: resp.status, message: "bot/challenge page (2xx non-JSON)", poolScoped: { reason: "ip-limit" } };
            logger.warn(`[attempt ${attempt}] 2xx non-JSON challenge, rotated identity -> ${this.provider.ocSession}`);
            this.provider.rotateIdentity();
            if (proxy) this.proxyRouter.reportFailure(proxy);
            this.logs.push({ type: "rotation", status: resp.status, model: body.model, proxy: proxy || null, rotated: true, attempt, message: "2xx non-JSON (challenge)" });
            if (attempt < retries) continue;
            return { status: 429, raw, json: { error: { message: "upstream returned a challenge page; try again", type: "rate_limit_error", code: "rate_limit_exceeded" } }, provider: this.provider, proxy, latencyMs: Date.now() - t0, rotated: true };
          }
          return {
            status: resp.status,
            raw,
            json,
            provider: this.provider,
            proxy,
            latencyMs: Date.now() - t0,
          };
        }

        const errBody = await resp.text();
        // REFERENCE-SYNC debug: snapshot meta body upstream saat error — dipakai
        // untuk diff request gagal vs lolos gate (tools/stream/defaults).
        if (resp.status === 403 || resp.status === 429) {
          logger.warn(
            `[gate] status=${resp.status} model=${body.model} path=${isResponses ? "responses" : isMessagesEndpoint ? "messages" : "chat"}` +
            ` tools=${Array.isArray(finalBody.tools) ? finalBody.tools.length : 0}` +
            ` stream=${finalBody.stream === true} max_tokens=${finalBody.max_tokens ?? "-"}` +
            ` tool_choice=${finalBody.tool_choice ?? "-"} stream_options=${finalBody.stream_options ? "set" : "-"}` +
            ` session=${headers["x-opencode-session"] || "-"} request=${headers["x-opencode-request"] || "-"} ` +
            `ua="${headers["User-Agent"] || "-"}" accept=${headers["Accept"] || "-"} proxy=${proxyLabel}` +
            ` upstream="${String(errBody).slice(0, 200)}"`
          );
        }
        // GATE-FALLBACK: 403 pada thin-client dengan stub14 tersuntik → coba
        // sekali lagi tanpa tools (title-agent lolos tanpa tools; chat biasa
        // butuh stub → kalau ini juga 403, jatuh ke jalur cooldown biasa).
        if (resp.status === 403 && strippedBody && finalBody !== strippedBody) {
          logger.warn(
            `[gate] 403 with injected stub14 on thin-client request → retry without tools ` +
            `(model=${body.model} attempt=${attempt})`
          );
          finalBody = strippedBody;
          continue;
        }
        lastError = this.provider.parseError(resp.status, errBody, {
          forbiddenCooldownMs: this.config.cooldown?.forbiddenCooldownMs ?? 60000,
          episodeWindowMs: this.config.cooldown?.episodeWindowMs ?? 180000,
        });
        if (lastError) {
          logger.warn(
            `[attempt ${attempt}] limit hit (${resp.status}), rotated identity -> ${this.provider.ocSession}` +
            ` (poolScoped: ${JSON.stringify(lastError.poolScoped)})`
          );
          // Usage-limit: rotate session AND burn this egress IP (fallback rotation).
          if (proxy) this.proxyRouter.reportLimit(proxy);
          // Warp-pool: report + WAIT for the quarantine ACK before retrying,
          // so the next attempt actually lands on the healthy backend while
          // the burned one re-handshakes for a fresh IP in background.
          const scope = lastError.poolScoped && lastError.poolScoped.reason;
          if (lastError.noRetry) {
            const waitMs = Math.min(lastError.waitMs || 60000, 120000);
            logger.warn(`[attempt ${attempt}] in 403-cooldown, waiting ${Math.ceil(waitMs / 1000)}s`);
            await new Promise((r) => setTimeout(r, waitMs));
            if (attempt < retries) continue;
          } else if (scope === "ip-limit") {
            await this.reportPoolLimit("freeusagelimit");
          } else if (scope === "forbidden-egress") {
            await this.reportPoolLimit("forbidden");
          } else if (scope === "forbidden-identity") {
            await this.reportPoolLimit("forbidden");
            // identity already rotated in parseError; loop-top waits out cooldown
          }
          this.logs.push({
            type: "rotation",
            status: resp.status,
            model: body.model,
            proxy: proxy || null,
            rotated: true,
            attempt,
            message: lastError.message.slice(0, 200),
          });
          if (attempt < retries) continue;
          return {
            status: resp.status,
            json: {
              error: {
                message: lastError.message,
                type: "rate_limit_error",
                code: "rate_limit_exceeded",
              },
            },
            raw: errBody,
            provider: this.provider,
            proxy,
            latencyMs: Date.now() - t0,
            rotated: true,
          };
        }

        // Non-limit error: 5xx (e.g. 503 "Endpoint is unavailable") is a
        // retryable upstream condition — report proxy and retry. Identity is
        // NOT rotated here (only proxy rotates); 429/403 limit is what rotates
        // the session (see parseError above).
        if (resp.status >= 500) {
          logger.warn(
            `[attempt ${attempt}] upstream 5xx (${resp.status}) retrying, proxy rotated -> ${proxy || "direct"} (identity kept)`
          );
          if (proxy) this.proxyRouter.reportFailure(proxy);
          this.logs.push({
            type: "5xx-retry",
            status: resp.status,
            model: body.model,
            proxy: proxy || null,
            rotated: false,
            attempt,
            message: (errBody || "").slice(0, 200) || `upstream ${resp.status}`,
          });
          if (attempt < retries) continue;
          return {
            status: resp.status,
            raw: errBody,
            json: null,
            provider: this.provider,
            proxy,
            latencyMs: Date.now() - t0,
            rotated: false,
          };
        }

        // Other non-limit error: return as-is.
        return {
          status: resp.status,
          raw: errBody,
          json: null,
          provider: this.provider,
          proxy,
          latencyMs: Date.now() - t0,
        };
      } catch (err) {
        logger.error(`[attempt ${attempt}] request failed: ${err.message}`);
        // Transport error = proxy buruk → buang permanen (bukan cuma cooldown).
        if (proxy) this.proxyRouter.reportBadProxy(proxy);
        if (attempt < retries) continue;
        throw Object.assign(
          new Error(err.message || "upstream request failed"),
          { status: 502, code: "upstream_error" }
        );
      }
    }
    throw Object.assign(new Error("unreachable"), { status: 500 });
  }
}

module.exports = { Router, JSON_HEADERS };
