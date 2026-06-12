# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# tech-stack
- Use Electron + React + TypeScript + Vite for the desktop IDE. Confidence: 0.50

# electron
- Use colon-delimited IPC channel names like dialog:openFolder and fs:readFile. Confidence: 0.65
- Keep all filesystem access in the Electron main process; the renderer must not use Node fs directly. Confidence: 0.70
- For streaming data from main to renderer (e.g., terminal output), use event subscriptions via ipcRenderer.on in preload, exposing callback-based methods like onData(cb) and onExit(cb). Confidence: 0.75
- On Windows, normalize resolved paths with lowercase comparison in safeResolvePath to avoid case-sensitivity edge cases. Confidence: 0.70
- On Windows, spawn command-code directly (or command-code.cmd) without wrapping in cmd.exe /c. Confidence: 0.70

# code-style
- Use nullish coalescing (??) instead of logical OR (||) for default values like fileSnapshots.get(resolved) ?? ''. Confidence: 0.65
- Use child_process execFile/execFileSync instead of shell string concatenation for spawning external commands to avoid shell injection. Confidence: 0.70

# electron-builder
- Use npmRebuild: true instead of nodeGypRebuild for native module rebuilding, and unpack node-pty from asar via asarUnpack: ["node_modules/node-pty/**/*"]. Confidence: 0.80

# workflow
- Avoid broad refactors when adding features; make minimal, targeted changes. Confidence: 0.85
- After making code changes, run npm run build to verify the build passes before marking work as complete. Confidence: 0.70
- For new feature areas, build the UI shell/mock first before wiring up real backend or persistent storage. Confidence: 0.65

# ux-architecture
- Design UI with agent/chat as the primary center experience, editor/diff as a secondary pane, collapsible file explorer as a right-side drawer, and a left session rail with project/session navigation (Codex-style layout). Confidence: 0.70

# npm
- When source code imports types from a package directly (e.g., monaco-editor), list it as an explicit dependency in package.json rather than relying on it being an indirect/peer dependency. Confidence: 0.70

# electron
- Separate cleanup refs for filesystem watcher listeners vs agent terminal event listeners; do not mix fs:onFileChanged and agent:onData/onExit cleanup. Confidence: 0.75
- Register agent terminal listeners (onAgentData, onAgentExit, onAgentError) before calling startAgent or restartAgent to prevent early terminal output from being dropped. Confidence: 0.75

