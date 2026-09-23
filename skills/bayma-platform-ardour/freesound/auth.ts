// Freesound authorization for this folder, kept in .auth/freesound.json,
// readable only by you: your Freesound API credential and the OAuth tokens it
// was granted. Freesound gives every user their own credential, at
// https://freesound.org/apiv2/apply, with Freesound as its redirect.
//
//   bun auth.ts          asks for the credential if none is saved, prints the
//                        link to approve, and takes the code Freesound shows
//   bun auth.ts <code>   takes the code, for the saved credential

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

interface Saved {
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken?: string;
  /** When the access token expires, in milliseconds since the epoch. */
  expiresAt?: number;
}

const SAVED = join(import.meta.dir, ".auth", "freesound.json");
const OAUTH = "https://freesound.org/apiv2/oauth2";

/** An error that ends with the command that fixes it. */
export function authorizationNeeded(reason: string): Error {
  return new Error(
    `${reason}. Authorize Freesound: ${process.execPath} ${join(import.meta.dir, "auth.ts")}`,
  );
}

function readSaved(): Saved | undefined {
  return existsSync(SAVED)
    ? (JSON.parse(readFileSync(SAVED, "utf8")) as Saved)
    : undefined;
}

function save(saved: Saved): void {
  mkdirSync(dirname(SAVED), { recursive: true, mode: 0o700 });
  writeFileSync(SAVED, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
  chmodSync(SAVED, 0o600);
}

/** Exchanges a code or refresh token for new tokens, and saves them. */
async function grant(
  saved: Saved,
  fields: Record<string, string>,
): Promise<Saved> {
  const response = await fetch(`${OAUTH}/access_token/`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: saved.clientId,
      client_secret: saved.clientSecret,
      ...fields,
    }),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof answer.access_token !== "string")
    throw new Error(
      `Freesound would not authorize: ${answer.error_description ?? answer.error ?? answer.detail ?? `HTTP ${response.status}`}`,
    );
  const granted: Saved = {
    ...saved,
    accessToken: answer.access_token,
    refreshToken: String(answer.refresh_token),
    expiresAt: Date.now() + Number(answer.expires_in) * 1000,
  };
  save(granted);
  return granted;
}

/** An access token for Freesound's API, renewed when it has expired. */
export async function freesoundToken(): Promise<string> {
  const saved = readSaved();
  if (!saved?.refreshToken)
    throw authorizationNeeded("Freesound is not authorized");
  if (saved.accessToken && Date.now() < (saved.expiresAt ?? 0) - 60_000)
    return saved.accessToken;
  try {
    const renewed = await grant(saved, {
      grant_type: "refresh_token",
      refresh_token: saved.refreshToken,
    });
    return renewed.accessToken!;
  } catch (error) {
    throw authorizationNeeded(
      `Freesound would not renew the authorization (${(error as Error).message})`,
    );
  }
}

/** Reads a line from the terminal; hidden, the typing is not echoed. A
 * listener rather than a for-await loop, which would end stdin with it. */
function ask(question: string, hidden = false): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  if (hidden && stdin.isTTY) stdin.setRawMode(true);
  return new Promise((resolve) => {
    let line = "";
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003") process.exit(130);
        if (character === "\r" || character === "\n") {
          stdin.off("data", onData);
          stdin.pause();
          if (hidden && stdin.isTTY) stdin.setRawMode(false);
          if (hidden) process.stdout.write("\n");
          resolve(line.trim());
          return;
        }
        if (character === "\u007f") line = line.slice(0, -1);
        else line += character;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function authorize(code?: string): Promise<void> {
  let saved = readSaved();
  if (!saved) {
    if (!process.stdin.isTTY)
      throw new Error(
        `No Freesound credential is saved; run ${process.execPath} ${join(import.meta.dir, "auth.ts")} in a terminal to enter it.`,
      );
    console.log(
      "Your Freesound API credential, from https://freesound.org/apiv2/apply",
    );
    saved = {
      clientId: await ask("Client ID: "),
      clientSecret: await ask("Client secret (hidden): ", true),
    };
    save(saved);
  }
  if (!code) {
    console.log(
      `Approve at ${OAUTH}/authorize/?client_id=${encodeURIComponent(saved.clientId)}&response_type=code`,
    );
    if (!process.stdin.isTTY) {
      console.log(
        `Then: ${process.execPath} ${join(import.meta.dir, "auth.ts")} <the code Freesound shows>`,
      );
      return;
    }
    code = await ask("The code Freesound shows: ");
  }
  try {
    await grant(saved, { grant_type: "authorization_code", code });
  } catch (error) {
    // A credential Freesound does not know is forgotten, to be entered again.
    if ((error as Error).message.includes("invalid_client")) {
      rmSync(SAVED);
      throw new Error(
        `Freesound does not know that client ID and secret; run ${process.execPath} ${join(import.meta.dir, "auth.ts")} again to enter them.`,
      );
    }
    throw error;
  }
  console.log("Freesound is authorized.");
}

if (import.meta.main) {
  try {
    await authorize(process.argv[2]);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
