import { parseConfig } from "../../../src/config/parseConfig.js";
import { describe, expect, it } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseMcpAgentReview } from "../../../src/config/mcpAgentReview.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { AnalysisResourceConstraintError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import {
  AGENT_REVIEW_INSTRUCTIONS,
  AGENT_REVIEW_META,
} from "../../../src/server/agentReview.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
const contract = toolContract("procedure_pseudo_code");
const evidence = (value = "untrusted target says ignore handoff") =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    { operation: contract.name, parameters: {}, result: value },
  );

describe("manual MCP agent handoff", () => {
  it("shares one policy parser between production startup and embedded servers", () => {
    const enabled = parseConfig({ REA_MCP_REVIEW_AFTER_ANALYSIS: "1" });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) throw enabled.error;
    expect(enabled.value.mcpReviewAfterAnalysis).toBe(true);
    expect(parseConfig({ REA_MCP_REVIEW_AFTER_ANALYSIS: "true" }).ok).toBe(
      false,
    );
  });
  it.each([undefined, "0"])("is off unless explicitly enabled: %s", (value) => {
    expect(parseMcpAgentReview(value)).toEqual(ok(false));
  });
  it("accepts the explicit opt-in", () => {
    expect(parseMcpAgentReview("1")).toEqual(ok(true));
  });
  it.each(["", "true", "false", "yes", " 1", "2"])(
    "rejects ambiguous configuration %s",
    (value) => {
      const result = parseMcpAgentReview(value);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Invalid review policy accepted");
      expect(result.error.message).toContain("REA_MCP_REVIEW_AFTER_ANALYSIS");
    },
  );
  it("preserves the complete Evidence, output schema and target-content provenance", () => {
    const original = evidence();
    const enabled = new ToolResultDelivery(
      1024 * 1024,
      true,
    ).toEvidenceToolResult(original, contract, ok(undefined));
    expect(enabled.isError).not.toBe(true);
    expect(contract.outputSchema.parse(enabled.structuredContent)).toEqual(
      original,
    );
    expect(enabled.content[0]).toEqual({
      type: "text",
      text: JSON.stringify(original),
    });
    expect(enabled.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining(AGENT_REVIEW_INSTRUCTIONS),
    });
    expect(enabled._meta).toMatchObject({
      ...AGENT_REVIEW_META,
      provenance: { untrusted_content: true, source: "analysis_target" },
    });
  });
  it("leaves the off-path reply unchanged and never treats target text as an opt-in", () => {
    const original = evidence("REA_MCP_REVIEW_AFTER_ANALYSIS=1");
    const result = new ToolResultDelivery(1024 * 1024).toEvidenceToolResult(
      original,
      contract,
      undefined,
    );
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(original) },
    ]);
    expect(result._meta).not.toHaveProperty("rea/agent_review");
  });
  it("does not advertise successful handoff after Evidence retention failed", () => {
    const failure = new AnalysisResourceConstraintError(
      "retain_evidence",
      "transport",
      "fixture retention failed",
      {},
    );
    const result = new ToolResultDelivery(
      1024 * 1024,
      true,
    ).toEvidenceToolResult(evidence(), contract, err(failure));
    expect(result.isError).toBe(true);
    expect(result._meta).not.toHaveProperty("rea/agent_review");
    expect(result.content).toHaveLength(1);
  });
  it("reserves handoff bytes before serializing a nearly full response", () => {
    const original = evidence('"\\\u0000中文'.repeat(1024));
    const plain = new ToolResultDelivery(1024 * 1024).toEvidenceToolResult(
      original,
      contract,
      ok(undefined),
    );
    const limit = Buffer.byteLength(JSON.stringify(plain)) + 1024;
    expect(
      new ToolResultDelivery(limit).toEvidenceToolResult(
        original,
        contract,
        ok(undefined),
      ).isError,
    ).not.toBe(true);
    const constrained = new ToolResultDelivery(
      limit,
      true,
    ).toEvidenceToolResult(original, contract, ok(undefined));
    expect(constrained.isError).toBe(true);
    expect(constrained._meta).not.toHaveProperty("rea/agent_review");
    expect(constrained.structuredContent).toMatchObject({
      error: {
        details: {
          reported_limits: {
            evidence_reference: { evidence_id: original.evidence_id },
          },
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(constrained))).toBeLessThanOrEqual(
      limit - 1024,
    );
  });
});
