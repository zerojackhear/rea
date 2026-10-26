export function dereference(schema, root) {
  if (!schema || typeof schema !== "object") return {};
  let current = schema;
  const seen = new Set();
  while (typeof current.$ref === "string" && current.$ref.startsWith("#/")) {
    if (seen.has(current.$ref)) break;
    seen.add(current.$ref);
    const parts = current.$ref
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    let target = root;
    for (const part of parts)
      target = target && typeof target === "object" ? target[part] : undefined;
    if (!target || typeof target !== "object") break;
    current = {
      ...target,
      ...Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== "$ref"),
      ),
    };
  }
  const branches = current.anyOf ?? current.oneOf;
  if (Array.isArray(branches)) {
    const nonNull = branches.filter((item) => item.type !== "null");
    if (nonNull.length === 1)
      current = {
        ...dereference(nonNull[0], root),
        ...Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => key !== "anyOf" && key !== "oneOf",
          ),
        ),
      };
  }
  return current;
}

export function schemaFields(inputSchema) {
  const schema = dereference(inputSchema ?? {}, inputSchema ?? {});
  const properties = schema.properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  return Object.entries(properties)
    .map(([key, value]) => ({
      key,
      schema: dereference(value, inputSchema),
      required: required.has(key),
    }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

export function fieldType(schema) {
  const types = Array.isArray(schema.type)
    ? schema.type.filter((type) => type !== "null")
    : [schema.type];
  if (types.length !== 1) return "json";
  if (schema.enum && schema.enum.every((value) => typeof value === "string"))
    return "enum";
  return ["string", "boolean", "number", "integer"].includes(types[0])
    ? types[0]
    : "json";
}

export function defaultFieldValue(schema) {
  if (!Object.hasOwn(schema, "default")) return "";
  const type = fieldType(schema);
  return type === "json"
    ? JSON.stringify(schema.default, null, 2)
    : String(schema.default);
}

export function readFormArguments(fields, values) {
  const entries = [];
  const errors = [];
  for (const field of fields) {
    const raw = values[field.key] ?? "";
    if (raw === "") {
      if (field.required)
        errors.push({
          key: field.key,
          message:
            "请填写此必填参数；需要传递空字符串或 null 时，请使用 JSON 模式。",
        });
      continue;
    }
    let value = raw;
    const type = fieldType(field.schema);
    if (type === "boolean") {
      if (raw !== "true" && raw !== "false") {
        errors.push({ key: field.key, message: "请选择“是”或“否”。" });
        continue;
      }
      value = raw === "true";
    } else if (type === "number" || type === "integer") {
      value = Number(raw);
      if (
        !Number.isFinite(value) ||
        (type === "integer" && !Number.isInteger(value))
      ) {
        errors.push({
          key: field.key,
          message: type === "integer" ? "请输入有效整数。" : "请输入有效数值。",
        });
        continue;
      }
    } else if (type === "json") {
      try {
        value = JSON.parse(raw);
      } catch {
        errors.push({
          key: field.key,
          message: "请输入有效 JSON；字符串需要双引号，数组使用方括号。",
        });
        continue;
      }
    }
    entries.push([field.key, value]);
  }
  return { arguments: Object.fromEntries(entries), errors };
}

export function readJsonArguments(raw) {
  const value = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("工具参数必须是一个 JSON 对象。");
  return value;
}

/** Convert the complete draft atomically; invalid fields must never disappear. */
export function formArgumentsToJson(fields, values) {
  const result = readFormArguments(fields, values);
  if (result.errors.length) return { ok: false, errors: result.errors };
  return { ok: true, value: JSON.stringify(result.arguments, null, 2) };
}
