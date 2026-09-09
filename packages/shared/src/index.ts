/**
 * SES-RDP shared package.
 * Phase 0: placeholder exports. Phase 1 adds the agent <-> relay wire protocol
 * (hello / call / result / ping / error) and tool schemas.
 */
export const SES_RDP_PROTOCOL_VERSION = 1;

export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: NodeJS.Platform;
  agentVersion: string;
}
