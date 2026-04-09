import type { AgentConfig } from "./types/index.js";

/**
 * Resolve a credential from an agent's channel bindings by channel type.
 * Returns the env var value, or undefined if the channel isn't configured
 * or the env var is not set.
 */
export function resolveChannelCredential(config: AgentConfig, channelType: string): string | undefined {
  const binding = config.channels.find((b) => b.channelType === channelType);
  if (!binding) return undefined;
  return process.env[binding.credentials];
}
