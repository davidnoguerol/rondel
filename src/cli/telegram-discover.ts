import { randomInt } from "node:crypto";
import { info, warn, success } from "./prompt.js";

/**
 * Validate a bot token by calling Telegram's getMe API.
 * Returns the bot info on success, or undefined on failure.
 */
export async function validateBotToken(token: string): Promise<{ username: string; firstName: string } | undefined> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { ok: boolean; result: { username: string; first_name: string } };
    if (!data.ok) return undefined;
    return { username: data.result.username, firstName: data.result.first_name };
  } catch {
    return undefined;
  }
}

/**
 * Discover the user's Telegram ID via a verification code.
 *
 * 1. Generate a random 5-digit code
 * 2. Show it in the CLI
 * 3. Ask the user to send the code to the bot
 * 4. Poll getUpdates until a message with that exact code arrives
 * 5. Return the sender's user ID
 *
 * Times out after the given duration.
 */
export async function discoverUserViaTelegram(
  botToken: string,
  botUsername: string,
  timeoutMs = 60_000,
): Promise<string | undefined> {
  const code = String(randomInt(10_000, 99_999));

  console.log("");
  info(`Send this code to @${botUsername} on Telegram:\n`);
  console.log(`    \x1b[1;36m${code}\x1b[0m\n`);
  info("Waiting for verification...");

  let offset = 0;
  const deadline = Date.now() + timeoutMs;

  // Flush any old updates so we only see new messages
  try {
    const flush = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=-1&timeout=0`, {
      signal: AbortSignal.timeout(5_000),
    });
    const flushData = await flush.json() as { result: Array<{ update_id: number }> };
    if (flushData.result?.length > 0) {
      offset = flushData.result[flushData.result.length - 1].update_id + 1;
    }
  } catch {
    // Ignore flush errors
  }

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const pollTimeout = Math.min(Math.floor(remainingMs / 1000), 10);

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=${pollTimeout}`,
        { signal: AbortSignal.timeout(remainingMs + 5_000) },
      );

      if (!res.ok) continue;

      const data = await res.json() as {
        result: Array<{
          update_id: number;
          message?: {
            text?: string;
            from: { id: number; first_name: string; last_name?: string; username?: string };
          };
        }>;
      };

      for (const update of data.result) {
        offset = update.update_id + 1;

        const text = update.message?.text?.trim();
        if (text === code && update.message?.from) {
          const from = update.message.from;
          let label = from.first_name;
          if (from.last_name) label += ` ${from.last_name}`;
          if (from.username) label += ` (@${from.username})`;

          // Send confirmation message to the user in Telegram
          await sendTelegramMessage(
            botToken,
            from.id,
            `Connected! You're now linked to Rondel. Head back to the terminal to finish setup.`,
          );

          // Wait briefly then drain any messages that arrived in the gap
          // (e.g., Telegram's auto-sent /start when user first opens a bot).
          // This ensures the agent process starts with a clean update queue.
          await drainPendingUpdates(botToken, offset);

          console.log("");
          success(`Verified! Hello ${label} (ID: ${from.id})`);
          return String(from.id);
        }
      }
    } catch {
      // Timeout or network error — continue polling
    }
  }

  console.log("");
  warn("Timed out waiting for the verification code.");
  return undefined;
}

/**
 * Wait briefly, then consume any updates that arrived after our last offset.
 * Repeats a few times to catch messages that trickle in (like Telegram's
 * auto-sent /start when a user first opens a bot chat).
 */
async function drainPendingUpdates(botToken: string, offset: number): Promise<void> {
  // Short pauses to let any trailing messages arrive
  for (let i = 0; i < 3; i++) {
    await sleep(500);
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=0`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (!res.ok) continue;
      const data = await res.json() as { result: Array<{ update_id: number }> };
      if (data.result?.length > 0) {
        offset = data.result[data.result.length - 1].update_id + 1;
      } else {
        break; // No more pending updates
      }
    } catch {
      break;
    }
  }
  // Final confirm so Telegram considers everything up to offset consumed
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=0`, {
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // Best-effort
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(5_000),
  });
}
