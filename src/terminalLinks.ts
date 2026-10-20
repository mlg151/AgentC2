import type { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';

// Use the same activation for detected URLs and explicit OSC 8 hyperlinks.
// Electron routes these new-window requests to the system browser.
function openLink(_event: MouseEvent, uri: string) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    }
  } catch { /* Terminal output can contain malformed or unsupported links. */ }
}

export function enableTerminalLinks(terminal: Terminal) {
  terminal.options.linkHandler = { activate: openLink };
  terminal.loadAddon(new WebLinksAddon(openLink));
}
