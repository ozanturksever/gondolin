/**
 * Asset builder for custom Linux kernel and rootfs images.
 *
 * This module wraps the existing guest build pipeline and provides
 * a programmatic interface for building custom VM assets.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execFileSync, SpawnOptions } from "child_process";
import { createHash } from "crypto";

import type {
  BuildConfig,
  AssetManifest,
  Architecture,
} from "./build-config";


/** Fixed output filenames for assets */
const KERNEL_FILENAME = "vmlinuz-virt";
const INITRAMFS_FILENAME = "initramfs.cpio.lz4";
const ROOTFS_FILENAME = "rootfs.ext4";
const MANIFEST_FILENAME = "manifest.json";

/** Zig target triples for cross-compilation */
const ZIG_TARGETS: Record<Architecture, string> = {
  aarch64: "aarch64-linux-musl",
  x86_64: "x86_64-linux-musl",
};

const DEFAULT_ROOTFS_PACKAGES = [
  "linux-virt",
  "rng-tools",
  "bash",
  "ca-certificates",
  "curl",
  "nodejs",
  "npm",
  "uv",
  "python3",
];

type ResolvedAlpineConfig = {
  version: string;
  branch?: string;
  mirror?: string;
  kernelPackage?: string;
  kernelImage?: string;
  rootfsPackages: string[];
  initramfsPackages: string[];
};

function resolveAlpineConfig(config: BuildConfig): ResolvedAlpineConfig {
  const alpine = config.alpine ?? { version: "3.23.0" };
  const kernelPackage = alpine.kernelPackage ?? "linux-virt";
  const defaultRootfsPackages = DEFAULT_ROOTFS_PACKAGES.map((pkg) =>
    pkg === "linux-virt" ? kernelPackage : pkg
  );

  return {
    version: alpine.version,
    branch: alpine.branch,
    mirror: alpine.mirror,
    kernelPackage: alpine.kernelPackage,
    kernelImage: alpine.kernelImage,
    rootfsPackages: alpine.rootfsPackages ?? defaultRootfsPackages,
    initramfsPackages: alpine.initramfsPackages ?? [],
  };
}

export interface BuildOptions {
  /** Output directory for the built assets */
  outputDir: string;
  /** Whether to print progress to stderr. Default: true */
  verbose?: boolean;
  /** Working directory for the build. Default: temp directory */
  workDir?: string;
  /** Skip building sandboxd/sandboxfs binaries (use pre-built) */
  skipBinaries?: boolean;
}

export interface BuildResult {
  /** Path to the output directory */
  outputDir: string;
  /** Path to the manifest file */
  manifestPath: string;
  /** The manifest data */
  manifest: AssetManifest;
}

/**
 * Build guest assets from a configuration.
 */
export async function buildAssets(
  config: BuildConfig,
  options: BuildOptions
): Promise<BuildResult> {
  const verbose = options.verbose ?? true;
  const log = verbose
    ? (msg: string) => process.stderr.write(`${msg}\n`)
    : () => {};

  if (config.distro !== "alpine") {
    throw new Error(
      `Distro '${config.distro}' is not supported yet. Only 'alpine' builds are implemented.`
    );
  }

  // Resolve paths
  const outputDir = path.resolve(options.outputDir);

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  log(`Building guest assets for ${config.arch} (${config.distro})`);
  log(`Output directory: ${outputDir}`);

  // Check if we need a container (macOS can't run Linux build tools natively)
  const needsContainer = shouldUseContainer(config);

  if (needsContainer) {
    return buildInContainer(config, options, log);
  }

  const workDir =
    options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-"));
  log(`Work directory: ${workDir}`);

  // Native Linux build
  return buildNative(config, options, workDir, log);
}

/**
 * Determine if we need to use a container for the build.
 */
function shouldUseContainer(config: BuildConfig): boolean {
  // Force container if explicitly configured
  if (config.container?.force) {
    return true;
  }

  // On macOS, cross-arch builds should use a container because the guest build
  // script overrides ARCH on Apple Silicon.
  if (process.platform === "darwin") {
    const hostArch = detectHostArch();
    if (hostArch !== config.arch) {
      return true;
    }
    return false;
  }

  return false;
}

