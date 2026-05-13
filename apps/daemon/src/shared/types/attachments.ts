/**
 * Inbound attachment metadata carried alongside a `ChannelMessage`.
 *
 * Attachments are downloaded by the channel adapter (Telegram bot API
 * `getFile`, etc.) and staged on disk under
 * `~/.rondel/state/attachments/{agent}/{chatId}/` before the message is
 * dispatched to the router. The `path` field is the absolute path of the
 * staged file — the spawned Claude CLI has read access to that directory
 * via `--add-dir`.
 *
 * `kind` is the channel-agnostic classification used downstream:
 *   - "image"   → inlined as a base64 content block in stream-JSON
 *   - everything else → referenced by path in the text content block
 *     (the agent reads it via `Read` / `rondel_read_file` when it wants
 *     to look at the bytes).
 */
export type AttachmentKind =
  | "image"
  | "document"
  | "audio"
  | "voice"
  | "video"
  | "video-note"
  | "animation"
  | "sticker";

export interface ChannelAttachment {
  readonly kind: AttachmentKind;
  /** Absolute path under `state/attachments/{agent}/{chatId}/`. */
  readonly path: string;
  /** MIME type — sniffed when possible, falls back to channel metadata. */
  readonly mimeType: string;
  /** Size of the staged file in bytes. */
  readonly bytes: number;
  /** Original filename if the platform reports one (Telegram document). */
  readonly originalName?: string;
  /** Width in pixels for image / video kinds. */
  readonly width?: number;
  /** Height in pixels for image / video kinds. */
  readonly height?: number;
  /** Duration in seconds for audio / voice / video kinds. */
  readonly durationSec?: number;
}
