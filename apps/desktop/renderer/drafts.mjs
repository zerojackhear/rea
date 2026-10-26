import {
  schemaFields,
  fieldType,
  defaultFieldValue,
  readFormArguments,
  readJsonArguments,
  formArgumentsToJson,
  jsonArgumentsToForm,
} from "./schema.mjs";

const PATH_FIELD =
  /^(path|target_path|file_path|binary_path|artifact_path|application_path|application_root|database_path|input_path|root|directory)$/;

/** One owner per tool retains the active representation across every navigation. */
export class ToolDraftStore {
  #drafts = new Map();

  get(tool, selectedPath = "") {
    if (!this.#drafts.has(tool.name)) {
      const definitions = schemaFields(tool.inputSchema);
      const values = Object.fromEntries(
        definitions.map((field) => [
          field.key,
          defaultFieldValue(field.schema),
        ]),
      );
      const pathField = this.#pathField(definitions);
      if (selectedPath && pathField) values[pathField.key] = selectedPath;
      const initial = readFormArguments(definitions, values);
      this.#drafts.set(tool.name, {
        definitions,
        values,
        mode: definitions.length ? "fields" : "json",
        json: JSON.stringify(initial.arguments, null, 2),
      });
    }
    return this.#drafts.get(tool.name);
  }

  setField(tool, key, value) {
    const draft = this.get(tool);
    if (!draft.definitions.some((field) => field.key === key))
      throw new Error("Unknown draft field: " + key);
    Object.defineProperty(draft.values, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  setJson(tool, raw) {
    this.get(tool).json = raw;
  }

  replaceArguments(tool, args) {
    const draft = this.get(tool);
    draft.json = JSON.stringify(args, null, 2);
    draft.mode = "json";
  }

  switchMode(tool, mode) {
    const draft = this.get(tool);
    if (mode === draft.mode) return { ok: true };
    if (mode === "json") {
      const converted = formArgumentsToJson(draft.definitions, draft.values);
      if (!converted.ok) return converted;
      draft.json = converted.value;
    } else if (mode === "fields") {
      if (!draft.definitions.length)
        return {
          ok: false,
          errors: [{ message: "此工具使用 JSON 参数，请保留 JSON 模式。" }],
        };
      const converted = jsonArgumentsToForm(draft.definitions, draft.json);
      if (!converted.ok) return converted;
      draft.values = converted.value;
    } else throw new Error("Unknown draft mode");
    draft.mode = mode;
    return { ok: true };
  }

  readArguments(tool) {
    const draft = this.get(tool);
    if (draft.mode === "json") {
      try {
        return { ok: true, arguments: readJsonArguments(draft.json) };
      } catch (error) {
        return { ok: false, errors: [{ message: error.message }] };
      }
    }
    const result = readFormArguments(draft.definitions, draft.values);
    return result.errors.length
      ? { ok: false, errors: result.errors }
      : { ok: true, arguments: result.arguments };
  }

  applyPath(tool, path) {
    const draft = this.get(tool);
    const field = this.#pathField(draft.definitions);
    if (!field)
      return {
        ok: false,
        message: "该工具没有可自动填写的路径字段，请手动填写参数。",
      };
    if (draft.mode === "json") {
      let args;
      try {
        args = readJsonArguments(draft.json);
      } catch {
        return {
          ok: false,
          message: "JSON 草稿尚未完成，已保留原文；请修正后再选择目标路径。",
        };
      }
      Object.defineProperty(args, field.key, {
        value: path,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      draft.json = JSON.stringify(args, null, 2);
    } else this.setField(tool, field.key, path);
    return { ok: true };
  }

  #pathField(definitions) {
    return definitions.find(
      (field) =>
        PATH_FIELD.test(field.key) && fieldType(field.schema) === "string",
    );
  }
}
