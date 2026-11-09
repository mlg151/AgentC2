import { useState } from 'react';
import type { DevUrl } from '../types';
import type { CompanionClient } from './client';

export function PhoneDevUrls({ client, sessionKey, target, connected }: { client: CompanionClient; sessionKey: string; target: string | null; connected: boolean }) {
  const [urls, setUrls] = useState<DevUrl[] | null>(null);
  const [previewLink, setPreviewLink] = useState('');
  const [error, setError] = useState('');
  async function refresh() {
    setError('');
    try { setUrls(await client.request<DevUrl[]>('tunnel:list', sessionKey)); }
    catch (cause) { setError(String(cause)); }
  }
  async function open(url: string) {
    setError('');
    try { const preview = await client.request<string>('tunnel:open', target, url); setPreviewLink(preview); window.open(preview, '_blank', 'noopener,noreferrer'); }
    catch (cause) { setError(String(cause)); }
  }
  return <section className="phone-dev-urls" aria-label="Development previews"><button disabled={!connected} onClick={() => void refresh()}>Development previews</button>{urls ? <div className="phone-actions">{urls.length ? urls.map((item) => <button key={item.url} aria-label={`Open preview ${item.url}`} disabled={!connected || !target} onClick={() => void open(item.url)}>{item.url}</button>) : <p>No development URLs detected yet. Start a server in this session and refresh.</p>}</div> : null}{previewLink ? <a className="phone-preview-link" href={previewLink} target="_blank" rel="noopener noreferrer">Open development preview</a> : null}{error ? <p role="alert" className="phone-error">{error}</p> : null}</section>;
}
