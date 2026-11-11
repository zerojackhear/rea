import { z } from "zod";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const mcpAgentReviewSchema = z
  .enum(["0", "1"])
  .transform((value) => value === "1");

/** Explicit opt-in; a misspelled value must never silently enable a workflow. */
export const parseMcpAgentReview = (
  value: string | undefined,
): Result<boolean, ConfigurationError> => {
  const parsed = mcpAgentReviewSchema.safeParse(value ?? "0");
  if (parsed.success) return ok(parsed.data);
  const constraint =
    "REA_MCP_REVIEW_AFTER_ANALYSIS must be 0 (off) or 1 (report findings and wait for the user).";
  return err(
    new ConfigurationError(constraint, {
      settings: [{ setting: "REA_MCP_REVIEW_AFTER_ANALYSIS", constraint }],
    }),
  );
};
