import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { z } from "zod";
import type {
  artifactCommandLimiterSchema,
  artifactCommandLimitsSchema,
} from "../domain/artifactCommandLimits.js";
import { AnalysisArtifactChangedError } from "../domain/analysisErrorCore.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import type { ArtifactAnalysisResources } from "./ArtifactAnalysisResources.js";
import {
  prlimitArgumentVector,
  type LinuxResourceLimits,
} from "./LinuxResourceLimits.js";

type CommandLimits = LinuxResourceLimits & {
  input_bytes: number;
  output_bytes: number;
  command_timeout_ms: number;
};
interface ArtifactCommandBound {
  /** Owned identity checked after execution; absent for kernel Job Objects. */
  readonly verificationPath: string | undefined;
  readonly linuxLimits: LinuxResourceLimits | undefined;
  readonly metadata: {
    resource_limiter: z.output<typeof artifactCommandLimiterSchema>;
    limits: z.output<typeof artifactCommandLimitsSchema>;
  };
  readonly limitation: string;
  invocation(args: readonly string[]): {
    command: string;
    arguments: readonly string[];
    memoryLimitBytes?: number;
  };
  verify(capturedOutput: AnalysisCapturedOutput | undefined): Promise<void>;
}

/** Refuse unsupported hosts before resolving or reading caller executables. */
export function artifactCommandHost(
  platform: NodeJS.Platform,
): "linux" | "win32" {
  if (platform !== "linux" && platform !== "win32")
    throw new Error(
      "Offline native analysis requires Linux prlimit or Windows owned Job Objects.",
    );
  return platform;
}

/** Own native limit admission, execution and evidence for offline artifact tools. */
export async function prepareArtifactCommandBound(options: {
  platform: "linux" | "win32";
  environment: Readonly<NodeJS.ProcessEnv>;
  limiterVariable: string;
  command: string;
  operation: string;
  resources: ArtifactAnalysisResources;
  limits: CommandLimits;
  signal?: AbortSignal;
}): Promise<ArtifactCommandBound> {
  const { platform, command, operation, limits, resources } = options;
  if (platform === "win32") {
    return {
      verificationPath: undefined,
      linuxLimits: undefined,
      metadata: {
        resource_limiter: {
          kind: "windows-job-object",
          scope: "owned-process-tree",
          memory_limit_bytes: limits.address_space_bytes,
        },
        limits: {
          input_bytes: limits.input_bytes,
          output_bytes: limits.output_bytes,
          command_timeout_ms: limits.command_timeout_ms,
          address_space_bytes: null,
          file_bytes: null,
          cpu_seconds: null,
          job_memory_bytes: limits.address_space_bytes,
        },
      },
      limitation:
        "Windows uses an owned Job Object with a 1 GiB committed-memory limit for the entire tool process tree, bounded input/output and a 30-second wall-clock deadline. It does not impose Linux address-space, per-file or CPU-time limits, or provide a filesystem/network sandbox. Caller-supplied tools and their libraries remain trusted.",
      invocation: (args) => ({
        command,
        arguments: args,
        memoryLimitBytes: limits.address_space_bytes,
      }),
      verify: async () => {},
    };
  }
  const configured =
    options.environment[options.limiterVariable] ?? "/usr/bin/prlimit";
  if (!isAbsolute(configured))
    throw new Error(options.limiterVariable + " must be absolute.");
  const limiter = await realpath(configured);
  await access(limiter, constants.X_OK);
  const identity = await resources.read(
    limiter,
    64 * 1024 * 1024,
    options.signal,
  );
  const effective = await resources.readLimits(limits);
  const prefix = prlimitArgumentVector(effective, command);
  return {
    verificationPath: limiter,
    linuxLimits: effective,
    metadata: {
      resource_limiter: {
        configured_path: configured,
        path: limiter,
        sha256: identity.sha256,
        arguments: prefix,
      },
      limits: { ...limits, ...effective },
    },
    limitation:
      "Linux prlimit enforces soft and hard ceilings before execution, preserving stricter inherited limits: at most 1 GiB address space per process, 64 MiB per file, 30 CPU seconds and no core dumps. Effective limits are reported. Input, output and wall-clock budgets also apply. These are per-process/per-file limits, not aggregate memory or filesystem quotas; caller-supplied tools and the limiter are trusted.",
    invocation: (args) => ({
      command: limiter,
      arguments: [...prefix, ...args],
    }),
    async verify(capturedOutput) {
      const current = await resources.read(limiter, 64 * 1024 * 1024);
      if (current.sha256 !== identity.sha256)
        throw new AnalysisArtifactChangedError(
          operation,
          limiter,
          "Configured resource limiter changed during analysis.",
          { capturedOutput },
        );
    },
  };
}
