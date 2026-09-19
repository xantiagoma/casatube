/**
 * Print a Telegram session string. That is the whole job.
 *
 * 🔴 **It stores nothing.** Storing belongs to Settings → Credentials, which
 * already does it properly: a `custom` credential, scope `t.me`, sealed with
 * `CREDENTIALS_KEY`, with the field names kept as readable metadata. This script
 * exists only because of the one value that form cannot produce.
 *
 * Telegram's login needs a code sent to the phone *and submitted inside the same
 * MTProto connection* — the `phoneCodeHash` belongs to that connection and
 * expires with it. So a code cannot be a form field that a server uses later,
 * and this is the dialogue that gets past it. Everything it produces is one
 * line, which a form takes without complaint.
 *
 * ```
 * CASATUBE_TG_API_ID=… CASATUBE_TG_API_HASH=… bun scripts/telegram-session.ts
 * ```
 *
 * Then paste the three values into Settings → Credentials:
 *
 * | field | value |
 * |---|---|
 * | `apiId` | the api_id |
 * | `apiHash` | the api_hash |
 * | `session` | what this prints |
 *
 * 📌 The RSA public key `my.telegram.org` shows is **not** an input: `teleproto`
 * carries Telegram's own server keys (`crypto/RSA.js`), which is what the
 * handshake uses.
 *
 * ⚠️ A session string is **the account**, not a per-channel token. Telegram lists
 * it as an active session and it can be revoked from any client under
 * Settings → Devices.
 */
import { createInterface } from "node:readline/promises";

const ETX = "";
const DEL = "";
const BACKSPACE = "\b";

/**
 * Read one line without echoing it.
 *
 * Ctrl-C is handled explicitly: raw mode swallows the default handler, and a
 * hidden prompt you cannot escape from is a trap.
 */
async function secret(question: string): Promise<string> {
  process.stdout.write(question);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  let value = "";
  for await (const chunk of process.stdin) {
    for (const character of chunk.toString("utf8")) {
      if (character === "\r" || character === "\n") {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return value;
      }
      if (character === ETX) {
        process.stdin.setRawMode?.(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (character === DEL || character === BACKSPACE) value = value.slice(0, -1);
      else value += character;
    }
  }
  process.stdin.setRawMode?.(false);
  return value;
}

/** The first line, trimmed. A paste with more in it loses the rest here, not later. */
function oneLine(value: string): string {
  return (value.split("\n")[0] ?? "").trim();
}

/**
 * What arrived, said without repeating it.
 *
 * ⚠️ Never echoes the value: this reports on an api_hash, and a message that
 * helpfully prints the secret back is one that puts it in a scrollback.
 */
function describe(value: string): string {
  const notes = [`${value.length} character${value.length === 1 ? "" : "s"}`];
  if (/\s/.test(value)) notes.push("with whitespace in it");
  if (value.includes("\n")) notes.push("spanning several lines");
  return notes.join(", ");
}

async function main(): Promise<void> {
  /**
   * 🔴 The two copied values come from the **environment** first.
   *
   * They are copied off a web page that shows them inside a block containing a
   * multi-line RSA key, so pasting into a prompt is the one input that cannot be
   * trusted: a newline ends the prompt early and the remainder is read by
   * whatever asks next — which looks like this script malfunctioning rather than
   * like a paste going wrong.
   */
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const fromEnvId = process.env.CASATUBE_TG_API_ID?.trim();
  const fromEnvHash = process.env.CASATUBE_TG_API_HASH?.trim();

  if (fromEnvId === undefined || fromEnvHash === undefined) {
    console.log("From https://my.telegram.org → API development tools.");
    console.log("⚠️  Only these two. Never the RSA public key — it is not an input.\n");
    console.log("   Easier: pass them as environment variables and skip the pasting —");
    console.log("   CASATUBE_TG_API_ID=… CASATUBE_TG_API_HASH=… bun scripts/telegram-session.ts\n");
  }

  const apiId = fromEnvId ?? oneLine(await rl.question("api_id   (digits):       "));
  const apiHash = fromEnvHash ?? oneLine(await secret("api_hash (32 hex chars): "));

  if (!/^\d+$/.test(apiId)) {
    console.error(`\nThat is not an api_id — it is a number, usually six or seven digits. Got ${describe(apiId)}.`);
    process.exit(1);
  }
  if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
    // ⚠️ Checked for its real shape, not a length floor: a pasted RSA key clears
    // "long enough" and then fails inside the handshake, where the error says
    // nothing about what went in.
    console.error(`\nThat is not an api_hash — it is exactly 32 hex characters. Got ${describe(apiHash)}.`);
    if (apiHash.includes("BEGIN")) {
      console.error("That looks like the RSA public key. Skip it entirely; it is never needed.");
    }
    process.exit(1);
  }

  const { TelegramClient, sessions } = await import("teleproto");
  const client = new TelegramClient(new sessions.StringSession(""), Number(apiId), apiHash, {
    connectionRetries: 3,
  });

  console.log("\nTelegram will send a code to the account you sign in with.");
  await client.start({
    phoneNumber: async () => oneLine(await rl.question("phone (+57…): ")),
    phoneCode: async () => oneLine(await rl.question("code: ")),
    password: async () => {
      // readline holds stdin; it has to let go before raw mode can read.
      rl.pause();
      const value = await secret("two-step password: ");
      rl.resume();
      return value;
    },
    onError: (error: unknown) => {
      console.error(`\nTelegram refused: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const me = (await client.getMe()) as { username?: string; phone?: string; firstName?: string };
  const session = String(client.session.save());
  await client.disconnect();
  rl.close();

  console.log(`\nSigned in as ${me.username ? `@${me.username}` : (me.firstName ?? me.phone ?? "account")}.`);
  console.log("\nPut these three into Settings → Credentials → custom, scope t.me:\n");
  console.log(`  apiId    ${apiId}`);
  console.log(`  apiHash  ${apiHash}`);
  console.log(`  session  ${session}`);
  console.log("\n⚠️  That session is an active Telegram login. Revoke it from any client");
  console.log("    under Settings → Devices if you ever want it gone.");
}

await main();
