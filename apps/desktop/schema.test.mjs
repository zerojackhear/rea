import assert from "node:assert/strict";
import test from "node:test";
import {
  dereference,
  schemaFields,
  fieldType,
  defaultFieldValue,
  readFormArguments,
  formArgumentsToJson,
  readJsonArguments,
} from "./renderer/schema.mjs";
import { modules, classifyTool, moduleForPath } from "./renderer/modules.mjs";

const inputSchema = {
  type: "object",
  required: ["path"],
  properties: {
    enabled: { type: "boolean" },
    path: { $ref: "#/$defs/Path" },
    limit: { type: "integer" },
    payload: { type: "array" },
    label: { type: "string" },
  },
  $defs: {
    Path: {
      type: "string",
      minLength: 1,
      description: "Original source path.",
    },
  },
};

test("form fields resolve local references without modifying the advertised contract", () => {
  const before = JSON.stringify(inputSchema);
  const fields = schemaFields(inputSchema);
  assert.equal(fields[0].key, "path");
  assert.equal(fields[0].required, true);
  assert.equal(fields[0].schema.description, "Original source path.");
  assert.equal(JSON.stringify(inputSchema), before);
});

test("nullable scalar references remain editable while preserving metadata", () => {
  const root = {
    properties: {
      mode: {
        anyOf: [
          { type: "string", enum: ["summary", "complete"] },
          { type: "null" },
        ],
        description: "Choose the requested detail.",
      },
    },
  };
  const [field] = schemaFields(root);
  assert.equal(fieldType(field.schema), "enum");
  assert.deepEqual(field.schema.enum, ["summary", "complete"]);
  assert.equal(field.schema.description, "Choose the requested detail.");
});

test("unresolved and cyclic local references return bounded unknown definitions", () => {
  assert.deepEqual(dereference({ $ref: "#/$defs/missing" }, {}), {
    $ref: "#/$defs/missing",
  });
  const root = { $defs: { self: { $ref: "#/$defs/self" } } };
  assert.equal(dereference(root.$defs.self, root).$ref, "#/$defs/self");
});

test("optional omission remains distinct from explicit false and numeric zero", () => {
  const fields = schemaFields(inputSchema);
  const parsed = readFormArguments(fields, {
    path: "C:\\owned\\target.js",
    enabled: "false",
    limit: "0",
    payload: "[]",
    label: "",
  });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.arguments, {
    path: "C:\\owned\\target.js",
    enabled: false,
    limit: 0,
    payload: [],
  });
  assert.equal(Object.hasOwn(parsed.arguments, "label"), false);
});

test("required missing values are rejected without inventing caller inputs", () => {
  const parsed = readFormArguments(schemaFields(inputSchema), {});
  assert.deepEqual(
    parsed.errors.map((item) => item.key),
    ["path"],
  );
  assert.deepEqual(parsed.arguments, {});
});

test("invalid booleans and nonfinite or fractional integer inputs are rejected", () => {
  const fields = schemaFields(inputSchema);
  for (const limit of ["NaN", "Infinity", "2.5"]) {
    const parsed = readFormArguments(fields, { path: "C:\\owned", limit });
    assert.deepEqual(
      parsed.errors.map((item) => item.key),
      ["limit"],
    );
    assert.equal(Object.hasOwn(parsed.arguments, "limit"), false);
  }
  const parsed = readFormArguments(fields, {
    path: "C:\\owned",
    enabled: "yes",
  });
  assert.deepEqual(
    parsed.errors.map((item) => item.key),
    ["enabled"],
  );
});

test("nested JSON fields preserve objects and arrays and reject malformed JSON", () => {
  const fields = schemaFields(inputSchema);
  const valid = readFormArguments(fields, {
    path: "C:\\owned",
    payload: '[{"name":"owned","value":null},false,0]',
  });
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.arguments.payload, [
    { name: "owned", value: null },
    false,
    0,
  ]);
  const invalid = readFormArguments(fields, {
    path: "C:\\owned",
    payload: "{",
  });
  assert.deepEqual(
    invalid.errors.map((item) => item.key),
    ["payload"],
  );
});

test("defaults are included only when explicitly present in the schema", () => {
  assert.equal(defaultFieldValue({ type: "boolean" }), "");
  assert.equal(defaultFieldValue({ type: "boolean", default: false }), "false");
  assert.equal(defaultFieldValue({ type: "integer", default: 0 }), "0");
  assert.equal(defaultFieldValue({ type: "array", default: [] }), "[]");
  assert.equal(
    defaultFieldValue({ type: "object", default: { mode: "complete" } }),
    '{\n  "mode": "complete"\n}',
  );
});

