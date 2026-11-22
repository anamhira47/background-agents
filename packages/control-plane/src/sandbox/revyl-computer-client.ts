/**
 * The one module that speaks Revyl's computer API (/api/v1/computer-runs).
 *
 * A Revyl persistent computer is a macOS VM that keeps one ID for life: stop
 * saves its whole disk, start boots a new run from that save, and a new
 * computer can be created from a named snapshot of a save. Guest access is
 * exec only; nothing outside the guest can reach its ports.
 */

export type RevylRunState = "starting" | "active" | "closing" | "stopped" | "failed" | "owner_lost";
export type RevylPersistentState = "starting" | "running" | "stopping" | "stopped";

export interface RevylComputer {
  computerId: string;
  /** The current run's state. */
  runState: RevylRunState;
  /** The persistent computer's state; null when the response carried none. */
  persistentState: RevylPersistentState | null;
  /** When the current run ends on its own. */
  expiresAtMs: number;
}

export interface RevylCreateComputerRequest {
  /** Caller-chosen UUID; it becomes the persistent computer's ID. */
  computerId: string;
  fromSnapshot: string;
  timeoutSeconds: number;
}

export interface RevylExecRequest {
  argv: string[];
  /** Bytes for the command's stdin; never recorded in Revyl's evidence. */
  stdin?: string;
  timeoutMs: number;
  /** Idempotency key; the same key returns the original result. */
  requestId: string;
}

export interface RevylExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class RevylApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
    this.name = "RevylApiError";
  }

  get isTransient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface RevylComputerApi {
  createComputer(request: RevylCreateComputerRequest, signal?: AbortSignal): Promise<RevylComputer>;
  /** Null when the computer does not exist or was deleted. */
  getComputer(computerId: string, signal?: AbortSignal): Promise<RevylComputer | null>;
  startComputer(computerId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<void>;
  stopComputer(computerId: string, signal?: AbortSignal): Promise<void>;
  /** Deletes the computer and its saved disk; deleting a deleted computer succeeds. */
  deleteComputer(computerId: string, signal?: AbortSignal): Promise<void>;
  exec(
    computerId: string,
    request: RevylExecRequest,
    signal?: AbortSignal
  ): Promise<RevylExecResult>;
}

export interface RevylComputerClientConfig {
  apiUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_REVYL_API_URL = "https://backend.revyl.ai";
const COMPUTER_RUNS_PATH = "/api/v1/computer-runs";
const OPERATION_POLL_INTERVAL_MS = 2_000;

export function createRevylComputerClient(config: RevylComputerClientConfig): RevylComputerApi {
  const baseUrl = config.apiUrl.replace(/\/+$/, "") + COMPUTER_RUNS_PATH;
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function request(
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}
  ): Promise<Response> {
    const response = await doFetch(baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal: options.signal,
    });
    if (response.ok) return response;
    throw await apiError(method, path, response);
  }

  async function readComputer(response: Response, computerId: string): Promise<RevylComputer> {
    return parseComputer(await response.json(), computerId);
  }

  async function awaitOperation(
    computerId: string,
    operationId: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    for (;;) {
      signal?.throwIfAborted();
      await sleep(OPERATION_POLL_INTERVAL_MS);
      const response = await request("GET", `/${computerId}/operations/${operationId}`, { signal });
      if (response.status !== 202) return response.json();
    }
  }

  return {
    async createComputer(create, signal) {
      const response = await request("POST", "", {
        body: {
          computer_session_id: create.computerId,
          os: "macos",
          persistent: true,
          from_snapshot: create.fromSnapshot,
          timeout_seconds: create.timeoutSeconds,
        },
        headers: { "X-Request-ID": create.computerId },
        signal,
      });
      return readComputer(response, create.computerId);
    },

    async getComputer(computerId, signal) {
      try {
        return await readComputer(await request("GET", `/${computerId}`, { signal }), computerId);
      } catch (error) {
        if (error instanceof RevylApiError && error.status === 404) return null;
        throw error;
      }
    },

    async startComputer(computerId, timeoutSeconds, signal) {
      await request("POST", `/${computerId}/start`, {
        body: { timeout_seconds: timeoutSeconds },
        headers: { "X-Request-ID": computerId },
        signal,
      });
    },

    async stopComputer(computerId, signal) {
      await request("POST", `/${computerId}/stop`, {
        headers: { "X-Request-ID": computerId },
        signal,
      });
    },

    async deleteComputer(computerId, signal) {
      try {
        await request("DELETE", `/${computerId}`, { signal });
      } catch (error) {
        if (error instanceof RevylApiError && error.status === 404) return;
        throw error;
      }
    },

    async exec(computerId, exec, signal) {
      const response = await request("POST", `/${computerId}/operations`, {
        body: {
          computer_session_id: computerId,
          request_id: exec.requestId,
          command: {
            kind: "exec",
            argv_b64: exec.argv.map(encodeBase64Url),
            ...(exec.stdin === undefined ? {} : { stdin: encodeBase64Url(exec.stdin) }),
            timeout_ms: exec.timeoutMs,
          },
        },
        headers: { "X-Request-ID": exec.requestId, Prefer: "respond-async" },
        signal,
      });
      const body =
        response.status === 202
          ? await awaitOperation(
              computerId,
              await revylOperationId(computerId, exec.requestId),
              signal
            )
          : await response.json();
      return parseExecResult(body);
    },
  };
}

