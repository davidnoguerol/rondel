import { describe, it, expect } from "vitest";
import { scanForSecrets } from "./secret-scanner.js";

describe("scanForSecrets — positive matches", () => {
  it("detects AWS access key id", () => {
    const content = "key = AKIAIOSFODNN7EXAMPLE";
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "aws_access_key_id")).toBe(true);
  });

  it("detects aws_secret_access_key assignment", () => {
    const content = "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "aws_secret_key_assign")).toBe(true);
  });

  it("detects GitHub token (ghp_)", () => {
    const content = "token: ghp_" + "A".repeat(40);
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "github_token")).toBe(true);
  });

  it("detects GitHub token (gho_)", () => {
    const content = "gho_" + "B".repeat(40);
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "github_token")).toBe(true);
  });

  it("detects OpenAI key", () => {
    const content = "key = sk-" + "a".repeat(48);
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "openai_key")).toBe(true);
  });

  it("detects Telegram bot token", () => {
    const content = "TOKEN=1234567890:" + "A".repeat(35);
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "telegram_bot_token")).toBe(true);
  });

  it("detects PEM private key header (RSA)", () => {
    const content = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIB...\n";
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "private_key_header")).toBe(true);
  });

  it("detects PEM private key header (generic)", () => {
    const content = "-----BEGIN PRIVATE KEY-----\n";
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "private_key_header")).toBe(true);
  });

  it("detects OPENSSH PRIVATE KEY header", () => {
    const content = "-----BEGIN OPENSSH PRIVATE KEY-----\n";
    const matches = scanForSecrets(content);
    expect(matches.some((m) => m.pattern === "private_key_header")).toBe(true);
  });
});

describe("scanForSecrets — false positive resistance", () => {
  it("does not match AKIAEXAMPLE (too short)", () => {
    expect(scanForSecrets("AKIAEXAMPLE")).toEqual([]);
  });

  it("does not match AKIA with lowercase chars in the tail", () => {
    expect(scanForSecrets("AKIAabcdefghijklmnop")).toEqual([]);
  });

  it("does not match 'sk-short'", () => {
    expect(scanForSecrets("sk-short")).toEqual([]);
  });

  it("does not match '-----BEGIN CERTIFICATE-----'", () => {
    expect(scanForSecrets("-----BEGIN CERTIFICATE-----\n")).toEqual([]);
  });

  it("does not match the literal word 'github_token'", () => {
    expect(scanForSecrets("The variable github_token holds our PAT.")).toEqual([]);
  });

  it("does not match a short github-style prefix (ghp_ plus 10 chars)", () => {
    expect(scanForSecrets("ghp_" + "x".repeat(10))).toEqual([]);
  });
});

describe("scanForSecrets — multiple matches", () => {
  it("returns every match with correct index and length", () => {
    const aws = "AKIAIOSFODNN7EXAMPLE";
    const gh = "ghp_" + "Z".repeat(40);
    const content = `header\n${aws}\nmiddle\n${gh}\ntrailer`;
    const matches = scanForSecrets(content);

    const patterns = matches.map((m) => m.pattern).sort();
    expect(patterns).toEqual(["aws_access_key_id", "github_token"]);

    const awsMatch = matches.find((m) => m.pattern === "aws_access_key_id");
    expect(awsMatch).toBeDefined();
    if (awsMatch) {
      expect(content.slice(awsMatch.index, awsMatch.index + awsMatch.length)).toBe(aws);
    }

    const ghMatch = matches.find((m) => m.pattern === "github_token");
    expect(ghMatch).toBeDefined();
    if (ghMatch) {
      expect(content.slice(ghMatch.index, ghMatch.index + ghMatch.length)).toBe(gh);
    }
  });

  it("returns empty array for empty content", () => {
    expect(scanForSecrets("")).toEqual([]);
  });

  it("preserves call independence (second call returns same matches)", () => {
    const content = "AKIAIOSFODNN7EXAMPLE";
    const first = scanForSecrets(content);
    const second = scanForSecrets(content);
    expect(first).toEqual(second);
    expect(first.length).toBe(1);
  });
});