function detectHostArch(): Architecture {
  let arch = process.arch;

  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      const result = execFileSync("sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.trim() === "1") {
        arch = "arm64";
      }
    } catch {
      // ignore
    }
  }

  if (arch === "arm64") {
    return "aarch64";
  }

  return "x86_64";
}

/**
 * Build assets natively (Linux or macOS with appropriate tools).
 */
async function buildNative(
  config: BuildConfig,
  options: BuildOptions,
  workDir: string,
  log: (msg: string) => void
): Promise<BuildResult> {
  const outputDir = path.resolve(options.outputDir);

  // Find the guest directory (relative to this package)
  const guestDir = findGuestDir();
  if (!guestDir) {
    throw new Error(
      "Could not find guest directory. Make sure you're running from a gondolin checkout."
    );
  }

  log(`Using guest sources from: ${guestDir}`);

  // Step 1: Build sandboxd and sandboxfs binaries
  let sandboxdPath = config.sandboxdPath;
  let sandboxfsPath = config.sandboxfsPath;

  if (!options.skipBinaries && !sandboxdPath && !sandboxfsPath) {
    log("Building guest binaries...");
    await buildGuestBinaries(guestDir, config.arch, log);
    sandboxdPath = path.join(guestDir, "zig-out", "bin", "sandboxd");
    sandboxfsPath = path.join(guestDir, "zig-out", "bin", "sandboxfs");
  } else {
    sandboxdPath = sandboxdPath ?? path.join(guestDir, "zig-out", "bin", "sandboxd");
    sandboxfsPath = sandboxfsPath ?? path.join(guestDir, "zig-out", "bin", "sandboxfs");
  }

  // Step 2: Build the images using the shell script
  log("Building guest images...");

  const imageDir = path.join(guestDir, "image");
  const buildScript = path.join(imageDir, "build.sh");

  // Build environment
  const alpineConfig = resolveAlpineConfig(config);
  const { kernelPackage } = resolveKernelConfig(alpineConfig);
  warnOnKernelPackageMismatch(alpineConfig.rootfsPackages, kernelPackage);

  const buildEnv: Record<string, string> = {
    ...process.env,
    ARCH: config.arch,
    ALPINE_VERSION: alpineConfig.version,
    OUT_DIR: workDir,
    SANDBOXD_BIN: sandboxdPath,
    SANDBOXFS_BIN: sandboxfsPath,
  };

  if (alpineConfig.branch) {
    buildEnv.ALPINE_BRANCH = alpineConfig.branch;
  }
  if (alpineConfig.mirror) {
    buildEnv.ALPINE_URL = `${alpineConfig.mirror}/${alpineConfig.branch ?? `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`}/releases/${config.arch}/alpine-minirootfs-${alpineConfig.version}-${config.arch}.tar.gz`;
  }
  if (alpineConfig.rootfsPackages) {
    buildEnv.ROOTFS_PACKAGES = alpineConfig.rootfsPackages.join(" ");
  }
  if (alpineConfig.initramfsPackages) {
    buildEnv.INITRAMFS_PACKAGES = alpineConfig.initramfsPackages.join(" ");
  }
  if (config.rootfs?.label) {
    buildEnv.ROOTFS_LABEL = config.rootfs.label;
  }
  if (config.rootfs?.sizeMb) {
    buildEnv.ROOTFS_IMAGE_SIZE_MB = String(config.rootfs.sizeMb);
  }
  if (config.init?.rootfsInit) {
    buildEnv.ROOTFS_INIT = path.resolve(config.init.rootfsInit);
  }
  if (config.init?.initramfsInit) {
    buildEnv.INITRAMFS_INIT = path.resolve(config.init.initramfsInit);
  }

  // Run the build script
  await runCommand(buildScript, [], { cwd: imageDir, env: buildEnv }, log);

  // Step 3: Fetch the kernel
  log("Fetching kernel...");
  await fetchKernel(workDir, config.arch, alpineConfig, log);

  // Step 4: Copy assets to output directory
  log("Copying assets to output directory...");

  const kernelSrc = path.join(workDir, KERNEL_FILENAME);
  const initramfsSrc = path.join(workDir, INITRAMFS_FILENAME);
  const rootfsSrc = path.join(workDir, ROOTFS_FILENAME);

  const kernelDst = path.join(outputDir, KERNEL_FILENAME);
  const initramfsDst = path.join(outputDir, INITRAMFS_FILENAME);
  const rootfsDst = path.join(outputDir, ROOTFS_FILENAME);

  fs.copyFileSync(kernelSrc, kernelDst);
  fs.copyFileSync(initramfsSrc, initramfsDst);
  fs.copyFileSync(rootfsSrc, rootfsDst);

  // Step 5: Generate manifest
  log("Generating manifest...");

  const manifest: AssetManifest = {
    version: 1,
    config,
    buildTime: new Date().toISOString(),
    assets: {
      kernel: KERNEL_FILENAME,
      initramfs: INITRAMFS_FILENAME,
      rootfs: ROOTFS_FILENAME,
    },
    checksums: {
      kernel: computeFileHash(kernelDst),
      initramfs: computeFileHash(initramfsDst),
      rootfs: computeFileHash(rootfsDst),
    },
  };

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  log(`Build complete! Assets written to ${outputDir}`);

  // Clean up work directory if it was a temp dir
  if (!options.workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return {
    outputDir,
    manifestPath,
    manifest,
  };
}

/**
 * Build assets inside a container.
 */
async function buildInContainer(
  config: BuildConfig,
  options: BuildOptions,
  log: (msg: string) => void
): Promise<BuildResult> {
  const runtime = detectContainerRuntime(config.container?.runtime);
  const image = config.container?.image ?? "alpine:3.23";
  const outputDir = path.resolve(options.outputDir);

  log(`Using container runtime: ${runtime}`);
  log(`Container image: ${image}`);

  // Find the guest directory
  const guestDir = findGuestDir();
  if (!guestDir) {
    throw new Error(
      "Could not find guest directory. Make sure you're running from a gondolin checkout."
    );
  }

  // Create a temporary script to run inside the container
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-build-"));
  const scriptPath = path.join(workDir, "build-in-container.sh");

  const alpineConfig = resolveAlpineConfig(config);
  const { kernelPackage, kernelImage } = resolveKernelConfig(alpineConfig);
  warnOnKernelPackageMismatch(alpineConfig.rootfsPackages, kernelPackage);
  const alpineBranch =
    alpineConfig.branch ?? `v${alpineConfig.version.split(".").slice(0, 2).join(".")}`;
  const alpineMirror = alpineConfig.mirror ?? "https://dl-cdn.alpinelinux.org/alpine";

  const rootfsPackages = alpineConfig.rootfsPackages.join(" ");
  const initramfsPackages = alpineConfig.initramfsPackages.join(" ");

  const envVars: Record<string, string> = {
    ARCH: config.arch,
    ZIG_TARGET: ZIG_TARGETS[config.arch],
    ALPINE_VERSION: alpineConfig.version,
    ALPINE_BRANCH: alpineBranch,
    ALPINE_MIRROR: alpineMirror,
    ALPINE_URL: `${alpineMirror}/${alpineBranch}/releases/${config.arch}/alpine-minirootfs-${alpineConfig.version}-${config.arch}.tar.gz`,
    ROOTFS_PACKAGES: rootfsPackages,
    INITRAMFS_PACKAGES: initramfsPackages,
    KERNEL_PKG: kernelPackage,
    KERNEL_IMAGE: kernelImage,
    KERNEL_OUTPUT: KERNEL_FILENAME,
    OUT_DIR: "/output",
  };

  if (config.rootfs?.label) {
    envVars.ROOTFS_LABEL = config.rootfs.label;
  }
  if (config.rootfs?.sizeMb) {
    envVars.ROOTFS_IMAGE_SIZE_MB = String(config.rootfs.sizeMb);
  }

  const copyExecutable = (source: string, name: string) => {
    const dest = path.join(workDir, name);
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, 0o755);
    return dest;
  };



  if (config.init?.rootfsInit) {
    copyExecutable(path.resolve(config.init.rootfsInit), "rootfs-init");
    envVars.ROOTFS_INIT = "/work/rootfs-init";
  }
  if (config.init?.initramfsInit) {
    copyExecutable(path.resolve(config.init.initramfsInit), "initramfs-init");
    envVars.INITRAMFS_INIT = "/work/initramfs-init";
  }
  if (config.sandboxdPath) {
    copyExecutable(path.resolve(config.sandboxdPath), "sandboxd");
    envVars.SANDBOXD_BIN = "/work/sandboxd";
  }
  if (config.sandboxfsPath) {
    copyExecutable(path.resolve(config.sandboxfsPath), "sandboxfs");
    envVars.SANDBOXFS_BIN = "/work/sandboxfs";
  }

  const containerScript = `#!/bin/sh
set -eu

# Install build dependencies
apk add --no-cache zig lz4 cpio curl python3 e2fsprogs bash

# Build guest binaries
cd /guest
zig build -Doptimize=ReleaseSmall -Dtarget="\${ZIG_TARGET}"

# Run the image build
cd /guest/image
ARCH="\${ARCH}" \
ALPINE_VERSION="\${ALPINE_VERSION}" \
ALPINE_BRANCH="\${ALPINE_BRANCH}" \
ALPINE_URL="\${ALPINE_URL}" \
ROOTFS_PACKAGES="\${ROOTFS_PACKAGES}" \
INITRAMFS_PACKAGES="\${INITRAMFS_PACKAGES}" \
ROOTFS_LABEL="\${ROOTFS_LABEL:-}" \
ROOTFS_IMAGE_SIZE_MB="\${ROOTFS_IMAGE_SIZE_MB:-}" \
ROOTFS_INIT="\${ROOTFS_INIT:-}" \
INITRAMFS_INIT="\${INITRAMFS_INIT:-}" \
SANDBOXD_BIN="\${SANDBOXD_BIN:-}" \
SANDBOXFS_BIN="\${SANDBOXFS_BIN:-}" \
OUT_DIR="\${OUT_DIR}" \
./build.sh

# Fetch kernel
mirror="\${ALPINE_MIRROR}"
branch="\${ALPINE_BRANCH}"
kernel_pkg="\${KERNEL_PKG}"
kernel_image="\${KERNEL_IMAGE}"
kernel_out="\${KERNEL_OUTPUT}"

curl -L -o /output/APKINDEX.tar.gz "\${mirror}/\${branch}/main/\${ARCH}/APKINDEX.tar.gz"
tar -xzf /output/APKINDEX.tar.gz -C /output APKINDEX
ver=$(awk "/^P:\${kernel_pkg}$/{p=1} p&&/^V:/{print substr($0,3); exit}" /output/APKINDEX)
if [ -z "\${ver}" ]; then
  echo "failed to determine \${kernel_pkg} version" >&2
  exit 1
fi
curl -L -o "/output/\${kernel_pkg}.apk" "\${mirror}/\${branch}/main/\${ARCH}/\${kernel_pkg}-\${ver}.apk"
tar -xzf "/output/\${kernel_pkg}.apk" -C /output "boot/\${kernel_image}"
mv "/output/boot/\${kernel_image}" "/output/\${kernel_out}"
rm -rf /output/boot /output/APKINDEX /output/APKINDEX.tar.gz "/output/\${kernel_pkg}.apk"

echo "Build complete!"
`;

  fs.writeFileSync(scriptPath, containerScript, { mode: 0o755 });

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(envVars)) {
    envArgs.push("-e", `${key}=${value}`);
  }

  // Run container
  const containerArgs = [
    "run",
    "--rm",
    "-v", `${guestDir}:/guest`,
    "-v", `${outputDir}:/output`,
    "-v", `${workDir}:/work`,
    ...envArgs,
    image,
    "/bin/sh", "/work/build-in-container.sh",
  ];

  await runCommand(runtime, containerArgs, {}, log);

  // Generate manifest
  const manifest: AssetManifest = {
    version: 1,
    config,
    buildTime: new Date().toISOString(),
    assets: {
      kernel: KERNEL_FILENAME,
      initramfs: INITRAMFS_FILENAME,
      rootfs: ROOTFS_FILENAME,
    },
    checksums: {
      kernel: computeFileHash(path.join(outputDir, KERNEL_FILENAME)),
      initramfs: computeFileHash(path.join(outputDir, INITRAMFS_FILENAME)),
      rootfs: computeFileHash(path.join(outputDir, ROOTFS_FILENAME)),
    },
  };

  const manifestPath = path.join(outputDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Clean up
  fs.rmSync(workDir, { recursive: true, force: true });

  log(`Build complete! Assets written to ${outputDir}`);

  return {
    outputDir,
    manifestPath,
    manifest,
  };
}

