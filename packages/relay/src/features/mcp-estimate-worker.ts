/** Worker thread: o200k BPE of MCP-visible text, never model usage claims.
 * No database access and no content logged or persisted. */
import { parentPort } from 'node:worker_threads';
import { countMcpText, selectTextEncoding } from './mcp-tokenizer.js';
import type { McpEstimateDelta } from './usage.js';

interface Job {
  id: number;
  user_id: string;
  day: string;
  model_input_text: string;  // tool result text delivered TO model
  model_output_text: string; // tool call arguments FROM model
  partial: boolean;
  model_hint?: string;
}
parentPort?.on('message', (job: Job) => {
  try {
    const encoding=selectTextEncoding(job.model_hint);
    const row: McpEstimateDelta = {
      user_id:job.user_id,
      day:job.day,
      input_tokens:countMcpText(job.model_input_text,job.model_hint).tokens,
      output_tokens:countMcpText(job.model_output_text,job.model_hint).tokens,
      calls:1,
      partial_calls:job.partial ? 1 : 0,
      to_agent_bytes:0,from_agent_bytes:0,
      matched_calls:encoding.matched?1:0,
      universal_calls:encoding.matched?0:1,
    };
    parentPort?.postMessage({ id: job.id, row });
  } catch {
    // Tokenizer failures must never alter MCP responses or leak payloads.
    parentPort?.postMessage({ id: job.id, row: {
      user_id:job.user_id, day:job.day, input_tokens:0, output_tokens:0, calls:1, partial_calls:1,
      to_agent_bytes:0,from_agent_bytes:0,matched_calls:0,universal_calls:0
    } satisfies McpEstimateDelta });
  }
});
