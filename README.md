# TerminVox

One window, IDE-style: terminals live in a named group tree (left), open ones as tabs, with a status dot per terminal.

    npm install
    npm run tauri dev      # develop
    npm run tauri build    # .app / .dmg in src-tauri/target/release/bundle

## Shortcuts
| Keys | Action |
|---|---|
| ⌘P | Go to terminal (fuzzy) |
| ⌘R | Search shell command history; Enter puts the command on the prompt |
| ⌘J | Jump to next terminal waiting for you (yellow) |
| ⌘F | Find in the terminal (↩ / ⇧↩ or ⌘G / ⇧⌘G for next / previous, Esc closes) |
| ⌘T | New terminal in current group (Settings → New terminals can ask for its name first) |
| ⌘D | New terminal in a split pane beside the current one |
| ⌘G | Show or hide the uncommitted changes of the current terminal's repository |
| ⌥-click tab / terminal | Open it in a pane beside the current one (up to 4) |
| ⌥⌘← / ⌥⌘→ | Focus the pane on the left / right |
| ⌘W | Close tab (process keeps running) |
| ⌥⌘1–9 | Open group N (tabs = all its terminals) |
| ⌃Tab | Previous tab · ⌘⇧[ / ⌘⇧] cycle · ⌘1–9 tab N |
| ⌘, | Settings: font picker with preview, size, line height, ⌥ as Meta, copy-on-select, notifications, light and dark mode, color import from iTerm2, macOS Terminal, Windows Terminal, Ghostty, kitty and Alacritty |
| ⌘+ / ⌘− / ⌘0 | Font bigger / smaller / reset |
| ⇧Enter | Newline in Claude Code / Codex |
| Home / End, ⌘← / ⌘→ | Start / end of line (real keys in full-screen apps like vim) |
| ⌥← / ⌥→ | Word left / right |
| ⌘⌫ | Delete line |
| ⇧Insert / ⌃Insert | Paste / copy |

Selecting text copies it (setting). Drop files from Finder to paste their paths. Drag tabs to reorder.
Dock badge and macOS notification when a terminal needs you while the app is in the background.

The tab-stack button next to a group name replaces the tabs with that group's terminals (all started; other groups keep running in the background). Clicking single terminals still opens them as tabs from any group.

Double-click to rename groups/terminals, drag to move/reorder, ⚙ for folder + startup command (e.g. `claude --continue`). A group's ⚙ sets a startup script (e.g. `cd ~/work/my-project`) that is typed into each new terminal created in that group, once. ✕ deletes right away, or asks first if something in it is still running.

