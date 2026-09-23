// The platforms bayma ships payloads for, and every pinned input that goes
// into them. Changing a pin here is the whole change.
//
// A payload is always built on the platform it targets, so the pins for the
// host platform are the ones provisioning uses; `PLATFORMS` exists so the
// other platform's pins are reviewable in the same place.

export interface PinnedArchive {
  url: string;
  sha256: string;
  /** Its exact size, for an archive larger than downloads are bounded to. */
  bytes?: number;
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
export const LLVM_VERSION = "23.1.2";
export const ZSTD_VERSION = "1.5.7";

/** The LLVM release's licence texts, for the parts of it the payload ships. */
export const LLVM_LICENSES: Record<string, PinnedArchive> = Object.fromEntries(
  (
    [
      [
        "llvm",
        "8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee",
      ],
      [
        "clang",
        "ebcd9bbf783a73d05c53ba4d586b8d5813dcdf3bbec50265860ccc885e606f47",
      ],
      [
        "libcxx",
        "539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b",
      ],
      [
        "libcxxabi",
        "e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c",
      ],
      [
        "libunwind",
        "b5efebcaca80879234098e52d1725e6d9eb8fb96a19fce625d39184b705f7b6d",
      ],
    ] as const
  ).map(([project, sha256]) => [
    project,
    {
      url: `https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-${LLVM_VERSION}/${project}/LICENSE.TXT`,
      sha256,
    },
  ]),
);

/**
 * zstd, built from source into the C and C++ host: LLVM's libraries compress
 * with it, and neither platform's build machine is relied on to provide it.
 */
export const ZSTD_SOURCE: PinnedArchive = {
  url: `https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz`,
  sha256: "eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3",
};

/** A dated, immutable snapshot of the Ubuntu archive. */
const UBUNTU_SNAPSHOT = "https://snapshot.ubuntu.com/ubuntu/20260915T000000Z";

function ubuntuPackage(path: string, sha256: string): PinnedArchive {
  return { url: `${UBUNTU_SNAPSHOT}/pool/${path}`, sha256 };
}

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
   * Linux only: the oldest glibc the payload's native hosts may require, so
   * no build machine's glibc decides which machines bayma runs on.
   */
  glibcFloor?: string;
  /**
   * Linux links the Rust host with a pinned zig so it keeps to the glibc
   * floor. macOS links with Apple's own clang and needs none.
   */
  linker?: { zigVersion: string } & PinnedArchive;
  /**
   * The LLVM release the C and C++ runtimes are built from: Clang's
   * incremental Interpreter as static libraries, the clang that compiles the
   * host against them, Clang's resource headers, and libc++.
   */
  llvm: PinnedArchive & {
    bytes: number;
    /** macOS only: the oldest macOS the release's libraries support, which
     * the host built from them inherits. */
    macosMinimum?: string;
  };
  /**
   * Linux only: Ubuntu 22.04 packages, at the glibc floor, so neither the C
   * and C++ host nor its cells depend on the machine. macOS uses the SDK of
   * the Xcode Command Line Tools instead.
   */
  clangSysroot?: {
    /** What cells compile against and load: glibc's and Linux's C headers,
     * and libatomic, which libc++ needs, with their copyrights. */
    cells: PinnedArchive[];
    /** What the host is also built against: glibc, GCC 12's runtime and
     * libstdc++ (the LLVM release's own), and zlib. */
    build: PinnedArchive[];
  };
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
    glibcFloor: "2.35",
    linker: {
      zigVersion: "0.16.0",
      url: "https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz",
      sha256:
        "70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00",
    },
    llvm: {
      url: `https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/LLVM-${LLVM_VERSION}-Linux-X64.tar.zst`,
      sha256:
        "6382de1c1a210ce5a5cc49d18bc8444d137742e7cbf9b19f4ae602bb1ab52534",
      bytes: 1_183_587_483,
    },
    clangSysroot: {
      cells: [
        ubuntuPackage(
          "main/g/glibc/libc6-dev_2.35-0ubuntu3.15_amd64.deb",
          "ce51ae233a9f800a040de2d0cd5983ef86f558c623b342c80942301d7f453f48",
        ),
        ubuntuPackage(
          "main/l/linux/linux-libc-dev_5.15.0-191.201_amd64.deb",
          "716aff7595cee9b427f23228e40829df437a415055e3e9867a76c2d59f3f1b75",
        ),
        ubuntuPackage(
          "main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_amd64.deb",
          "56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462",
        ),
        // libatomic's copyright, which it shares with the rest of GCC 12.
        ubuntuPackage(
          "main/g/gcc-12/gcc-12-base_12.3.0-1ubuntu1~22.04.3_amd64.deb",
          "7f9253b7e0976f0526fc21346c73ee006e185a7b2f2f865048ea78a2af55bc8d",
        ),
      ],
      build: [
        ubuntuPackage(
          "main/g/glibc/libc6_2.35-0ubuntu3.15_amd64.deb",
          "79e35256227e16a607c154cdeb8d76ff12d20e31de286ea7fd9ad3b96fe0452d",
        ),
        ubuntuPackage(
          "main/g/gcc-12/libgcc-12-dev_12.3.0-1ubuntu1~22.04.3_amd64.deb",
          "a9933d9949219f3a0598bf48390091f45c03c036fe736de38f33b7c60eddca0e",
        ),
        ubuntuPackage(
          "universe/g/gcc-12/libstdc++-12-dev_12.3.0-1ubuntu1~22.04.3_amd64.deb",
          "250f538cb3a5dfbbb767e16cb3d840a2b113de1582bec155ea97600740a6ed1e",
        ),
        ubuntuPackage(
          "main/g/gcc-12/libgcc-s1_12.3.0-1ubuntu1~22.04.3_amd64.deb",
          "d383e642d83263147f7b4b69fb92cf1036e5246c6be3accf10b77f986684589a",
        ),
        ubuntuPackage(
          "main/z/zlib/zlib1g-dev_1.2.11.dfsg-2ubuntu9.2_amd64.deb",
          "679f94589586a433c31fa9f705a6fd2e3bfa2407542ba06227ce14f821647764",
        ),
      ],
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
    llvm: {
      url: `https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/LLVM-${LLVM_VERSION}-macOS-ARM64.tar.zst`,
      sha256:
        "3da0e91b5dfe3a5ec795ad2be79b3f5e6f28c8b23edcd3847fad7742b25e0507",
      bytes: 873_761_429,
      macosMinimum: "14.0",
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
export const CLANG = {
  llvmVersion: LLVM_VERSION,
  llvm: PLATFORM.llvm,
  licenses: LLVM_LICENSES,
  zstdVersion: ZSTD_VERSION,
  zstd: ZSTD_SOURCE,
  sysroot: PLATFORM.clangSysroot,
  glibcFloor: PLATFORM.glibcFloor,
} as const;
export const RUST = {
  version: RUST_VERSION,
  distDate: RUST_DIST_DATE,
  target: PLATFORM.rustTarget,
  evcxrVersion: EVCXR_VERSION,
  channelManifest: RUST_CHANNEL_MANIFEST,
  components: PLATFORM.rustComponents,
  linker: PLATFORM.linker,
  glibcFloor: PLATFORM.glibcFloor,
  supportSeedLockSha256: RUST_SUPPORT_SEED_LOCK_SHA256,
} as const;
