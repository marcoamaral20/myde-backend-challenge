import type {
  ConversationListItem,
  ConversationMessageListItem,
  ConversationRepository,
} from "./conversation-repository.js";

export class ConversationService {
  constructor(private readonly conversationRepository: ConversationRepository) {}

  async listConversations(input: {
    tenantId: string;
    limit: number;
    offset: number;
  }): Promise<ConversationListItem[]> {
    return this.conversationRepository.listByTenant(input);
  }

  async listConversationMessages(input: {
    tenantId: string;
    conversationId: string;
    limit: number;
    offset: number;
  }): Promise<ConversationMessageListItem[] | null> {
    const conversationBelongsToTenant =
      await this.conversationRepository.existsForTenant({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
      });

    if (!conversationBelongsToTenant) {
      return null;
    }

    return this.conversationRepository.listMessagesByConversation(input);
  }
}
