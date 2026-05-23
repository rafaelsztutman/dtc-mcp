import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { transform } from "sucrase";
import { discoverNode, type DiscoveredNode } from "./node-discovery.js";
import { invoke, methodPaths } from "./bridge.js";
import { log } from "../config.js";
import type { RunResult } from "./vm-runner.js";
import type {
  ExecuteResponseMessage,
  HostCallRequestMessage,
  SidecarToMain,
} from "./protocol.js";

/**
 * Sidecar runner: spawns a system-Node child process that hosts `isolated-vm`
 * and proxies execute_code calls to it. The sidecar exists because Claude
 * Desktop's Electron hardened runtime blocks loading native modules into the
 * main MCP server process. See ./sidecar/index.ts for the child side.
 *
 * Lifecycle (lazy):
 *   - First call to runSandboxSidecar triggers discovery + spawn.
 *   - Sidecar emits `ready` → we send `init` with the method registry.
 *   - Subsequent calls reuse the same process for low per-call latency.
 *   - On unexpected exit we mark the runner unavailable; runner.ts falls
 *     back to the vm-runner for the current and future calls.
 *
 * Why not fork() a worker thread instead: workers run in the SAME process
 * (still bound by Electron's hardened runtime). A separately-spawned `node`
 * binary is the actual escape hatch.
 */

export interface SidecarAvailability {
  available: true;
  node: DiscoveredNode;
}

export interface SidecarUnavailable {
  available: false;
  reason: string;
}

export type SidecarStatus = SidecarAvailability | SidecarUnavailable;

interface Pending {
  resolve: (result: RunResult) => void;
  reject: (err: Error) => void;
  start: number;
}

class SidecarProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private readyPromise: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private execIdCounter = 0;
  private dead = false;
  private deadReason = "";

  constructor(
    private nodePath: string,
    private sidecarScriptPath: string,
  ) {}

  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.spawnAndAwaitReady();
    return this.readyPromise;
  }

  private spawnAndAwaitReady(): Promise<void> {
    return new Promise((res, rej) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.markDead("sidecar did not signal ready within 5s");
        rej(new Error(this.deadReason));
      }, 5_000);

      const child = spawn(this.nodePath, [this.sidecarScriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          // Inherit only what the sidecar genuinely needs. Notably, we do
          // NOT forward Klaviyo/Shopify credentials — those calls happen
          // in the main process, never in the sidecar.
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          USERPROFILE: process.env.USERPROFILE ?? "",
          NODE_OPTIONS: "", // strip any inherited --inspect flags etc.
        },
      });
      this.child = child;

      child.stderr.on("data", (d: Buffer) => {
        // Sidecar's stderr is for our diagnostics, not the MCP transport.
        log("debug", "[sidecar stderr] " + d.toString("utf8").trimEnd());
      });

      this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      this.rl.on("line", (line) => {
        if (settled) {
          this.onMessage(line);
          return;
        }
        // While not yet ready, watch for ready or fatal.
        let msg: SidecarToMain;
        try {
          msg = JSON.parse(line) as SidecarToMain;
        } catch {
          return;
        }
        if (msg.type === "ready") {
          settled = true;
          clearTimeout(timer);
          this.sendInit();
          res();
        } else if (msg.type === "fatal") {
          settled = true;
          clearTimeout(timer);
          this.markDead(`sidecar fatal: ${msg.reason}`);
          rej(new Error(this.deadReason));
        }
      });

      child.on("exit", (code, signal) => {
        const reason = `sidecar exited (code=${code}, signal=${signal})`;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.markDead(reason);
          rej(new Error(reason));
          return;
        }
        this.markDead(reason);
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.markDead(`spawn error: ${err.message}`);
          rej(new Error(this.deadReason));
        }
      });
    });
  }

  private sendInit(): void {
    if (!this.child) return;
    this.child.stdin.write(
      JSON.stringify({ type: "init", methodPaths }) + "\n",
    );
  }

  private markDead(reason: string): void {
    this.dead = true;
    this.deadReason = reason;
    for (const p of this.pending.values()) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private onMessage(line: string): void {
    if (!line.trim()) return;
    let msg: SidecarToMain;
    try {
      msg = JSON.parse(line) as SidecarToMain;
    } catch (e) {
      log("warn", "bad JSON from sidecar", {
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (msg.type === "execute-result") {
      this.onExecuteResult(msg);
    } else if (msg.type === "host-call") {
      void this.onHostCall(msg);
    } else if (msg.type === "log") {
      log(msg.level, `[sidecar] ${msg.message}`);
    }
  }

  private onExecuteResult(msg: ExecuteResponseMessage): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      const result =
        msg.resultJson !== undefined ? JSON.parse(msg.resultJson) : null;
      p.resolve({
        ok: true,
        result,
        stdout: msg.stdout,
        durationMs: msg.durationMs,
      });
    } else {
      p.resolve({
        ok: false,
        error: msg.error ?? "unknown error",
        stdout: msg.stdout ?? [],
        durationMs: msg.durationMs,
      });
    }
  }

  private async onHostCall(msg: HostCallRequestMessage): Promise<void> {
    if (!this.child) return;
    let resultJson: string;
    try {
      const args = JSON.parse(msg.argsJson) as unknown[];
      const result = await invoke(msg.path, args);
      resultJson = JSON.stringify(result ?? null);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      resultJson = `__ERROR__${errMsg}`;
    }
    this.child.stdin.write(
      JSON.stringify({
        type: "host-result",
        execId: msg.execId,
        callId: msg.callId,
        resultJson,
      }) + "\n",
    );
  }

  async execute(code: string, timeoutMs: number): Promise<RunResult> {
    if (this.dead) {
      return {
        ok: false,
        error: `Sidecar unavailable: ${this.deadReason}`,
        stdout: [],
        durationMs: 0,
      };
    }
    if (!this.child) {
      throw new Error("Sidecar not started — call start() first");
    }
    const id = `e${this.execIdCounter++}`;
    return new Promise<RunResult>((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej, start: Date.now() });
      this.child!.stdin.write(
        JSON.stringify({ type: "execute", id, code, timeoutMs }) + "\n",
      );
    });
  }

  isDead(): boolean {
    return this.dead;
  }

  deathReason(): string {
    return this.deadReason;
  }

  shutdown(): void {
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        // ignore
      }
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill("SIGKILL");
      }, 1_000).unref();
    }
  }
}

