// Fullscreen applications own their history. tmux copy mode can only browse
// the pane's normal buffer, which is often empty for Codex and Claude.
async function scrollTerminal(command, target, direction, count) {
  // Start with the numeric mode flag: control-mode notifications start with %.
  const format = '#{pane_in_mode}|#{pane_id}|#{alternate_on}|#{@hq_provider}|#{mouse_any_flag}|#{mouse_button_flag}|#{mouse_standard_flag}|#{mouse_sgr_flag}|#{pane_width}|#{pane_height}';
  const state = await command(`display-message -p -t ${target} "${format}"`);
  const [mode, pane, alternate, provider, anyMouse, buttonMouse, standardMouse, sgr, width, height] = state.trim().split('|');
  if (!/^%\d+$/.test(pane)) throw new Error('Could not locate terminal pane');
  const inMode = mode === '1';
  if (alternate === '1') {
    // Recover panes left in copy mode by an older AgentC2 scroll request.
    if (inMode) await command(`send-keys -t ${pane} -X cancel`);
    if (direction === 'latest') {
      if (provider === 'codex' || provider === 'claude') await command(`send-keys -t ${pane} C-End`);
    } else if (sgr === '1' && [anyMouse, buttonMouse, standardMouse].includes('1')) {
      // Bypass tmux's mouse setting so local drag selection stays available.
      // Send wheel events over the transcript, away from the pinned composer.
      const x = Math.max(1, Math.floor(Number(width) / 2));
      const y = Math.max(1, Math.floor(Number(height) / 3));
      const data = `\x1b[<${direction === 'up' ? 64 : 65};${x};${y}M`.repeat(Math.ceil(count / 3));
      await command(`send-keys -t ${pane} -H ${[...Buffer.from(data)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ')}`);
    } else {
      const pages = Math.max(1, Math.ceil(count / Math.max(1, Number(height) - 2)));
      await command(`send-keys -t ${pane} -N ${pages} ${direction === 'up' ? 'PPage' : 'NPage'}`);
    }
    return false;
  }
  if (direction === 'latest') {
    if (inMode) await command(`send-keys -t ${pane} -X cancel`);
    return false;
  }
  // Scrolling down at the live prompt must not enter copy mode and trap input.
  if (!inMode && direction === 'down') return false;
  if (!inMode) await command(`copy-mode -e -t ${pane}`);
  await command(`send-keys -t ${pane} -X -N ${count} scroll-${direction}`);
  return true;
}

module.exports = { scrollTerminal };
