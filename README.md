# Codex Limits Monitor

A personal macOS VS Code extension that displays used percentages of the Codex five-hour and weekly plan limits and reset countdowns in the status bar, with conversation token usage in the tooltip.

Example: **5h 40% · 2h30  |  Week 15% · 3d**. Percentages are used quota; the time after each dot is the time until renewal. Hover to see remaining quota and conversation token usage. The interface is in English.

## Install locally

1. Run `npm ci` and `npm run check`.
2. Run `npm run package`. The VSIX is written to `artifacts/codex-tokens-monitor-0.1.0.vsix`.
3. In VS Code, open the Extensions view, select **… → Install from VSIX…**, and select that file.
4. Reload VS Code if prompted. Both limits appear together in the bottom status bar.

You can also install with `code --install-extension artifacts/codex-tokens-monitor-0.1.0.vsix`. To update an existing installation, append `--force` and run **Developer: Reload Window** in VS Code.

Requires VS Code 1.96 or newer, local macOS, and local Codex session records. Node.js 22.14+ is recommended for development and packaging. No separate runtime, API key or account login is needed for this extension.

## Use

Hover over the indicator to see used and remaining percentages for both limits, exact reset times in your system timezone, token breakdown, and record timestamps. The token figure is cumulative for the selected conversation, not the number of tokens remaining in your plan. Click the indicator for:

- **Select conversation**: select a recent VS Code conversation from the current workspace, or return to automatic selection.
- **Refresh**: reread local files. This never requests fresh account data from OpenAI.
- **Open settings**: configure the Codex home directory.
- **View diagnostics**: show sanitized monitor state in an Output channel.

The background uses the theme's warning color if either limit has 20% remaining or less and its error color if either has 5% remaining or less. Missing windows display `—`. Once a recorded reset time has passed, the indicator displays **· pending** until a newer Codex record arrives. The extension does not assume a quota has reset to 100%. Countdown displays update at least every 30 seconds while the monitor is running.

By default, the token counter follows the eligible local VS Code conversation whose token count was updated most recently within an open workspace folder. This is a heuristic and may not match the chat currently visible in the Codex extension. Use the menu to pin a different session; its ID is saved in workspace state. A pinned session that disappears or belongs to another workspace shows `—` rather than switching to a different conversation. Without an open workspace or an eligible session, token usage is unavailable. The picker identifies conversations by an abbreviated session ID and last token update time.

Input, output and total token counts are cumulative values reported by Codex for the conversation. Cached input is part of input, and reasoning output is part of output; they are displayed as details and are not added to the total. Values update only when Codex writes a token event and are not guaranteed to update continuously while a response is generated.

## Configuration

Set `codexTokensMonitor.codexHome` to an absolute local Codex home directory, for example `~/custom-codex`. Select the home directory, not its `sessions` subdirectory.

Resolution order:

1. Nonempty `codexTokensMonitor.codexHome` setting.
2. Nonempty `CODEX_HOME` environment variable inherited by VS Code.
3. `~/.codex`.

The setting is machine scoped. Invalid relative paths display an error in the diagnostic output. Setting changes restart the reader automatically. Restart VS Code after changing its inherited environment variables.

## How it works

The reader streams `.jsonl` files under `<codexHome>/sessions` and ignores symbolic links during discovery. For quota limits it extracts `event_msg` / `token_count` events with `rate_limits.limit_id` equal to `codex`. It recognizes the windows by `window_minutes` values of 300 and 10080, regardless of their primary/secondary position. The latest valid event by its timestamp wins across all projects. A missing window in that event stays unavailable; it is not filled from an older sample. For conversation tokens, it uses session metadata and cumulative token events from local VS Code sessions, excluding subagents.

Files are initially read in 64 KiB chunks. Subsequent reads keep byte offsets and incomplete-line buffers in memory. File identity, size, and a trailing byte checkpoint detect replacement and truncation. Lines over 1 MiB are skipped to bound memory usage. File watching schedules updates after 250 ms; a reconciliation every 30 seconds handles missed changes and directory recovery. Timers, watchers and open reads are stopped or allowed to close on deactivation.

## Privacy and limitations

- No telemetry, network requests, credential reads, transcript copies, or persisted quota cache.
- Parsing necessarily reads transcript bytes, but only quota fields, token totals, session IDs, workspace paths and file metadata are retained in memory. When a session is pinned, its ID is stored in VS Code's workspace state. Diagnostics omit file paths, messages, account details and raw errors.
- Limits belong to the account, not the open workspace or chat. One account per Codex home is assumed. Records from a previous account may remain; account switching is not supported.
- Data can be stale while Codex is idle or when usage happens on another device. Last local read time is not the same as last quota update time.
- This is not an official OpenAI extension. The local JSONL format is not a stable public API and may change after a Codex update. Unsupported records are ignored.
- Only local macOS use is supported in v0.1. Remote windows, WSL, containers, Windows, Linux, multiple accounts and Marketplace publishing are out of scope.
- Reset times and event ordering rely on valid timestamps in the local records. An unknown reset time is explicitly shown as unavailable.

## Diagnostics

`ready` means the last scan completed, even if no quota event was found. `warning` means an oversized line was skipped but reading continued; available limits remain visible. `missing` means the sessions directory is absent. `error` means the last scan encountered a filesystem or watching error, even if an oversized-line warning was also recorded; an available snapshot can still be displayed with a tooltip warning. The monitor retries automatically every 30 seconds. Issues describe the last scan, so a skipped-line warning clears on a subsequent scan without that issue.

| Code | Meaning / action |
| --- | --- |
| `ENOENT`, `ENOTDIR` | Sessions directory or a file disappeared. Check the configured home and run a local Codex conversation. |
| `EACCES`, `EPERM` | macOS denied access. Check directory permissions. |
| `EMFILE`, `ENOSPC`, `IO_ERROR` | A filesystem resource or read failed. Retry after resolving the local filesystem issue. |
| `WATCH_UNAVAILABLE` | File watching failed; 30-second reconciliation remains active. |
| `OVERSIZED_LINE_SKIPPED` | Warning: a line exceeded 1 MiB and was skipped; subsequent lines are still read. By itself, this does not set the monitor to `error`. |
| `INVALID_HOME` | Use an absolute directory or a path beginning with `~/`. |
| `UNSUPPORTED_ENVIRONMENT` | Use a local macOS VS Code window. |

## Development

```sh
npm ci
npm run check
npm run package
```

Press **F5** in this project to launch an Extension Development Host. The launch task builds the extension first. The implementation separates the session reader, quota interpretation and status presentation; it exposes no public extension API.

Tests use synthetic records in temporary directories and cover window parsing, percentages, expiration, file streaming, incomplete and oversized lines, out-of-order snapshots, new sessions, replacement, truncation, missing directories, file watching and disposal.

The lockfile pins the packaging toolchain. Its Azure authentication dependency uses an override for a patched CommonJS-compatible `uuid` version; that dependency only calls `v4()`. None of these development dependencies are included in the VSIX.

For visual acceptance, launch the development host with a real local Codex home, run a Codex conversation and compare the tooltip with the latest available limits. Changes should appear within 35 seconds of a record being written. Verify both light and dark themes, the clickable menu, configuration changes, missing directories and deactivation. Actual quota freshness depends on Codex writing a new event.