async function apiError(method: string, path: string, response: Response): Promise<RevylApiError> {
  let code: string | null = null;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") code = body.detail;
  } catch {
    code = null;
  }
  return new RevylApiError(
    `Revyl ${method} computer-runs${path.replace(/\/[0-9a-f-]{36}/g, "/:id")} answered ${response.status}${code ? ` ${code}` : ""}`,
    response.status,
    code
  );
}

function parseComputer(raw: unknown, computerId: string): RevylComputer {
  const body = raw as {
    state?: string;
    expires_at?: string;
    persistent?: { state?: string } | null;
  };
  const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : NaN;
  if (!body.state || !Number.isFinite(expiresAtMs)) {
    throw new RevylApiError("Revyl computer response is missing its state or expiry", 502, null);
  }
  return {
    computerId,
    runState: body.state as RevylRunState,
    persistentState: (body.persistent?.state as RevylPersistentState | undefined) ?? null,
    expiresAtMs,
  };
}

function parseExecResult(raw: unknown): RevylExecResult {
  const execution = (raw as { execution?: Record<string, unknown> } | null)?.execution;
  const outcome = execution?.outcome;
  const result = execution?.result as
    { exit_code?: number; stdout?: string; stderr?: string } | undefined;
  const exitCodeResult =
    (outcome === "succeeded" ||
      (outcome === "failed" && execution?.error_code === "exec_nonzero")) &&
    typeof result?.exit_code === "number";
  if (!exitCodeResult) {
    throw new RevylApiError(
      `Revyl exec ended ${String(outcome)}${execution?.error_code ? ` (${String(execution.error_code)})` : ""}`,
      outcome === "unknown" ? 503 : 500,
      typeof execution?.error_code === "string" ? execution.error_code : null
    );
  }
  return {
    exitCode: result.exit_code!,
    stdout: decodeBase64Url(result.stdout),
    stderr: decodeBase64Url(result.stderr),
  };
}

/** UUIDv5 of the request ID in the computer ID's namespace, as Revyl derives it. */
export async function revylOperationId(computerId: string, requestId: string): Promise<string> {
  const namespace = uuidBytes(computerId);
  const name = new TextEncoder().encode(requestId);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash);
}

/** A stable UUID (v8 layout) for a name, so a retried create names the same computer. */
export async function revylComputerIdFor(name: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name))
  ).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x80;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return formatUuid(hash);
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64Url(value: string | undefined): string {
  if (!value) return "";
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
