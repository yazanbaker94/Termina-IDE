# Changelog

## v0.1.0 — Initial Release

### IDE Shell
- Electron + React + TypeScript + Vite desktop app
- File explorer with recursive tree view
- Monaco editor with syntax highlighting and Ctrl+S save
- Resizable panels (sidebar, editor, agent panel with drag handle)
- Dark Catppuccin-inspired theme
- Bottom status bar with project, file, language, save status, and git branch

### Agent Terminal
- Embedded xterm.js terminal running Command Code CLI via node-pty
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
- Command Code CLI must be installed and on PATH
- Windows packaging requires Visual Studio Build Tools with C++ workload
