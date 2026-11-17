/** Worker thread: token-counts MCP-visible text. No database access; nothing is logged or persisted. */
import { parentPort } from 'node:worker_threads';
import { countMcpText } from './mcp-tokenizer.js';

interface Job { id: number; model_input_text: string; model_output_text: string; partial: boolean }
parentPort?.on('message', (job: Job) => {
  try {
    parentPort?.postMessage({ id: job.id, input: countMcpText(job.model_input_text), output: countMcpText(job.model_output_text), partial: job.partial });
  } catch {
    parentPort?.postMessage({ id: job.id, input: 0, output: 0, partial: true });
  }
});
