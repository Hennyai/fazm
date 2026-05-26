import { OutboundMessage } from "./protocol.js";

type NotificationHandler = (method: string, params: unknown) => void;

export class DirectOpenAIProvider {
  readonly name = "direct-openai";
  private sessionNotificationHandlers = new Map<string, NotificationHandler>();
  private logErr: (msg: string) => void;
  private apiKey: string;
  private apiBase: string;
  private model: string;
  private providerType: string;

  constructor(opts: { apiKey?: string; apiBase?: string; model?: string; logErr?: (msg: string) => void } = {}) {
    this.providerType = process.env.FAZM_DIRECT_PROVIDER || "openai";
    
    // Pick the right key based on provider type
    if (this.providerType === "anthropic") {
        this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || "";
    } else if (this.providerType === "google") {
        this.apiKey = opts.apiKey || process.env.GEMINI_API_KEY || "";
    } else {
        this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || "";
    }

    this.apiBase = opts.apiBase || process.env.FAZM_DIRECT_BASE_URL || process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
    this.model = opts.model || process.env.FAZM_DIRECT_MODEL || process.env.OPENAI_MODEL || "gpt-4o";
    this.logErr = opts.logErr || ((m) => process.stderr.write(`[direct-llm] ${m}\n`));
    
    // Default model if none provided and type matches
    if (!opts.model && !process.env.OPENAI_MODEL) {
        if (this.providerType === "anthropic") this.model = "claude-3-5-sonnet-20241022";
        else if (this.providerType === "google") this.model = "gemini-1.5-pro";
    }
  }

  isRunning(): boolean {
    return true;
  }

  start(): void {
    this.logErr(`DirectLLMProvider starting (type=${this.providerType}, base=${this.apiBase}, model=${this.model})`);
    
    if (!this.apiKey && this.providerType !== "ollama") {
        this.logErr("WARNING: No API key configured for Direct Model");
    }
    if (!this.apiBase) {
        this.logErr("WARNING: No API Base URL configured for Direct Model");
    }
  }

  shutdown(): void {
    this.logErr("DirectLLMProvider shutdown");
  }

  registerSessionHandler(sessionId: string, handler: NotificationHandler): void {
    this.sessionNotificationHandlers.set(sessionId, handler);
  }

  unregisterSessionHandler(sessionId: string): void {
    this.sessionNotificationHandlers.delete(sessionId);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentInfo: { name: "direct-llm", version: "1.0.0", title: "Direct LLM Adapter" },
        };

      case "authenticate":
        return {};

      case "session/new":
        const sessionId = `direct-${Math.random().toString(36).slice(2)}`;
        return { sessionId };

      case "session/prompt":
        return this.handlePrompt(params);

      case "session/set_model":
        if (typeof params.modelId === "string") {
            // Only update if it's not a generic placeholder
            if (params.modelId !== "direct-openai") {
                this.model = params.modelId;
            }
        }
        return {};

