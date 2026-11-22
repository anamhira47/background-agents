import { describe, expect, it, vi } from "vitest";
import type { SandboxBootstrapRecord, SandboxBootstrapStore } from "../bootstrap";
import {
  SandboxLaunchRejectedError,
  SandboxProviderError,
  type CreateSandboxConfig,
} from "../provider";
import { FAKE_API_URL, FakeRevylApi } from "../revyl-computer-fake.test-helpers";
import { createRevylComputerClient, revylComputerIdFor } from "../revyl-computer-client";
import { REVYL_START_SESSION_ARGV, RevylSandboxProvider } from "./revyl-provider";

const NOW = 1_700_000_000_000;
const API_KEY = "revyl-api-key";

function setup() {
  let clock = NOW;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms;
  };
  const api = new FakeRevylApi(now);
  const puts: Array<{ record: SandboxBootstrapRecord; token: string; expiresAtMs: number }> = [];
  const store: SandboxBootstrapStore = {
    put: vi.fn(async (record, token, expiresAtMs) => {
      puts.push({ record, token, expiresAtMs });
    }),
    consume: vi.fn(async () => null),
  };
  const client = createRevylComputerClient({
    apiUrl: FAKE_API_URL,
    apiKey: API_KEY,
    fetch: api.fetch,
    sleep,
  });
  const provider = new RevylSandboxProvider(
    client,
    store,
    { scmProvider: "github", baseSnapshot: "oi-base" },
    now,
    sleep
  );
  return { api, provider, puts, now };
}

const createConfig: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-acme-web-app-1700000000000",
  repoOwner: "acme",
  repoName: "web-app",
  controlPlaneUrl: "https://control.example.com/",
  sandboxAuthToken: "sandbox-auth-secret",
  harness: "opencode",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  userEnvVars: { MY_SECRET: "repo-secret" },
  timeoutSeconds: 3600,
  generationCreatedAtMs: NOW - 1000,
  codeServerEnabled: true,
};

async function createdComputerId(config: CreateSandboxConfig = createConfig): Promise<string> {
  return revylComputerIdFor(`${config.sandboxId}:${config.generationCreatedAtMs}`);
}

