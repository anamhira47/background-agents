/**
 * Revyl sandbox provider: each session runs in its own Revyl persistent macOS
 * computer, created from a base snapshot that carries the runtime and its
 * launcher (packages/revyl-infra).
 *
 * - Launch: the session environment is stored behind a single-use bootstrap
 *   token, as for EC2. One exec hands the guest launcher only the bootstrap
 *   URL and token, on stdin, which Revyl never records; the launcher redeems
 *   them over HTTPS and starts the runtime under launchd.
 * - Idle and resume: a preserve-stop stops the computer, which saves its whole
 *   disk. Resume starts it again from that save, possibly on another Mac;
 *   launchd restarts the runtime from the kept environment on boot.
 * - Archive: destroy deletes the computer and its saved disk.
 *
 * Nothing outside the guest can reach its ports, so no preview URLs are offered.
 */

import { supportsConfigurableSandboxTimeout } from "@open-inspect/shared/types/integrations";
import { createLogger } from "../../logger";
import type { SourceControlProviderName } from "../../source-control";
import {
  generateSandboxBootstrapToken,
  SANDBOX_BOOTSTRAP_TOKEN_TTL_MS,
  type SandboxBootstrapStore,
} from "../bootstrap";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxLaunchRejectedError,
  SandboxProviderError,
  signalUntilDeadline,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";
import {
  RevylApiError,
  revylComputerIdFor,
  type RevylComputer,
  type RevylComputerApi,
} from "../revyl-computer-client";
import {
  buildSandboxEnvVars,
  DEFERRED_START_ENV_VAR,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
} from "../sandbox-env";
import { resolveSandboxPortPlan } from "./port-resolution";

const log = createLogger("revyl-provider");

/** Installed by packages/revyl-infra into the base snapshot. */
export const REVYL_START_SESSION_ARGV = ["sudo", "-n", "/opt/openinspect/revyl/start-session"];

const BOOTSTRAP_PATH_SUFFIX = "/sandbox-bootstrap";
const MIN_LIFETIME_SECONDS = 60;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const POLL_INTERVAL_MS = 2_000;
/** Kept under the control plane's 240 s connect watchdog, which counts from the reservation. */
const ACTIVE_WAIT_MS = 180_000;
const STOPPING_WAIT_MS = 120_000;
/** A save takes up to 60 s in the guest plus the host's release. */
const STOP_SAVE_WAIT_MS = 300_000;
const START_SESSION_TIMEOUT_MS = 60_000;

const ENDED_RUN_STATES = new Set(["stopped", "failed", "owner_lost"]);

export interface RevylProviderConfig {
  scmProvider: SourceControlProviderName;
  /** Snapshot ID or name every new session's computer is created from. */
  baseSnapshot: string;
}

export class RevylSandboxProvider implements SandboxProvider {
  readonly name = "revyl";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly api: RevylComputerApi,
    private readonly bootstrapStore: SandboxBootstrapStore,
    private readonly config: RevylProviderConfig,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    const bootstrapUrl = `${config.controlPlaneUrl.replace(/\/+$/, "")}/sessions/${encodeURIComponent(
      config.sessionId
    )}${BOOTSTRAP_PATH_SUFFIX}`;
    if (new URL(bootstrapUrl).protocol !== "https:") {
      throw new SandboxProviderError(
        "Revyl sandboxes need an https:// control plane URL to receive their environment",
        "permanent"
      );
    }
    const token = generateSandboxBootstrapToken();
    await this.bootstrapStore.put(
      { sandboxId: config.sandboxId, env: this.buildEnvVars(config) },
      token,
      this.now() + SANDBOX_BOOTSTRAP_TOKEN_TTL_MS
    );

    const computerId = await revylComputerIdFor(
      `${config.sandboxId}:${config.generationCreatedAtMs ?? ""}`
    );
    try {
      await this.api.createComputer({
        computerId,
        fromSnapshot: this.config.baseSnapshot,
        timeoutSeconds: lifetimeSeconds(config.timeoutSeconds),
      });
    } catch (error) {
      throw classifyRevylError("Failed to create Revyl computer", error);
    }
    log.info("revyl.computer_created", {
      session_id: config.sessionId,
      sandbox_id: config.sandboxId,
      computer_id: computerId,
    });

