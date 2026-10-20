import type { Provider } from '../types';

const names: Record<Provider, string> = {
  codex: 'C', claude: '✳', antigravity: 'A', terminal: '>_',
};

export function ProviderMark({ provider, small = false }: { provider: Provider; small?: boolean }) {
  return <span aria-label={provider} className={`provider-mark provider-${provider}${small ? ' provider-mark-small' : ''}`}>{names[provider]}</span>;
}
