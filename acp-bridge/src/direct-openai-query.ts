import type { QueryMessage, OutboundMessage, PriorContextEntry } from "./protocol.js";
import type { DirectOpenAIProvider } from "./direct-openai-provider.js";

export interface DirectOpenAIQueryDeps {
  logErr: (msg: string) => void;
  send: (msg: OutboundMessage) => void;
  sendWithSession: (sessionId: string | undefined, msg: OutboundMessage) => void;
  getProvider: () => DirectOpenAIProvider;
  registerSession: (sessionKey: string, entry: { sessionId: string; cwd: string; model?: string; provider: "claude" | "codex" | "gemini" | "direct-openai" }) => void;
}

interface OpenAISessionEntry {
  sessionId: string;
  cwd: string;
  modelId: string;
}

const openAISessions = new Map<string, OpenAISessionEntry>();
const openAISessionIdToKey = new Map<string, string>();

export function isDirectOpenAIModel(modelId: string | undefined): boolean {
  if (process.env.FAZM_USE_DIRECT_MODEL_ONLY === "true") return true;
  if (!modelId) return false;
  return modelId.startsWith("direct-") || modelId.startsWith("ollama-") || modelId.startsWith("openai-") || modelId.startsWith("models/gemini-");
}

export async function handleDirectOpenAIQuery(msg: QueryMessage, deps: DirectOpenAIQueryDeps): Promise<void> {
  const { logErr, send, sendWithSession, getProvider, registerSession } = deps;
  const sessionKey = msg.sessionKey ?? msg.model ?? "direct-default";
  const cwd = msg.cwd ?? process.env.HOME ?? process.cwd();
  
  // Use the direct model from env if in bypass mode or if model is missing
  const modelId = (process.env.FAZM_USE_DIRECT_MODEL_ONLY === "true" ? process.env.FAZM_DIRECT_MODEL : null) 
    ?? msg.model 
    ?? process.env.FAZM_DIRECT_MODEL 
    ?? "gpt-4o";

  let provider: DirectOpenAIProvider;
  try {
    provider = getProvider();
    provider.start();
  } catch (err) {
    logErr(`[direct-openai-query] init failed: ${err}`);
    send({ type: "error", message: `Direct OpenAI unavailable: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  let entry = openAISessions.get(sessionKey);
  if (entry && (entry.cwd !== cwd || entry.modelId !== modelId)) {
    logErr(`[direct-openai-query] dropping cached session for ${sessionKey}: cwd or model changed`);
    openAISessions.delete(sessionKey);
    openAISessionIdToKey.delete(entry.sessionId);
    entry = undefined;
  }

  if (!entry) {
    try {
      const result = (await provider.request("session/new", { cwd })) as { sessionId: string };
      entry = { sessionId: result.sessionId, cwd, modelId };
      openAISessions.set(sessionKey, entry);
      openAISessionIdToKey.set(entry.sessionId, sessionKey);
      registerSession(sessionKey, { sessionId: entry.sessionId, cwd, model: modelId, provider: "direct-openai" });
      sendWithSession(entry.sessionId, { type: "session_started", sessionKey, isResume: false } as OutboundMessage);
      
      await provider.request("session/set_model", { sessionId: entry.sessionId, modelId });
    } catch (err) {
      logErr(`[direct-openai-query] session/new failed: ${err}`);
      send({ type: "error", message: `Direct OpenAI session failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
  }

  const sessionId = entry.sessionId;

  // We don't have a complex translator for OpenAI yet, we'll just capture text deltas
  let collectedText = "";
  provider.registerSessionHandler(sessionId, (method, params) => {
    if (method !== "session/update") return;
    const p = params as any;
    if (p.update?.sessionUpdate === "text_delta") {
      collectedText += p.update.text;
      sendWithSession(sessionId, { type: "text_delta", text: p.update.text, sessionId });
    }
  });

  try {
    const promptResult = (await provider.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: msg.prompt }],
    })) as { stopReason: string };

    if (!collectedText) {
        logErr("[direct-openai-query] model returned empty response");
    }

    sendWithSession(sessionId, {
      type: "result",
      text: collectedText || " ", // Send a space so it's not strictly empty
      sessionId,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  } catch (err) {
    logErr(`[direct-openai-query] session/prompt failed: ${err}`);
    send({ type: "error", message: `Direct OpenAI prompt failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export function interruptDirectOpenAISession(sessionKey: string, provider: DirectOpenAIProvider): boolean {
  const entry = openAISessions.get(sessionKey);
  if (!entry) return false;
  provider.unregisterSessionHandler(entry.sessionId);
  openAISessions.delete(sessionKey);
  openAISessionIdToKey.delete(entry.sessionId);
  return true;
}
