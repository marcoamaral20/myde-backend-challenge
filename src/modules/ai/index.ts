import { env } from "../../shared/env/index.js";
import type { AIProvider } from "./ai-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { StubAIProvider } from "./stub-ai-provider.js";

export const createAIProvider = (): AIProvider => {
  if (env.AI_PROVIDER === "stub") {
    return new StubAIProvider();
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  }

  return new OpenAIProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    timeoutMs: env.OPENAI_TIMEOUT_MS,
  });
};

export type {
  AIProvider,
  ConversationHistoryMessage,
  GenerateReplyInput,
} from "./ai-provider.js";
