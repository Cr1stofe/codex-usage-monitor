import * as vscode from 'vscode';
import { SessionReader, resolveCodexHome } from './reader';
import { presentLimits } from './presentation';
import { selectSession, sessionsForWorkspace } from './session-selection';
import type { MonitorState } from './quota';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Codex Limits — Diagnostics');
  const limits = vscode.window.createStatusBarItem('codexLimits.usage', vscode.StatusBarAlignment.Right, 101);
  limits.name = 'Codex — usage limits';
  limits.command = 'codexTokensMonitor.menu';
  limits.show();
  let reader: SessionReader | undefined;
  let state: MonitorState;
  let pinnedSessionId = context.workspaceState.get<string>('pinnedSessionId');
  const workspaceSessions = (): NonNullable<MonitorState['sessions']> => sessionsForWorkspace(
    state.sessions ?? [], (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath),
  );
  const render = (next: MonitorState): void => {
    state = next;
    const session = selectSession(workspaceSessions(), pinnedSessionId);
    const presentation = presentLimits(next, Date.now(), session);
    limits.text = presentation.text;
    limits.tooltip = `${presentation.tooltip}\n${session ? `${pinnedSessionId ? 'Pinned conversation' : 'Most recently updated token count in this project'}: ${session.id.slice(-8)}`
      : pinnedSessionId ? 'The pinned conversation is not available in this project.' : 'No local Codex conversation found in this project.'}\nAutomatic selection may not match the visible chat.`;
    limits.backgroundColor = presentation.severity === 'normal' ? undefined
      : new vscode.ThemeColor(`statusBarItem.${presentation.severity}Background`);
    limits.accessibilityInformation = { label: presentation.text };
  };
  const restart = (): void => {
    reader?.dispose();
    reader = undefined;
    render({ status: 'loading', snapshot: null, checkedAt: null, filesTracked: 0, issues: [] });
    if (process.platform !== 'darwin' || vscode.env.remoteName) {
      render({ ...state, status: 'error', issues: ['UNSUPPORTED_ENVIRONMENT'] });
      return;
    }
    try {
      const home = resolveCodexHome(vscode.workspace.getConfiguration('codexTokensMonitor').get<string>('codexHome', ''));
      reader = new SessionReader(home, render);
      reader.start();
    } catch {
      render({ ...state, status: 'error', issues: ['INVALID_HOME'] });
    }
  };
  context.subscriptions.push(output, limits, { dispose: () => reader?.dispose() },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codexTokensMonitor.codexHome')) restart();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => render(state)),
    vscode.commands.registerCommand('codexTokensMonitor.selectSession', async () => {
      const sessions = workspaceSessions();
      const options = [
        { label: '$(sync) Follow most recent', description: 'Most recently updated token count in this project', id: '' },
        ...sessions.map((session) => ({
          label: `$(comment-discussion) Conversation ${session.id.slice(-8)}`,
          description: `Updated ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(session.recordedAt)}`,
          detail: `Total: ${new Intl.NumberFormat('en-GB').format(session.total)} tokens${pinnedSessionId === session.id ? ' • pinned' : ''}`,
          id: session.id,
        })),
      ];
      const selection = await vscode.window.showQuickPick(options, { title: 'Select Codex conversation' });
      if (!selection) return;
      pinnedSessionId = selection.id || undefined;
      await context.workspaceState.update('pinnedSessionId', pinnedSessionId);
      render(state);
    }),
    vscode.commands.registerCommand('codexTokensMonitor.refresh', async () => {
      if (reader) await reader.refresh(); else restart();
    }),
    vscode.commands.registerCommand('codexTokensMonitor.settings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-codex-tools.codex-tokens-monitor')),
    vscode.commands.registerCommand('codexTokensMonitor.diagnostics', () => {
      output.clear();
      output.appendLine(JSON.stringify({
        status: state.status, lastLocalRead: state.checkedAt === null ? null : new Date(state.checkedAt).toISOString(),
        lastQuotaRecord: state.snapshot ? new Date(state.snapshot.recordedAt).toISOString() : null,
        filesTracked: state.filesTracked, issues: state.issues,
        note: 'Local records are read every 30s. No account request is made. See the README for diagnostic codes.',
      }, null, 2));
      output.show(true);
    }),
    vscode.commands.registerCommand('codexTokensMonitor.menu', async () => {
      const options = [
        { label: '$(comment-discussion) Select conversation', description: 'Choose the conversation for token counts', command: 'codexTokensMonitor.selectSession' },
        { label: '$(refresh) Refresh', description: 'Reread local files', command: 'codexTokensMonitor.refresh' },
        { label: '$(settings-gear) Open settings', command: 'codexTokensMonitor.settings' },
        { label: '$(output) View diagnostics', command: 'codexTokensMonitor.diagnostics' },
      ];
      const selection = await vscode.window.showQuickPick(options, { title: 'Codex Limits Monitor' });
      if (selection) await vscode.commands.executeCommand(selection.command);
    }),
  );
  restart();
}
