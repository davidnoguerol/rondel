import { createInterface } from "node:readline";

/**
 * Minimal interactive prompt helpers using Node's readline.
 * No external dependencies. Designed so non-interactive flags
 * can be layered on top later without restructuring.
 */

/** Ask a question and return the trimmed answer. Returns defaultValue if empty. */
export async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

/** Ask a yes/no question. Returns true for yes, false for no. */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${hint}`);

  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

/** Print a styled header. */
export function header(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m\n`);
}

/** Print a success message. */
export function success(text: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${text}`);
}

/** Print a warning message. */
export function warn(text: string): void {
  console.log(`\x1b[33m!\x1b[0m ${text}`);
}

/** Print an error message. */
export function error(text: string): void {
  console.log(`\x1b[31m✗\x1b[0m ${text}`);
}

/** Print an info message. */
export function info(text: string): void {
  console.log(`  ${text}`);
}
