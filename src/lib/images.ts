// Pictures are shrunk in the browser before they are uploaded: it keeps uploads
// quick on a phone connection, and redrawing the image drops any hidden data
// the camera attached to it — such as where the photo was taken.

interface ShrinkOptions {
  /** Longest side of the result, in pixels. */
  maxSide: number;
  /** Crop to a centred square first (profile pictures). */
  square?: boolean;
  quality?: number;
}

export async function shrinkImage(file: Blob, { maxSide, square = false, quality = 0.84 }: ShrinkOptions): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("That file isn't a picture we can read. Try a JPEG or PNG.");
  }
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (square) {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2;
    sy = (sh - side) / 2;
    sw = sh = side;
  }
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff'; // JPEG has no transparency
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('That picture could not be prepared. Try another one.'))), 'image/jpeg', quality);
  });
}
