import type { AIProvider, GenerateReplyInput } from "./ai-provider.js";

const fallbackReply =
  "Não tenho informação suficiente na base de conhecimento para responder com segurança.";

export class StubAIProvider implements AIProvider {
  async generateReply(input: GenerateReplyInput): Promise<string> {
    const normalizedMessage = input.userMessage.trim();
    const knowledgeBase = input.knowledgeBase.trim();

    if (!knowledgeBase) {
      return `${fallbackReply} Recebi sua mensagem: "${normalizedMessage}".`;
    }

    const relevantSnippet = findRelevantSnippet(normalizedMessage, knowledgeBase);

    if (!relevantSnippet) {
      return fallbackReply;
    }

    return `Com base na base de conhecimento: ${relevantSnippet}`;
  }
}

const findRelevantSnippet = (message: string, knowledgeBase: string) => {
  const keywords = new Set(
    message
      .toLocaleLowerCase("pt-BR")
      .split(/\W+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 4),
  );

  const paragraphs = knowledgeBase
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const matchingParagraph = paragraphs.find((paragraph) => {
    const normalizedParagraph = paragraph.toLocaleLowerCase("pt-BR");

    for (const keyword of keywords) {
      if (normalizedParagraph.includes(keyword)) {
        return true;
      }
    }

    return false;
  });

  return matchingParagraph ? truncateForWhatsApp(matchingParagraph) : undefined;
};

const truncateForWhatsApp = (text: string) => {
  if (text.length <= 450) {
    return text;
  }

  return `${text.slice(0, 447).trimEnd()}...`;
};
