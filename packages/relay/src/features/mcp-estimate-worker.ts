/** Worker thread: token-counts MCP-visible text. No database access; nothing is logged or persisted. */
import { parentPort } from 'node:worker_threads';
import { countMcpTextWith } from './mcp-tokenizer.js';

interface Job { id: number; model_input_text: string; model_output_text: string; partial: boolean; model_hint?: string }
parentPort?.on('message', (job: Job) => {
  try {
    const i = countMcpTextWith(job.model_input_text, job.model_hint);
    const o = countMcpTextWith(job.model_output_text, job.model_hint);
    parentPort?.postMessage({ id: job.id, input: i.tokens, output: o.tokens, partial: job.partial, matched: i.encoding.matched });
  } catch {
    parentPort?.postMessage({ id: job.id, input: 0, output: 0, partial: true, matched: false });
  }
});