describe("RevylSandboxProvider.createSandbox", () => {
  it("creates a persistent computer from the base snapshot and hands the guest only a bootstrap token", async () => {
    const { api, provider, puts } = setup();

    const result = await provider.createSandbox(createConfig);

    const computerId = await createdComputerId();
    expect(api.computers.get(computerId)).toMatchObject({ fromSnapshot: "oi-base" });
    const create = api.requests.find((request) => request.method === "POST" && request.path === "");
    expect(JSON.parse(create!.body)).toEqual({
      computer_session_id: computerId,
      os: "macos",
      persistent: true,
      from_snapshot: "oi-base",
      timeout_seconds: 3600,
    });
    expect(create!.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);

    expect(puts).toHaveLength(1);
    const [{ record, token }] = puts;
    expect(record).toMatchObject({
      sandboxId: createConfig.sandboxId,
      env: {
        SANDBOX_AUTH_TOKEN: "sandbox-auth-secret",
        MY_SECRET: "repo-secret",
        SANDBOX_TIMEOUT_SECONDS: "3600",
        RESTORED_FROM_SNAPSHOT: "false",
        FROM_REPO_IMAGE: "false",
        TERMINAL_ENABLED: "",
      },
    });
    expect(record.env.CODE_SERVER_PORT).toBeUndefined();

    expect(api.execs).toEqual([
      {
        computerId,
        argv: REVYL_START_SESSION_ARGV,
        stdin: `https://control.example.com/sessions/session-1/sandbox-bootstrap\n${token}\n`,
        timeoutMs: 60_000,
      },
    ]);
    for (const request of api.requests) {
      expect(request.body).not.toContain("sandbox-auth-secret");
      expect(request.body).not.toContain("repo-secret");
    }

    expect(result).toEqual({
      sandboxId: createConfig.sandboxId,
      providerObjectId: computerId,
      createdAt: expect.any(Number),
      lifetime: {
        kind: "finite",
        expiresAtMs: NOW + 3600 * 1000,
        observedAtMs: expect.any(Number),
        source: "provider",
      },
    });
  });

  it("names one computer per sandbox generation", async () => {
    const first = await createdComputerId();
    expect(await createdComputerId()).toBe(first);
    expect(await createdComputerId({ ...createConfig, generationCreatedAtMs: NOW })).not.toBe(
      first
    );
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([
    [10, 60],
    [200_000, 86_400],
  ])("keeps a %i s lifetime inside Revyl's bounds (%i s)", async (requested, sent) => {
    const { api, provider } = setup();

    await provider.createSandbox({ ...createConfig, timeoutSeconds: requested });

    const create = api.requests.find((request) => request.method === "POST" && request.path === "");
    expect(JSON.parse(create!.body).timeout_seconds).toBe(sent);
  });

  it("refuses to send the bootstrap over plain HTTP", async () => {
    const { api, provider } = setup();

    await expect(
      provider.createSandbox({ ...createConfig, controlPlaneUrl: "http://control.example.com" })
    ).rejects.toThrow("need an https:// control plane URL");
    expect(api.requests).toEqual([]);
  });

  it.each([
    [403, "persistent_computers_not_enabled", "permanent"],
    [503, "saved_disk_unavailable", "transient"],
    [429, "computer_limit", "transient"],
  ] as const)("classifies a create refused with %i %s as %s", async (status, detail, type) => {
    const { api, provider } = setup();
    api.refuseNext({ method: "POST", pathSuffix: "", status, detail });

    const error = await provider.createSandbox(createConfig).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxProviderError);
    expect(error).not.toBeInstanceOf(SandboxLaunchRejectedError);
    expect((error as SandboxProviderError).errorType).toBe(type);
    expect((error as Error).message).toContain(detail);
  });

  it("leaves a computer that never became active as a cleanup obligation", async () => {
    const { api, provider } = setup();
    api.nextStartOutcome = "failed";

    const error = await provider.createSandbox(createConfig).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxLaunchRejectedError);
    expect((error as SandboxLaunchRejectedError).providerObjectId).toBe(await createdComputerId());
    expect(api.execs).toEqual([]);
  });

  it("gives up waiting for a computer before the connect watchdog would", async () => {
    const { api, provider, now } = setup();
    api.readsToSettle = 1_000;

    const error = await provider.createSandbox(createConfig).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxLaunchRejectedError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
    expect(now() - NOW).toBeLessThan(240_000);
  });

  it("rejects the launch when the guest launcher fails", async () => {
    const { api, provider } = setup();
    api.execExitCode = 3;

    const error = await provider.createSandbox(createConfig).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxLaunchRejectedError);
    expect((error as Error).message).toBe("Revyl guest launcher exited 3");
    expect((error as SandboxLaunchRejectedError).providerObjectId).toBe(await createdComputerId());
  });
});