/**
 * Build the guest binaries (sandboxd, sandboxfs).
 */
async function buildGuestBinaries(
  guestDir: string,
  arch: Architecture,
  log: (msg: string) => void
): Promise<void> {
  const zigTarget = ZIG_TARGETS[arch];
  log(`Building for target: ${zigTarget}`);

  await runCommand(
    "zig",
    ["build", "-Doptimize=ReleaseSmall", `-Dtarget=${zigTarget}`],
    { cwd: guestDir },
    log
  );
}

type AlpineKernelConfig = {
  kernelPackage: string;
  kernelImage: string;
};

function resolveKernelConfig(alpineConfig: {
  kernelPackage?: string;
  kernelImage?: string;
}): AlpineKernelConfig {
  const kernelPackage = alpineConfig.kernelPackage ?? "linux-virt";
  const kernelImage = alpineConfig.kernelImage ?? deriveKernelImage(kernelPackage);
  return { kernelPackage, kernelImage };
}

function deriveKernelImage(kernelPackage: string): string {
  if (kernelPackage.startsWith("linux-") && kernelPackage.length > "linux-".length) {
    return `vmlinuz-${kernelPackage.slice("linux-".length)}`;
  }
  return "vmlinuz-virt";
}

function warnOnKernelPackageMismatch(
  rootfsPackages: string[],
  kernelPackage: string
): void {
  if (!rootfsPackages.includes(kernelPackage)) {
    process.stderr.write(
      `Warning: rootfsPackages does not include kernel package '${kernelPackage}'. ` +
        "This may cause module mismatches at boot.\n"
    );
  }
}

