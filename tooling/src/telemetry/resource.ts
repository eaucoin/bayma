import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ATTR } from "./attributes.ts";

// What every signal a development run exports says about where it came from:
// the run itself, the checkout, and the CI run when there is one.
// OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES override any of it.

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
export const DEFAULT_SERVICE_NAME = "bayma-development";

type Attributes = Record<string, string>;

function git(args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  const output = result.status === 0 ? result.stdout.trim() : "";
  return output === "" ? undefined : output;
}

/** A remote's URL without any credentials in it. */
function withoutCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // scp-like `git@host:owner/repo` has no URL form and no secret.
    return url;
  }
}

function checkout(): Attributes {
  const attributes: Attributes = {};
  const revision = git(["rev-parse", "HEAD"]);
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remote = git(["remote", "get-url", "origin"]);
  if (revision) attributes[ATTR.vcsRefHeadRevision] = revision;
  if (branch) attributes[ATTR.vcsRefHeadName] = branch;
  if (remote)
    attributes[ATTR.vcsRepositoryUrlFull] = withoutCredentials(remote);
  return attributes;
}

/** GitHub Actions' description of the run, from its default variables. */
function githubActions(env: Record<string, string | undefined>): Attributes {
  if (env.GITHUB_ACTIONS !== "true") return {};
  const attributes: Attributes = {};
  const set = (name: string, value: string | undefined) => {
    if (value) attributes[name] = value;
  };
  set(ATTR.cicdPipelineName, env.GITHUB_WORKFLOW);
  set(ATTR.cicdPipelineRunId, env.GITHUB_RUN_ID);
  set(ATTR.cicdPipelineTaskName, env.GITHUB_JOB);
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID)
    set(
      ATTR.cicdPipelineRunUrlFull,
      `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` +
        (env.GITHUB_RUN_ATTEMPT ? `/attempts/${env.GITHUB_RUN_ATTEMPT}` : ""),
    );
  // A pull request's checkout is a merge commit; the branch is the head's.
  set(ATTR.vcsRefHeadName, env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME);
  return attributes;
}

/** The resource attributes of a development run. */
export function developmentResource(
  env: Record<string, string | undefined>,
): Attributes {
  const { version } = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "server", "package.json"), "utf8"),
  ) as { version: string };
  return {
    [ATTR.serviceName]: DEFAULT_SERVICE_NAME,
    [ATTR.serviceVersion]: version,
    // Each process is an instance of its own: its counters start from zero,
    // so runs that shared one would read as a single series that resets.
    [ATTR.serviceInstanceId]: randomUUID(),
    ...checkout(),
    ...githubActions(env),
  };
}
