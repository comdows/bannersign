import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  WORKER_SHARED_SECRET: z.string().min(16),
  CREDENTIALS_ENC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  SUBMIT_DRY_RUN_DEFAULT: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  PORT: z.coerce.number().default(8080),
});

export const env = envSchema.parse(process.env);
