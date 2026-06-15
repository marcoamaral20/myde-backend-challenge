import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../shared/logger/index.js";

export type KnowledgeBaseContext = {
  content: string;
  promptRules: string[];
};

const defaultPromptRules = [
  "Responda apenas usando a base de conhecimento.",
  "Se a informação não estiver disponível, diga que não possui informação suficiente.",
  "Mantenha a resposta curta e adequada para WhatsApp.",
  "Não invente preços, prazos, políticas ou informações operacionais.",
];

export class KnowledgeBaseService {
  constructor(
    private readonly basePath = path.join(process.cwd(), "knowledge-base"),
  ) {}

  async loadContext(): Promise<KnowledgeBaseContext> {
    const files = await this.listKnowledgeBaseFiles();
    const documents = await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        content: await readFile(filePath, "utf8"),
      })),
    );

    return {
      content: documents
        .map((document) => {
          const relativePath = path.relative(this.basePath, document.filePath);

          return `# ${relativePath}\n${document.content.trim()}`;
        })
        .filter(Boolean)
        .join("\n\n"),
      promptRules: defaultPromptRules,
    };
  }

  private async listKnowledgeBaseFiles() {
    try {
      return await listFilesRecursively(this.basePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        createLogger({ event: "knowledge_base_missing" }).warn({
          path: this.basePath,
        });
        return [];
      }

      throw error;
    }
  }
}

const supportedExtensions = new Set([".md", ".txt"]);

const listFilesRecursively = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listFilesRecursively(entryPath);
      }

      if (entry.isFile() && supportedExtensions.has(path.extname(entry.name))) {
        return [entryPath];
      }

      return [];
    }),
  );

  return files.flat().sort();
};
