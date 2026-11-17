/** Offline o200k_base approximation of token counts for MCP-visible text. It is NOT a claim about any
 * specific model's tokenizer or billing. No network access. Loaded only inside the estimator worker. */
import { countTokens } from 'gpt-tokenizer';
export const countMcpText = (text: string): number => (text.length === 0 ? 0 : countTokens(text));
