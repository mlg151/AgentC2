import { useEffect, useId, useState } from 'react';

export function ChatModelSelector({ model, disabled, onChange }: { model: string | null; disabled: boolean; onChange: (model: string) => void }) {
  const [draft, setDraft] = useState(model || '');
  const [recent, setRecent] = useState<string[]>(model ? [model] : []);
  const list = useId();
  useEffect(() => {
    setDraft(model || '');
    if (model) setRecent((values) => [...new Set([model, ...values])].slice(0, 10));
  }, [model]);
  const valid = Boolean(draft) && draft.length <= 200 && !/[\x00-\x20\x7f]/.test(draft);
  return <form className="chat-model-selector" onSubmit={(event) => { event.preventDefault(); if (!disabled && valid && draft !== model) onChange(draft); }}>
    <label>Model<input aria-label="Chat model" list={list} value={draft} maxLength={200} placeholder="Provider default" disabled={disabled} onChange={(event) => setDraft(event.target.value)} /></label>
    <datalist id={list}>{recent.map((value) => <option key={value} value={value} />)}</datalist>
    <button type="submit" disabled={disabled || !valid || draft === model}>Apply model</button>
    <small>Enter an available model ID or choose a recently used model. Applies to the next turn.</small>
  </form>;
}