test("JSON mode accepts only argument objects and preserves null and empty strings", () => {
  for (const value of ["null", "[]", "true", "42", '"text"', "{"]) {
    assert.throws(() => readJsonArguments(value));
  }
  assert.deepEqual(
    readJsonArguments('{"value":null,"label":"","enabled":false,"limit":0}'),
    {
      value: null,
      label: "",
      enabled: false,
      limit: 0,
    },
  );
});

test("caller-selected prototype-like keys remain own values without prototype mutation", () => {
  const raw = readJsonArguments(
    '{"__proto__":{"marker":"source-value"},"constructor":"source-constructor"}',
  );
  assert.ok(Object.hasOwn(raw, "__proto__"));
  assert.deepEqual(raw.__proto__, { marker: "source-value" });
  assert.equal(raw.constructor, "source-constructor");
  assert.equal({}.marker, undefined);
  const fields = schemaFields(
    JSON.parse('{"properties":{"__proto__":{"type":"string"}}}'),
  );
  const parsed = readFormArguments(
    fields,
    JSON.parse('{"__proto__":"caller-value"}'),
  );
  assert.ok(Object.hasOwn(parsed.arguments, "__proto__"));
  assert.equal(parsed.arguments.__proto__, "caller-value");
  assert.equal({}.marker, undefined);
});

test("the fourteen module identities are distinct and route real named capabilities", () => {
  assert.equal(modules.length, 14);
  assert.equal(new Set(modules.map((item) => item.id)).size, 14);
  const cases = [
    ["analyze_javascript_application", "javascript"],
    ["capture_electron_scenario", "electron"],
    ["inspect_managed_artifact", "dotnet"],
    ["inspect_flutter_binary", "mobile"],
    ["inspect_rust_binary", "go-rust"],
    ["inspect_go_binary", "go-rust"],
    ["inspect_wasm_artifact", "wasm-evm"],
    ["inspect_sqlite_database", "sqlite"],
    ["inspect_pcap", "network"],
    ["inspect_web_page", "browser"],
    ["extract_artifact", "firmware"],
    ["list_evidence", "evidence"],
    ["attach_debugger", "runtime"],
    ["get_capabilities", "system"],
    ["decompile_function", "native"],
  ];
  for (const [name, expected] of cases) {
    assert.equal(classifyTool({ name }), expected, name);
  }
});

test("path hints route known formats without executing or reading the selected file", () => {
  const cases = [
    ["D:\\owned\\application.asar", "electron"],
    ["D:\\owned\\index.MJS", "javascript"],
    ["D:\\owned\\target.apk", "mobile"],
    ["D:\\owned\\target.sqlite", "sqlite"],
    ["D:\\owned\\target.wasm", "wasm-evm"],
    ["D:\\owned\\trace.pcapng", "network"],
    ["D:\\owned\\archive.zip", "firmware"],
    ["D:\\owned\\target.exe", "native"],
  ];
  for (const [path, expected] of cases)
    assert.equal(moduleForPath(path), expected, path);
});

test("form-to-JSON conversion preserves an invalid numeric draft instead of returning partial JSON", () => {
  const draft = { path: "C:\\owned", enabled: "false", limit: "2.5" };
  const before = structuredClone(draft);
  const result = formArgumentsToJson(schemaFields(inputSchema), draft);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((item) => item.key),
    ["limit"],
  );
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.deepEqual(draft, before);
});

test("malformed nested JSON is retained verbatim when mode conversion is rejected", () => {
  const draft = { path: "C:\\owned", payload: '{"unfinished":' };
  const result = formArgumentsToJson(schemaFields(inputSchema), draft);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((item) => item.key),
    ["payload"],
  );
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.equal(draft.payload, '{"unfinished":');
});

test("missing required fields prevent mode conversion without serializing a partial object", () => {
  const draft = { enabled: "false", limit: "0" };
  const result = formArgumentsToJson(schemaFields(inputSchema), draft);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((item) => item.key),
    ["path"],
  );
  assert.equal(Object.hasOwn(result, "value"), false);
  assert.deepEqual(draft, { enabled: "false", limit: "0" });
});

test("successful form-to-JSON conversion preserves false, zero, arrays, and omissions", () => {
  const draft = {
    path: "C:\\owned",
    enabled: "false",
    limit: "0",
    payload: "[]",
    label: "",
  };
  const before = structuredClone(draft);
  const result = formArgumentsToJson(schemaFields(inputSchema), draft);
  assert.equal(result.ok, true);
  assert.deepEqual(readJsonArguments(result.value), {
    path: "C:\\owned",
    enabled: false,
    limit: 0,
    payload: [],
  });
  assert.deepEqual(draft, before);
});
