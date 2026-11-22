import { describe, expect, it } from "vitest";
import { FAKE_API_URL, FakeRevylApi } from "./revyl-computer-fake.test-helpers";
import {
  createRevylComputerClient,
  RevylApiError,
  revylOperationId,
} from "./revyl-computer-client";

const COMPUTER_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const REQUEST_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";

function setup() {
  const api = new FakeRevylApi(() => 1_700_000_000_000);
  api.addComputer(COMPUTER_ID, { persistentState: "running", runState: "active" });
  const client = createRevylComputerClient({
    apiUrl: `${FAKE_API_URL}/`,
    apiKey: "key",
    fetch: api.fetch,
    sleep: async () => {},
  });
  return { api, client };
}

describe("revylOperationId", () => {
  it("matches Revyl's UUIDv5 of the request ID in the computer's namespace", async () => {
    // Python: uuid.uuid5(uuid.UUID(COMPUTER_ID), REQUEST_ID)
    await expect(revylOperationId(COMPUTER_ID, REQUEST_ID)).resolves.toBe(
      "5e6bc3a4-d725-53b3-bc6d-b63960e5f553"
    );
  });
});

describe("RevylComputerClient.exec", () => {
  it("sends argv and stdin as padded URL-safe base64 and decodes the output", async () => {
    const { api, client } = setup();

    const result = await client.exec(COMPUTER_ID, {
      argv: ["printf", "é?>"],
      stdin: "line\n",
      timeoutMs: 5_000,
      requestId: REQUEST_ID,
    });

    const body = JSON.parse(api.requests[0].body);
    expect(body).toEqual({
      computer_session_id: COMPUTER_ID,
      request_id: REQUEST_ID,
      command: {
        kind: "exec",
        argv_b64: ["cHJpbnRm", "w6k_Pg=="],
        stdin: "bGluZQo=",
        timeout_ms: 5_000,
      },
    });
    expect(api.requests[0].headers.get("Prefer")).toBe("respond-async");
    expect(api.requests[0].headers.get("X-Request-ID")).toBe(REQUEST_ID);
    expect(result).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
  });

  it("returns a non-zero exit as a result", async () => {
    const { api, client } = setup();
    api.execExitCode = 2;

    await expect(
      client.exec(COMPUTER_ID, { argv: ["false"], timeoutMs: 1_000, requestId: REQUEST_ID })
    ).resolves.toEqual({ exitCode: 2, stdout: "", stderr: "no\n" });
  });

  it("reads a still-running operation by its derived ID until it settles", async () => {
    const { api, client } = setup();
    api.execRespondsAsync = true;
    api.pendingOperationReads = 2;

    const result = await client.exec(COMPUTER_ID, {
      argv: ["sleep", "90"],
      timeoutMs: 120_000,
      requestId: REQUEST_ID,
    });

    const reads = api.requests.filter((request) => request.method === "GET");
    expect(reads).toHaveLength(3);
    expect(new Set(reads.map((read) => read.path))).toEqual(
      new Set([`/${COMPUTER_ID}/operations/5e6bc3a4-d725-53b3-bc6d-b63960e5f553`])
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("RevylComputerClient errors", () => {
  it("carries Revyl's refusal code without the computer ID", async () => {
    const { api, client } = setup();
    api.refuseNext({ method: "POST", pathSuffix: "/start", status: 409, detail: "run_conflict" });

    const error = await client.startComputer(COMPUTER_ID, 60).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RevylApiError);
    expect(error).toMatchObject({ status: 409, code: "run_conflict", isTransient: false });
    expect((error as Error).message).toBe(
      "Revyl POST computer-runs/:id/start answered 409 run_conflict"
    );
  });

  it("reads a missing computer as null", async () => {
    const { client } = setup();

    await expect(client.getComputer("00000000-0000-4000-8000-000000000000")).resolves.toBeNull();
  });
});
