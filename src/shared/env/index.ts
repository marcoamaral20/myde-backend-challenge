import { z } from "zod";

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    PORT: z.coerce.number().int().positive().default(8000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    META_VERIFY_TOKEN: z.string().min(1),
    META_APP_SECRET: z.string().min(1),
    META_API_BASE_URL: z.string().url(),
    AI_PROVIDER: z.enum(["stub", "openai"]).default("stub"),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
    OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  .superRefine((value, ctx) => {
    if (value.AI_PROVIDER === "openai" && !value.OPENAI_API_KEY?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENAI_API_KEY"],
        message: "OPENAI_API_KEY is required when AI_PROVIDER=openai",
      });
    }
  });

const parsedEnv = EnvSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const formattedErrors = parsedEnv.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

  throw new Error(
    `Invalid environment configuration: ${JSON.stringify(formattedErrors)}`,
  );
}

export const env = parsedEnv.data;
export type Env = typeof env;
