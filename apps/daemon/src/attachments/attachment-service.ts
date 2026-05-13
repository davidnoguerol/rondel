/**
 * Channel-agnostic orchestration layer for inbound attachments.
 *
 * Today the service knows how to ingest Telegram messages — it wraps
 * the bot API's `getFile` endpoint, downloads bytes via the file CDN,
 * applies size and MIME policy, and stages everything via the
 * `AttachmentStore`. Other channels (Slack files, Discord uploads)
 * will add sibling `ingestX` methods over time.
 *
 * Design notes
 * ------------
 *  - The service is *stateless* beyond its store + logger; no per-call
 *    side effects outside disk writes through the store.
 *  - 20 MB cap matches the Telegram bot API's `getFile` hard limit. Any
 *    larger file would fail at the API level anyway; we reject early so
 *    the adapter can give the user a useful reply.
 *  - 3× retry with 1–4 s + ±20 % jitter backoff follows OpenClaw's
 *    proven recipe (`extensions/telegram/src/bot/delivery.resolve-media.ts`).
 *    Permanent errors (HTTP 4xx, oversized) short-circuit; transient
 *    errors (network, 5xx) consume retries.
 *  - Stickers: static `.webp` is treated as an image (the model can
 *    actually look at it). Animated TGS and video WEBM are skipped
 *    silently — the model has no useful way to consume them and the
 *    bytes are wasted disk.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.js";
import type { AttachmentKind, ChannelAttachment } from "../shared/types/attachments.js";
import type { AttachmentStore } from "./attachment-store.js";

/**
 * Hard cap on a single attachment. Mirrors Telegram's `getFile` API
 * limit. Exposed so the adapter can format a user-facing reply.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Retry policy for `downloadFromTelegram`. Permanent failures (oversized
 * file, HTTP 4xx) short-circuit; transient ones consume attempts.
 */
const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_BASE_DELAY_MS = 1_000;
const DOWNLOAD_MAX_DELAY_MS = 4_000;

// ---------------------------------------------------------------------------
// Telegram inbound shapes (structural — adapter passes its parsed update)
// ---------------------------------------------------------------------------

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  width: number;
  height: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TgAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgVideoNote {
  file_id: string;
  file_unique_id: string;
  length: number;
  duration: number;
  file_size?: number;
}

