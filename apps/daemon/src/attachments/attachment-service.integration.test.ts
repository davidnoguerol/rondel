import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { AttachmentStore } from "./attachment-store.js";
import { AttachmentService, MAX_ATTACHMENT_BYTES } from "./attachment-service.js";
import { withTmpRondel } from "../../../../tests/helpers/tmp.js";
import { createCapturingLogger } from "../../../../tests/helpers/logger.js";

/**
 * Telegram bot API is mocked at the `fetch` level: the service makes
 * exactly two calls per attachment — `getFile` (JSON) followed by the
 * file CDN URL (bytes). The mock pattern below dispatches on URL
 * substring, returning either a JSON envelope or a raw byte body.
 */

interface FileFixture {
  fileId: string;
  filePath: string;
  body: Buffer;
  /** Override `file_size` reported by getFile. Defaults to `body.length`. */
  declaredSize?: number;
}

function mockFetch(fixtures: FileFixture[]): ReturnType<typeof vi.spyOn> {
  const byFileId = new Map(fixtures.map((f) => [f.fileId, f]));
  const byPath = new Map(fixtures.map((f) => [f.filePath, f]));

  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    if (url.includes("/getFile")) {
      const body = init?.body ? JSON.parse(init.body as string) as { file_id: string } : { file_id: "" };
      const fixture = byFileId.get(body.file_id);
      if (!fixture) {
        return new Response(JSON.stringify({ ok: false, description: "file not found" }), {
          status: 404,
        });
      }
      const declared = fixture.declaredSize ?? fixture.body.length;
      return new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: fixture.filePath, file_size: declared, file_id: fixture.fileId },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // File CDN path → return raw bytes
    if (url.includes("/file/bot")) {
      const path = url.split("/file/bot")[1]?.split("/").slice(1).join("/") ?? "";
      const fixture = byPath.get(path);
      if (!fixture) {
        return new Response("not found", { status: 404 });
      }
      return new Response(fixture.body, { status: 200 });
    }
    throw new Error(`unexpected fetch URL in test: ${url}`);
  });
}

function newService(tmpStateDir: string): { service: AttachmentService; store: AttachmentStore } {
  const store = new AttachmentStore(join(tmpStateDir, "attachments"), createCapturingLogger());
  const service = new AttachmentService(store, createCapturingLogger());
  return { service, store };
}

