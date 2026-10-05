import {
  PrepareFileTransferArgsSchema,
  ReceiveFileTransferArgsSchema,
  SendFileTransferArgsSchema,
} from '../tools/schemas.js';
import {
  prepareFileReceive,
  receiveFileTransfer,
  sendFileTransfer,
} from '../file-transfer.js';
import type { ServerResult } from '../types.js';

function errorResult(message: string): ServerResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export async function handlePrepareFileTransfer(args: unknown): Promise<ServerResult> {
  const parsed = PrepareFileTransferArgsSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult('Invalid arguments for prepare_file_transfer: ' + parsed.error);
  }

  try {
    const result = prepareFileReceive(parsed.data.ttlSeconds);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          receiveId: result.receiveId,
          recipientPublicKey: result.recipientPublicKey,
          expiresAt: new Date(result.expiresAt).toISOString(),
        }),
      }],
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

export async function handleSendFileTransfer(args: unknown): Promise<ServerResult> {
  const parsed = SendFileTransferArgsSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult('Invalid arguments for send_file_transfer: ' + parsed.error);
  }

  try {
    const result = await sendFileTransfer(
      parsed.data.sourcePath,
      parsed.data.recipientPublicKey,
      parsed.data.expireSeconds,
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          transferToken: result.transferToken,
          size: result.size,
          sha256: result.sha256,
          expiresAt: new Date(result.expiresAt).toISOString(),
          provider: 'tmpfiles.org',
          encrypted: true,
        }),
      }],
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
export async function handleReceiveFileTransfer(args: unknown): Promise<ServerResult> {
  const parsed = ReceiveFileTransferArgsSchema.safeParse(args);
  if (!parsed.success) {
    return errorResult('Invalid arguments for receive_file_transfer: ' + parsed.error);
  }

  try {
    const result = await receiveFileTransfer(
      parsed.data.receiveId,
      parsed.data.transferToken,
      parsed.data.destinationPath,
      parsed.data.overwrite,
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          path: result.path,
          size: result.size,
          sha256: result.sha256,
          verified: true,
        }),
      }],
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}