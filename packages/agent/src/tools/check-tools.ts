/** discover_checks / run_project_checks: manifest-backed verification recipes. Selected IDs only; no shell interpolation, no dependency installation. */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { discoverChecks, runProjectChecks } from '../runtime/harness.js';
import { result } from '../runtime/errors.js';

const DiscoverSchema = z.object({ path: z.string().min(1) });
const RunSchema = z.object({
    path: z.string().min(1),
    scripts: z.array(z.string().regex(/^[A-Za-z0-9_.:-]+$/)).min(1).max(5),
    execute: z.boolean().default(false),
});

export const CHECK_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
    discover_checks: async (raw) => result(await discoverChecks(DiscoverSchema.parse(raw).path)) as unknown as ServerResult,
    run_project_checks: async (raw) => {
        const a = RunSchema.parse(raw), r = await runProjectChecks(a.path, a.scripts, a.execute);
        return result(r, a.execute && 'passed' in r && r.passed === false) as unknown as ServerResult;
    },
};

export function buildCheckToolDefinitions(): ToolDefinition[] {
    return [
        { name: 'discover_checks', schema: DiscoverSchema, readOnly: true, description: 'List verification recipes found in project manifests (package.json scripts, .NET, Rust, Python, Go, JVM, CMake, Swift, Dart/Flutter) plus test files and default checks. Read-only: nothing is executed or installed; toolchains must already be present. Watch/dev/serve scripts are excluded.' },
        { name: 'run_project_checks', schema: RunSchema, readOnly: false, description: 'Run up to 5 check names returned by discover_checks, in order, stopping at the first failure. Preview by default; execute=true runs them with real exit codes, a shared 110s timeout and bounded output (tail of each step). Unknown names are rejected; no free-form commands, no dependency installation. Fails if project source files change while checks run. Passing proves only the selected checks.' },
    ].map(d => ({
        name: d.name, description: d.description,
        inputSchema: zodToJsonSchema(d.schema) as ToolDefinition['inputSchema'],
        annotations: { title: d.name, readOnlyHint: d.readOnly, ...(d.readOnly ? {} : { destructiveHint: true }), openWorldHint: false },
    }));
}