## Status dots
blue pulsing = output flowing · green = idle · yellow = needs you (bell/OSC 9 notification, or long run that went quiet while you weren't looking) · red ring = exited without you typing anything, such as a shell that failed to start (Enter restarts). Leaving a shell yourself (`exit`, Ctrl+D) closes its tab and deletes the terminal.

Saved automatically (human-readable JSON, safe to copy between machines):

| | macOS | Windows | Linux |
|---|---|---|---|
| `settings.json` (font, theme, options) | `~/Library/Application Support/dev.terminvox/` | `%APPDATA%\dev.terminvox\` | `~/.config/dev.terminvox/` |
| `layout.json` (groups, terminals, tabs) | same folder | same folder | `~/.local/share/dev.terminvox/` |

Each save keeps the previous version as `*.json.bak`. An unreadable file is set aside as `*.json.corrupt` and the `.bak` is loaded instead.

Processes don't survive app restart, but each terminal reopens where it was:
- **Folder:** the shell's own current folder, read from the OS every 5s and on quit (so inside `ssh` it's the local folder you connected from).
- **Agent session:** if Claude Code, Codex, Gemini CLI, OpenCode, Pi or Kimi was running, it starts again with its continue command (`claude --continue`, `codex resume --last`, `gemini --resume latest`, `opencode --continue`, `pi --continue`, `kimi --continue`). Editable in Settings → Restore on restart.
- **Flags:** on/off flags the agent was started with are kept (`claude --dangerously-skip-permissions` → `claude --continue --dangerously-skip-permissions`). Flags with a value (`--model opus`, `--model=opus`) are dropped, and so is any flag followed by a non-flag word, since a value and a prompt look the same on the command line. Can be turned off in Settings.
- Changing a terminal's Folder/Startup command in ⚙ overrides the remembered values. ⌘Q or closing the window lists terminals with a running program (claude, npm, …) and asks first; pressing ⌘Q twice always quits.

## Tests
    node tests/util.test.mjs

## Code
- `src-tauri/src/lib.rs` — PTYs (portable-pty), state file, menu
- `src/lib/store.svelte.ts` — tree, tabs, persistence
- `src/lib/terms.svelte.ts` — xterm.js instances, status heuristic
- `src/lib/Sidebar.svelte`, `src/routes/+page.svelte` — UI

## Sidebar

- A small tag next to a terminal (`claude`, `codex`, …) shows which agent is running in it right now; hover a terminal to see its current folder.
- Drag the sidebar's right edge to resize it; double-click the edge to reset.

## Split panes

⌘D or ⌥-click shows terminals side by side. Each pane has a header with its status dot; ✕ there closes only the pane (the tab and process stay). ⌘W on a split tab closes its pane too. Panes are saved with the layout.

## Changes pane

⌘G (or the ± button in the tab bar) opens a read-only pane to the right of the terminals with everything uncommitted in the focused terminal's git repository, compared with the last commit: staged and unstaged edits, plus new files. It reads like the "Files changed" tab on GitHub, one file after another, each with a header you can fold. It refreshes when you switch terminals, when the terminal stops working, when the window gets focus, and with its refresh button. It needs `git` on your PATH.

## Links

Click a web link in a terminal to open it in your browser. Click a file or folder path to show it in Finder (Explorer on Windows, the file manager on Linux): a folder is opened, a file is selected in its folder and never run. Only paths that exist on this machine become links; relative ones are looked up in the terminal's current folder. Links the program marks itself (agents do this) work the same way.

## Exact "waiting for you" status

Settings → *Exact “waiting for you” status* → **Install** adds a hook to Claude Code (`~/.claude/settings.json`: `UserPromptSubmit`, `Stop`, `Notification`) and/or Codex (`~/.codex/config.toml`: `notify`). A backup (`*.terminvox.bak`) is written first; **Remove** takes the hooks out again and leaves your own hooks alone. Codex is skipped if you already have your own `notify`.

Each terminal gets `TERMINVOX_NOTIFY` (a localhost URL with a random per-launch token); the hook calls it with `curl`, and is a silent no-op anywhere else. For Claude, the hook events replace the timing guess entirely. For Codex they only cover "turn finished", since Codex doesn't send approval prompts to `notify`. Other agents still use the guess.

## Windows

Everything above works on Windows too, with these differences:

| macOS | Windows |
|---|---|
| ⌘ + letter (⌘T, ⌘W, ⌘P, ⌘J, ⌘F, ⌘D, ⌘G) | Ctrl+Shift + letter (plain Ctrl+letter goes to the shell) |
| ⌘, / ⌘+ / ⌘− / ⌘0 | Ctrl+, / Ctrl+= / Ctrl+− / Ctrl+0 |
| ⌘1–9 tab, ⌥⌘1–9 group | Alt+1–9 tab, Ctrl+Alt+1–9 group |
| ⌘G / ⇧⌘G find next/previous | F3 / Shift+F3 |
| ⌘⇧[ / ⌘⇧] | Ctrl+PgUp / Ctrl+PgDn |
| ⌥⌘← / ⌥⌘→ panes, ⌥-click | Ctrl+Alt+← / →, Alt+click |
| ⌘C / ⌘V | Ctrl+Shift+C / V; Ctrl+C copies when text is selected (else interrupts), Ctrl+V pastes |
| Dock badge | Count in the window title (taskbar) + the taskbar button flashes |

- **Shell:** PowerShell 7 (`pwsh.exe`) if installed, else Windows PowerShell; pick another (cmd, Git Bash, WSL) in Settings → Shell.
- **Folder tracking:** PowerShell's `cd` doesn't change the process's folder, so TerminVox adds a tiny prompt hook that reports it (OSC 9;9, the same signal Windows Terminal uses); cmd gets an equivalent `PROMPT`. Other shells (Git Bash, WSL) aren't tracked yet.
- **Agent detection:** the shell's newest child process (through `cmd /c` shims like npm's `claude.cmd`).
- **Hooks:** Claude Code runs hooks through Git Bash, so the same hook works. Codex gets `~/.codex/terminvox-notify.ps1`, run with `-File` so the event text Codex appends is passed as data, never as code.

## Releasing (maintainers)

One-time: `brew install gh && gh auth login`, then `npm run setup-github` — creates the repo, a protected `release` environment (only `v*` tags, your approval required) and uploads the signing secrets to it.

Each release: `npm run release 0.2.0` → bumps versions, tags, pushes → approve the run in GitHub → Actions. The workflow builds a universal macOS app (signed + notarized), Windows and Linux installers, publishes the release, and installed copies offer "Restart to update".

The update signing key lives in `~/.tauri/terminvox.key` (+ `.password`) — never in the repo. Back it up: without it, installed copies can't be updated.

## License & trademark

The code is released under the [MIT License](LICENSE) — use, modify and redistribute it freely.

The MIT License covers the code only. The **TerminVox** name and logo are trademarks of Ivan Vetrau and are not licensed under it. Forks and derivative works are welcome, but must use a different name and logo, and must not suggest they are the official TerminVox. Unmodified copies of an official release may keep the name.
