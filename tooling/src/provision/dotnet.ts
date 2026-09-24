import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersionPrecedence,
  isValidVersion,
  resolveDotnetScriptLibraryDirFromToolsRoot,
} from "@bayma/runtime-dotnet-script";
import { DOTNET } from "../platforms.ts";
import { fetchPinned } from "../shared/download.ts";
import { ensureDir } from "../shared/files.ts";
import { runOrThrow } from "../shared/process.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
} from "./payload.ts";

// A pinned .NET SDK plus the dotnet-script global tool installed into it. The
// payload is the subset of the SDK that dotnet-script needs at runtime: the
// host, the shared framework, the SDK and reference packs for the tool's own
// target framework, and the tool itself.

const IDENTITY = `${DOTNET.sha256}:dotnet-script@${DOTNET.scriptVersion}`;

function highestMatchingVersion(root: string, prefix: string): string | null {
  if (!existsSync(root)) return null;
  const matches = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        isValidVersion(entry.name) &&
        (prefix === "" ||
          entry.name === prefix ||
          entry.name.startsWith(`${prefix}.`)),
    )
    .map((entry) => entry.name)
    .sort(compareVersionPrecedence);
  return matches.at(-1) ?? null;
}

function frameworkPrefix(libraryDir: string): string {
  const config = JSON.parse(
    readFileSync(join(libraryDir, "dotnet-script.runtimeconfig.json"), "utf8"),
  ) as { runtimeOptions?: { framework?: { version?: string } } };
  const version = config.runtimeOptions?.framework?.version;
  if (!version)
    throw new Error("dotnet-script runtimeconfig declares no framework");
  const [major, minor] = version.split(".");
  return `${major}.${minor}`;
}

/** The SDK entries dotnet-script needs, relative to the SDK root. */
export function selectSdkEntries(
  sdkRoot: string,
  libraryDir: string,
): string[] {
  const prefix = frameworkPrefix(libraryDir);
  const entries = ["dotnet", "host", "sdk-manifests"];
  const versioned: Array<[string, string]> = [
    ["sdk", prefix],
    ["shared/Microsoft.NETCore.App", prefix],
    ["shared/Microsoft.AspNetCore.App", prefix],
    ["packs/Microsoft.NETCore.App.Host.linux-x64", prefix],
    ["packs/Microsoft.NETCore.App.Ref", prefix],
    ["packs/Microsoft.AspNetCore.App.Ref", prefix],
    ["packs/NETStandard.Library.Ref", ""],
  ];
  for (const [directory, versionPrefix] of versioned) {
    const version = highestMatchingVersion(
      join(sdkRoot, directory),
      versionPrefix,
    );
    if (version) entries.push(join(directory, version));
  }
  return entries.filter((entry) => existsSync(join(sdkRoot, entry)));
}

export async function provisionDotnet(
  context: ProvisionContext,
): Promise<RuntimePayload> {
  const directory = join(context.workDir, "dotnet");
  const root = join(directory, "payload");
  const toolsRoot = join(root, "tools");
  const sdkEnv = {
    DOTNET_CLI_HOME: directory,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
  };
  if (!isProvisioned(context, directory, IDENTITY)) {
    resetDirectory(directory);
    // The full SDK is only needed to install the tool; the payload keeps the
    // subset dotnet-script uses at runtime.
    const sdkRoot = mkdtempSync(join(tmpdir(), "bayma-dotnet-sdk-"));
    try {
      const archive = await fetchPinned(
        DOTNET,
        context.downloadsDir,
        ".NET SDK",
      );
      await runOrThrow(["tar", "-xzf", archive, "-C", sdkRoot]);
      ensureDir(root);
      await runOrThrow(
        [
          join(sdkRoot, "dotnet"),
          "tool",
          "install",
          "dotnet-script",
          "--version",
          DOTNET.scriptVersion,
          "--tool-path",
          toolsRoot,
        ],
        { env: { ...sdkEnv, DOTNET_ROOT: sdkRoot } },
      );
      const libraryDir = resolveDotnetScriptLibraryDirFromToolsRoot(toolsRoot);
      for (const entry of selectSdkEntries(sdkRoot, libraryDir)) {
        cpSync(join(sdkRoot, entry), join(root, entry), { recursive: true });
      }
      // dotnet-script resolves its own library directory through the tool
      // store; a short alias keeps generated project paths well under limits.
      cpSync(libraryDir, join(root, "ds"), { recursive: true });
    } finally {
      rmSync(sdkRoot, { recursive: true, force: true });
    }
    markProvisioned(directory, IDENTITY);
  }
  const version = (
    await runOrThrow([join(root, "tools", "dotnet-script"), "--version"], {
      env: { ...sdkEnv, DOTNET_ROOT: root },
    })
  ).stdout.trim();
  if (version !== DOTNET.scriptVersion) {
    throw new Error(
      `dotnet-script reports ${version}, expected ${DOTNET.scriptVersion}`,
    );
  }
  return {
    runtimeId: "dotnet-script",
    root,
    env: {
      DOTNET_MULTILEVEL_LOOKUP: "0",
      DOTNET_NOLOGO: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    },
    envPaths: {
      DOTNET_ROOT: ".",
      BAYMA_DOTNET_ROOT: ".",
      BAYMA_DOTNET_SCRIPT_BIN: "tools/dotnet-script",
      BAYMA_DOTNET_SCRIPT_LIB_DIR: "ds",
    },
    pathEnvPrepend: { PATH: [".", "tools"] },
    pins: {
      sdkVersion: DOTNET.sdkVersion,
      sdkSha256: DOTNET.sha256,
      sdkUrl: DOTNET.url,
      scriptVersion: DOTNET.scriptVersion,
    },
  };
}
