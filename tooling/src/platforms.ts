// The platforms bayma ships payloads for, and every pinned input that goes
// into them. Changing a pin here is the whole change.
//
// A payload is always built on the platform it targets, so the pins for the
// host platform are the ones provisioning uses; `PLATFORMS` exists so the
// other platform's pins are reviewable in the same place.

export interface PinnedArchive {
  url: string;
  sha256: string;
}

export const PLATFORM_IDS = ["linux-x64", "darwin-arm64"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export const BUN_VERSION = "1.3.14";
export const PYTHON_VERSION = "3.12.13";
export const DOTNET_SDK_VERSION = "10.0.401";
export const DOTNET_SCRIPT_VERSION = "2.0.1";
export const RUST_VERSION = "1.97.1";
export const RUST_DIST_DATE = "2026-07-16";
export const EVCXR_VERSION = "0.21.1";
export const UV_VERSION = "0.12.9";

/** The signed manifest every Rust component digest below was taken from. */
export const RUST_CHANNEL_MANIFEST: PinnedArchive = {
  url: `https://static.rust-lang.org/dist/${RUST_DIST_DATE}/channel-rust-${RUST_VERSION}.toml`,
  sha256: "03569b1886ceb5c05276b50c8431ab111de944cd6140fe1fa7d821dd8e0f29cf",
};

/** Cargo registry seed for the support crate compiled into every cell. */
export const RUST_SUPPORT_SEED_LOCK_SHA256 =
  "22de8730e34498031408f0746516d9dba993043d2f5103bca368e5d065554ead";

export interface PlatformPins {
  id: PlatformId;
  /** The Rust target triple the toolchain and host are built for. */
  rustTarget: string;
  bun: PinnedArchive;
  python: PinnedArchive;
  dotnet: PinnedArchive;
  rustComponents: Record<"cargo" | "rustc" | "rust-std", PinnedArchive>;
  /** uv builds the toolbelt's Python environment from its lockfile. */
  uv: PinnedArchive;
  /**
   * Linux links the host with a pinned zig so its glibc floor does not depend
   * on the build machine. macOS links with Apple's own clang and needs none.
   */
  linker?: { zigVersion: string; glibcFloor: string } & PinnedArchive;
}

export const PLATFORMS: Record<PlatformId, PlatformPins> = {
  "linux-x64": {
    id: "linux-x64",
    rustTarget: "x86_64-unknown-linux-gnu",
    bun: {
      url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`,
      sha256:
        "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260805/cpython-3.12.13%2B20260805-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
      sha256:
        "f04a55ae95e8bd352cdff8da11c344fe609ec84795d106fa91b6620366d786fe",
    },
    dotnet: {
      url: `https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-linux-x64.tar.gz`,
      sha256:
        "137268c8ad939c064ff1ee2a6fdf0899d8725377114ea012fbd1ad5fa2550418",
    },
    rustComponents: {
      cargo: {
        url: `https://static.rust-lang.org/dist/${RUST_DIST_DATE}/cargo-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz`,
        sha256:
          "e1be5f5ff7f7f80ca506fb65770b759edbdc6d303781ed71c5de8ec8a8394779",
      },
      rustc: {
        url: `https://static.rust-lang.org/dist/${RUST_DIST_DATE}/rustc-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz`,
        sha256:
          "9819d0a32d56bd339585319c80260e332779f5541fd66838ab7e016d6c814819",
      },
      "rust-std": {
        url: `https://static.rust-lang.org/dist/${RUST_DIST_DATE}/rust-std-${RUST_VERSION}-x86_64-unknown-linux-gnu.tar.xz`,
        sha256:
          "1c1e704ae80126b7de34f72ea2825f7fd01736dec20732faed47374b95282fba",
      },
    },
    uv: {
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz`,
      sha256:
        "ec7a99cd05e0cd7f80243f135ce1361c76835cb0ee60055d14d20eba8eba1460",
    },
    linker: {
      zigVersion: "0.16.0",
      glibcFloor: "2.35",
      url: "https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz",
      sha256:
        "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
    },
  },
  "darwin-arm64": {
    id: "darwin-arm64",
    rustTarget: "aarch64-apple-darwin",
    bun: {
      url: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-aarch64.zip`,
      sha256:
        "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
    },
    python: {
      url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260805/cpython-3.12.13%2B20260805-aarch64-apple-darwin-install_only_stripped.tar.gz",
      sha256:
        "a4b36035915038104aabee94d6f02827161da444296881fe4493cb98f70304b2",
    },
    dotnet: {
      url: `https://builds.dotnet.microsoft.com/dotnet/Sdk/${DOTNET_SDK_VERSION}/dotnet-sdk-${DOTNET_SDK_VERSION}-osx-arm64.tar.gz`,
      sha256:
        "d143ccec4474dce17d7b778854598137a2599b81828bce51e809897fe8bdf035",
    },
    rustComponents: {
      cargo: {
        url: `https://static.rust-lang.org/dist/${RUST_DIST_DATE}/cargo-${RUST_VERSION}-aarch64-apple-darwin.tar.xz`,
        sha256:
          "2d84a74e9558192a7de674aca6aa3ab7464bed2df97e0377156ddb7e09a0fd7a",
      },
      rustc: {
        url: `https://static.rust-lang.org/dist/${RUST_DIST_DATE}/rustc-${RUST_VERSION}-aarch64-apple-darwin.tar.xz`,
        sha256:
          "6076cad38ccabaa24325f26a74080a363a2633a9cd34c473a8977255d8a593cb",
      },
      "rust-std": {
        url: `https://static.rust-lang.org/dist/${RUST_DIST_DATE}/rust-std-${RUST_VERSION}-aarch64-apple-darwin.tar.xz`,
        sha256:
          "a4895f5c6995e83cab8687e46b14324592398049def71ce75ca308c981cf200d",
      },
    },
    uv: {
      url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
      sha256:
        "301f72afaf54060f92da7016cb0115bd077f43a9c8e39c1d8170a0bac80fd398",
    },
  },
};

export function hostPlatformId(): PlatformId {
  const id = `${process.platform === "darwin" ? "darwin" : process.platform}-${process.arch}`;
  if ((PLATFORM_IDS as readonly string[]).includes(id)) return id as PlatformId;
  throw new Error(
    `bayma builds payloads for ${PLATFORM_IDS.join(" and ")}, not ${id}`,
  );
}

/** The pins provisioning uses: this machine's. */
export const PLATFORM: PlatformPins = PLATFORMS[hostPlatformId()];

export const BUN = { version: BUN_VERSION, ...PLATFORM.bun } as const;
export const PYTHON = { version: PYTHON_VERSION, ...PLATFORM.python } as const;
export const DOTNET = {
  sdkVersion: DOTNET_SDK_VERSION,
  scriptVersion: DOTNET_SCRIPT_VERSION,
  ...PLATFORM.dotnet,
} as const;
export const UV = { version: UV_VERSION, ...PLATFORM.uv } as const;
export const RUST = {
  version: RUST_VERSION,
  distDate: RUST_DIST_DATE,
  target: PLATFORM.rustTarget,
  evcxrVersion: EVCXR_VERSION,
  channelManifest: RUST_CHANNEL_MANIFEST,
  components: PLATFORM.rustComponents,
  linker: PLATFORM.linker,
  supportSeedLockSha256: RUST_SUPPORT_SEED_LOCK_SHA256,
} as const;
