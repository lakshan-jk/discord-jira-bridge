import { envSchema, toConfig, type Config } from './schema.js';

export type { Config } from './schema.js';

/** Thrown when the environment fails validation. Message lists every problem. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validate the given environment (defaults to process.env) and return the grouped
 * Config. Throws ConfigError listing every problem at once — so a misconfigured
 * deployment fails fast on startup rather than at first use.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }
  return toConfig(result.data);
}

/**
 * Eagerly-loaded singleton. Importing this module validates the environment, giving
 * the fail-fast-on-startup guarantee. Tests that need custom env can call
 * loadConfig() directly instead of importing this binding.
 */
export const config: Config = loadConfig();
