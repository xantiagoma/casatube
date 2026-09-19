/**
 * The one interactive step Telegram cannot avoid: signing in.
 *
 * 🔴 **Run by a person, once.** MTProto has no way to authenticate a user
 * without a code sent to their phone at that moment, so there is no version of
 * this a server can do on its own — and no point pretending otherwise with a
 * screen that would sit there waiting for an SMS. What it produces is a *session
 * string*, and from then on the provider needs nothing interactive.
 *
 * The session goes straight into CasaTube's credential store, sealed with
 * `CREDENTIALS_KEY`, as a `custom` credential scoped to `t.me`. It never touches
 * a file, an argument, or this script's output.
 *
 * ```
 * bun scripts/telegram-login.ts
 * ```
 *
 * 📌 The RSA public key that `my.telegram.org` shows next to the api_id is **not
 * needed**: `teleproto` ships Telegram's server keys itself (`crypto/RSA.js`),
 * which is what the handshake uses. Only `api_id` and `api_hash` are asked for.
 *
 * ⚠️ The session string is **the account**, not a per-channel token: whatever
 * holds it can do what the account can do. Telegram lists it as an active
 * session and it can be revoked from any client under Settings → Devices. That
 * is the trade this feature is, and it is why nothing here is stored in plain
 * text.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { CredentialStore } from "../src/core/credentials";
import { appDbPath, closeDb, openDb } from "../src/core/db";

/** Where the deployment keeps its database and its key, when nothing says otherwise. */
const DEPLOYED_DATA_DIR = "/DATA/AppData/casatube/data";
const DEPLOYED_ENV_FILE = "/DATA/AppData/casatube/casatube.env";

const TELEGRAM_SCOPE = "t.me";

const ETX = "";
const DEL = "";
const BACKSPACE = "\b";

/**
 * Read one line without echoing it.
 *
 * ⚠️ `prompt()` and a plain readline both echo, and this asks for an API hash
 * and possibly a two-step password. A terminal is not a threat model by itself;
 * a scrollback in a screen share is. Muting costs a dozen lines.
 *
 * Ctrl-C is handled explicitly — a hidden prompt you cannot escape from is a
 * trap, and raw mode swallows the default handler.
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

/**
 * `CREDENTIALS_KEY`, from the environment or from the deployment's env file.
 *
 * 🔴 It has to be the **same** key the server runs with. A credential sealed
 * with another one is a credential the server cannot open, and the failure would
 * arrive much later as a download that cannot authenticate — so the source is
 * resolved here and printed, rather than left to whatever the shell exported.
 */
async function resolveKey(): Promise<{ key: string | null; from: string }> {
  const fromEnv = process.env.CREDENTIALS_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return { key: fromEnv, from: "the environment" };

  if (existsSync(DEPLOYED_ENV_FILE)) {
    for (const line of (await Bun.file(DEPLOYED_ENV_FILE).text()).split("\n")) {
      const match = /^\s*(?:export\s+)?CREDENTIALS_KEY\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value !== "") return { key: value, from: DEPLOYED_ENV_FILE };
    }
  }
  return { key: null, from: "nowhere" };
}

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR ?? (existsSync(DEPLOYED_DATA_DIR) ? DEPLOYED_DATA_DIR : "./data");
  const dbPath = appDbPath(dataDir);
  const { key, from } = await resolveKey();

  console.log(`database:        ${dbPath}`);
  console.log(
    `CREDENTIALS_KEY: ${key === null ? "NOT SET" : `from ${from}`}`,
  );

  if (!existsSync(dbPath)) {
    console.error(`\nThere is no database at ${dbPath}. Point DATA_DIR at the one the server uses.`);
    process.exit(1);
  }
  if (key === null) {
    /**
     * 🔴 Refused rather than warned, and this is the one place in CasaTube that
     * refuses.
     *
     * Everywhere else encryption is optional and merely says so loudly (Santi's
     * decision, and the right one for a self-hosted tool) — but everywhere else
     * the secret is one site's cookies. This one is a whole Telegram account,
     * and writing that in plain text because nobody objected is not a trade to
     * make on someone's behalf.
     */
    console.error("\nRefusing to write a Telegram session in plain text — it is the whole account.");
    console.error("Set CREDENTIALS_KEY (the same one the server runs with) and try again.");
    process.exit(1);
  }

  const db = openDb({ path: dbPath });
  const store = new CredentialStore({ db, key, tempDir: dataDir });

  const existing = await store.resolve(`https://${TELEGRAM_SCOPE}/x/1`, ["custom"]);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  if (existing !== null) {
    console.log(`\nThere is already a Telegram credential (${existing.id}, scope ${existing.scope}).`);
    const answer = (await rl.question("Replace it? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Left alone.");
      rl.close();
      closeDb(db);
      return;
    }
  }

  console.log("\nFrom https://my.telegram.org → API development tools:");
  const apiId = (await rl.question("api_id:   ")).trim();
  rl.close();
  const apiHash = await secret("api_hash: ");

  if (!/^\d+$/.test(apiId) || apiHash.length < 16) {
    console.error("\nThat api_id is not a number, or that api_hash is too short to be one.");
    closeDb(db);
    process.exit(1);
  }

  // Imported here rather than at the top: every check above exists to fail
  // before anything touches the network.
  const { TelegramClient, sessions } = await import("teleproto");
  const client = new TelegramClient(new sessions.StringSession(""), Number(apiId), apiHash, {
    connectionRetries: 3,
  });

  console.log("\nTelegram will send a code to the account you sign in with.");
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  await client.start({
    phoneNumber: async () => (await lines.question("phone (+57…): ")).trim(),
    phoneCode: async () => (await lines.question("code: ")).trim(),
    password: async () => {
      // ⚠️ readline holds stdin; it has to let go before raw mode can read.
      lines.pause();
      const value = await secret("two-step password: ");
      lines.resume();
      return value;
    },
    onError: (error: unknown) => {
      console.error(`\nTelegram refused: ${error instanceof Error ? error.message : String(error)}`);
    },
  });
  lines.close();

  const me = (await client.getMe()) as { username?: string; phone?: string; firstName?: string };
  const saved = String(client.session.save());
  await client.disconnect();

  const who = me.username ? `@${me.username}` : (me.firstName ?? me.phone ?? "account");
  const created = await store.create({
    scope: TELEGRAM_SCOPE,
    label: `Telegram — ${who}`,
    secret: { type: "custom", data: { apiId, apiHash, session: saved } },
  });

  closeDb(db);

  if (created.status !== "ok") {
    console.error(`\nCould not store it: ${JSON.stringify(created.error)}`);
    process.exit(1);
  }

  console.log(`\nSigned in as ${who}.`);
  console.log(`Stored, sealed, as credential ${created.value.id} (scope ${TELEGRAM_SCOPE}).`);
  console.log("\n⚠️  This is an active Telegram session. Revoke it from any client under");
  console.log("    Settings → Devices if you ever want it gone.");
  console.log("Restart CasaTube and t.me links resolve through it.");
}

await main();
