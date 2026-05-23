import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

/**
 * Discover a usable Node binary on the user's system, scanning common
 * install locations and version managers. Returns the first one whose
 * `--version` reports >= minMajor. Null if none found.
 *
 * Order of preference:
 *   1. DTC_MCP_NODE_PATH env var (explicit override)
 *   2. PATH (via `which` / `where`)
 *   3. Homebrew (macOS Intel + Apple Silicon)
 *   4. Standard system locations
 *   5. nvm (POSIX + Windows)
 *   6. Volta
 *   7. fnm (POSIX + Windows)
 *   8. asdf
 *
 * Why exhaustive: a developer who installed Node via nvm or fnm has it
 * available in their shell but NOT in the GUI app's PATH (Claude Desktop
 * launches without a login shell). Walking the common per-version-manager
 * directories catches those.
 */

const MIN_MAJOR = 20;
const MAX_CANDIDATES_TO_PROBE = 12;

export interface DiscoveredNode {
  path: string;
  version: string;
  major: number;
  source: string;
}

export async function discoverNode(): Promise<DiscoveredNode | null> {
  const candidates = await collectCandidates();
  let probed = 0;

  for (const candidate of candidates) {
    if (probed >= MAX_CANDIDATES_TO_PROBE) break;
    if (!candidate.path) continue;
    if (!(await exists(candidate.path))) continue;
    probed++;

    const version = await probeNodeVersion(candidate.path);
    if (!version) continue;
    const major = parseInt(version.replace(/^v/, "").split(".")[0], 10);
    if (!Number.isFinite(major) || major < MIN_MAJOR) continue;

    return {
      path: candidate.path,
      version,
      major,
      source: candidate.source,
    };
  }
  return null;
}

interface Candidate {
  path: string;
  source: string;
}

async function collectCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const isWindows = platform() === "win32";
  const home = homedir();

  // 1. Explicit override
  const override = process.env.DTC_MCP_NODE_PATH;
  if (override) out.push({ path: override, source: "DTC_MCP_NODE_PATH" });

  // 2. PATH lookup (via shell)
  const fromPath = await whichNode();
  if (fromPath) out.push({ path: fromPath, source: "PATH" });

  if (isWindows) {
    // 3. Windows common locations
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData =
      process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const userProfile = process.env.USERPROFILE ?? home;

    out.push(
      { path: join(programFiles, "nodejs", "node.exe"), source: "Program Files" },
      { path: join(programFilesX86, "nodejs", "node.exe"), source: "Program Files (x86)" },
      { path: join(userProfile, ".volta", "bin", "node.exe"), source: "volta" },
    );

    // nvm-windows: %LOCALAPPDATA%\nvm\v22.x.x\node.exe — scan dir
    out.push(
      ...(await scanDir(join(localAppData, "nvm"), "node.exe", "nvm-windows")),
    );
    // fnm: %LOCALAPPDATA%\fnm_multishells\<pid>_<ts>\node.exe — scan dir
    out.push(
      ...(await scanDir(
        join(localAppData, "fnm_multishells"),
        "node.exe",
        "fnm-windows",
      )),
    );
    // fnm node-versions: %LOCALAPPDATA%\fnm\node-versions\v22.x.x\installation\node.exe
    out.push(
      ...(await scanFnmNodeVersions(
        join(localAppData, "fnm", "node-versions"),
        true,
      )),
    );
  } else {
    // 3. POSIX common locations
    out.push(
      { path: "/opt/homebrew/bin/node", source: "homebrew-arm64" },
      { path: "/usr/local/bin/node", source: "homebrew-x64" },
      { path: "/usr/bin/node", source: "system" },
    );

    // 4. nvm (~/.nvm/versions/node/v22.x.x/bin/node) — pick latest
    out.push(
      ...(await scanNvm(join(home, ".nvm", "versions", "node"))),
    );

    // 5. Volta
    out.push({ path: join(home, ".volta", "bin", "node"), source: "volta" });

    // 6. fnm (~/.fnm/node-versions/v22.x.x/installation/bin/node)
    out.push(
      ...(await scanFnmNodeVersions(
        join(home, ".fnm", "node-versions"),
        false,
      )),
    );
    // fnm alternate: ~/.local/share/fnm/node-versions/v22.x.x/installation/bin/node
    out.push(
      ...(await scanFnmNodeVersions(
        join(home, ".local", "share", "fnm", "node-versions"),
        false,
      )),
    );

    // 7. asdf (~/.asdf/installs/nodejs/22.x.x/bin/node)
    out.push(
      ...(await scanAsdf(join(home, ".asdf", "installs", "nodejs"))),
    );
  }

  return dedupe(out);
}

function dedupe(items: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const item of items) {
    const key = resolve(item.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, path: key });
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichNode(): Promise<string | null> {
  const cmd = platform() === "win32" ? "where" : "which";
  return new Promise((resolveP) => {
    const proc = spawn(cmd, ["node"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    proc.on("close", () => {
      // `where` on Windows can return multiple lines; take the first.
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolveP(first || null);
    });
    proc.on("error", () => resolveP(null));
  });
}

async function probeNodeVersion(nodePath: string): Promise<string | null> {
  return new Promise((resolveP) => {
    const proc = spawn(nodePath, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code !== 0) return resolveP(null);
      const version = out.trim();
      resolveP(version.startsWith("v") ? version : null);
    });
    proc.on("error", () => resolveP(null));
  });
}

async function scanDir(
  dir: string,
  binaryName: string,
  source: string,
): Promise<Candidate[]> {
  try {
    const entries = await readdir(dir);
    // Largest version-looking dir wins, so a user with multiple installed
    // versions tries the most recent first.
    const sorted = entries
      .filter((e) => /v?\d/.test(e))
      .sort((a, b) => semverDescend(a, b));
    return sorted.slice(0, 5).map((entry) => ({
      path: join(dir, entry, binaryName),
      source: `${source}:${entry}`,
    }));
  } catch {
    return [];
  }
}

async function scanNvm(nvmDir: string): Promise<Candidate[]> {
  try {
    const entries = await readdir(nvmDir);
    const sorted = entries
      .filter((e) => /^v?\d/.test(e))
      .sort((a, b) => semverDescend(a, b));
    return sorted.slice(0, 5).map((entry) => ({
      path: join(nvmDir, entry, "bin", "node"),
      source: `nvm:${entry}`,
    }));
  } catch {
    return [];
  }
}

async function scanFnmNodeVersions(
  versionsDir: string,
  isWindows: boolean,
): Promise<Candidate[]> {
  try {
    const entries = await readdir(versionsDir);
    const sorted = entries
      .filter((e) => /^v?\d/.test(e))
      .sort((a, b) => semverDescend(a, b));
    const segments = isWindows
      ? ["installation", "node.exe"]
      : ["installation", "bin", "node"];
    return sorted.slice(0, 5).map((entry) => ({
      path: join(versionsDir, entry, ...segments),
      source: `fnm:${entry}`,
    }));
  } catch {
    return [];
  }
}

async function scanAsdf(asdfDir: string): Promise<Candidate[]> {
  try {
    const entries = await readdir(asdfDir);
    const sorted = entries
      .filter((e) => /^\d/.test(e))
      .sort((a, b) => semverDescend(a, b));
    return sorted.slice(0, 5).map((entry) => ({
      path: join(asdfDir, entry, "bin", "node"),
      source: `asdf:${entry}`,
    }));
  } catch {
    return [];
  }
}

function semverDescend(a: string, b: string): number {
  const ax = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const bx = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = ax[i] ?? 0;
    const bv = bx[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}
