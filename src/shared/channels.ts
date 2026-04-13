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
 *
 * Produces `RONDEL_CHANNEL_{TYPE}_TOKEN` for each binding's primary credential,
 * plus `RONDEL_CHANNEL_{TYPE}_{KEY}` for each entry in the binding's
 * `extraEnvVars`. This keeps channel-specific knowledge out of
 * conversation-manager and cron-runner.
 *
 * Example: a Slack binding with `credentialEnvVar: "RONDEL_SLACK_BOT"` and
 * `extraEnvVars: { appToken: "RONDEL_SLACK_APP" }` produces:
 *   RONDEL_CHANNEL_SLACK_TOKEN=<bot token>
 *   RONDEL_CHANNEL_SLACK_APPTOKEN=<app token>
 */
export function buildChannelMcpEnv(config: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const binding of config.channels) {
    const typePrefix = `RONDEL_CHANNEL_${binding.channelType.toUpperCase()}`;

    const primary = process.env[binding.credentialEnvVar];
    if (primary) {
      env[`${typePrefix}_TOKEN`] = primary;
    }

    for (const [key, envVarName] of Object.entries(binding.extraEnvVars ?? {})) {
      const value = process.env[envVarName];
      if (value) {
        env[`${typePrefix}_${key.toUpperCase()}`] = value;
      }
    }
  }
  return env;
}
