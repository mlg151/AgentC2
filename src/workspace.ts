import type { Session, SessionMetadata } from './types';

export const emptyMetadata: SessionMetadata = { pinned: false, project: '', notes: '' };
export function projectFor(session: Session, metadata: Record<string, SessionMetadata>) {
  return metadata[session.key]?.project || session.cwd || 'Ungrouped';
}
