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
 * expires with it. So a code cannot be a form field a server uses later, and
 * this is the dialogue that gets past it. Everything it prints is one line,
 * which a form takes without complaint.
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
 * ## ⚠️ Everything you type here is visible, deliberately
 *
 * An earlier version hid the api_hash and the two-step password. It **hung**: a
 * hidden prompt needs raw mode, raw mode needs its own reader, and `readline`
 * already holds stdin — so the bytes went to readline and the Enter key did
 * nothing. Two attempts at fixing that produced one prompt that hung and one
 * that swallowed two answers at once.
 *
 * So there is one reader and nothing is hidden. A prompt that works beats a
 * prompt that hides, and this runs on the server's own terminal for a few
 * seconds. If the scrollback matters where you are, pass the two copied values
 * as environment variables — then only the phone, the code and the two-step
 * password are typed, and none of those is worth anything after this exits.
 *
 * 📌 The RSA public key `my.telegram.org` shows is **not** an input: `teleproto`
 * carries Telegram's own server keys (`crypto/RSA.js`, two of them), which is
 * what the handshake uses. It is also public and identical for every account.
 *
 * ⚠️ A session string is **the account**, not a per-channel token. Telegram lists
 * it as an active session; revoke it from any client under Settings → Devices.
 */
import { createInterface } from "node:readline/promises";

/** The first line, trimmed. A paste with more in it loses the rest here, not later. */
function oneLine(value: string): string {
  return (value.split("\n")[0] ?? "").trim();
}

/**
 * What arrived, said without repeating it.
 *
 * ⚠️ Never echoes the value. A "that is wrong" message that helpfully prints the
 * secret back is one that puts it somewhere it was not going to be otherwise —
 * and unlike the prompt above, an error line is what gets pasted into a chat.
 */
function describe(value: string): string {
  const notes = [`${value.length} character${value.length === 1 ? "" : "s"}`];
  if (/\s/.test(value)) notes.push("with whitespace in it");
  if (value.includes("\n")) notes.push("spanning several lines");
  return notes.join(", ");
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  /**
   * 🔴 The two copied values come from the **environment** first.
   *
   * They are copied off a page that shows them beside a multi-line RSA key, and
   * pasting that into a prompt is the one input nothing can save: a newline ends
   * the prompt early and the remainder is read as the *next* answer, so the
   * phone number arrives pre-filled with a fragment of a key and the script
   * looks broken rather than mis-fed.
   */
  const fromEnvId = process.env.CASATUBE_TG_API_ID?.trim();
  const fromEnvHash = process.env.CASATUBE_TG_API_HASH?.trim();

  if (fromEnvId === undefined || fromEnvHash === undefined) {
    console.log("From https://my.telegram.org → API development tools.");
    console.log("⚠️  Only the api_id and the api_hash. Never the RSA public key — not an input.\n");
    console.log("   Less typing, and no paste to go wrong:");
    console.log("   CASATUBE_TG_API_ID=… CASATUBE_TG_API_HASH=… bun scripts/telegram-session.ts\n");
  }

  const apiId = fromEnvId ?? oneLine(await rl.question("api_id   (digits):       "));
  const apiHash = fromEnvHash ?? oneLine(await rl.question("api_hash (32 hex chars): "));

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
  console.log("(What you type is visible — see the note at the top of this file.)");
  await client.start({
    phoneNumber: async () => oneLine(await rl.question("phone (+57…):      ")),
    phoneCode: async () => oneLine(await rl.question("code:              ")),
    password: async () => oneLine(await rl.question("two-step password: ")),
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
