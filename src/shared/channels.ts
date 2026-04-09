import type { AgentConfig } from "./types/index.js";

/**
 * Resolve a credential from an agent's channel bindings by channel type.
 * Returns the env var value, or undefined if the channel isn't configured
 * or the env var is not set.
 */
export function resolveChannelCredential(config: AgentConfig, channelType: string): string | undefined {
  const binding = config.channels.find((b) => b.channelType === channelType);
  if (!binding) return undefined;
  return process.env[binding.credentialEnvVar];
}

/**
 * Build MCP env vars for channel credentials.
 * Produces RONDEL_CHANNEL_{TYPE}_TOKEN for each configured channel binding
 * where the credential env var is set. This keeps channel-specific knowledge
 * out of conversation-manager and cron-runner.
 */
export function buildChannelMcpEnv(config: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const binding of config.channels) {
    const value = process.env[binding.credentialEnvVar];
    if (value) {
      const key = `RONDEL_CHANNEL_${binding.channelType.toUpperCase()}_TOKEN`;
      env[key] = value;
      // Legacy compat: MCP server reads RONDEL_BOT_TOKEN for Telegram
      if (binding.channelType === "telegram") {
        env.RONDEL_BOT_TOKEN = value;
      }
    }
  }
  return env;
}
