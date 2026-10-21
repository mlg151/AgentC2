import type { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';

// Use the same activation for detected URLs and explicit OSC 8 hyperlinks.
// Electron routes these new-window requests to the system browser.
function openLink(_event: MouseEvent, uri: string, openDevUrl?: (url: string) => void) {
  try {
    const url = new URL(uri);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (openDevUrl && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}(?=[/?#]|$)/i.test(uri)) openDevUrl(uri);
      else window.open(url.href, '_blank', 'noopener,noreferrer');
    }
  } catch { /* Terminal output can contain malformed or unsupported links. */ }
}

export function enableTerminalLinks(terminal: Terminal, openDevUrl?: (url: string) => void) {
  const activate = (event: MouseEvent, uri: string) => openLink(event, uri, openDevUrl);
  terminal.options.linkHandler = { activate };
  terminal.loadAddon(new WebLinksAddon(activate));
}
