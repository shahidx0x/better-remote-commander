// Phase 1 helper: extracts the upstream tool definition array from server.ts.ref
// into core/tool-definitions.ts. Run once from repo root: node scripts/extract-tools.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const src = readFileSync('packages/agent/src/core/server.ts.ref', 'utf8').split(/\r?\n/);
const start = src.findIndex(l => l.includes('const allTools = ['));
let end = -1;
for (let i = start; i < src.length; i++) { if (/^\s*\];\s*$/.test(src[i])) { end = i; break; } }
if (start < 0 || end < 0) throw new Error(`markers not found: ${start} ${end}`);
const body = src.slice(start + 1, end)
  .filter(l => !/_meta:\s*buildUiToolMeta\(/.test(l))
  .map(l => l.replace(/^ {8}/, ''))
  .join('\n');
const header = readFileSync('scripts/tool-definitions.header.ts', 'utf8');
const footer = `
  ];
  return allTools.filter(t => !EXCLUDED_TOOLS.has(t.name));
}
`;
writeFileSync('packages/agent/src/core/tool-definitions.ts', header + body + footer);
console.log(`extracted lines ${start + 2}-${end} (${end - start - 1} lines)`);