let cachedStatus: SidecarStatus | null = null;
let processInstance: SidecarProcess | null = null;
let initPromise: Promise<SidecarStatus> | null = null;

export async function getSidecarStatus(): Promise<SidecarStatus> {
  if (cachedStatus) return cachedStatus;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (process.env.DTC_MCP_SANDBOX === "vm") {
      cachedStatus = { available: false, reason: "forced via DTC_MCP_SANDBOX=vm" };
      return cachedStatus;
    }

    const node = await discoverNode();
    if (!node) {
      cachedStatus = {
        available: false,
        reason: "no system Node ≥ 20 found",
      };
      return cachedStatus;
    }

    const sidecarPath = locateSidecarScript();
    const proc = new SidecarProcess(node.path, sidecarPath);
    try {
      await proc.start();
      processInstance = proc;
      log("info", "Sidecar ready", {
        node: node.path,
        nodeVersion: node.version,
        source: node.source,
      });
      cachedStatus = { available: true, node };
      // Ensure clean shutdown when the main process exits.
      const onExit = (): void => proc.shutdown();
      process.once("exit", onExit);
      process.once("SIGTERM", onExit);
      process.once("SIGINT", onExit);
      return cachedStatus;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log("warn", "Sidecar startup failed; falling back to node:vm", {
        reason,
      });
      cachedStatus = { available: false, reason };
      return cachedStatus;
    }
  })();
  return initPromise;
}

function locateSidecarScript(): string {
  // Override always wins (used by tests + power users).
  if (process.env.DTC_MCP_SIDECAR_SCRIPT) {
    return process.env.DTC_MCP_SIDECAR_SCRIPT;
  }

  const here = dirname(fileURLToPath(import.meta.url));

  // Runtime case: this file is dist/sandbox/sidecar-runner.js, sidecar is
  // alongside at dist/sandbox/sidecar/index.js.
  const sibling = resolve(here, "sidecar", "index.js");

  // Dev/test case: vitest loads the .ts directly so `here` is src/sandbox.
  // The compiled sidecar lives at <repo>/dist/sandbox/sidecar/index.js.
  const distFromSrc = resolve(
    here,
    "..",
    "..",
    "dist",
    "sandbox",
    "sidecar",
    "index.js",
  );

  // Return the first one that exists; statSync is cheap and only runs once.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statSync } = require("node:fs") as typeof import("node:fs");
    if (statSync(sibling, { throwIfNoEntry: false })?.isFile()) return sibling;
    if (statSync(distFromSrc, { throwIfNoEntry: false })?.isFile())
      return distFromSrc;
  } catch {
    // Fall through.
  }
  return sibling;
}

export async function runSandboxSidecar(
  code: string,
  options: { timeoutMs: number },
): Promise<RunResult> {
  const status = await getSidecarStatus();
  if (!status.available || !processInstance) {
    return {
      ok: false,
      error: `Sidecar unavailable: ${(status as SidecarUnavailable).reason}`,
      stdout: [],
      durationMs: 0,
    };
  }

  // TS-strip happens in the main process so the sidecar doesn't need sucrase.
  let jsCode: string;
  try {
    jsCode = transform(code, {
      transforms: ["typescript"],
      disableESTransforms: true,
      production: true,
    }).code;
  } catch {
    jsCode = code;
  }

  return processInstance.execute(jsCode, options.timeoutMs);
}
