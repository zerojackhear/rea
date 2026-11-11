import { z } from "zod";

/** Report the boundary actually used; a Job Object is not a prlimit executable. */
export const artifactCommandLimiterSchema = z.union([
  z.strictObject({
    configured_path: z.string(),
    path: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    arguments: z.array(z.string()),
  }),
  z.strictObject({
    kind: z.literal("windows-job-object"),
    scope: z.literal("owned-process-tree"),
    memory_limit_bytes: z.number().int().positive(),
  }),
]);

/** Null means this OS boundary does not impose that Linux-style resource limit. */
export const artifactCommandLimitsSchema = z.strictObject({
  input_bytes: z.number().int().positive(),
  output_bytes: z.number().int().positive(),
  command_timeout_ms: z.number().int().positive(),
  address_space_bytes: z.number().int().nonnegative().nullable(),
  file_bytes: z.number().int().nonnegative().nullable(),
  cpu_seconds: z.number().int().nonnegative().nullable(),
  job_memory_bytes: z.number().int().positive().optional(),
});
