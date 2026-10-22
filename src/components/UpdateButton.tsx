import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { AppUpdate } from '../types';

export function UpdateButton() {
  const [update, setUpdate] = useState<AppUpdate | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const check = () => { void window.agentHQ?.checkForUpdates?.().then((value) => { if (active) setUpdate(value); }).catch(() => {}); };
    check();
    const timer = window.setInterval(check, 60 * 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  if (!update?.available) return null;
  return <><button className="toolbar-button update-button" title={update.kind === 'release' ? 'Open GitHub to download the latest release' : 'Review changes on GitHub before updating your source build'} onClick={() => void window.agentHQ?.openUpdate().catch((cause) => setError(String(cause)))}><Download size={14} />{update.label}</button>{error ? <span role="alert">{error}</span> : null}</>;
}
