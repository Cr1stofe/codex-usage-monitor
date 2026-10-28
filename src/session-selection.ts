import { isAbsolute, relative, resolve } from 'node:path';
import type { SessionUsage } from './quota';

export function sessionsForWorkspace(sessions: readonly SessionUsage[], workspaceRoots: readonly string[]): SessionUsage[] {
  return sessions.filter((session) => isAbsolute(session.cwd) && workspaceRoots.some((root) => {
    const fromRoot = relative(resolve(root), resolve(session.cwd));
    return fromRoot === '' || (!fromRoot.startsWith('..' + '/') && fromRoot !== '..' && !isAbsolute(fromRoot));
  })).sort((a, b) => b.recordedAt - a.recordedAt || a.id.localeCompare(b.id));
}

export function selectSession(sessions: readonly SessionUsage[], pinnedId: string | undefined): SessionUsage | null {
  return (pinnedId ? sessions.find((session) => session.id === pinnedId) : sessions[0]) ?? null;
}