describe("RevylSandboxProvider.resumeSandbox", () => {
  const resumeConfig = {
    providerObjectId: "11111111-2222-4333-8444-555555555555",
    sessionId: "session-1",
    sandboxId: "sb-1",
    timeoutSeconds: 1800,
  };

  it("starts a stopped computer from its saved disk", async () => {
    const { api, provider } = setup();
    api.addComputer(resumeConfig.providerObjectId, {
      persistentState: "stopped",
      runState: "stopped",
    });

    const result = await provider.resumeSandbox(resumeConfig);

    const start = api.requests.find((request) => request.path.endsWith("/start"));
    expect(JSON.parse(start!.body)).toEqual({ timeout_seconds: 1800 });
    expect(result).toMatchObject({
      success: true,
      providerObjectId: resumeConfig.providerObjectId,
      lifetime: { kind: "finite", expiresAtMs: NOW + 1800 * 1000, source: "provider" },
    });
    expect(api.execs).toEqual([]);
  });

  it("waits for a computer that is still saving its disk, then starts it", async () => {
    const { api, provider } = setup();
    api.readsToSettle = 3;
    api.addComputer(resumeConfig.providerObjectId, {
      persistentState: "stopping",
      runState: "closing",
    });

    const result = await provider.resumeSandbox(resumeConfig);

    expect(result.success).toBe(true);
    expect(api.requests.filter((request) => request.path.endsWith("/start"))).toHaveLength(1);
  });

  it("leaves a running computer alone", async () => {
    const { api, provider } = setup();
    api.addComputer(resumeConfig.providerObjectId, {
      persistentState: "running",
      runState: "active",
    });

    const result = await provider.resumeSandbox(resumeConfig);

    expect(result.success).toBe(true);
    expect(api.requests.some((request) => request.path.endsWith("/start"))).toBe(false);
  });

  it("asks for a fresh spawn when the computer is gone", async () => {
    const { provider } = setup();

    await expect(provider.resumeSandbox(resumeConfig)).resolves.toMatchObject({
      success: false,
      shouldSpawnFresh: true,
    });
  });

  it("asks for a fresh spawn when the saved disk has expired", async () => {
    const { api, provider } = setup();
    api.addComputer(resumeConfig.providerObjectId, {
      persistentState: "stopped",
      runState: "stopped",
    });
    api.refuseNext({
      method: "POST",
      pathSuffix: "/start",
      status: 409,
      detail: "saved_disk_expired",
    });

    await expect(provider.resumeSandbox(resumeConfig)).resolves.toMatchObject({
      success: false,
      shouldSpawnFresh: true,
    });
  });

  it.each([
    [409, "run_conflict"],
    [503, "saved_disk_unavailable"],
  ] as const)("treats a start refused with %i %s as transient", async (status, detail) => {
    const { api, provider } = setup();
    api.addComputer(resumeConfig.providerObjectId, {
      persistentState: "stopped",
      runState: "stopped",
    });
    api.refuseNext({ method: "POST", pathSuffix: "/start", status, detail });

    const error = await provider.resumeSandbox(resumeConfig).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxProviderError);
    expect((error as SandboxProviderError).errorType).toBe("transient");
  });

  it("fails transiently when a start ends before the computer is active", async () => {
    const { api, provider } = setup();
    api.nextStartOutcome = "failed";
    api.addComputer(resumeConfig.providerObjectId, {
      persistentState: "stopped",
      runState: "stopped",
    });

    const error = await provider.resumeSandbox(resumeConfig).catch((e: unknown) => e);

    expect((error as SandboxProviderError).errorType).toBe("transient");
  });
});

describe("RevylSandboxProvider.stopSandbox", () => {
  const computerId = "11111111-2222-4333-8444-555555555555";
  const stopConfig = { providerObjectId: computerId, sessionId: "session-1", reason: "inactivity" };

  it("stops a running computer and waits until its disk is saved", async () => {
    const { api, provider } = setup();
    api.readsToSettle = 3;
    api.addComputer(computerId, { persistentState: "running", runState: "active" });

    const result = await provider.stopSandbox({ ...stopConfig, intent: "preserve" });

    expect(result).toEqual({ success: true });
    expect(api.computers.get(computerId)?.persistentState).toBe("stopped");
    expect(api.requests.filter((request) => request.path.endsWith("/stop"))).toHaveLength(1);
  });

  it("does not stop a computer that is already stopped", async () => {
    const { api, provider } = setup();
    api.addComputer(computerId, { persistentState: "stopped", runState: "stopped" });

    await expect(provider.stopSandbox({ ...stopConfig, intent: "preserve" })).resolves.toEqual({
      success: true,
    });
    expect(api.requests.some((request) => request.path.endsWith("/stop"))).toBe(false);
  });

  it("reports a save that outlasts its wait as unconfirmed", async () => {
    const { api, provider } = setup();
    api.readsToSettle = 1_000;
    api.addComputer(computerId, { persistentState: "running", runState: "active" });

    const result = await provider.stopSandbox({ ...stopConfig, intent: "preserve" });

    expect(result).toEqual({ success: false, error: "Revyl computer was still saving its disk" });
  });

  it("cannot confirm a preserve-stop of a computer that is gone", async () => {
    const { provider } = setup();

    const result = await provider.stopSandbox({ ...stopConfig, intent: "preserve" });

    expect(result.success).toBe(false);
  });

  it("deletes the computer and its saved disk to destroy it", async () => {
    const { api, provider } = setup();
    api.addComputer(computerId, { persistentState: "running", runState: "active" });

    await expect(provider.stopSandbox({ ...stopConfig, intent: "destroy" })).resolves.toEqual({
      success: true,
    });
    expect(api.computers.has(computerId)).toBe(false);
  });

  it("treats a computer Revyl no longer has as destroyed", async () => {
    const { provider } = setup();

    await expect(provider.stopSandbox({ ...stopConfig, intent: "destroy" })).resolves.toEqual({
      success: true,
    });
  });
});
