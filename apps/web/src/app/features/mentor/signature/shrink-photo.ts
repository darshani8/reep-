/**
 * A phone camera's photo of a signature is 3–6 MB; the signature endpoint
 * refuses anything over 2 MB (PUT /api/staff/signature). So a picture straight
 * from the "Take a photo" picker would be refused every time, and the faculty
 * member would be told their file is too big for doing exactly what the screen
 * asked them to do ("photograph or scan it").
 *
 * The signature is printed about 14 mm tall, so 1600 px on the long edge is
 * several times what the paper can show. A file already under the limit is
 * returned untouched — nothing that worked before is re-encoded — and any
 * failure (an old browser, a format the decoder cannot read) returns the
 * original too, so the server's own refusal still speaks for it.
 */
export const SIGNATURE_MAX_BYTES = 2 * 1024 * 1024;
const LONG_EDGE = 1600;

/** The size a `width`×`height` image is drawn at so neither edge passes `max`. */
export function fitWithin(width: number, height: number, max = LONG_EDGE): { w: number; h: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

export async function shrinkPhoto(file: File, limit = SIGNATURE_MAX_BYTES): Promise<File> {
  if (file.size <= limit || !/^image\/(jpeg|png)$/.test(file.type)) return file;
  try {
    // `from-image` applies the EXIF rotation, so a portrait photo stays upright.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { w, h } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // White underneath: a JPEG has no alpha, and a transparent PNG drawn
    // straight onto one would turn black around the ink.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.9));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.(png|jpe?g)$/i, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
