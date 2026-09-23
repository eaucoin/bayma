// Freesound's API, authorized by auth.ts. Downloads are one sound at a time,
// each credited in CREDITS.md beside it: Freesound's terms allow copies only
// as needed, and its licenses ask for attribution.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { authorizationNeeded, freesoundToken } from "./auth.ts";

const API = "https://freesound.org/apiv2";

/** What search and sound return unless asked for other fields. */
export const FIELDS =
  "id,name,username,license,duration,type,samplerate,channels,tags,previews,url";

/** GET from the API, as JSON. */
export async function api<T = Record<string, unknown>>(
  path: string,
  query: Record<string, string | number> = {},
): Promise<T> {
  const url = new URL(`${API}${path}`);
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, String(value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${await freesoundToken()}` },
  });
  if (response.status === 401)
    throw authorizationNeeded("Freesound rejected the authorization");
  if (!response.ok)
    throw new Error(
      `Freesound answered HTTP ${response.status} for ${path}: ${await response.text()}`,
    );
  return (await response.json()) as T;
}

export interface Sound {
  id: number;
  name: string;
  username: string;
  license: string;
  duration: number;
  type: string;
  url: string;
  [field: string]: unknown;
}

/** Sounds matching query; filter uses Freesound's syntax, such as `license:"Creative Commons 0"`. */
export async function search(
  query: string,
  options: {
    filter?: string;
    sort?: string;
    fields?: string;
    pageSize?: number;
  } = {},
): Promise<Sound[]> {
  const answer = await api<{ results: Sound[] }>("/search/", {
    query,
    fields: options.fields ?? FIELDS,
    page_size: options.pageSize ?? 15,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.sort ? { sort: options.sort } : {}),
  });
  return answer.results;
}

export function sound(id: number): Promise<Sound> {
  return api<Sound>(`/sounds/${id}/`, { fields: FIELDS });
}

/** Downloads one sound's original file into directory, credited in its CREDITS.md. */
export async function download(id: number, directory: string): Promise<string> {
  const info = await sound(id);
  mkdirSync(directory, { recursive: true });
  const slug = info.name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
  const path = join(directory, `${id}-${slug}.${info.type}`);
  const response = await fetch(`${API}/sounds/${id}/download/`, {
    headers: { Authorization: `Bearer ${await freesoundToken()}` },
  });
  if (response.status === 401)
    throw authorizationNeeded("Freesound rejected the authorization");
  if (!response.ok)
    throw new Error(
      `Freesound answered HTTP ${response.status} downloading sound ${id}`,
    );
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  const credits = join(directory, "CREDITS.md");
  if (!existsSync(credits))
    writeFileSync(credits, "# Sounds from Freesound\n\n");
  appendFileSync(
    credits,
    `- "${info.name}" by ${info.username}, ${info.license}, ${info.url}\n`,
  );
  return path;
}
