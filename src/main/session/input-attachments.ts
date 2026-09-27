import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { sessionsRoot } from './store.js';
import type { InputAttachment } from '../../shared/input.js';
import { BrowserResourceStore, DEFAULT_BROWSER_RESOURCE_CHUNK_BYTES } from '../browser-resource.js';

export const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = DEFAULT_BROWSER_RESOURCE_CHUNK_BYTES;
export const attachmentSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES), mimeType: z.string().max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),
  preview: z.string().max(32768).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/).optional() });
function directory(): string {
  const root = sessionsRoot();
  if (!root) throw new Error('Session storage is not ready');
  return path.join(path.dirname(root), 'input-attachments');
}
const resources = new BrowserResourceStore({
  purpose: 'input attachment',
  directory,
  maxBytes: MAX_ATTACHMENT_BYTES,
  chunkBytes: ATTACHMENT_CHUNK_BYTES
});
function metadataFor(id: string): string { return `${resources.localPath(id)}.json`; }
/** Only explicit file selection, drop or clipboard paste writes here; bytes never inflate the durable outbox. */
let staging: Promise<unknown> = Promise.resolve();
export type AttachmentSource = string | { text: string } | { name: string; bytes: Uint8Array };
export function stageInputAttachment(source: AttachmentSource, retained: Set<string>): Promise<InputAttachment> {
  const next = staging.then(() => stage(source, retained));
  staging = next.catch(() => undefined);
  return next;
}
async function stage(source: AttachmentSource, retained: Set<string>): Promise<InputAttachment> {
  const dir = directory();
  await fs.mkdir(dir, { recursive: true });
  let used = 0;
  for (const name of await fs.readdir(dir)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const file = resources.localPath(name), stat = await fs.stat(file);
    if (!retained.has(name) && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      await resources.remove(name); await fs.unlink(metadataFor(name)).catch(() => undefined);
    } else used += stat.size;
  }
  const stat = typeof source === 'string' ? await fs.stat(source) : null;
  const size = typeof source === 'string' ? stat!.size : 'text' in source ? Buffer.byteLength(source.text) : source.bytes.byteLength;
  if (stat && !stat.isFile()) throw new Error('Attach files individually; folders cannot be uploaded');
  if (size > MAX_ATTACHMENT_BYTES) throw new Error('Each attachment must be 512 MB or smaller');
  if (used + size > 2 * 1024 * 1024 * 1024) throw new Error('Attachment storage is full; finish or remove pending messages first');
  const name = typeof source === 'string' ? path.basename(source) : 'text' in source ? 'Attached text.txt' : path.basename(source.name);
  const types: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
  let resource: Awaited<ReturnType<typeof resources.snapshot>> | null = null;
  try {
    resource = await resources.snapshot(typeof source === 'string'
      ? source
      : { bytes: 'text' in source ? Buffer.from(source.text) : source.bytes });
    if (resource.size !== size) throw new Error('The attachment changed while being read; attach it again');
    const attachment = attachmentSchema.parse({ id: resource.id, name, size, mimeType: types[path.extname(name).toLowerCase()] ?? 'application/octet-stream' });
    if (attachment.mimeType.startsWith('image/') && size <= 12 * 1024 * 1024) {
      try {
        const thumbnail = await sharp(resources.localPath(attachment.id), { limitInputPixels: 30_000_000, animated: false }).rotate()
          .resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
        if (thumbnail.length <= 24000) attachment.preview = `data:image/webp;base64,${thumbnail.toString('base64')}`;
      } catch { /* Preview is presentation only; the original file remains unchanged for native validation. */ }
    }
    await fs.writeFile(metadataFor(attachment.id), JSON.stringify(attachment), { flag: 'wx' });
    return attachment;
  } catch (error) {
    if (resource) await resources.remove(resource.id).catch(() => undefined);
    throw error;
  }
}
export function validateInputAttachments(attachments: InputAttachment[]): Promise<void> {
  const next = staging.then(() => validate(attachments));
  staging = next.catch(() => undefined);
  return next;
}
async function validate(attachments: InputAttachment[]): Promise<void> {
  if (attachments.length > 20 || attachments.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) throw new Error('Attach up to 20 files and 512 MB per message');
  for (const attachment of attachments) {
    const stored = attachmentSchema.parse(JSON.parse(await fs.readFile(metadataFor(attachment.id), 'utf8')));
    if (JSON.stringify(stored) !== JSON.stringify(attachmentSchema.parse(attachment))) throw new Error('Attachment is missing or changed; attach it again');
    await resources.validate(attachment).catch(() => { throw new Error('Attachment is missing or changed; attach it again'); });
    // Admission renews the draft age under the same lock as pruning; a fresh
    // outbox commit cannot lose its bytes to an older concurrent cleanup snapshot.
    await resources.touch(attachment);
  }
}
/** Caller must first prove exact claimed input ownership and membership. */
export async function readInputAttachmentChunk(attachment: InputAttachment, offset: number): Promise<string> {
  return resources.readChunk(attachment, offset);
}
