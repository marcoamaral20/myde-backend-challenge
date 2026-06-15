import OpenAI, { APIError } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AIProvider, GenerateReplyInput } from "./ai-provider.js";
import { createLogger } from "../../shared/logger/index.js";

const fallbackReply =
  "Não tenho informação suficiente na base de conhecimento para responder com segurança.";

const maxHistoryMessages = 8;
const maxHistoryMessageCharacters = 1_500;
const maxKnowledgeBaseCharacters = 12_000;
const maxReplyTokens = 350;
const temperature = 0.2;

export type OpenAIProviderConfig = {
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export class OpenAIProvider implements AIProvider {
  private readonly client: OpenAI;

  constructor(private readonly config: OpenAIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
      // BullMQ owns retries for worker failures in this project.
      maxRetries: 0,
    });
  }

  async generateReply(input: GenerateReplyInput): Promise<string> {
    const log = createLogger({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      correlationId: input.correlationId,
    });

    const knowledgeBase = truncateText(
      input.knowledgeBase.trim(),
      maxKnowledgeBaseCharacters,
    );

    if (!knowledgeBase) {
      log.info({
        event: "ai_safe_fallback_used",
        reason: "knowledge_base_empty",
        provider: "openai",
      });
      return fallbackReply;
    }

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: this.config.model,
          temperature,
          max_tokens: maxReplyTokens,
          messages: buildMessages(input, knowledgeBase),
        },
        {
          timeout: this.config.timeoutMs,
        },
      );

      const usage = completion.usage;

      if (usage) {
        log.info({
          event: "openai_token_usage",
          provider: "openai",
          model: this.config.model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        });
      }

      const content = completion.choices[0]?.message.content?.trim();

      if (!content) {
        log.warn({
          event: "ai_safe_fallback_used",
          reason: "empty_openai_response",
          provider: "openai",
          model: this.config.model,
        });
        return fallbackReply;
      }

      return content;
    } catch (error) {
      log.warn({
        event: "openai_call_failed",
        provider: "openai",
        model: this.config.model,
        error: error instanceof Error ? error.message : "Unknown error",
        status: error instanceof APIError ? error.status : undefined,
        requestId: error instanceof APIError ? error.requestID : undefined,
      });

      throw error;
    }
  }
}

const buildMessages = (
  input: GenerateReplyInput,
  knowledgeBase: string,
): ChatCompletionMessageParam[] => [
  {
    role: "developer",
    content: [
      "Você é um atendente de WhatsApp da empresa.",
      "Responda em português do Brasil.",
      "Use exclusivamente a base de conhecimento fornecida.",
      `Se a base não tiver informação suficiente, responda exatamente: "${fallbackReply}"`,
      "Não invente preços, prazos, políticas, links ou informações operacionais.",
      "Mantenha a resposta curta, objetiva e adequada para WhatsApp.",
      ...input.promptRules,
    ].join("\n"),
  },
  {
    role: "user",
    content: `Base de conhecimento:\n${knowledgeBase}`,
  },
  ...buildHistoryMessages(input),
  {
    role: "user",
    content: truncateText(input.userMessage, maxHistoryMessageCharacters),
  },
];

const buildHistoryMessages = (
  input: GenerateReplyInput,
): ChatCompletionMessageParam[] => {
  const recentHistory = input.history
    .filter(
      (message, index, history) =>
        !(
          index === history.length - 1 &&
          message.role === "user" &&
          message.content.trim() === input.userMessage.trim()
        ),
    )
    .slice(-maxHistoryMessages);

  return recentHistory.map((message) => ({
    role: message.role,
    content: truncateText(message.content, maxHistoryMessageCharacters),
  }));
};

const truncateText = (text: string, maxCharacters: number) => {
  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, maxCharacters - 3).trimEnd()}...`;
};