describe("AttachmentService.ingestTelegramMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stages a Telegram photo as an image attachment with sniffed MIME and JPEG ext", async () => {
    const tmp = withTmpRondel();
    const { service, store } = newService(tmp.stateDir);

    mockFetch([
      {
        fileId: "photo_id",
        filePath: "photos/file_1.jpg",
        body: Buffer.from("FAKE_JPEG_BYTES"),
      },
    ]);

    const result = await service.ingestTelegramMessage("alice", "42", "TOK", {
      messageId: 101,
      photo: [
        { file_id: "photo_id", file_unique_id: "u", width: 1280, height: 960, file_size: 15 },
      ],
    });

    expect(result.rejections).toHaveLength(0);
    expect(result.attachments).toHaveLength(1);
    const a = result.attachments[0];
    expect(a.kind).toBe("image");
    expect(a.mimeType).toBe("image/jpeg");
    expect(a.bytes).toBe("FAKE_JPEG_BYTES".length);
    expect(a.path.endsWith(".jpg")).toBe(true);

    // The bytes actually landed on disk and the store can see them.
    const listed = await store.list("alice", "42");
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe(a.path);
  });

  it("recognises an image document (mime starts with image/) and classifies kind=image", async () => {
    const tmp = withTmpRondel();
    const { service } = newService(tmp.stateDir);

    mockFetch([
      {
        fileId: "doc_image",
        filePath: "documents/file.png",
        body: Buffer.from("FAKE_PNG_BYTES"),
      },
    ]);

    const result = await service.ingestTelegramMessage("alice", "1", "TOK", {
      messageId: 1,
      document: {
        file_id: "doc_image",
        file_unique_id: "u",
        mime_type: "image/png",
        file_name: "screenshot.png",
        file_size: 14,
      },
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].kind).toBe("image");
    expect(result.attachments[0].mimeType).toBe("image/png");
    expect(result.attachments[0].originalName).toBe("screenshot.png");
  });

  it("stages a Telegram voice note as kind='voice' with duration metadata", async () => {
    const tmp = withTmpRondel();
    const { service } = newService(tmp.stateDir);

    mockFetch([
      {
        fileId: "voice_id",
        filePath: "voices/file.oga",
        body: Buffer.from("OGG_OPUS_BYTES"),
      },
    ]);

    const result = await service.ingestTelegramMessage("alice", "1", "TOK", {
      messageId: 5,
      voice: {
        file_id: "voice_id",
        file_unique_id: "u",
        duration: 7,
        mime_type: "audio/ogg",
        file_size: 14,
      },
    });

    expect(result.attachments).toHaveLength(1);
    const v = result.attachments[0];
    expect(v.kind).toBe("voice");
    expect(v.durationSec).toBe(7);
    expect(v.mimeType).toBe("audio/ogg");
  });

  it("rejects oversized documents declared above the 20 MB cap without making the file CDN call", async () => {
    const tmp = withTmpRondel();
    const { service } = newService(tmp.stateDir);

    const fetchSpy = mockFetch([]); // no fixtures — any actual network attempt would 404

    const result = await service.ingestTelegramMessage("alice", "1", "TOK", {
      messageId: 9,
      document: {
        file_id: "huge",
        file_unique_id: "u",
        file_name: "huge.zip",
        mime_type: "application/zip",
        file_size: MAX_ATTACHMENT_BYTES + 1,
      },
    });

    expect(result.attachments).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].kind).toBe("oversized");
    // Critically: we short-circuited before touching the network.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns oversized rejection (no exception) when Telegram getFile returns a too-big file_size", async () => {
    const tmp = withTmpRondel();
    const { service } = newService(tmp.stateDir);

    mockFetch([
      {
        fileId: "sneaky",
        filePath: "photos/sneaky.jpg",
        // Bytes don't matter — the declared file_size triggers rejection.
        body: Buffer.from("anything"),
        declaredSize: MAX_ATTACHMENT_BYTES + 100,
      },
    ]);

    const result = await service.ingestTelegramMessage("alice", "1", "TOK", {
      messageId: 11,
      // Photo has no declared file_size here, so the pre-check passes
      // and the rejection happens at getFile time.
      photo: [
        { file_id: "sneaky", file_unique_id: "u", width: 100, height: 100 },
      ],
    });

    expect(result.attachments).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].kind).toBe("oversized");
  });

  it("skips animated stickers silently (no rejection, no attachment)", async () => {
    const tmp = withTmpRondel();
    const { service } = newService(tmp.stateDir);

    const fetchSpy = mockFetch([]);

    const result = await service.ingestTelegramMessage("alice", "1", "TOK", {
      messageId: 1,
      sticker: {
        file_id: "tgs",
        file_unique_id: "u",
        width: 512,
        height: 512,
        is_animated: true,
      },
    });

    expect(result.attachments).toHaveLength(0);
    expect(result.rejections).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("static .webp stickers are treated as images and staged on disk", async () => {
    const tmp = withTmpRondel();
    const { service } = newService(tmp.stateDir);

    mockFetch([
      {
        fileId: "static_sticker",
        filePath: "stickers/file.webp",
        body: Buffer.from("WEBP_BYTES"),
      },
    ]);

    const result = await service.ingestTelegramMessage("alice", "1", "TOK", {
      messageId: 1,
      sticker: {
        file_id: "static_sticker",
        file_unique_id: "u",
        width: 512,
        height: 512,
        mime_type: "image/webp",
      },
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].kind).toBe("image");
    expect(result.attachments[0].mimeType).toBe("image/webp");
  });

  it("ingests a multi-media message (photo + caption document) and stages both", async () => {
    const tmp = withTmpRondel();
    const { service, store } = newService(tmp.stateDir);

    mockFetch([
      {
        fileId: "p1",
        filePath: "photos/p1.jpg",
        body: Buffer.from("PHOTO_BYTES"),
      },
      {
        fileId: "d1",
        filePath: "docs/d1.pdf",
        body: Buffer.from("PDF_BYTES"),
      },
    ]);

    const result = await service.ingestTelegramMessage("alice", "1", "TOK", {
      messageId: 33,
      photo: [{ file_id: "p1", file_unique_id: "u", width: 100, height: 100 }],
      document: {
        file_id: "d1",
        file_unique_id: "u",
        mime_type: "application/pdf",
        file_name: "contract.pdf",
      },
    });

    expect(result.rejections).toHaveLength(0);
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments.map((a) => a.kind).sort()).toEqual(["document", "image"]);

    const listed = await store.list("alice", "1");
    expect(listed).toHaveLength(2);
  });
});