/**
 * Fetch the kernel from Alpine repositories.
 */
async function fetchKernel(
  outputDir: string,
  arch: Architecture,
  alpineConfig: {
    version: string;
    branch?: string;
    mirror?: string;
    kernelPackage?: string;
    kernelImage?: string;
  },
  log: (msg: string) => void
): Promise<void> {
  const kernelPath = path.join(outputDir, KERNEL_FILENAME);

  // Skip if already present
  if (fs.existsSync(kernelPath)) {
    log("Kernel already present, skipping download");
    return;
  }

  const version = alpineConfig.version;
  const branch = alpineConfig.branch ?? `v${version.split(".").slice(0, 2).join(".")}`;
  const mirror = alpineConfig.mirror ?? "https://dl-cdn.alpinelinux.org/alpine";
  const { kernelPackage, kernelImage } = resolveKernelConfig(alpineConfig);

  log(`Fetching ${kernelPackage} from Alpine ${branch} (${arch})`);

  // Download APKINDEX to find kernel version
  const indexUrl = `${mirror}/${branch}/main/${arch}/APKINDEX.tar.gz`;
  const indexPath = path.join(outputDir, "APKINDEX.tar.gz");

  execFileSync("curl", ["-L", "-o", indexPath, indexUrl], { stdio: "pipe" });
  execFileSync("tar", ["-xzf", indexPath, "-C", outputDir, "APKINDEX"], { stdio: "pipe" });

  // Parse APKINDEX to find kernel version
  const apkIndexPath = path.join(outputDir, "APKINDEX");
  const apkIndex = fs.readFileSync(apkIndexPath, "utf8");

  let kernelVersion: string | null = null;
  const lines = apkIndex.split("\n");
  let foundPkg = false;

  for (const line of lines) {
    if (line === `P:${kernelPackage}`) {
      foundPkg = true;
    } else if (foundPkg && line.startsWith("V:")) {
      kernelVersion = line.slice(2);
      break;
    } else if (line === "") {
      foundPkg = false;
    }
  }

  if (!kernelVersion) {
    throw new Error(`Failed to find ${kernelPackage} version in APKINDEX`);
  }

  log(`Found ${kernelPackage} version: ${kernelVersion}`);

  // Download and extract kernel
  const apkUrl = `${mirror}/${branch}/main/${arch}/${kernelPackage}-${kernelVersion}.apk`;
  const apkPath = path.join(outputDir, `${kernelPackage}.apk`);
  const kernelEntry = `boot/${kernelImage}`;

  execFileSync("curl", ["-L", "-o", apkPath, apkUrl], { stdio: "pipe" });
  execFileSync("tar", ["-xzf", apkPath, "-C", outputDir, kernelEntry], { stdio: "pipe" });

  // Move kernel to correct location
  fs.renameSync(path.join(outputDir, kernelEntry), kernelPath);

  // Clean up
  fs.rmSync(path.join(outputDir, "boot"), { recursive: true, force: true });
  fs.unlinkSync(indexPath);
  fs.unlinkSync(apkIndexPath);
  fs.unlinkSync(apkPath);
}

