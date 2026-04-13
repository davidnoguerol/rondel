// Public surface of the channel subsystem.
//
// Per-channel adapters live in their own subfolder (./telegram today;
// add ./slack, ./discord, etc. as needed). Core interfaces and the
// registry live in ./core. External consumers should import from this
// barrel or from a specific channel subfolder barrel — never from
// concrete adapter files.
export type { ChannelAdapter, ChannelCredentials, ChannelMessage } from "./core/index.js";
export { ChannelRegistry } from "./core/index.js";
export { TelegramAdapter, registerTelegramTools } from "./telegram/index.js";
