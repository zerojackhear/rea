import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { EngineBridge, canAcknowledgeUnknownClose } from "./bridge.mjs";

async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "rea-desktop-bridge-"));
  const script = join(directory, "fixture.mjs");
  await writeFile(script, source);
  const bridge = new EngineBridge({
    node: process.execPath,
    engine: script,
    coreRoot: directory,
    dataDir: directory,
  });
  t.after(async () => {
    const receipt = await bridge.close();
    assert.equal(
      receipt.closed,
      true,
      "The test-owned sidecar must be physically closed before fixture removal.",
    );
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("rea-desktop-bridge-"));
    await rm(target, { recursive: true, force: true });
  });
  return bridge;
}
async function until(read, accept) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (accept(value)) return value;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  }
  throw Error("The owned sidecar did not reach the expected state.");
}

test("clean shutdown waits for actual sidecar close and remains clean on retry", async (t) => {
  const bridge = await fixture(
    t,
    [
      "process.on('message', m=>{if(m.method==='close')process.send({id:m.id,ok:true,value:{closed:true,cleanupUnknown:false,process:{closeObserved:true,exitCode:0,signal:null}}},()=>process.disconnect());});",
    ].join("\n"),
  );
  const result = await bridge.close();
  assert.equal(result.closed, true);
  assert.equal(result.cleanupUnknown, false);
  assert.deepEqual(result.sidecar, {
    closeObserved: true,
    exitCode: 0,
    signal: null,
  });
  assert.equal(canAcknowledgeUnknownClose(result), false);
  assert.deepEqual(await bridge.close(), result);
});

test("a physically exited sidecar retains unknown cleanup but permits explicit acknowledgement", async (t) => {
  const bridge = await fixture(t, "process.exit(2);\n");
  await until(
    () => bridge.state(),
    (state) => state.connection === "error",
  );
  const result = await bridge.close();
  assert.equal(result.closed, true);
  assert.equal(result.cleanupUnknown, true);
  assert.equal(result.sidecar.exitCode, 2);
  assert.equal(canAcknowledgeUnknownClose(result), true);
  const acknowledged = await bridge.acknowledgeUnknownClose();
  assert.equal(acknowledged.closed, true);
  assert.equal(acknowledged.cleanupUnknown, true);
  assert.equal(acknowledged.userAcknowledged, true);
});

test("live owners or unsaved results cannot be acknowledged away", async (t) => {
  const bridge = await fixture(
    t,
    [
      "let count=0;process.on('message',m=>{if(m.method!=='close')return; count++;",
      "const value=count===1?{closed:false,cleanupUnknown:true,message:'result still in memory'}:{closed:true,cleanupUnknown:false};",
      "process.send({id:m.id,ok:true,value},()=>{if(count>1)process.disconnect();});});",
    ].join("\n"),
  );
  const pending = await bridge.close();
  assert.equal(pending.closed, false);
  assert.equal(canAcknowledgeUnknownClose(pending), false);
  await assert.rejects(
    () => bridge.acknowledgeUnknownClose(),
    /活动资源|未保存/,
  );
  assert.equal((await bridge.close()).cleanupUnknown, false);
  assert.equal(
    canAcknowledgeUnknownClose({
      closed: false,
      cleanupUnknown: true,
      process: { closeObserved: true },
    }),
    false,
  );
});

test("a lower-level MCP close cannot authorize abandoning a live sidecar", async (t) => {
  const bridge = await fixture(
    t,
    [
      "let count=0;process.on('message',m=>{if(m.method!=='close')return;count++;",
      "const value=count===1?{closed:true,cleanupUnknown:true,process:{closeObserved:true,exitCode:1,signal:null}}:{closed:true,cleanupUnknown:false};",
      "process.send({id:m.id,ok:true,value},()=>{if(count>1)process.disconnect();});});",
    ].join("\n"),
  );
  const result = await bridge.close();
  assert.equal(result.cleanupUnknown, true);
  assert.equal(canAcknowledgeUnknownClose(result), false);
  await assert.rejects(
    () => bridge.acknowledgeUnknownClose(),
    /活动资源|未保存/,
  );
  assert.equal((await bridge.close()).cleanupUnknown, false);
});

test("the sidecar rechecks settled resources and owns acknowledged IPC closure", async (t) => {
  const bridge = await fixture(
    t,
    [
      "process.on('message',m=>{if(m.method==='close')process.send({id:m.id,ok:true,value:{closed:true,cleanupUnknown:true,desktopOwner:{acknowledgementRequired:true,resourcesSettled:true}}});",
      "else if(m.method==='acknowledge-close'){if(m.payload.acceptUnknownCleanup!==true)throw Error('missing user decision');process.send({id:m.id,ok:true,value:{accepted:true,cleanupUnknown:true}},()=>process.disconnect());}});",
    ].join("\n"),
  );
  const result = await bridge.close();
  assert.equal(canAcknowledgeUnknownClose(result), true);
  const accepted = await bridge.acknowledgeUnknownClose();
  assert.equal(accepted.closed, true);
  assert.equal(accepted.cleanupUnknown, true);
  assert.equal(accepted.sidecar.closeObserved, true);
});
