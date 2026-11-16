/**
 * One offline tokenizer package for all MCP-visible text:
 * - use the matching OpenAI encoding only for an explicitly supplied model ID;
 * - otherwise retain o200k_base as a universal *approximation*, not as a
 *   claim about Claude/Gemini/DeepSeek/Llama/Qwen tokenization.
 * No external model/tokenizer downloads or network counting calls.
 */
import { countTokens as countO200k } from 'gpt-tokenizer';
import { countTokens as countCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { countTokens as countHarmony } from 'gpt-tokenizer/encoding/o200k_harmony';

export type EncodingDecision = { encoding: 'o200k_base' | 'cl100k_base' | 'o200k_harmony'; matched: boolean };

/** Metadata hint is NOT verified model/provider usage, nor used for authentication. */
export function selectTextEncoding(hint: string | undefined): EncodingDecision {
  const model = (hint ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.:-]{0,99}$/.test(model))
    return {encoding:'o200k_base',matched:false};
  if (/^gpt-oss(?:-|$)/.test(model))
    return {encoding:'o200k_harmony',matched:true};
  if (/^(?:gpt-(?:4o|4\.1|4\.5|5|6)(?:$|[-.])|o(?:1|3|4)(?:$|-))/.test(model))
    return {encoding:'o200k_base',matched:true};
  if (/^(?:gpt-(?:4(?:$|-)|3\.5(?:$|-))|text-embedding-3-)/.test(model))
    return {encoding:'cl100k_base',matched:true};
  return {encoding:'o200k_base',matched:false};
}

export function countMcpText(text: string, hint?: string): {tokens:number;encoding:EncodingDecision} {
  const encoding=selectTextEncoding(hint);
  const tokens = text.length===0 ? 0
    : encoding.encoding==='cl100k_base' ? countCl100k(text)
    : encoding.encoding==='o200k_harmony' ? countHarmony(text)
    : countO200k(text);
  return {tokens,encoding};
}
