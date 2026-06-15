import { env } from "../../shared/env/index.js";
import type { AIProvider } from "./ai-provider.js";
import { StubAIProvider } from "./stub-ai-provider.js";

export const createAIProvider = (): AIProvider => {
  if (env.AI_PROVIDER === "stub") {
    return new StubAIProvider();
  }

  throw new Error("AI_PROVIDER=openai is not implemented in this milestone");
};

export type {
  AIProvider,
  ConversationHistoryMessage,
  GenerateReplyInput,
} from "./ai-provider.js";
