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
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || "";
    this.apiBase = opts.apiBase || process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
    this.model = opts.model || process.env.OPENAI_MODEL || "gpt-4o";
    this.providerType = process.env.FAZM_DIRECT_PROVIDER || "openai";
    this.logErr = opts.logErr || ((m) => process.stderr.write(`[direct-llm] ${m}\n`));
  }

  isRunning(): boolean {
    return true;
  }

  start(): void {
    this.logErr(`DirectLLMProvider started (type=${this.providerType}, base=${this.apiBase}, model=${this.model})`);
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

  private async handlePrompt(params: Record<string, unknown>): Promise<unknown> {
    if (this.providerType === "google") {
      return this.handleGeminiPrompt(params);
    } else {
      return this.handleOpenAIPrompt(params);
    }
  }

  private async handleOpenAIPrompt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params.sessionId as string;
    const promptBlocks = params.prompt as any[];
    const promptText = promptBlocks.map((b: any) => b.text).join("\n");
    const handler = this.sessionNotificationHandlers.get(sessionId);

    try {
      const response = await fetch(`${this.apiBase}/chat/completions`, {
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
            try {
              const data = JSON.parse(trimmedLine.slice(6));
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
              // Ignore parse errors for partial chunks
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
    const url = `${this.apiBase}/models/${this.model}:streamGenerateContent?key=${this.apiKey}`;

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

        buffer += decoder.decode(value, { stream: true });
        
        // Gemini returns a JSON array of objects, one per chunk. 
        // For simplicity, we'll try to find complete JSON objects in the stream.
        // This is a naive parser; a better one would track [ ] brackets.
        let startIdx = buffer.indexOf('{"candidates"');
        while (startIdx !== -1) {
            let endIdx = buffer.indexOf('}\n', startIdx);
            if (endIdx === -1) endIdx = buffer.indexOf('},', startIdx);
            if (endIdx === -1) break;
            
            try {
                const chunkStr = buffer.slice(startIdx, endIdx + 1);
                const data = JSON.parse(chunkStr);
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
                buffer = buffer.slice(endIdx + 1);
                startIdx = buffer.indexOf('{"candidates"');
            } catch (e) {
                // If parse fails, move past this startIdx to avoid infinite loop
                startIdx = buffer.indexOf('{"candidates"', startIdx + 1);
            }
        }
      }

      return { stopReason: "end_turn" };
    } catch (err) {
      this.logErr(`Gemini prompt failed: ${err}`);
      throw err;
    }
  }
}
