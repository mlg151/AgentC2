import type { ChatApi } from './chatTypes';
import type { CompanionClient } from './companion/client';

export function chatCommandId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const desktopChatApi: ChatApi = {
  open: (id, hostId) => window.agentHQ!.openChat(id, hostId),
  ready: (id, after) => window.agentHQ!.readyChat(id, after),
  history: (id, after, limit) => window.agentHQ!.chatHistory(id, after, limit),
  take: (id) => window.agentHQ!.takeChat(id),
  submit: (id, command) => window.agentHQ!.submitChat(id, command),
  receipt: (id, commandId) => window.agentHQ!.chatReceipt(id, commandId),
  close: (id) => window.agentHQ!.closeChat(id),
  onEvents: (callback) => window.agentHQ!.onChatEvents(callback),
  onState: (callback) => window.agentHQ!.onChatState(callback),
};

export function companionChatApi(client: CompanionClient): ChatApi {
  return {
    open: (id, hostId) => client.request('chat:open', id, hostId),
    ready: (id, after) => client.request('chat:ready', id, after),
    history: (id, after, limit) => client.request('chat:history', id, after, limit),
    take: (id) => client.request('chat:take', id),
    submit: (id, command) => client.request('chat:submit', id, command),
    receipt: (id, commandId) => client.request('chat:receipt', id, commandId),
    close: (id) => client.request('chat:close', id),
    onEvents: (callback) => client.on('chat:events', (value) => callback(value as Parameters<typeof callback>[0])),
    onState: (callback) => client.on('chat:state', (value) => callback(value as Parameters<typeof callback>[0])),
  };
}

export function chatLink(url: string) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch { return undefined; }
}
