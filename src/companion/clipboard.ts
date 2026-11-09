export async function readPhoneClipboard(): Promise<string> {
  if (navigator.clipboard) return navigator.clipboard.readText();
  return window.prompt('Paste text from your clipboard') || '';
}

export async function writePhoneClipboard(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea');
  input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Copy is unavailable. Select and copy the text manually.');
  } finally { input.remove(); }
}