export interface TgAnimation {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgSticker {
  file_id: string;
  file_unique_id: string;
  type?: string; // "regular" | "mask" | "custom_emoji"
  width: number;
  height: number;
  is_animated?: boolean;
  is_video?: boolean;
  mime_type?: string;
  file_size?: number;
}

/** The subset of a Telegram `Message` the service consumes. */
export interface TelegramIngestInput {
  readonly messageId: number;
  readonly photo?: TgPhotoSize[];
  readonly document?: TgDocument;
  readonly voice?: TgVoice;
  readonly audio?: TgAudio;
  readonly video?: TgVideo;
  readonly video_note?: TgVideoNote;
  readonly animation?: TgAnimation;
  readonly sticker?: TgSticker;
}

/**
 * Outcome describing why an attachment was rejected (so the adapter can
 * tell the user). Successes are returned via `attachments`.
 */
export interface IngestRejection {
  readonly kind: "oversized" | "unsupported" | "download_failed";
  readonly description: string;
}

export interface IngestResult {
  readonly attachments: ChannelAttachment[];
  readonly rejections: IngestRejection[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AttachmentService {
  private readonly log: Logger;

  constructor(
    private readonly store: AttachmentStore,
    log: Logger,
  ) {
    this.log = log.child("attachments");
  }

  /**
   * Download every attachment present on a Telegram message and stage
   * it on disk. Returns the resulting `ChannelAttachment[]` plus a
   * parallel list of rejections (oversized / unsupported / failed
   * download) so the adapter can build a single user-facing reply.
   *
   * Never throws — every error is captured as a rejection so a
   * partially-broken message still surfaces the parts that did
   * succeed.
   */
  async ingestTelegramMessage(
    agent: string,
    chatId: string,
    botToken: string,
    msg: TelegramIngestInput,
  ): Promise<IngestResult> {
    const attachments: ChannelAttachment[] = [];
    const rejections: IngestRejection[] = [];

    // --- Photo (largest size wins) ---
    if (msg.photo && msg.photo.length > 0) {
      const largest = pickLargestPhoto(msg.photo);
      await this.handleOne({
        agent,
        chatId,
        botToken,
        msg,
        fileId: largest.file_id,
        declaredSize: largest.file_size,
        declaredMime: "image/jpeg", // Telegram always re-encodes photos to JPEG
        kind: "image",
        label: "photo",
        meta: { width: largest.width, height: largest.height },
        originalName: undefined,
      }, attachments, rejections);
    }

    // --- Document (could be an image if mime starts with image/) ---
    if (msg.document) {
      const d = msg.document;
      const isImage = (d.mime_type ?? "").startsWith("image/");
      await this.handleOne({
        agent,
        chatId,
        botToken,
        msg,
        fileId: d.file_id,
        declaredSize: d.file_size,
        declaredMime: d.mime_type ?? "application/octet-stream",
        kind: isImage ? "image" : "document",
        label: "document",
        meta: {},
        originalName: d.file_name,
      }, attachments, rejections);
    }

    // --- Voice (Telegram OPUS-in-OGG) ---
    if (msg.voice) {
      const v = msg.voice;
      await this.handleOne({
        agent,
        chatId,
        botToken,
        msg,
        fileId: v.file_id,
        declaredSize: v.file_size,
        declaredMime: v.mime_type ?? "audio/ogg",
        kind: "voice",
        label: "voice",
        meta: { durationSec: v.duration },
        originalName: undefined,
      }, attachments, rejections);
    }

    // --- Audio (music files) ---
    if (msg.audio) {
      const a = msg.audio;
      await this.handleOne({
        agent,
        chatId,
        botToken,
        msg,
        fileId: a.file_id,
        declaredSize: a.file_size,
        declaredMime: a.mime_type ?? "audio/mpeg",
        kind: "audio",
        label: "audio",
        meta: { durationSec: a.duration },
        originalName: a.file_name,
      }, attachments, rejections);
    }

    // --- Video ---
    if (msg.video) {
      const v = msg.video;
      await this.handleOne({
        agent,
        chatId,
        botToken,
        msg,
        fileId: v.file_id,
        declaredSize: v.file_size,
        declaredMime: v.mime_type ?? "video/mp4",
        kind: "video",
        label: "video",
        meta: { width: v.width, height: v.height, durationSec: v.duration },
        originalName: v.file_name,
      }, attachments, rejections);
    }

    // --- Video note (round selfie videos) ---
    if (msg.video_note) {
      const v = msg.video_note;
      await this.handleOne({
        agent,
        chatId,
        botToken,
        msg,
        fileId: v.file_id,
        declaredSize: v.file_size,
        declaredMime: "video/mp4",
        kind: "video-note",
        label: "video note",
        meta: { durationSec: v.duration },
        originalName: undefined,
      }, attachments, rejections);
    }

    // --- Animation (GIF, often MP4 under the hood) ---
    if (msg.animation) {
      const a = msg.animation;
      const mime = a.mime_type ?? "video/mp4";
      // Animations are typically MP4 — model can't natively view them.
      // Treat as `animation` so the manifest line is descriptive.
      await this.handleOne({
        agent,
        chatId,
        botToken,
        msg,
        fileId: a.file_id,
        declaredSize: a.file_size,
        declaredMime: mime,
        kind: "animation",
        label: "animation",
        meta: { width: a.width, height: a.height, durationSec: a.duration },
        originalName: a.file_name,
      }, attachments, rejections);
    }

    // --- Sticker (only static WEBP becomes an image; others skipped) ---
    if (msg.sticker) {
      const s = msg.sticker;
      if (s.is_animated || s.is_video) {
        this.log.debug(`Skipping animated/video sticker (file_id=${s.file_id})`);
        // Silent skip — don't add to rejections since OpenClaw treats
        // unsupported stickers as non-events and the user typically
        // sends them as flair, not as content.
      } else {
        await this.handleOne({
          agent,
          chatId,
          botToken,
          msg,
          fileId: s.file_id,
          declaredSize: s.file_size,
          declaredMime: s.mime_type ?? "image/webp",
          kind: "image",
          label: "sticker",
          meta: { width: s.width, height: s.height },
          originalName: undefined,
        }, attachments, rejections);
      }
    }

    return { attachments, rejections };
  }

  /**
   * Download bytes for a single Telegram `file_id`. Public so the
   * adapter (or tests) can reuse the retry / cap logic.
   *
   * Throws on permanent failure (oversized, 4xx). Returns the bytes on
   * success. Callers running inside `ingestTelegramMessage` get errors
   * converted to rejections.
   */
  async downloadFromTelegram(botToken: string, fileId: string): Promise<Buffer> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const fileInfo = await this.getFileInfo(botToken, fileId);
        if (typeof fileInfo.file_size === "number" && fileInfo.file_size > MAX_ATTACHMENT_BYTES) {
          throw new OversizedError(fileInfo.file_size);
        }
        if (!fileInfo.file_path) {
          throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
        }
        const bytes = await this.downloadFileBytes(botToken, fileInfo.file_path);
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          // CDN occasionally returns more than declared (e.g. files
          // uploaded by another bot with stale metadata). Belt and
          // braces.
          throw new OversizedError(bytes.byteLength);
        }
        return bytes;
      } catch (err) {
        lastErr = err;
        if (err instanceof OversizedError) throw err;
        if (err instanceof PermanentDownloadError) throw err;
        if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
          const backoff = pickBackoff(attempt);
          this.log.warn(
            `Telegram download attempt ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} failed for ${fileId}: ` +
            `${err instanceof Error ? err.message : String(err)} — retrying in ${backoff}ms`,
          );
          await delay(backoff);
        }
      }
    }
    throw lastErr ?? new Error(`Download failed for ${fileId}`);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async handleOne(args: HandleOneArgs, attachments: ChannelAttachment[], rejections: IngestRejection[]): Promise<void> {
    // Pre-check the declared size to skip the round-trip to getFile
    // when the user clearly sent something too large.
    if (typeof args.declaredSize === "number" && args.declaredSize > MAX_ATTACHMENT_BYTES) {
      rejections.push({
        kind: "oversized",
        description: formatRejection(args, "exceeds 20 MB cap"),
      });
      this.log.warn(`Rejected ${args.label} ${args.fileId}: declared ${args.declaredSize}B > ${MAX_ATTACHMENT_BYTES}B`);
      return;
    }

    let bytes: Buffer;
    try {
      bytes = await this.downloadFromTelegram(args.botToken, args.fileId);
    } catch (err) {
      if (err instanceof OversizedError) {
        rejections.push({
          kind: "oversized",
          description: formatRejection(args, "exceeds 20 MB cap"),
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      rejections.push({
        kind: "download_failed",
        description: formatRejection(args, `download failed (${message})`),
      });
      return;
    }

    const ext = pickExtension(args.declaredMime, args.originalName);
    const staged = await this.store.save(args.agent, args.chatId, bytes, {
      messageId: args.msg.messageId,
      extension: ext,
    });

    attachments.push({
      kind: args.kind,
      path: staged.path,
      mimeType: args.declaredMime,
      bytes: staged.bytes,
      originalName: args.originalName,
      width: args.meta.width,
      height: args.meta.height,
      durationSec: args.meta.durationSec,
    });

    this.log.info(
      `Staged ${args.label} (${args.kind}, ${staged.bytes}B, ${args.declaredMime}) ` +
      `for ${args.agent}:${args.chatId} → ${staged.path}`,
    );
  }

  private async getFileInfo(botToken: string, fileId: string): Promise<{ file_path?: string; file_size?: number }> {
    const url = `https://api.telegram.org/bot${botToken}/getFile`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status >= 400 && res.status < 500) {
        // Telegram surfaces "file is too big" as 400. We've already
        // capped declared sizes, but a fresh 400 still means there's no
        // useful retry — it'll just keep failing.
        if (text.includes("file is too big")) {
          throw new OversizedError(undefined);
        }
        throw new PermanentDownloadError(`Telegram getFile ${res.status}: ${text.slice(0, 200)}`);
      }
      throw new Error(`Telegram getFile ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.json() as { ok: boolean; result?: { file_path?: string; file_size?: number }; description?: string };
    if (!body.ok || !body.result) {
      throw new PermanentDownloadError(`Telegram getFile ok=false: ${body.description ?? "unknown"}`);
    }
    return body.result;
  }

  private async downloadFileBytes(botToken: string, filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        throw new PermanentDownloadError(`Telegram file CDN ${res.status} for ${filePath}`);
      }
      throw new Error(`Telegram file CDN ${res.status} for ${filePath}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return buf;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HandleOneArgs {
  readonly agent: string;
  readonly chatId: string;
  readonly botToken: string;
  readonly msg: TelegramIngestInput;
  readonly fileId: string;
  readonly declaredSize?: number;
  readonly declaredMime: string;
  readonly kind: AttachmentKind;
  readonly label: string; // human-readable for logs / rejection messages
  readonly meta: { width?: number; height?: number; durationSec?: number };
  readonly originalName: string | undefined;
}

class OversizedError extends Error {
  constructor(public readonly bytes: number | undefined) {
    super(bytes ? `Oversized (${bytes} bytes)` : "Oversized");
    this.name = "OversizedError";
  }
}

class PermanentDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDownloadError";
  }
}

function pickLargestPhoto(photos: TgPhotoSize[]): TgPhotoSize {
  let best = photos[0]!;
  for (const p of photos) {
    if (p.width * p.height > best.width * best.height) best = p;
  }
  return best;
}

function pickBackoff(attempt: number): number {
  // Exponential within the configured min/max with ±20% jitter.
  const base = Math.min(DOWNLOAD_MAX_DELAY_MS, DOWNLOAD_BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Best-effort extension picker. Prefer the original filename's
 * extension if present; otherwise map the declared MIME. Falls back to
 * empty string when nothing useful is available — the stored file just
 * has no extension, the bytes are intact.
 */
function pickExtension(mime: string, originalName: string | undefined): string {
  if (originalName) {
    const dot = originalName.lastIndexOf(".");
    if (dot > 0 && dot < originalName.length - 1) {
      const ext = originalName.slice(dot).toLowerCase();
      if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
    }
  }
  return MIME_TO_EXT[mime.toLowerCase()] ?? "";
}

// Note: HEIC/HEIF land here as `image/heic` and `image/heif`. They are
// NOT in Claude's stream-JSON image content-block allowlist (only
// jpeg/png/gif/webp are inlineable today — see
// `CLAUDE_IMAGE_MIME_ALLOWLIST` in agent-process.ts). HEIC stickers /
// documents still stage to disk and surface as manifest-only entries,
// which is the right fallback; the agent reads bytes via tools if it
// wants to handle them.
const MIME_TO_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/ogg": ".ogg",
  "audio/oga": ".oga",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
};

function formatRejection(args: HandleOneArgs, reason: string): string {
  const name = args.originalName ? ` "${args.originalName}"` : "";
  return `${args.label}${name}: ${reason}`;
}
