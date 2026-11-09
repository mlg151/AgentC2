/** Normalize a phone photo to the bounded PNG format accepted by the gateway. */
export async function imagePayload(file: File): Promise<string> {
  if (!file.type.startsWith('image/') || file.size > 768 * 1024) throw new Error('Choose an image no larger than 768 KB');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image conversion is unavailable on this device');
    context.drawImage(bitmap, 0, 0);
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    if (base64.length > Math.ceil(768 * 1024 / 3) * 4) throw new Error('Converted image exceeds 768 KB');
    return base64;
  } finally { bitmap.close(); }
}
