import type {OperationRow} from './operation-record.js';

/** Short-lived MongoDB socket ownership, not authentication credentials. */
export interface DevicePresence {
 device_id:string;user_id:string;instance_id:string;lease_id:string;
 expires_at:number;
}
/** Encrypted cross-relay arguments never enter ordinary source/audit columns. */
export interface RoutedOperation extends OperationRow {
 route_state?:'queued'|'running';
 route_instance?:string;
 route_target_instance?:string;
 route_started_at?:number;
 route_ciphertext?:string;
}
