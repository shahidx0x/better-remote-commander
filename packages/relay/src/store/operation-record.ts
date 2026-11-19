/** Durable relay operation metadata. Never persist raw tool arguments, paths or
 * plaintext results. The separate encrypted payload is optional and bounded. */
export type OperationState = 'claimed'|'settled'|'uncertain';
export interface OperationRow {
  id:string; user_id:string; client_id:string; device_id:string; tool:string;
  args_hash:string; state:OperationState; created_at:number; updated_at:number;
  expires_at:number; encrypted_result:string|null; result_bytes:number;
  result_sha256:string|null; result_is_error:number|null; error_code:string|null;
}
export interface OperationUpdate {
  state:'settled'|'uncertain'; updated_at:number;
  encrypted_result:string|null; result_bytes:number; result_sha256:string|null;
  result_is_error:number|null; error_code:string|null;
}
export const OPERATION_TTL_MS=7*24*60*60_000;
export const MAX_OPERATION_ROWS_PER_USER=16384;
export const MAX_OPERATION_RESULT_BYTES=512*1024;
export const MAX_OPERATION_STORED_BYTES=64*1024*1024;
