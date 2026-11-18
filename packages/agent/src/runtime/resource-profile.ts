/**
 * Agent resource profile.
 *
 * Normal mode is enforced on every PC. Legacy responsive/auto environment
 * settings are normalized here so every runtime module sees the same policy.
 * Hardware only caps concurrency; it never enables unbounded parallelism.
 */
import os from 'node:os';

export type ResourceProfile = 'normal';

export interface ResourceProfileStatus {
  profile: ResourceProfile;
  selection: 'manual' | 'automatic' | 'low-resource-override';
  cpuParallelism: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  maxConcurrentJobs: number;
  maxToolConcurrency: number;
  parserWorkers: number;
  reason: string;
}

const cpuParallelism = Math.max(
  1,
  typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
);
const totalMemoryBytes = os.totalmem();
const freeMemoryBytes = os.freemem();
const profile: ResourceProfile = 'normal';
const selection: ResourceProfileStatus['selection'] = 'automatic';
const reason = 'normal mode is enforced on every PC; legacy responsive/auto overrides are ignored; worker concurrency is capped at three and CPU-heavy tasks are serialized';

// Normalize stale launcher settings before any other runtime module is evaluated.
process.env.BRC_RESOURCE_PROFILE = profile;
delete process.env.BRC_LOW_RESOURCE_MODE;

const hardwareWorkerLimit = Math.max(1, Math.min(3, cpuParallelism));
const maxConcurrentJobs = hardwareWorkerLimit;
const maxToolConcurrency = hardwareWorkerLimit;
const parserWorkers = Math.max(1, Math.min(2, cpuParallelism));

// Never allow stale one-thread or oversized environment settings to override
// the Normal profile's bounded worker counts.
process.env.BRC_MAX_JOBS = String(maxConcurrentJobs);
process.env.BRC_MAX_CONCURRENCY = String(maxToolConcurrency);
process.env.BRC_PARSER_WORKERS = String(parserWorkers);

export const RESOURCE_PROFILE: ResourceProfile = profile;
export const RESOURCE_PROFILE_STATUS: ResourceProfileStatus = {
  profile,
  selection,
  cpuParallelism,
  totalMemoryBytes,
  freeMemoryBytes,
  maxConcurrentJobs,
  maxToolConcurrency,
  parserWorkers,
  reason,
};

export function getResourceProfileStatus(): ResourceProfileStatus {
  return { ...RESOURCE_PROFILE_STATUS };
}
