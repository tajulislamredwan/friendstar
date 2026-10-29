import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { FILE_MIME, IMAGE_MIME, LIMITS, STATUS_MEDIA_MIME, STATUS_MUSIC_MIME, VIDEO_MIME } from '@friendstar/shared';
import { config } from '../config.ts';
import { run } from '../db/database.ts';
import { HttpError, newId, nowIso } from '../lib/util.ts';

const storage = multer.diskStorage({
  destination: config.uploadDir,
  // Never use the client's filename on disk.
  filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
});

function makeUploader(maxBytes: number, allowed: readonly string[]) {
  return multer({
    storage,
    limits: { fileSize: maxBytes, files: 1, fields: 5 },
    fileFilter: (_req, file, cb) => {
      if (allowed.includes(file.mimetype)) cb(null, true);
      else cb(new HttpError(415 as number, 'VALIDATION', 'That file type isn’t supported'));
    },
  });
}

export const attachmentUpload = makeUploader(LIMITS.attachmentBytes, FILE_MIME);
export const avatarUpload = makeUploader(LIMITS.avatarBytes, IMAGE_MIME);
export const statusMediaUpload = multer({
  storage,
  limits: { fileSize: LIMITS.statusMediaBytes, files: 2, fields: 8 },
  fileFilter: (_req, file, cb) => {
    const allowed = file.fieldname === 'musicFile' ? STATUS_MUSIC_MIME : STATUS_MEDIA_MIME;
    if (allowed.includes(file.mimetype as never)) cb(null, true);
    else cb(new HttpError(415 as number, 'VALIDATION', 'That file type isn’t supported'));
  },
}).fields([{ name: 'file', maxCount: 1 }, { name: 'musicFile', maxCount: 1 }]);

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('ascii') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'mp4 ']);
const WEBM_DOC_TYPE = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
const VIDEO_SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'video/mp4': (b) => {
    if (b.length < 16 || b.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
    const boxSize = b.readUInt32BE(0);
    return boxSize >= 16 && boxSize <= b.length && MP4_BRANDS.has(b.subarray(8, 12).toString('ascii'));
  },
  'video/webm': (b) => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && b.indexOf(WEBM_DOC_TYPE) >= 0,
};

/** Read width/height from PNG/GIF/JPEG headers (best effort, no dependencies). */
function imageSize(b: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Validate an uploaded file and record it. Deletes the file from disk if it fails checks. */
export function registerUpload(file: Express.Multer.File, ownerId: string): { id: string; isImage: boolean; isVideo: boolean } {
  const fullPath = path.join(config.uploadDir, file.filename);
  const isImage = (IMAGE_MIME as readonly string[]).includes(file.mimetype);
  const isVideo = (VIDEO_MIME as readonly string[]).includes(file.mimetype);
  let dims: { width: number; height: number } | null = null;
  if (isImage) {
    const head = Buffer.alloc(64 * 1024);
    const fd = fs.openSync(fullPath, 'r');
    const n = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const buf = head.subarray(0, n);
    if (!SIGNATURES[file.mimetype]?.(buf)) {
      fs.rmSync(fullPath, { force: true });
      throw new HttpError(400, 'VALIDATION', 'That image looks damaged or isn’t really an image');
    }
    dims = imageSize(buf, file.mimetype);
  } else if (isVideo) {
    const head = Buffer.alloc(64 * 1024);
    const fd = fs.openSync(fullPath, 'r');
    const n = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    if (!VIDEO_SIGNATURES[file.mimetype]?.(head.subarray(0, n))) {
      fs.rmSync(fullPath, { force: true });
      throw new HttpError(400, 'VALIDATION', 'That video looks damaged or isn’t really an MP4/WebM video');
    }
  }
  const id = newId();
  const safeName = file.originalname.replace(/[\u0000-\u001f\\/]/g, '_').slice(0, 120) || 'file';
  run(
    `INSERT INTO files (id, owner_id, storage_name, original_name, mime_type, size_bytes, width, height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ownerId,
    file.filename,
    safeName,
    file.mimetype,
    file.size,
    dims?.width ?? null,
    dims?.height ?? null,
    nowIso(),
  );
  return { id, isImage, isVideo };
}
