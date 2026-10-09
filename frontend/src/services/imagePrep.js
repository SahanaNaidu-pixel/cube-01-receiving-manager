// Prepares real camera photos for upload. Phone photos are often 4-12 MB, sometimes report an empty
// MIME type, and carry EXIF rotation. The backend accepts JPEG/PNG/WebP up to MAX_IMAGE_SIZE_MB (10),
// and the model reads at most ~2k px anyway, so large photos are re-encoded to a <=2048 px JPEG here.
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_EDGE = 2048;
const RECODE_ABOVE_BYTES = 1.5 * 1024 * 1024;

export function detectType(file) {
  if (TYPES[file.type?.split('/')[1]]) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return TYPES[ext] || '';
}

function isHeic(file) {
  return /image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

// Returns { file, width, height, note } ready to upload, or throws Error with an operator-readable reason.
export async function prepareImage(file) {
  const type = detectType(file);
  if (!type && !isHeic(file)) throw new Error(`${file.name}: not a photo (JPEG, PNG or WebP).`);

  let bitmap;
  try {
    // imageOrientation applies the EXIF rotation so the model sees the photo upright.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      bitmap = await createImageBitmap(file); // browsers that reject the option can still decode the photo
    } catch {
      if (isHeic(file)) throw new Error(`${file.name}: HEIC photos can't be decoded in this browser. Set the camera to "Most Compatible" (JPEG) or export as JPEG.`);
      throw new Error(`${file.name}: the file could not be decoded as an image.`);
    }
  }

  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  // Small PNG/WebP pass through untouched. JPEGs always go through the canvas so EXIF rotation is baked in.
  if (type && type !== 'image/jpeg' && scale === 1 && file.size <= RECODE_ABOVE_BYTES) {
    bitmap.close?.();
    // Upload with a MIME type and extension that match the content; the backend checks both.
    const ext = type.split('/')[1];
    const matches = file.type === type && file.name.toLowerCase().endsWith(`.${ext}`);
    const named = matches ? file : new File([file], `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.${ext}`, { type });
    return { file: named, width, height, note: '' };
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNG/WebP areas would otherwise turn black in the JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
  if (!blob) throw new Error(`${file.name}: could not re-encode the photo.`);
  const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
  const note = scale === 1 && file.size <= RECODE_ABOVE_BYTES ? '' : `${width}×${height} · ${(file.size / 1048576).toFixed(1)} MB → ${canvas.width}×${canvas.height} · ${(blob.size / 1048576).toFixed(1)} MB`;
  return { file: new File([blob], `${base}.jpg`, { type: 'image/jpeg' }), width: canvas.width, height: canvas.height, note };
}
