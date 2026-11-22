import type { RevylPersistentState, RevylRunState } from "./revyl-computer-client";

/**
 * A small in-memory stand-in for Revyl's /api/v1/computer-runs, served through
 * fetch so tests drive the real client. Each read of a computer advances a
 * pending transition (starting -> active, stopping -> stopped) once
 * readsToSettle reads have seen it.
 */

interface FakeComputer {
  id: string;
  fromSnapshot: string;
  persistentState: RevylPersistentState;
  runState: RevylRunState;
  expiresAtMs: number;
  readsUntilSettled: number;
  /** What a pending start settles to; "failed" models a start that never goes active. */
  startOutcome: "active" | "failed";
}

export interface FakeExec {
  computerId: string;
  argv: string[];
  stdin: string | null;
  timeoutMs: number;
}

export interface FakeRefusal {
  method: string;
  pathSuffix: string;
  status: number;
  detail: string;
}

export const FAKE_API_URL = "https://revyl.test";

interface CreateBody {
  computer_session_id: string;
  os: string;
  persistent: boolean;
  from_snapshot: string;
  timeout_seconds: number;
}

interface StartBody {
  timeout_seconds: number;
}

interface OperationBody {
  request_id: string;
  command: { kind: string; argv_b64: string[]; stdin?: string; timeout_ms: number };
}

export class FakeRevylApi {
  readonly computers = new Map<string, FakeComputer>();
  readonly requests: Array<{ method: string; path: string; headers: Headers; body: string }> = [];
  readonly execs: FakeExec[] = [];
  readsToSettle = 1;
  nextStartOutcome: "active" | "failed" = "active";
  execExitCode = 0;
  /** Answer exec with 202 and serve the result from the operation read. */
  execRespondsAsync = false;
  /** Operation reads still answered 202 before the async exec result is served. */
  pendingOperationReads = 0;
  private pendingOperation: unknown;
  private readonly refusals: FakeRefusal[] = [];

  constructor(readonly now: () => number) {}

  refuseNext(refusal: FakeRefusal): void {
    this.refusals.push(refusal);
  }

  addComputer(
    id: string,
    state: { persistentState: RevylPersistentState; runState: RevylRunState }
  ): void {
    this.computers.set(id, {
      id,
      fromSnapshot: "seeded",
      expiresAtMs: this.now() + 3_600_000,
      readsUntilSettled: this.readsToSettle,
      startOutcome: "active",
      ...state,
    });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    const path = url.pathname.replace(/^\/api\/v1\/computer-runs/, "");
    this.requests.push({ method, path, headers: new Headers(init?.headers), body });

    const refusal = this.refusals.findIndex(
      (candidate) => candidate.method === method && path.endsWith(candidate.pathSuffix)
    );
    if (refusal >= 0) {
      const [{ status, detail }] = this.refusals.splice(refusal, 1);
      return Response.json({ detail }, { status });
    }
    if (url.origin !== FAKE_API_URL || !url.pathname.startsWith("/api/v1/computer-runs")) {
      return Response.json({ detail: "not_found" }, { status: 404 });
    }
    return this.route(method, path, body ? JSON.parse(body) : undefined);
  };

  private route(method: string, path: string, body: unknown): Response {
    const [, id, action, operationId] = path.split("/");
    if (method === "POST" && path === "") return this.create(body as CreateBody);
    const computer = id ? this.computers.get(id) : undefined;
    if (!computer) return Response.json({ detail: "inaccessible" }, { status: 404 });

    if (method === "GET" && action === undefined) {
      this.advance(computer);
      return Response.json(this.report(computer));
    }
    if (method === "DELETE" && action === undefined) {
      this.computers.delete(computer.id);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && action === "start") {
      if (computer.persistentState !== "stopped") {
        return Response.json({ detail: "run_conflict" }, { status: 409 });
      }
      Object.assign(computer, {
        persistentState: "starting",
        runState: "starting",
        expiresAtMs: this.now() + (body as StartBody).timeout_seconds * 1000,
        readsUntilSettled: this.readsToSettle,
        startOutcome: this.nextStartOutcome,
      });
      return Response.json({ computer_id: computer.id, state: "starting" });
    }
    if (method === "POST" && action === "stop") {
      Object.assign(computer, {
        persistentState: "stopping",
        runState: "closing",
        readsUntilSettled: this.readsToSettle,
      });
      return Response.json(this.report(computer));
    }
    if (method === "POST" && action === "operations") {
      return this.exec(computer, body as OperationBody);
    }
    if (method === "GET" && action === "operations" && operationId) {
      if (this.pendingOperationReads-- > 0) return Response.json(null, { status: 202 });
      return this.pendingOperation === undefined
        ? Response.json({ detail: "operation_not_found" }, { status: 404 })
        : Response.json(this.pendingOperation);
    }
    return Response.json({ detail: "invalid_request" }, { status: 422 });
  }

  private create(body: CreateBody): Response {
    if (body.os !== "macos" || body.persistent !== true) {
      return Response.json({ detail: "invalid_request" }, { status: 422 });
    }
    const computer: FakeComputer = {
      id: body.computer_session_id,
      fromSnapshot: body.from_snapshot,
      persistentState: "starting",
      runState: "starting",
      expiresAtMs: this.now() + body.timeout_seconds * 1000,
      readsUntilSettled: this.readsToSettle,
      startOutcome: this.nextStartOutcome,
    };
    this.computers.set(computer.id, computer);
    return Response.json(this.report(computer));
  }

  private exec(computer: FakeComputer, body: OperationBody): Response {
    const command = body.command;
    if (computer.runState !== "active" || command.kind !== "exec") {
      return Response.json({ detail: "run_closed" }, { status: 409 });
    }
    this.execs.push({
      computerId: computer.id,
      argv: command.argv_b64.map(decode),
      stdin: command.stdin === undefined ? null : decode(command.stdin),
      timeoutMs: command.timeout_ms,
    });
    const result = {
      computer_session_id: computer.id,
      operation_id: body.request_id,
      evidence: { status: "recorded" },
      execution:
        this.execExitCode === 0
          ? {
              outcome: "succeeded",
              result: { kind: "exec", exit_code: 0, stdout: encode("ok\n"), stderr: "" },
            }
          : {
              outcome: "failed",
              error_code: "exec_nonzero",
              result: {
                kind: "exec",
                exit_code: this.execExitCode,
                stdout: "",
                stderr: encode("no\n"),
              },
            },
    };
    if (!this.execRespondsAsync) return Response.json(result);
    this.pendingOperation = result;
    return Response.json(null, { status: 202 });
  }

  private advance(computer: FakeComputer): void {
    if (computer.persistentState !== "starting" && computer.persistentState !== "stopping") return;
    if (--computer.readsUntilSettled > 0) return;
    if (computer.persistentState === "stopping") {
      Object.assign(computer, { persistentState: "stopped", runState: "stopped" });
    } else if (computer.startOutcome === "failed") {
      Object.assign(computer, { persistentState: "stopped", runState: "failed" });
    } else {
      Object.assign(computer, { persistentState: "running", runState: "active" });
    }
  }

  private report(computer: FakeComputer) {
    return {
      computer_session_id: computer.id,
      state: computer.runState,
      expires_at: new Date(computer.expiresAtMs).toISOString(),
      persistent: { computer_id: computer.id, state: computer.persistentState, durable: true },
    };
  }
}

function decode(value: string): string {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function encode(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_");
}
