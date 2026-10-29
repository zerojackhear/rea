import assert from "node:assert/strict";
import test from "node:test";
import { ToolDraftStore } from "./renderer/drafts.mjs";
import {
  jsonArgumentsToForm,
  schemaFields,
  readFormArguments,
} from "./renderer/schema.mjs";

const tool = {
  name: "own_tool",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      detail: {
        type: "string",
        enum: ["summary", "complete"],
        default: "summary",
      },
      enabled: { type: "boolean" },
      limit: { type: "integer" },
      payload: { type: "object" },
    },
  },
};
const other = { ...tool, name: "other_tool" };
const path = "C:\\owned 中文\\literal %2e%2e\\target.js";

test("module and tool navigation reuse the active JSON owner without reapplying defaults", () => {
  const store = new ToolDraftStore();
  store.get(tool, path);
  assert.equal(store.switchMode(tool, "json").ok, true);
  const raw = '{\n  "path": ' + JSON.stringify(path) + ',\n  "limit": 129\n}';
  store.setJson(tool, raw);
  store.get(other, "C:\\other");
  const returned = store.get(tool, "C:\\unrelated-new-selection");
  assert.equal(returned.mode, "json");
  assert.equal(returned.json, raw);
  assert.deepEqual(store.readArguments(tool), {
    ok: true,
    arguments: { path, limit: 129 },
  });
  assert.equal(
    Object.hasOwn(store.readArguments(tool).arguments, "detail"),
    false,
  );
});

test("incomplete JSON survives tool navigation, failed reads, and rejected mode conversion byte for byte", () => {
  const store = new ToolDraftStore();
  store.replaceArguments(tool, { path });
  const raw = ' { "path": "unfinished", "payload": { ';
  store.setJson(tool, raw);
  store.get(other);
  assert.equal(store.readArguments(tool).ok, false);
  assert.equal(store.switchMode(tool, "fields").ok, false);
  assert.equal(store.get(tool).mode, "json");
  assert.equal(store.get(tool).json, raw);
});

test("field drafts preserve original path, false and zero over navigation and both mode conversions", () => {
  const store = new ToolDraftStore();
  store.get(tool, path);
  store.setField(tool, "enabled", "false");
  store.setField(tool, "limit", "0");
  store.get(other);
  assert.equal(store.get(tool).mode, "fields");
  assert.equal(store.get(tool).values.path, path);
  assert.equal(store.switchMode(tool, "json").ok, true);
  assert.deepEqual(store.readArguments(tool).arguments, {
    path,
    detail: "summary",
    enabled: false,
    limit: 0,
  });
  assert.equal(store.switchMode(tool, "fields").ok, true);
  assert.equal(store.get(tool).values.enabled, "false");
  assert.equal(store.get(tool).values.limit, "0");
});

test("JSON scalar type mismatches never coerce values or partially replace a field draft", () => {
  const store = new ToolDraftStore();
  store.get(tool, path);
  const before = structuredClone(store.get(tool).values);
  for (const value of [42, true, {}, [], null, ""]) {
    const args = { path: value, limit: 0 };
    store.replaceArguments(tool, args);
    const raw = store.get(tool).json;
    const converted = store.switchMode(tool, "fields");
    assert.equal(converted.ok, false, JSON.stringify(value));
    assert.equal(store.get(tool).mode, "json");
    assert.equal(store.get(tool).json, raw);
    assert.deepEqual(store.get(tool).values, before);
    assert.deepEqual(store.readArguments(tool).arguments, args);
  }
});

test("unknown fields and invalid enums remain in JSON rather than being discarded by the form", () => {
  const store = new ToolDraftStore();
  for (const args of [
    { path, future_option: 0 },
    { path, detail: "future-mode" },
  ]) {
    store.replaceArguments(tool, args);
    assert.equal(store.switchMode(tool, "fields").ok, false);
    assert.deepEqual(store.readArguments(tool).arguments, args);
  }
});

test("invalid form conversion preserves the active fields and earlier JSON representation", () => {
  const store = new ToolDraftStore();
  const initial = store.get(tool, path).json;
  store.setField(tool, "limit", "1.25");
  assert.equal(store.switchMode(tool, "json").ok, false);
  assert.equal(store.get(tool).mode, "fields");
  assert.equal(store.get(tool).values.limit, "1.25");
  assert.equal(store.get(tool).json, initial);
});

test("an explicit new path updates only that caller-selected field in JSON", () => {
  const store = new ToolDraftStore();
  const args = JSON.parse(
    '{"path":"C:\\\\before","enabled":false,"limit":0,"payload":null,"__proto__":{"literal":true}}',
  );
  store.replaceArguments(tool, args);
  assert.equal(store.applyPath(tool, path).ok, true);
  const updated = store.readArguments(tool).arguments;
  assert.equal(updated.path, path);
  assert.equal(updated.enabled, false);
  assert.equal(updated.limit, 0);
  assert.equal(updated.payload, null);
  assert.ok(Object.hasOwn(updated, "__proto__"));
  assert.deepEqual(updated.__proto__, { literal: true });
  assert.equal({}.literal, undefined);
});

test("an explicit path choice never overwrites an incomplete JSON draft", () => {
  const store = new ToolDraftStore();
  store.replaceArguments(tool, { path });
  const raw = '{"path": "C:\\\\before", "payload":';
  store.setJson(tool, raw);
  assert.equal(store.applyPath(tool, "C:\\new").ok, false);
  assert.equal(store.get(tool).json, raw);
  assert.equal(store.get(tool).mode, "json");
});

test("valid JSON-to-form conversion retains false, zero and JSON-field null", () => {
  const args = { path, enabled: false, limit: 0, payload: null };
  const converted = jsonArgumentsToForm(
    schemaFields(tool.inputSchema),
    JSON.stringify(args),
  );
  assert.equal(converted.ok, true);
  assert.deepEqual(
    readFormArguments(schemaFields(tool.inputSchema), converted.value)
      .arguments,
    args,
  );
});

test("JSON scalar strings are never coerced into numeric or boolean fields", () => {
  for (const args of [
    { path, enabled: "false" },
    { path, limit: "0" },
    { path, limit: false },
    { path, limit: -0 },
  ]) {
    assert.equal(
      jsonArgumentsToForm(
        schemaFields(tool.inputSchema),
        JSON.stringify(args).replace(
          '"limit":0',
          Object.is(args.limit, -0) ? '"limit":-0' : '"limit":0',
        ),
      ).ok,
      false,
    );
  }
});

test("prototype-like named fields remain own values in lossless form conversion", () => {
  const schema = JSON.parse(
    '{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}',
  );
  const values = JSON.parse(
    '{"__proto__":"source-value","constructor":"source-constructor"}',
  );
  const result = jsonArgumentsToForm(
    schemaFields(schema),
    JSON.stringify(values),
  );
  assert.equal(result.ok, true);
  assert.ok(Object.hasOwn(result.value, "__proto__"));
  assert.equal(result.value.__proto__, "source-value");
  assert.equal(result.value.constructor, "source-constructor");
  assert.equal({}.literal, undefined);
});
