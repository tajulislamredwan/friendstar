/**
 * Uploads on Cloudflare: validate type, size and magic bytes, then store the bytes
 * in 1 MB chunks inside the Durable Object's SQLite database (values are capped at 2 MB).
 */
import { FILE_MIME, IMAGE_MIME, LIMITS, STATUS_MEDIA_MIME, STATUS_MUSIC_MIME, VIDEO_MIME } from '@friendstar/shared';
import { all, run, tx } from './platform/database.ts';
import { HttpError, newId, nowIso } from './platform/util.ts';

const CHUNK = 1024 * 1024;

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  'image/gif': (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
};

const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'mp4 ']);
const WEBM_DOC_TYPE = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];
const VIDEO_SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'video/mp4': (b) => {
    if (b.length < 16 || ascii(b, 4, 8) !== 'ftyp') return false;
    const boxSize = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
    return boxSize >= 16 && boxSize <= b.length && MP4_BRANDS.has(ascii(b, 8, 12));
  },
  'video/webm': (b) => {
    if (b.length < 4 || b[0] !== 0x1a || b[1] !== 0x45 || b[2] !== 0xdf || b[3] !== 0xa3) return false;
    for (let i = 0; i <= b.length - WEBM_DOC_TYPE.length; i++) {
      if (WEBM_DOC_TYPE.every((value, j) => b[i + j] === value)) return true;
    }
    return false;
  },
};

function imageSize(b: Uint8Array, mime: string): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (mime === 'image/png') return { width: v.getUint32(16), height: v.getUint32(20) };
    if (mime === 'image/gif') return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = v.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export type UploadKind = 'avatar' | 'attachment' | 'status' | 'status-music';

/** Validate an uploaded File and store it. Returns the new file id. */
export async function storeUpload(file: unknown, ownerId: string, kind: UploadKind): Promise<{ id: string; isImage: boolean; isVideo: boolean }> {
  if (!(file instanceof File)) throw new HttpError(400, 'VALIDATION', kind === 'avatar' ? 'Choose an image' : 'Choose a file');
  const allowed: readonly string[] = kind === 'attachment' ? FILE_MIME : kind === 'status' ? STATUS_MEDIA_MIME : kind === 'status-music' ? STATUS_MUSIC_MIME : IMAGE_MIME;
  const maxBytes = kind === 'avatar' ? LIMITS.avatarBytes : kind === 'status' || kind === 'status-music' ? LIMITS.statusMediaBytes : LIMITS.attachmentBytes;
  if (!allowed.includes(file.type)) throw new HttpError(415, 'VALIDATION', 'That file type isn’t supported');
  if (file.size > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'That file is too large');
  if (file.size === 0) throw new HttpError(400, 'VALIDATION', 'That file is empty');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const isImage = (IMAGE_MIME as readonly string[]).includes(file.type);
  const isVideo = (VIDEO_MIME as readonly string[]).includes(file.type);
  let dims: { width: number; height: number } | null = null;
  if (isImage) {
    const head = bytes.subarray(0, 64 * 1024);
    if (!SIGNATURES[file.type]?.(head)) {
      throw new HttpError(400, 'VALIDATION', 'That image looks damaged or isn’t really an image');
    }
    dims = imageSize(head, file.type);
  } else if (isVideo && !VIDEO_SIGNATURES[file.type]?.(bytes.subarray(0, 64 * 1024))) {
    throw new HttpError(400, 'VALIDATION', 'That video looks damaged or isn’t really an MP4/WebM video');
  }

  const id = newId();
  const safeName = (file.name || 'file').replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 120) || 'file';
  tx(() => {
    run(
      `INSERT INTO files (id, owner_id, storage_name, original_name, mime_type, size_bytes, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ownerId,
      'sqlite-chunks',
      safeName,
      file.type,
      bytes.byteLength,
      dims?.width ?? null,
      dims?.height ?? null,
      nowIso(),
    );
    for (let i = 0, idx = 0; i < bytes.byteLength; i += CHUNK, idx++) {
      // slice() copies into a standalone ArrayBuffer of exactly this chunk.
      run('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)', id, idx, bytes.slice(i, i + CHUNK).buffer);
    }
  });
  return { id, isImage, isVideo };
}

export function readFileBytes(fileId: string, size: number): Uint8Array | null {
  const chunks = all<{ data: ArrayBuffer }>('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx', fileId);
  if (!chunks.length) return null;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    const part = new Uint8Array(c.data);
    out.set(part, offset);
    offset += part.byteLength;
  }
  return offset === size ? out : out.subarray(0, offset);
}
