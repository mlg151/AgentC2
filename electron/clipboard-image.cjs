const { validatePng, PNG_LIMIT } = require('./image-upload.cjs');

async function readClipboardPng(clipboard, nativeImage) {
  const items = await clipboard.read();
  for (const item of items) {
    const type = ['image/png', 'image/jpeg'].find((candidate) => item.types.includes(candidate));
    if (!type) continue;
    const blob = await item.getType(type);
    if (blob.size > PNG_LIMIT) throw new Error('Clipboard image is larger than 8 MB');
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    if (image.isEmpty()) throw new Error('Clipboard image could not be decoded');
    const { width, height } = image.getSize();
    if (!width || !height || width > 10000 || height > 10000 || width * height > 24_000_000) throw new Error('Clipboard image dimensions exceed the supported limit');
    const png = image.toPNG();
    validatePng(png);
    return png;
  }
  return null;
}

module.exports = { readClipboardPng };
