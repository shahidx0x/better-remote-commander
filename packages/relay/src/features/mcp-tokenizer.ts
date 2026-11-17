/**
 * Offline token counting for MCP-visible text. Universal fallback is o200k_base, an *approximation*,
 * not a claim about Claude/Gemini/Llama tokenizers or billing. An OpenAI encoding is used only when
 * the client supplies an explicit model hint (X-BRC-Model). The hint is unverified metadata: it never
 * authenticates anything and is never stored. No network access. Loaded only inside the estimator worker.
 */
import { countTokens as countO200k } from 'gpt-tokenizer';
import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { countTokens as countHarmony } from 'gpt-tokenizer/encoding/o200k_harmony';

export type EncodingDecision = { encoding: 'o200k_base' | 'cl100k_base' | 'o200k_harmony'; matched: boolean };

export function selectTextEncoding(hint: string | undefined): EncodingDecision {
  const model = (hint ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.:-]{0,99}$/.test(model)) return { encoding: 'o200k_base', matched: false };
  if (/^gpt-oss(?:-|$)/.test(model)) return { encoding: 'o200k_harmony', matched: true };
  if (/^(?:gpt-(?:4o|4\.1|4\.5|5|6)(?:$|[-.])|o(?:1|3|4)(?:$|-))/.test(model)) return { encoding: 'o200k_base', matched: true };
  if (/^(?:gpt-(?:4(?:$|-)|3\.5(?:$|-))|text-embedding-3-)/.test(model)) return { encoding: 'cl100k_base', matched: true };
  return { encoding: 'o200k_base', matched: false };
}

export function countMcpTextWith(text: string, hint?: string): { tokens: number; encoding: EncodingDecision } {
  const encoding = selectTextEncoding(hint);
  const tokens = text.length === 0 ? 0
    : encoding.encoding === 'cl100k_base' ? countCl100k(text)
    : encoding.encoding === 'o200k_harmony' ? countHarmony(text)
    : countO200k(text);
  return { tokens, encoding };
}

export const countMcpText = (text: string, hint?: string): number => countMcpTextWith(text, hint).tokens;