      default:
        this.logErr(`Unhandled RPC method: ${method}`);
        throw new Error(`Method not implemented: ${method}`);
    }
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    // No-op
  }

  private getEndpointUrl(suffix: string): string {
    let base = this.apiBase.trim().replace(/\/+$/, "");
    if (base.endsWith(suffix)) return base;
    
    // Special handling for common partial suffixes
    if (suffix === "/v1/messages") {
        if (base.endsWith("/v1")) return base + "/messages";
    }
    
    return base + suffix;
  }

  private async handlePrompt(params: Record<string, unknown>): Promise<unknown> {
    if (this.providerType === "google") {
      return this.handleGeminiPrompt(params);
    } else if (this.providerType === "anthropic") {
      return this.handleAnthropicPrompt(params);
    } else {
      return this.handleOpenAIPrompt(params);
    }
  }

  private async handleAnthropicPrompt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params.sessionId as string;
    const promptBlocks = params.prompt as any[];
    const promptText = promptBlocks.map((b: any) => b.text).join("\n");
    const handler = this.sessionNotificationHandlers.get(sessionId);

    const url = this.getEndpointUrl("/v1/messages");

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: promptText }],
          max_tokens: 4096,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body not readable");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine === "event: message_stop") continue;

          if (trimmedLine.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmedLine.slice(6));
              if (data.type === "content_block_delta" && data.delta?.text) {
                const delta = data.delta.text;
                if (handler) {
                  handler("session/update", {
                    sessionId,
                    update: {
                      sessionUpdate: "text_delta",
                      text: delta,
                    },
                  });
                }
              }
            } catch (e) {
              // Ignore parse errors for partial chunks
            }
          }
        }
      }

      return { stopReason: "end_turn" };
    } catch (err) {
      this.logErr(`Anthropic prompt failed: ${err}`);
      throw err;
    }
  }

  private async handleOpenAIPrompt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params.sessionId as string;
    const promptBlocks = params.prompt as any[];
    const promptText = promptBlocks.map((b: any) => b.text).join("\n");
    const handler = this.sessionNotificationHandlers.get(sessionId);

    const url = this.getEndpointUrl("/chat/completions");

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: promptText }],
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI-compatible API error (${response.status}): ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body not readable");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine === "data: [DONE]") continue;

          if (trimmedLine.startsWith("data: ")) {
            const dataStr = trimmedLine.slice(6);
            try {
              const data = JSON.parse(dataStr);
              
              // Check for error in stream
              if (data.error) {
                throw new Error(`OpenAI Stream Error: ${data.error.message || JSON.stringify(data.error)}`);
              }

              const delta = data.choices[0]?.delta?.content;
              if (delta && handler) {
                handler("session/update", {
                  sessionId,
                  update: {
                    sessionUpdate: "text_delta",
                    text: delta,
                  },
                });
              }
            } catch (e) {
              // If it was our explicit error throw, rethrow it
              if (e instanceof Error && e.message.includes("OpenAI Stream Error")) throw e;
              // Otherwise ignore parse errors for partial chunks
            }
          }
        }
      }

      return { stopReason: "end_turn" };
    } catch (err) {
      this.logErr(`OpenAI prompt failed: ${err}`);
      throw err;
    }
  }

  private async handleGeminiPrompt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params.sessionId as string;
    const promptBlocks = params.prompt as any[];
    const promptText = promptBlocks.map((b: any) => b.text).join("\n");
    const handler = this.sessionNotificationHandlers.get(sessionId);

    // Google AI uses a different URL and body format
    let url = this.getEndpointUrl("");
    const modelSegment = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    
    if (url.includes("/models")) {
        if (url.endsWith("/models")) {
            const idOnly = this.model.replace(/^models\//, "");
            url = `${url}/${idOnly}:streamGenerateContent?key=${this.apiKey}`;
        } else {
            url = `${url}:streamGenerateContent?key=${this.apiKey}`;
        }
    } else {
        url = `${url}/${modelSegment}:streamGenerateContent?key=${this.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google AI API error (${response.status}): ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response body not readable");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        
        // Gemini streamGenerateContent often returns a JSON array: [ {...}, {...} ]
        // We'll try to find any { ... } block that looks like a candidate result.
        let pos = 0;
        while (pos < buffer.length) {
            // Find the start of a JSON object
            const startIdx = buffer.indexOf('{', pos);
            if (startIdx === -1) {
                // No more objects in buffer, but might be junk like "[" or ","
                pos = buffer.length;
                break;
            }
            
            // Find the matching closing brace
            let braceCount = 0;
            let endIdx = -1;
            for (let i = startIdx; i < buffer.length; i++) {
                if (buffer[i] === '{') braceCount++;
                else if (buffer[i] === '}') braceCount--;
                
                if (braceCount === 0) {
                    endIdx = i;
                    break;
                }
            }
            
            if (endIdx !== -1) {
                const jsonStr = buffer.slice(startIdx, endIdx + 1);
                try {
                    const data = JSON.parse(jsonStr);
                    // Standard Gemini response format
                    const delta = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (delta && handler) {
                        handler("session/update", {
                            sessionId,
                            update: {
                                sessionUpdate: "text_delta",
                                text: delta,
                            },
                        });
                    }
                } catch (e) {
                    // Not a valid JSON object or not the one we want, skip it
                }
                pos = endIdx + 1;
            } else {
                // Incomplete object, keep it in buffer for next read
                buffer = buffer.slice(startIdx);
                pos = buffer.length; // exit loop
                break;
            }
        }
        if (pos >= buffer.length) {
            buffer = "";
        } else {
            buffer = buffer.slice(pos);
        }
      }

      return { stopReason: "end_turn" };
    } catch (err) {
      this.logErr(`Gemini prompt failed: ${err}`);
      throw err;
    }
  }
}
