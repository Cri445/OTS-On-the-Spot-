import { randomBytes } from 'node:crypto';
import { HttpError, iso, nowIso, type Ctx } from './util';

// Profile pictures and venue photos. They live in the database next to everything
// else, so there is one file to back up and no upload folder to protect.

export type ImageKind = 'avatar' | 'venue';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_BYTES: Record<ImageKind, number> = { avatar: 1_000_000, venue: 3_000_000 };
const MAX_IMAGES_PER_PERSON = 300;

/** Work out the real type from the file's first bytes — never trust the declared one. */
export function sniffImage(b: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export const imageUrl = (id: string | null | undefined): string | null => (id ? `/api/images/${id}` : null);

/** Store an uploaded image and return its id. */
export function saveImage(ctx: Ctx, ownerId: number, kind: ImageKind, body: unknown): string {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(415, 'Upload a JPEG, PNG or WebP image.', 'bad_image');
  if (body.length > MAX_BYTES[kind]) throw new HttpError(413, 'That image is too large.', 'too_large');
  const mime = sniffImage(body);
  if (!mime) throw new HttpError(415, 'Upload a JPEG, PNG or WebP image.', 'bad_image');
  const count = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM images WHERE owner_id = ?', ownerId)!.n;
  if (count >= MAX_IMAGES_PER_PERSON) throw new HttpError(409, 'You have reached the photo limit. Remove some photos first.', 'too_many');
  const id = randomBytes(16).toString('hex');
  ctx.db.run('INSERT INTO images (id, owner_id, kind, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, ownerId, kind, mime, body, nowIso(ctx));
  return id;
}

export function loadImage(ctx: Ctx, id: string): { mime: string; bytes: Uint8Array } | undefined {
  if (!/^[0-9a-f]{32}$/.test(id)) return undefined;
  return ctx.db.get<{ mime: string; bytes: Uint8Array }>('SELECT mime, bytes FROM images WHERE id = ?', id);
}

export function deleteImage(ctx: Ctx, id: string | null): void {
  if (id) ctx.db.run('DELETE FROM images WHERE id = ?', id);
}

/** Make sure every id is a venue photo this person uploaded. Returns the list without duplicates. */
export function checkVenuePhotos(ctx: Ctx, ownerId: number, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const ok = ctx.db.get(`SELECT 1 FROM images WHERE id = ? AND owner_id = ? AND kind = 'venue'`, id, ownerId);
    if (!ok) throw new HttpError(400, 'One of the photos could not be found. Upload it again.', 'validation');
  }
  return unique;
}

/** Venue photos that were uploaded but never attached to an activity (or later removed from one) are deleted after a day. */
export function sweepOrphanImages(ctx: Ctx): void {
  const cutoff = iso(new Date(ctx.now().getTime() - 86_400_000));
  ctx.db.run(
    `DELETE FROM images WHERE kind = 'venue' AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM activities a, json_each(a.photos) p WHERE p.value = images.id)`,
    cutoff,
  );
}
