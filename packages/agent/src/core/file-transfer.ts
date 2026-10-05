import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validatePath } from './tools/filesystem.js';

const TMPFILES_UPLOAD_URL = 'https://tmpfiles.org/api/v1/upload';
const MAX_PLAINTEXT_BYTES = 99_000_000;
const MAX_REMOTE_BYTES = 100_000_000;
const FILE_AAD = Buffer.from('BRCX1:file');
const WRAP_AAD = Buffer.from('BRCX1:key');
const WRAP_INFO = Buffer.from('brc-file-transfer-v1');

type ReceiveKey = { privateKey: KeyObject; expiresAt: number };

const receiveKeys = new Map<string, ReceiveKey>();

type TransferEnvelopeV1 = {
  v: 1;
  provider: 'tmpfiles.org';
  url: string;
  size: number;
  sha256: string;
  expiresAt: number;
  fileIv: string;
  fileTag: string;
  senderPublicKey: string;
  wrapSalt: string;
  wrapIv: string;
  wrapTag: string;
  wrappedKey: string;
};

class HashingPassThrough extends Transform {
  private readonly hash = createHash('sha256');
  bytes = 0;

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest('hex');
  }
}

class SizeLimitPassThrough extends Transform {
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) {
      callback(new Error('Encrypted transfer exceeds the 100 MB provider limit.'));
      return;
    }
    callback(null, chunk);
  }
}

function b64(data: Buffer): string {
  return data.toString('base64');
}

function fromB64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function encodeToken(envelope: TransferEnvelopeV1): string {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

function decodeToken(token: string): TransferEnvelopeV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid BRC file-transfer token.');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as any).v !== 1) {
    throw new Error('Unsupported BRC file-transfer token.');
  }
  const envelope = parsed as TransferEnvelopeV1;
  const url = new URL(envelope.url);
  if (url.protocol !== 'https:' || !['tmpfiles.org', 'www.tmpfiles.org'].includes(url.hostname)) {
    throw new Error('Transfer token points to an unsupported download host.');
  }
  if (!Number.isFinite(envelope.size) || envelope.size < 0 || envelope.size > MAX_PLAINTEXT_BYTES) {
    throw new Error('Transfer token contains an invalid file size.');
  }
  return envelope;
}

