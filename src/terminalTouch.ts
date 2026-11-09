import type { Terminal } from '@xterm/xterm';

// xterm 6.0 does not register its touch target. Browse retained local history
// without sending terminal input or changing the remote controller.
export function enableTerminalTouchScroll(terminal: Terminal, node: HTMLElement) {
  let touch: { id: number; x: number; y: number; remainder: number; vertical: boolean } | null = null;
  const touchStart = (event: TouchEvent) => {
    const point = event.touches.length === 1 ? event.touches[0] : null;
    touch = point ? { id: point.identifier, x: point.clientX, y: point.clientY, remainder: 0, vertical: false } : null;
  };
  const touchMove = (event: TouchEvent) => {
    if (!touch || event.touches.length !== 1) { touch = null; return; }
    const point = event.touches[0];
    if (point.identifier !== touch.id) return;
    const dy = point.clientY - touch.y;
    if (!touch.vertical) {
      const dx = point.clientX - touch.x;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      if (Math.abs(dx) > Math.abs(dy)) { touch = null; return; }
      touch.vertical = true;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    const screen = terminal.element?.querySelector('.xterm-screen');
    const rowHeight = (screen?.clientHeight || node.clientHeight) / terminal.rows;
    if (!rowHeight) return;
    const delta = touch.remainder - dy / rowHeight;
    const lines = Math.trunc(delta);
    touch.remainder = delta - lines; touch.y = point.clientY;
    if (lines) terminal.scrollLines(lines);
  };
  const touchEnd = () => { touch = null; };
  node.addEventListener('touchstart', touchStart, { capture: true, passive: true });
  node.addEventListener('touchmove', touchMove, { capture: true, passive: false });
  node.addEventListener('touchend', touchEnd, true); node.addEventListener('touchcancel', touchEnd, true);
  return () => {
    node.removeEventListener('touchstart', touchStart, true); node.removeEventListener('touchmove', touchMove, true);
    node.removeEventListener('touchend', touchEnd, true); node.removeEventListener('touchcancel', touchEnd, true);
  };
}
