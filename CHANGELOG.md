# Changelog

## Unreleased

### Smoothness fixes (terminal no longer twitches when opening side panel / code files)
- xterm `initTerminal` no longer depends on `terminalBuffer`, so the terminal is not recreated on every data event. Latest buffer is read via `terminalBufferRef` on first init.
- xterm `syncResize` coalesces calls through `requestAnimationFrame` to absorb the burst of ResizeObserver fires that happens when the right-dock opens/closes.
- ResizeObserver effect on the terminal container debounces via RAF and cleans up pending RAF/timer on unmount.
- `Editor` now renders Monaco directly (no parent-driven loading branch). Monaco's own `loading` state handles brief load, eliminating the intermediate layout pass that caused the right-dock to grow then settle.
- `App.handleFileSelect` defers `setIsLoading(true)` until after the diff is cleared and only around the read call, removing the extra re-render.
- CSS layout hardening: `contain: layout` on `.app-body`, `.app-main`, `.agent-region`, `.right-dock`, and `.dock-pane` isolates layout shifts so the terminal does not twitch when child panes reflow.
- Fixed pre-existing invalid DOM nesting (`<button>` inside `<button>`) in `SessionRail`.

### Smooth open/close of the right-dock (no more abrupt CLI resize, animated transition)
- Switched `.app-main` from flex to CSS grid (`grid-template-columns: minmax(0, 1fr) var(--right-dock-width, 0px)`) with `transition: grid-template-columns 0.15s cubic-bezier(0.2, 0, 0, 1)` on the column. The agent-region and the right-dock now share the row, and the dock's column animates between `0px` and the measured dock content width.
- The right-dock is now **always rendered**. The `collapsed` class hides inner panes via `visibility: hidden; pointer-events: none` so they don't intercept clicks while invisible. This eliminates React unmount/remount during toggle, which was the main cause of the visible "refresh" in the CLI.
- `App` measures the dock's content width (sum of `.dock-pane` widths) and writes it to `--right-dock-width` on `.app-main`. A `ResizeObserver` keeps this in sync as the dock's contents change (e.g. switching between files-drawer and code-pane).
- **Mid-transition rewrap suppression**: `App` sets a `dockTransitioningRef.current = true` flag and adds an `is-dock-transitioning` class to `.app-main` at the start of every dock open/close, and clears both on `transitionend` (with a 220ms safety timeout). `AgentPanel.syncResize` checks this ref and **skips `term.resize()` while transitioning**. This stops the xterm buffer from being rewrapped on every animation frame as the agent-region's width changes — the terminal content stays put during the slide and is laid out exactly once at the end. This eliminates the "CLI restarts for a sec and comes back" feel.
- The dock-resize signal to AgentPanel is now fired on the `transitionend` event of `grid-template-columns`. xterm only refits **once, at the end of the transition**, so the terminal never rewraps mid-animation.
- The Files toolbar button now actually opens and closes the dock (the always-mounted layout makes the click handler's state change visible immediately).

### Smart session auto-naming
- Replaced the old `buildChatTitle` helper with a dedicated `src/utils/sessionNaming.ts` module that handles the full range of messy real-world prompts.
- **Prompt-based naming (AgentPanel)**: on the first Enter, the new `extractTitleFromPrompt` utility strips fenced code blocks, inline backticks, `@`-mentions, URLs, file paths, and orphan file extensions. It then drops up to 3 leading noise tokens (shell commands, shell operators, path-like tokens, common directory names, generic greetings/farewells) before extracting the first sentence. Titles are truncated to 7 words / 42 chars on a word boundary, then sentence-cased. This means a prompt like `cd src && explain @/auth/login.tsx refactor` becomes `Explain refactor`, and `hi, can you fix the login bug` becomes `Can you fix the login bug`.
- **Agent-response-based naming (App)**: a new effect watches each session's `terminalBuffer` and, once it crosses 200 chars, extracts a title from the first non-code line of the agent's reply using `extractTitleFromAgentResponse`. This catches sessions where the user just pressed Enter without typing (e.g. to wake the agent) or where the first prompt was too weak to title. Runs at most once per session via `agentResponseNamingRef`.
- **Manual rename preservation**: a new `isDefaultLabel` helper checks for `Chat N` or `Untitled` and is used by both the prompt-based and agent-response-based rename paths. Once a user manually renames a session, neither auto-naming path will touch it.
- **Deduplication**: `deduplicateTitle` appends `(2)`, `(3)`, etc. when a proposed title collides with an existing sibling session. Case-insensitive matching, finds the lowest free suffix.
- **Project-name fallback**: `buildContextualTitle` falls back to the project name when neither the prompt nor the agent response yields a usable title.
- The old `buildChatTitle` function in `AgentPanel.tsx` has been removed (it was a 20-line function with hardcoded heuristics; the new utility covers all its cases and more).

### Test infrastructure
- Added Vitest + jsdom + Testing Library.
- `npm test` runs 86 unit + integration + source-shape tests covering: terminal recreation prevention, resize coalescing, grid transition CSS, dock resize timing via `transitionend`, mid-transition rewrap suppression, toolbar toggle behavior, store persistence, CLI debug logger/overlay, session auto-naming extraction/dedup/manual-override, and App-level smoke tests.
- `npm run typecheck` and `npm run build` both pass clean.

### Debug instrumentation (live overlay to diagnose CLI "flash"/"restart" issues)
- Added `src/debug/cliDebug.ts` — a lightweight event logger that captures terminal lifecycle, resize, fit, buffer-write, and dock-transition events with millisecond-precision deltas.
- Added `src/debug/CliDebugOverlay.tsx` — a fixed-position overlay in the bottom-right of the viewport that streams events live as you interact with the app. Color-coded by event type (init, dispose, resize, fit, buffer write, dock transition). Has clear/off buttons and auto-scroll that pauses when you scroll up.
- **Enable it** by appending `?debug=cli` to the app URL (e.g. `http://localhost:5173/?debug=cli` in dev) or by running `cliDebug.enable()` in the devtools console. You can also set `localStorage.setItem('termina-debug-cli', '1')` and reload.
- Logged events include: `terminal:initStart`, `terminal:innerHTMLCleared`, `terminal:bufferWritten`, `terminal:initDone`, `terminal:dispose`, `terminal:effectRun`, `terminal:effectCleanup`, `terminal:resizeSignalEffect`, `terminal:fitRequested`, `terminal:fitSkipped` (with reason), `terminal:fitNoop`, `terminal:resize` (with fromCols/fromRows/toCols/toRows), `terminal:dataWrite`, `dock:stateChange`, `dock:transitionStart`, `dock:transitionEnd`, `dock:transitionSafetyTimeout`, `dock:widthChange` (from→to pixel values), `dock:noMain`.
- When you see the CLI "flash off and on" while toggling files or opening files, the overlay will show exactly which events fired in what order and how many `term.resize` calls happened — making it possible to pinpoint whether the flash is from a re-init, a rewrap, a mid-transition refit, or something else entirely.

## v0.1.0 — Initial Release

### IDE Shell
- Electron + React + TypeScript + Vite desktop app
- File explorer with recursive tree view
- Monaco editor with syntax highlighting and Ctrl+S save
- Resizable panels (sidebar, editor, agent panel with drag handle)
- Dark Catppuccin-inspired theme
- Bottom status bar with project, file, language, save status, and git branch

### Agent Terminal
- Embedded xterm.js terminal via node-pty
- Start, stop, and restart agent from toolbar
- Auto-resize terminal on window/panel resize

### File Watching
- Chokidar-based file system watcher
- Changed files list in agent panel (added, changed, deleted)
- Click to view before/after diff
- Revert individual files to pre-agent state
- Auto-reload editor when files change on disk (preserves unsaved edits)

### Git Integration
- Git status display with branch name
- File list with staged / unstaged / untracked indicators
- Stage and unstage individual files
- Commit with message input (Enter or button)
- Bottom bar commit success/failure feedback

### Windows Packaging
- electron-builder with NSIS installer output
- Native node-pty module rebuild support (npmRebuild + asarUnpack)

### Known Requirements
- The `command-code` CLI must be installed and on PATH
- Windows packaging requires Visual Studio Build Tools with C++ workload