/**
 * Find the guest directory relative to this package.
 */
function findGuestDir(): string | null {
  // Check common locations relative to the package
  const candidates = [
    path.resolve(__dirname, "..", "..", "guest"),           // from src/
    path.resolve(__dirname, "..", "..", "..", "guest"),     // from dist/src/
  ];

  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, "image", "build.sh"))
    ) {
      return candidate;
    }
  }

  // Check GONDOLIN_GUEST_SRC environment variable
  if (process.env.GONDOLIN_GUEST_SRC) {
    const envPath = process.env.GONDOLIN_GUEST_SRC;
    if (fs.existsSync(path.join(envPath, "image", "build.sh"))) {
      return envPath;
    }
  }

  return null;
}

/**
 * Detect available container runtime.
 */
function detectContainerRuntime(
  preferred?: "docker" | "podman"
): "docker" | "podman" {
  if (preferred) {
    try {
      execFileSync(preferred, ["--version"], { stdio: "pipe" });
      return preferred;
    } catch {
      throw new Error(`Preferred container runtime '${preferred}' not found`);
    }
  }

  // Try docker first, then podman
  for (const runtime of ["docker", "podman"] as const) {
    try {
      execFileSync(runtime, ["--version"], { stdio: "pipe" });
      return runtime;
    } catch {
      // Continue to next
    }
  }

  throw new Error(
    "No container runtime found. Please install Docker or Podman."
  );
}