async function resolveDirectDownloadUrl(pageUrl: string): Promise<string> {
  const page = new URL(pageUrl);
  if (page.protocol !== 'https:' || !['tmpfiles.org', 'www.tmpfiles.org'].includes(page.hostname)) {
    throw new Error('Unexpected temporary-file provider response.');
  }

  const response = await fetch(page.toString());
  if (!response.ok) {
    throw new Error('Failed to resolve temporary-file download URL (HTTP ' + response.status + ').');
  }
  const html = await response.text();
  const match = html.match(/<a[^>]+class=["']download["'][^>]+href=["']([^"']+)["']/i);
  if (!match?.[1]) {
    throw new Error('Temporary-file provider did not expose a download link.');
  }

  const download = new URL(match[1], page);
  if (download.protocol !== 'https:' || !['tmpfiles.org', 'www.tmpfiles.org'].includes(download.hostname)
      || !download.pathname.startsWith('/dl/')) {
    throw new Error('Temporary-file provider returned an invalid download link.');
  }
  return download.toString();
}

function tempFilePath(suffix: string): string {
  return path.join(os.tmpdir(), 'brc-' + randomBytes(16).toString('hex') + suffix);
}

export function prepareFileReceive(ttlSeconds = 3600): {
  receiveId: string;
  recipientPublicKey: string;
  expiresAt: number;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const receiveId = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + ttlSeconds * 1000;
  receiveKeys.set(receiveId, { privateKey, expiresAt });

  const timer = setTimeout(() => receiveKeys.delete(receiveId), ttlSeconds * 1000);
  timer.unref?.();

  return {
    receiveId,
    recipientPublicKey: b64(publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
    expiresAt,
  };
}

async function encryptFile(sourcePath: string, fileKey: Buffer, fileIv: Buffer): Promise<{
  encryptedPath: string;
  sha256: string;
  fileTag: Buffer;
}> {
  const encryptedPath = tempFilePath('.brcx');
  const cipher = createCipheriv('aes-256-gcm', fileKey, fileIv);
  cipher.setAAD(FILE_AAD);
  const hashing = new HashingPassThrough();

  try {
    await pipeline(
      createReadStream(sourcePath),
      hashing,
      cipher,
      createWriteStream(encryptedPath, { flags: 'wx' }),
    );
    return {
      encryptedPath,
      sha256: hashing.digestHex(),
      fileTag: cipher.getAuthTag(),
    };
  } catch (error) {
    await fs.rm(encryptedPath, { force: true }).catch(() => {});
    throw error;
  }
}

function wrapFileKey(fileKey: Buffer, recipientPublicKey: string): {
  senderPublicKey: string;
  wrapSalt: Buffer;
  wrapIv: Buffer;
  wrapTag: Buffer;
  wrappedKey: Buffer;
} {
  const recipient = createPublicKey({
    key: fromB64(recipientPublicKey),
    format: 'der',
    type: 'spki',
  });
  const sender = generateKeyPairSync('x25519');
  const sharedSecret = diffieHellman({ privateKey: sender.privateKey, publicKey: recipient });
  const wrapSalt = randomBytes(16);
  const wrapKey = Buffer.from(hkdfSync('sha256', sharedSecret, wrapSalt, WRAP_INFO, 32));
  const wrapIv = randomBytes(12);
  const wrapCipher = createCipheriv('aes-256-gcm', wrapKey, wrapIv);
  wrapCipher.setAAD(WRAP_AAD);
  const wrappedKey = Buffer.concat([wrapCipher.update(fileKey), wrapCipher.final()]);
  const wrapTag = wrapCipher.getAuthTag();

  return {
    senderPublicKey: b64(sender.publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
    wrapSalt,
    wrapIv,
    wrapTag,
    wrappedKey,
  };
}

async function uploadEncryptedFile(encryptedPath: string, expireSeconds: number): Promise<string> {
  const form = new FormData();
  const blob = await openAsBlob(encryptedPath, { type: 'application/octet-stream' });
  const uploadName = randomBytes(12).toString('hex') + '.brcx';
  form.append('file', blob, uploadName);
  form.append('expire', String(expireSeconds));

  const response = await fetch(TMPFILES_UPLOAD_URL, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error('Temporary-file upload failed with HTTP ' + response.status + '.');
  }
  const payload = await response.json() as { status?: string; data?: { url?: string } };
  if (payload.status !== 'success' || !payload.data?.url) {
    throw new Error('Temporary-file provider returned an invalid response.');
  }
  const page = new URL(payload.data.url);
  if (page.protocol !== 'https:' || !['tmpfiles.org', 'www.tmpfiles.org'].includes(page.hostname)) {
    throw new Error('Temporary-file provider returned an invalid file URL.');
  }
  return page.toString();
}
export async function sendFileTransfer(
  sourcePath: string,
  recipientPublicKey: string,
  expireSeconds = 3600,
): Promise<{ transferToken: string; size: number; sha256: string; expiresAt: number }> {
  const validSource = await validatePath(sourcePath);
  const stat = await fs.stat(validSource);
  if (!stat.isFile()) throw new Error('Source path must be a file.');
  if (stat.size > MAX_PLAINTEXT_BYTES) {
    throw new Error('File is too large for temporary transfer. Maximum plaintext size is 99 MB.');
  }

  const fileKey = randomBytes(32);
  const fileIv = randomBytes(12);
  const wrapped = wrapFileKey(fileKey, recipientPublicKey);
  const encrypted = await encryptFile(validSource, fileKey, fileIv);

  try {
    const url = await uploadEncryptedFile(encrypted.encryptedPath, expireSeconds);
    const expiresAt = Date.now() + expireSeconds * 1000;
    const envelope: TransferEnvelopeV1 = {
      v: 1,
      provider: 'tmpfiles.org',
      url,
      size: stat.size,
      sha256: encrypted.sha256,
      expiresAt,
      fileIv: b64(fileIv),
      fileTag: b64(encrypted.fileTag),
      senderPublicKey: wrapped.senderPublicKey,
      wrapSalt: b64(wrapped.wrapSalt),
      wrapIv: b64(wrapped.wrapIv),
      wrapTag: b64(wrapped.wrapTag),
      wrappedKey: b64(wrapped.wrappedKey),
    };
    return {
      transferToken: encodeToken(envelope),
      size: stat.size,
      sha256: encrypted.sha256,
      expiresAt,
    };
  } finally {
    fileKey.fill(0);
    await fs.rm(encrypted.encryptedPath, { force: true }).catch(() => {});
  }
}

function unwrapFileKey(envelope: TransferEnvelopeV1, privateKey: KeyObject): Buffer {
  const senderPublicKey = createPublicKey({
    key: fromB64(envelope.senderPublicKey),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = diffieHellman({ privateKey, publicKey: senderPublicKey });
  const wrapKey = Buffer.from(hkdfSync('sha256', sharedSecret, fromB64(envelope.wrapSalt), WRAP_INFO, 32));
  const decipher = createDecipheriv('aes-256-gcm', wrapKey, fromB64(envelope.wrapIv));
  decipher.setAAD(WRAP_AAD);
  decipher.setAuthTag(fromB64(envelope.wrapTag));
  const fileKey = Buffer.concat([decipher.update(fromB64(envelope.wrappedKey)), decipher.final()]);
  if (fileKey.length !== 32) throw new Error('Invalid wrapped file key.');
  return fileKey;
}
async function downloadEncryptedFile(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['tmpfiles.org', 'www.tmpfiles.org'].includes(parsed.hostname)) {
    throw new Error('Refusing to download transfer data from an unsupported host.');
  }

  const downloadUrl = parsed.pathname.startsWith('/dl/')
    ? parsed.toString()
    : await resolveDirectDownloadUrl(parsed.toString());
  const response = await fetch(downloadUrl);
  if (!response.ok || !response.body) {
    throw new Error('Temporary-file download failed with HTTP ' + response.status + '.');
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_REMOTE_BYTES) {
    throw new Error('Encrypted transfer exceeds the 100 MB provider limit.');
  }

  const encryptedPath = tempFilePath('.download.brcx');
  try {
    const body = Readable.fromWeb(response.body as any);
    await pipeline(
      body,
      new SizeLimitPassThrough(MAX_REMOTE_BYTES),
      createWriteStream(encryptedPath, { flags: 'wx' }),
    );
    return encryptedPath;
  } catch (error) {
    await fs.rm(encryptedPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function receiveFileTransfer(
  receiveId: string,
  transferToken: string,
  destinationPath: string,
  overwrite = false,
): Promise<{ path: string; size: number; sha256: string }> {
  const receiveKey = receiveKeys.get(receiveId);
  if (!receiveKey || receiveKey.expiresAt <= Date.now()) {
    receiveKeys.delete(receiveId);
    throw new Error('Receive session is missing or expired. Prepare a new file-transfer receive session.');
  }

  const envelope = decodeToken(transferToken);
  if (envelope.expiresAt <= Date.now()) {
    throw new Error('The temporary file-transfer token has expired.');
  }

  const validDestination = await validatePath(destinationPath);
  try {
    const current = await fs.stat(validDestination);
    if (current.isDirectory()) throw new Error('Destination path points to a directory.');
    if (!overwrite) throw new Error('Destination file already exists. Set overwrite=true to replace it.');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const fileKey = unwrapFileKey(envelope, receiveKey.privateKey);
  const encryptedPath = await downloadEncryptedFile(envelope.url);
  const partPath = validDestination + '.brc-part-' + randomBytes(6).toString('hex');
  const decipher = createDecipheriv('aes-256-gcm', fileKey, fromB64(envelope.fileIv));
  decipher.setAAD(FILE_AAD);
  decipher.setAuthTag(fromB64(envelope.fileTag));
  const hashing = new HashingPassThrough();

  try {
    await fs.mkdir(path.dirname(validDestination), { recursive: true });
    await pipeline(
      createReadStream(encryptedPath),
      decipher,
      hashing,
      createWriteStream(partPath, { flags: 'wx' }),
    );

    const sha256 = hashing.digestHex();
    if (hashing.bytes !== envelope.size) {
      throw new Error('Transfer size verification failed.');
    }
    if (sha256 !== envelope.sha256) {
      throw new Error('Transfer SHA-256 verification failed.');
    }

    if (overwrite) {
      await fs.rm(validDestination, { force: true });
    }
    await fs.rename(partPath, validDestination);
    receiveKeys.delete(receiveId);

    return {
      path: validDestination,
      size: hashing.bytes,
      sha256,
    };
  } catch (error) {
    await fs.rm(partPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    fileKey.fill(0);
    await fs.rm(encryptedPath, { force: true }).catch(() => {});
  }
}