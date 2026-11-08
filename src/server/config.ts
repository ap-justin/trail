import { z } from "zod";

const envSchema = z.object({
  DATABASE_PATH: z.string().min(1).default("./data/trail.db"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