    try {
      const computer = await this.waitUntilActive(computerId);
      const launch = await this.api.exec(computerId, {
        argv: REVYL_START_SESSION_ARGV,
        stdin: `${bootstrapUrl}\n${token}\n`,
        timeoutMs: START_SESSION_TIMEOUT_MS,
        requestId: crypto.randomUUID(),
      });
      if (launch.exitCode !== 0) {
        throw new SandboxLaunchRejectedError(
          `Revyl guest launcher exited ${launch.exitCode}`,
          computerId
        );
      }
      return {
        sandboxId: config.sandboxId,
        providerObjectId: computerId,
        createdAt: this.now(),
        lifetime: this.lifetimeOf(computer),
      };
    } catch (error) {
      if (error instanceof SandboxLaunchRejectedError) throw error;
      const classified = classifyRevylError("Failed to start the Revyl sandbox", error);
      throw new SandboxLaunchRejectedError(classified.message, computerId, classified);
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    const computerId = config.providerObjectId;
    try {
      let computer = await this.api.getComputer(computerId);
      const stoppingDeadline = this.now() + STOPPING_WAIT_MS;
      while (computer?.persistentState === "stopping" && this.now() < stoppingDeadline) {
        await this.sleep(POLL_INTERVAL_MS);
        computer = await this.api.getComputer(computerId);
      }
      if (!computer) {
        return { success: false, error: "Revyl computer no longer exists", shouldSpawnFresh: true };
      }
      if (computer.persistentState === "stopping") {
        throw new SandboxProviderError("Revyl computer is still saving its disk", "transient");
      }
      if (computer.persistentState === "stopped") {
        try {
          await this.api.startComputer(computerId, lifetimeSeconds(config.timeoutSeconds));
        } catch (error) {
          if (
            error instanceof RevylApiError &&
            (error.status === 404 || error.code === "saved_disk_expired")
          ) {
            return {
              success: false,
              error: `Revyl computer cannot start again (${error.code ?? error.status})`,
              shouldSpawnFresh: true,
            };
          }
          throw error;
        }
      }
      const running = await this.waitUntilActive(computerId);
      return { success: true, providerObjectId: computerId, lifetime: this.lifetimeOf(running) };
    } catch (error) {
      throw classifyRevylError("Failed to resume Revyl computer", error);
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const signal = signalUntilDeadline(config.deadlineAtMs, config.signal);
    const computerId = config.providerObjectId;
    try {
      if (config.intent === "destroy") {
        await this.api.deleteComputer(computerId, signal);
        return { success: true };
      }
      let computer = await this.api.getComputer(computerId, signal);
      if (!computer) {
        return {
          success: false,
          error: "Sandbox disappeared before graceful shutdown was verified",
        };
      }
      if (computer.persistentState === "starting" || computer.persistentState === "running") {
        await this.api.stopComputer(computerId, signal);
      }
      const deadline = this.now() + STOP_SAVE_WAIT_MS;
      while (computer?.persistentState !== "stopped") {
        if (!computer) {
          return { success: false, error: "Sandbox disappeared before its disk was saved" };
        }
        if (this.now() >= deadline || signal?.aborted) {
          return { success: false, error: "Revyl computer was still saving its disk" };
        }
        await this.sleep(POLL_INTERVAL_MS);
        computer = await this.api.getComputer(computerId, signal);
      }
      return { success: true };
    } catch (error) {
      throw classifyRevylError(
        `Failed to ${config.intent === "destroy" ? "delete" : "stop"} Revyl computer`,
        error
      );
    }
  }

  private async waitUntilActive(computerId: string): Promise<RevylComputer> {
    const deadline = this.now() + ACTIVE_WAIT_MS;
    for (;;) {
      const computer = await this.api.getComputer(computerId);
      if (!computer) {
        throw new SandboxProviderError("Revyl computer disappeared while starting", "permanent");
      }
      if (computer.runState === "active" && computer.persistentState !== "stopping") {
        return computer;
      }
      if (ENDED_RUN_STATES.has(computer.runState) && computer.persistentState !== "starting") {
        throw new SandboxProviderError(
          `Revyl computer ended ${computer.runState} before it became active`,
          "transient"
        );
      }
      if (this.now() >= deadline) {
        throw new SandboxProviderError("Revyl computer did not become active in time", "transient");
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  private lifetimeOf(computer: RevylComputer): Extract<SandboxLifetime, { kind: "finite" }> {
    return {
      kind: "finite",
      expiresAtMs: computer.expiresAtMs,
      observedAtMs: this.now(),
      source: "provider",
    };
  }

  private buildEnvVars(config: CreateSandboxConfig): Record<string, string> {
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: scmCloneIdentity(this.config.scmProvider),
      portPlan: resolveSandboxPortPlan({ codeServer: false, terminal: false, vnc: false }, {}),
      emitDisabledTerminalEnv: true,
    });
    Object.assign(envVars, {
      [DEFERRED_START_ENV_VAR]: "false",
      [IMAGE_BUILD_MODE_ENV_VAR]: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
    });
    return envVars;
  }
}

function lifetimeSeconds(timeoutSeconds: number | undefined): number {
  return Math.min(
    MAX_LIFETIME_SECONDS,
    Math.max(MIN_LIFETIME_SECONDS, Math.ceil(timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS))
  );
}

function classifyRevylError(message: string, error: unknown): SandboxProviderError {
  if (error instanceof SandboxProviderError) return error;
  if (error instanceof RevylApiError) {
    return new SandboxProviderError(
      `${message}: ${error.message}`,
      error.isTransient || error.code === "run_conflict" ? "transient" : "permanent",
      error
    );
  }
  return SandboxProviderError.fromFetchError(`${message}: ${String(error)}`, error);
}

export function createRevylProvider(
  api: RevylComputerApi,
  bootstrapStore: SandboxBootstrapStore,
  config: RevylProviderConfig
): RevylSandboxProvider {
  return new RevylSandboxProvider(api, bootstrapStore, config);
}
