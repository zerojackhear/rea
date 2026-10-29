import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRemoteServer } from "./server.mjs";
import { ACTIONS, digest, MAX_FILE } from "./protocol.mjs";

const tlsRoot = process.env.REA_ANDROID_TEST_TLS;
if (!tlsRoot)
  throw new Error(
    "Set REA_ANDROID_TEST_TLS to an isolated setup.mjs output directory.",
  );
const token = randomBytes(32).toString("hex"),
  other = randomBytes(32).toString("hex");
const devices = [
  { id: randomUUID(), tokenHash: digest(token) },
  { id: randomUUID(), tokenHash: digest(other) },
];
let service,
  origin,
  root,
  ca,
  submissions = 0,
  failNext = false,
  large = false;
const owned = new Map();
function bridgeFactory({ dataDir }) {
  if (!owned.has(dataDir)) owned.set(dataDir, []);
  const jobs = owned.get(dataDir);
  return {
    state: () => ({ connection: "ready" }),
    async request(method, payload) {
      if (method === "tools")
        return Object.values(ACTIONS).map((a) => ({ name: a.tool }));
      if (method === "history") return jobs;
      if (method === "submit") {
        submissions++;
        if (failNext) {
          failNext = false;
          throw new Error("fixture transport failed after intent");
        }
        const job = { id: randomUUID(), state: "queued", ...payload };
        jobs.push(job);
        return job;
      }
      if (method === "cancel")
        return {
          id: payload.id,
          state: "cancelled",
          serverSettlement: "unconfirmed",
        };
      if (method === "result")
        return {
          task: { id: payload.id },
          result: {
            kind: "observation",
            coverage: "partial",
            unknown: null,
            evidence_id: "fixture-evidence",
            ...(large ? { text: "x".repeat(17 * 1024 * 1024) } : {}),
          },
        };
    },
    close: async () => ({ closed: true, cleanupUnknown: false }),
  };
}
async function start() {
  const config = JSON.parse(
    await readFile(join(tlsRoot, "server.json"), "utf8"),
  );
  service = await createRemoteServer({
    root,
    config: { ...config, devices },
    tls: {
      pfx: await readFile(join(tlsRoot, "server.p12")),
      passphrase: config.tlsPassword,
    },
    bridgeFactory,
  });
  await new Promise((resolve) =>
    service.server.listen(0, "127.0.0.1", resolve),
  );
  origin = `https://127.0.0.1:${service.server.address().port}`;
}
before(async () => {
  await mkdir(".cache/android-tests", { recursive: true });
  root = await mkdtemp(resolve(".cache/android-tests/server-"));
  ca = new X509Certificate(
    await readFile(join(tlsRoot, "server.cer")),
  ).toString();
  await start();
});
after(async () => {
  await service.close();
});
function call(method, path, data, headers = {}, deviceToken = token) {
  const bytes = Buffer.isBuffer(data)
    ? data
    : data === undefined
      ? undefined
      : Buffer.from(JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const req = https.request(
      origin + path,
      {
        method,
        ca,
        checkServerIdentity: (_host, cert) =>
          new X509Certificate(cert.raw).fingerprint256 ===
          new X509Certificate(ca).fingerprint256
            ? undefined
            : new Error("bad certificate"),
        headers: {
          ...(deviceToken ? { authorization: "Bearer " + deviceToken } : {}),
          ...(bytes
            ? {
                "content-length": bytes.length,
                "content-type": Buffer.isBuffer(data)
                  ? "application/octet-stream"
                  : "application/json",
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            value: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}
async function upload(
  name = "hello.js",
  content = "export const answer=42;",
  deviceToken = token,
) {
  const b = Buffer.from(content);
  return call(
    "POST",
    "/v1/files",
    b,
    { "x-file-name": encodeURIComponent(name), "x-sha256": digest(b) },
    deviceToken,
  );
}
test("authentication, browser origin and undocumented methods fail closed", async () => {
  assert.equal(
    (await call("GET", "/v1/state", undefined, {}, null)).status,
    401,
  );
  assert.equal(
    (await call("GET", "/v1/state", undefined, {}, "0".repeat(64))).status,
    401,
  );
  assert.equal(
    (
      await call("GET", "/v1/state", undefined, {
        origin: "https://evil.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("POST", "/mcp", { method: "execute_command" })).status,
    404,
  );
  const state = await call("GET", "/v1/state");
  assert.equal(state.status, 200);
  assert.equal(state.value.actions.length, 8);
});
test("uploads preserve exact bytes, names, hashes and cannot collide with metadata", async () => {
  const value = await upload("metadata.json", '{"observation":"原始值"}');
  assert.equal(value.status, 201);
  assert.equal(
    await readFile(
      join(
        root,
        "devices",
        devices[0].id,
        "uploads",
        value.value.id,
        "artifact",
        "metadata.json",
      ),
      "utf8",
    ),
    '{"observation":"原始值"}',
  );
  assert.equal(value.value.sha256, digest('{"observation":"原始值"}'));
});
test("traversal, Windows device paths, wrong hashes and oversized uploads are rejected", async () => {
  for (const name of ["../x.js", "C:\\secret.js", "CON.js", "trailing."])
    assert.equal((await upload(name)).status, 400);
  assert.equal(
    (
      await call("POST", "/v1/files", Buffer.from("x"), {
        "x-file-name": "a.js",
        "x-sha256": "0".repeat(64),
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await call("POST", "/v1/files", Buffer.from("x"), {
        "content-length": MAX_FILE + 1,
        "x-file-name": "a.js",
        "x-sha256": digest("x"),
      })
    ).status,
    413,
  );
});
test("arbitrary tools, extra paths and foreign file identities never reach MCP", async () => {
  const f = (await upload()).value;
  const before = submissions;
  const base = { action: "javascript", fileId: f.id, requestId: randomUUID() };
  assert.equal(
    (await call("POST", "/v1/jobs", { ...base, path: "C:\\private" })).status,
    400,
  );
  assert.equal(
    (await call("POST", "/v1/jobs", { ...base, action: "execute_command" }))
      .status,
    400,
  );
  assert.equal((await call("POST", "/v1/jobs", base, {}, other)).status, 404);
  assert.equal(submissions, before);
});
test("same-size changes to owned input fail integrity verification", async () => {
  const f = (await upload("same.js", "first")).value;
  await writeFile(
    join(
      root,
      "devices",
      devices[0].id,
      "uploads",
      f.id,
      "artifact",
      "same.js",
    ),
    "other",
  );
  assert.equal(
    (
      await call("POST", "/v1/jobs", {
        action: "javascript",
        fileId: f.id,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
});
test("concurrent retry and service restart dispatch a request only once", async () => {
  const f = (await upload()).value,
    input = { action: "javascript", fileId: f.id, requestId: randomUUID() },
    before = submissions;
  const results = await Promise.all([
    call("POST", "/v1/jobs", input),
    call("POST", "/v1/jobs", input),
  ]);
  assert.equal(results[0].status, 202);
  assert.equal(results[1].value.id, results[0].value.id);
  assert.equal(submissions, before + 1);
  assert.equal(
    (await call("POST", "/v1/jobs", { ...input, action: "rust" })).status,
    409,
  );
  await service.close();
  await start();
  assert.equal(
    (await call("POST", "/v1/jobs", input)).value.id,
    results[0].value.id,
  );
  assert.equal(submissions, before + 1);
  assert.equal(
    (
      await call(
        "GET",
        `/v1/jobs/${results[0].value.id}/result`,
        undefined,
        {},
        other,
      )
    ).status,
    404,
  );
});
test("ambiguous dispatch remains unknown and is not silently retried", async () => {
  const f = (await upload()).value,
    input = { action: "javascript", fileId: f.id, requestId: randomUUID() },
    before = submissions;
  failNext = true;
  assert.equal((await call("POST", "/v1/jobs", input)).status, 500);
  assert.equal((await call("POST", "/v1/jobs", input)).status, 409);
  assert.equal(submissions, before + 1);
});
test("result provenance, partial and unknown cancellation are preserved", async () => {
  const f = (await upload()).value;
  const job = (
    await call("POST", "/v1/jobs", {
      action: "javascript",
      fileId: f.id,
      requestId: randomUUID(),
    })
  ).value;
  const result = await call("GET", `/v1/jobs/${job.id}/result`);
  assert.equal(result.value.result.evidence_id, "fixture-evidence");
  assert.equal(result.value.result.coverage, "partial");
  assert.equal(result.value.result.unknown, null);
  const cancel = await call("POST", `/v1/jobs/${job.id}/cancel`, {});
  assert.equal(cancel.value.serverSettlement, "unconfirmed");
  large = true;
  assert.equal((await call("GET", `/v1/jobs/${job.id}/result`)).status, 413);
  large = false;
});
