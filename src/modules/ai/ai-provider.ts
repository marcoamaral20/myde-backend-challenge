export type ConversationHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type GenerateReplyInput = {
  tenantId: string;
  conversationId: string;
  messageId: string;
  userMessage: string;
  history: ConversationHistoryMessage[];
  knowledgeBase: string;
  promptRules: string[];
  correlationId: string;
};

export interface AIProvider {
  generateReply(input: GenerateReplyInput): Promise<string>;
}
