// GitHub authorization for this skill, kept in this skill's folder. auth.json
// names the OAuth App to authorize and the scopes to request; the token
// GitHub grants is saved in .auth/github.json, readable only by you.
//
//   bun auth.ts    authorize in the browser, with GitHub's device flow
//
// The OAuth App is the GitHub CLI's, whose client ID is public: GitHub hands
// the token only to this script, and the browser shows an app people know.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

interface AuthConfig {
  clientId: string;
  scopes: string[];
}

interface SavedToken {
  token: string;
  /**
   * The scopes the token was requested with. The device flow grants exactly
   * those, but GitHub names only the broadest of each family it grants, so
   * the request is what auth.json is compared against.
   */
  requestedScopes: string[];
}

const CONFIG = join(import.meta.dir, "auth.json");
const SAVED = join(import.meta.dir, ".auth", "github.json");

function readConfig(): AuthConfig {
  return JSON.parse(readFileSync(CONFIG, "utf8")) as AuthConfig;
}

/** An error that ends with the one command that fixes it. */
export function authorizationNeeded(reason: string): Error {
  return new Error(
    `${reason}. Authorize this skill with GitHub: ${process.execPath} ${join(import.meta.dir, "auth.ts")}`,
  );
}

/** The saved token, provided it was requested with every scope auth.json asks for. */
export function readGitHubToken(): string {
  if (!existsSync(SAVED))
    throw authorizationNeeded("This skill has no GitHub authorization");
  const saved = JSON.parse(readFileSync(SAVED, "utf8")) as SavedToken;
  const missing = readConfig().scopes.filter(
    (scope) => !saved.requestedScopes.includes(scope),
  );
  if (missing.length > 0)
    throw authorizationNeeded(
      `auth.json asks for scopes this skill was not authorized for (${missing.join(", ")})`,
    );
  return saved.token;
}

/** GitHub's answer to a client ID it has no OAuth App for. */
class NotFound extends Error {}

async function post(
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: new URLSearchParams(body),
  });
  if (response.status === 404) throw new NotFound(`${url} answered HTTP 404`);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

/** Authorizes this skill with GitHub's device flow and saves the token. */
export async function authorize(): Promise<void> {
  const { clientId, scopes } = readConfig();
  const device = await post("https://github.com/login/device/code", {
    client_id: clientId,
    scope: scopes.join(" "),
  }).catch((error: unknown) => {
    throw error instanceof NotFound
      ? new Error(
          `GitHub has no OAuth App with the client ID ${clientId} (clientId in ${CONFIG})`,
        )
      : error;
  });
  if (typeof device.device_code !== "string")
    throw new Error(
      `GitHub would not start authorization: ${device.error_description ?? device.error}`,
    );
  console.log(
    `Open ${device.verification_uri} and enter ${device.user_code} (requesting ${scopes.join(", ")})`,
  );

  let intervalSeconds = Number(device.interval);
  const deadline = Date.now() + Number(device.expires_in) * 1000;
  while (Date.now() < deadline) {
    await Bun.sleep(intervalSeconds * 1000);
    const grant = await post("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (typeof grant.access_token === "string") {
      const saved: SavedToken = {
        token: grant.access_token,
        requestedScopes: scopes,
      };
      mkdirSync(dirname(SAVED), { recursive: true, mode: 0o700 });
      writeFileSync(SAVED, JSON.stringify(saved, null, 2) + "\n", {
        mode: 0o600,
      });
      chmodSync(SAVED, 0o600);
      console.log(`Authorized for ${scopes.join(", ")}`);
      return;
    }
    if (grant.error === "slow_down") {
      intervalSeconds = Number(grant.interval) || intervalSeconds + 5;
    } else if (grant.error !== "authorization_pending") {
      throw new Error(
        `GitHub did not authorize this skill: ${grant.error_description ?? grant.error}`,
      );
    }
  }
  throw new Error("The code expired before it was entered; run this again.");
}

if (import.meta.main) await authorize();