/**
 * Run a command and stream output.
 */
async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptions,
  log: (msg: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`Running: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      ...options,
      stdio: ["inherit", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Compute SHA256 hash of a file.
 */
function computeFileHash(filePath: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest("hex");
}

/**
 * Load an asset manifest from a directory.
 */
export function loadAssetManifest(assetDir: string): AssetManifest | null {
  const manifestPath = path.join(assetDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, "utf8");
    return JSON.parse(content) as AssetManifest;
  } catch {
    return null;
  }
}

/**
 * Verify asset checksums against manifest.
 */
export function verifyAssets(assetDir: string): boolean {
  const manifest = loadAssetManifest(assetDir);
  if (!manifest) {
    return false;
  }

  const assets = [
    { name: "kernel", file: manifest.assets.kernel, expected: manifest.checksums.kernel },
    { name: "initramfs", file: manifest.assets.initramfs, expected: manifest.checksums.initramfs },
    { name: "rootfs", file: manifest.assets.rootfs, expected: manifest.checksums.rootfs },
  ];

  for (const { name, file, expected } of assets) {
    const filePath = path.join(assetDir, file);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const actual = computeFileHash(filePath);
    if (actual !== expected) {
      process.stderr.write(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}\n`);
      return false;
    }
  }

  return true;
}
