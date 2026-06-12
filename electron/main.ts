import { app, BrowserWindow, shell, dialog, ipcMain } from 'electron';
import path from 'path';
import fs from 'fs';
import * as pty from 'node-pty';
import { execSync, execFileSync } from 'child_process';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';

let mainWindow: BrowserWindow | null = null;
let rootPath: string | null = null;
const agentPtys = new Map<string, pty.IPty>();
const agentStopRequested = new Map<string, boolean>();
const sessionRoots = new Map<string, string>();
let fileWatcher: FSWatcher | null = null;
const sessionFileSnapshots = new Map<string, Map<string, string>>();

const MAX_DEPTH = 5;
const MAX_FILES = 2000;
const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'dist-electron', 'build', 'release', '.git', '.commandcode',
  'coverage', '__pycache__', '.next', '.nuxt', '.cache', '.vite',
]);
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.webm',
  '.gz', '.zip', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.pyc', '.class', '.o', '.obj',
  '.db', '.sqlite', '.sqlite3',
]);

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

let fileCount = 0;

function safeResolvePath(requestedPath: string): string {
  if (!rootPath) {
    throw new Error('No project folder is open.');
  }

  const resolved = path.resolve(requestedPath);
  const normalizedRoot = path.resolve(rootPath) + path.sep;

  const lowerResolved = resolved.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();

  if (!lowerResolved.startsWith(lowerRoot) && lowerResolved !== path.resolve(rootPath).toLowerCase()) {
    throw new Error('Access denied: file is outside the workspace folder.');
  }

  return resolved;
}

function buildFileTree(dirPath: string, depth: number = 0): FileNode | null {
  if (depth > MAX_DEPTH || fileCount >= MAX_FILES) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const children: FileNode[] = [];

  for (const entry of entries) {
    if (fileCount >= MAX_FILES) break;
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const subtree = buildFileTree(fullPath, depth + 1);
      if (subtree && subtree.children) {
        children.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children: subtree.children,
        });
      } else if (subtree) {
        children.push(subtree);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      fileCount++;
      children.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
      });
    }
  }

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    name: path.basename(dirPath),
    path: dirPath,
    type: 'directory',
    children,
  };
}

function getLanguage(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.html': 'html', '.htm': 'html',
    '.json': 'json', '.jsonc': 'json',
    '.md': 'markdown', '.mdx': 'markdown',
    '.py': 'python', '.rb': 'ruby',
    '.rs': 'rust', '.go': 'go',
    '.java': 'java', '.kt': 'kotlin',
    '.swift': 'swift',
    '.c': 'c', '.cpp': 'cpp', '.h': 'c',
    '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
    '.yml': 'yaml', '.yaml': 'yaml',
    '.xml': 'xml', '.svg': 'xml',
    '.sql': 'sql',
    '.graphql': 'graphql', '.gql': 'graphql',
  };
  return map[ext] || 'plaintext';
}

function sendToRenderer(channel: string, ...args: any[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function startFileWatcher() {
  stopFileWatcher();

  if (!rootPath) return;

  const ignored = [
    /[\\/]node_modules[\\/]/,
    /[\\/]dist[\\/]/,
    /[\\/]dist-electron[\\/]/,
    /[\\/]build[\\/]/,
    /[\\/]release[\\/]/,
    /[\\/]\.git[\\/]/,
    /[\\/]\.commandcode[\\/]/,
    /[\\/]__pycache__[\\/]/,
    /[\\/]\.next[\\/]/,
    /[\\/]\.nuxt[\\/]/,
    /[\\/]\.cache[\\/]/,
    /[\\/]\.vite[\\/]/,
  ];

  fileWatcher = chokidar.watch(rootPath, {
    ignored,
    ignoreInitial: true,
    depth: 10,
    persistent: true,
  });

  const emit = (eventType: string, filePath: string) => {
    const changeType = eventType === 'add' ? 'added' : eventType === 'change' ? 'changed' : 'deleted';
    sendToRenderer('fs:onFileChanged', { path: filePath, changeType });
  };

  fileWatcher.on('add', (p) => emit('add', p));
  fileWatcher.on('change', (p) => emit('change', p));
  fileWatcher.on('unlink', (p) => emit('unlink', p));
}

function stopFileWatcher() {
  if (fileWatcher) {
    try {
      fileWatcher.close();
    } catch {}
    fileWatcher = null;
  }
}

function captureFileSnapshots(sessionId: string, cwd: string) {
  const snaps = new Map<string, string>();
  sessionFileSnapshots.set(sessionId, snaps);

  let snapCount = 0;
  const MAX_SNAPSHOTS = 2000;

  const walk = (dir: string, depth: number) => {
    if (depth > 5 || snapCount >= MAX_SNAPSHOTS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapCount >= MAX_SNAPSHOTS) break;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        try {
          snaps.set(fullPath, fs.readFileSync(fullPath, 'utf-8'));
          snapCount++;
        } catch {}
      }
    }
  };

  walk(cwd, 0);
}

function resolveCommandCode(): { command: string; args: string[] } | null {
  const executable = process.platform === 'win32'
    ? 'command-code.cmd'
    : 'command-code';

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';

  try {
    const result = execSync(`"${whichCmd}" "${executable}"`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    const lines = result.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      return { command: lines[0].trim(), args: [] };
    }
  } catch {
    return null;
  }

  return null;
}

function startAgent(sessionId: string, cwd: string): { success: boolean; error?: string } {

  if (agentPtys.has(sessionId)) {
    return { success: true };
  }

  sessionRoots.set(sessionId, cwd);
  captureFileSnapshots(sessionId, cwd);

  const cols = 80;
  const rows = 24;
  const cmdInfo = resolveCommandCode();

  if (!cmdInfo) {
    return { success: false, error: 'Command Code CLI not found. Install it and make sure command-code is in your PATH.' };
  }

  let shellCmd: string;
  let shellArgs: string[];

  if (process.platform === 'win32') {
    shellCmd = cmdInfo.command;
    shellArgs = cmdInfo.args;
  } else {
    const shell = process.env.SHELL || '/bin/bash';
    shellCmd = shell;
    shellArgs = ['-c', `${cmdInfo.command} ${cmdInfo.args.join(' ')}`.trim()];
  }

  let spawnedPty: pty.IPty;
  try {
    spawnedPty = pty.spawn(shellCmd, shellArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd,
      env: { ...process.env } as { [key: string]: string },
    });
  } catch (err: any) {
    sessionRoots.delete(sessionId);
    return { success: false, error: `Failed to spawn agent: ${err.message}` };
  }

  agentPtys.set(sessionId, spawnedPty);
  agentStopRequested.set(sessionId, false);

  const owningSession = sessionId;

  spawnedPty.onData((data: string) => {
    sendToRenderer('agent:onData', { sessionId: owningSession, data });
  });

  spawnedPty.onExit(({ exitCode }: { exitCode: number }) => {
    const wasStopRequested = agentStopRequested.get(owningSession);
    if (wasStopRequested) {
      sendToRenderer('agent:onExit', { sessionId: owningSession, exitCode: -1 });
    } else {
      sendToRenderer('agent:onExit', { sessionId: owningSession, exitCode });
    }
    agentPtys.delete(owningSession);
    agentStopRequested.delete(owningSession);
    sessionRoots.delete(owningSession);
  });

  return { success: true };
}

function stopAgent(sessionId: string) {
  const p = agentPtys.get(sessionId);
  if (p) {
    agentStopRequested.set(sessionId, true);
    try {
      p.kill();
    } catch {
      // already dead
    }
    agentPtys.delete(sessionId);
    agentStopRequested.delete(sessionId);
    sessionRoots.delete(sessionId);
  }
}

function stopAllAgents() {
  for (const sessionId of [...agentPtys.keys()]) {
    stopAgent(sessionId);
  }
}

function getGitStatus() {
  if (!rootPath) return { isRepo: false, branch: null, files: [] };

  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: 5000,
    });

    const files: {
      path: string;
      absolutePath: string;
      gitPath: string;
      status: string;
      staged: boolean;
      unstaged: boolean;
      untracked: boolean;
    }[] = [];

    for (const line of output.split('\n')) {
      if (line.length < 3) continue;

      const X = line[0];
      const Y = line[1];
      const rawPath = line.slice(3).trim();

      const arrowIdx = rawPath.indexOf(' -> ');
      const destPath = arrowIdx !== -1 ? rawPath.slice(arrowIdx + 4) : rawPath;
      const absPath = path.resolve(rootPath, destPath);

      files.push({
        path: rawPath,
        absolutePath: absPath,
        gitPath: destPath,
        status: X + Y,
        staged: X !== ' ' && X !== '?',
        unstaged: Y !== ' ',
        untracked: X === '?' && Y === '?',
      });
    }

    return { isRepo: true, branch, files };
  } catch {
    return { isRepo: false, branch: null, files: [] };
  }
}

function setupIPC() {
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Open Project Folder',
    });

    if (result.canceled || !result.filePaths.length) return null;

    rootPath = result.filePaths[0];
    fileCount = 0;
    const tree = buildFileTree(rootPath);
    startFileWatcher();

    return {
      rootPath,
      projectName: path.basename(rootPath),
      tree,
    };
  });

  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    try {
      const resolved = safeResolvePath(filePath);
      const content = fs.readFileSync(resolved, 'utf-8');
      const ext = path.extname(resolved).toLowerCase();
      return {
        filePath: resolved,
        content,
        language: getLanguage(ext),
      };
    } catch (err: any) {
      throw new Error(`Cannot read file: ${err.message}`);
    }
  });

  ipcMain.handle('fs:saveFile', async (_event, filePath: string, content: string) => {
    try {
      const resolved = safeResolvePath(filePath);
      fs.writeFileSync(resolved, content, 'utf-8');
      return { success: true };
    } catch (err: any) {
      throw new Error(`Cannot save file: ${err.message}`);
    }
  });

  ipcMain.handle('agent:getStatus', async () => {
    const running: Record<string, { pid: number | null }> = {};
    for (const [sessionId, p] of agentPtys) {
      running[sessionId] = { pid: (p as any).pid ?? null };
    }
    return { running };
  });

  ipcMain.handle('agent:start', async (_event, sessionId: string, cwd: string) => {
    return startAgent(sessionId, cwd);
  });

  ipcMain.handle('agent:write', async (_event, sessionId: string, input: string) => {
    const p = agentPtys.get(sessionId);
    if (!p) return { success: false };
    p.write(input);
    return { success: true };
  });

  ipcMain.handle('agent:stop', async (_event, sessionId: string) => {
    stopAgent(sessionId);
    return { success: true };
  });

  ipcMain.handle('agent:restart', async (_event, sessionId: string) => {
    const cwd = sessionRoots.get(sessionId);
    if (!cwd) return { success: false, error: 'Session root not found.' };
    stopAgent(sessionId);
    return startAgent(sessionId, cwd);
  });

  ipcMain.handle('agent:resize', async (_event, sessionId: string, cols: number, rows: number) => {
    const p = agentPtys.get(sessionId);
    if (!p) return { success: false };
    if (!Number.isInteger(cols) || cols < 10 || cols > 500) return { success: false };
    if (!Number.isInteger(rows) || rows < 4 || rows > 200) return { success: false };
    try {
      p.resize(cols, rows);
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('fs:getFileTree', async () => {
    if (!rootPath) return null;
    fileCount = 0;
    const tree = buildFileTree(rootPath);
    return tree;
  });

  ipcMain.handle('diff:getFileDiff', async (_event, sessionId: string, filePath: string) => {
    const cwd = sessionRoots.get(sessionId);
    if (!cwd) return null;

    const resolved = path.resolve(cwd, filePath);
    const ext = path.extname(resolved).toLowerCase();
    const language = getLanguage(ext);
    const fileName = path.basename(resolved);
    const snaps = sessionFileSnapshots.get(sessionId);
    const wasSnapshotted = snaps?.has(resolved) ?? false;
    const beforeContent = snaps?.get(resolved) ?? '';

    let afterContent = '';
    let changeType: 'added' | 'changed' | 'deleted' = 'changed';

    try {
      afterContent = fs.readFileSync(resolved, 'utf-8');
      if (!wasSnapshotted) {
        changeType = 'added';
      }
    } catch {
      changeType = 'deleted';
    }

    return {
      filePath: resolved,
      fileName,
      beforeContent,
      afterContent,
      changeType,
      language,
    };
  });

  ipcMain.handle('diff:revertFile', async (_event, sessionId: string, filePath: string) => {
    const cwd = sessionRoots.get(sessionId);
    if (!cwd) return { success: false, action: 'none', filePath, existedInSnapshot: false };

    const resolved = path.resolve(cwd, filePath);
    const snaps = sessionFileSnapshots.get(sessionId);
    const wasSnapshotted = snaps?.has(resolved) ?? false;
    const beforeContent = snaps?.get(resolved) ?? '';

    if (wasSnapshotted) {
      try {
        const dir = path.dirname(resolved);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolved, beforeContent, 'utf-8');
        return { success: true, action: 'restored', filePath: resolved, existedInSnapshot: true };
      } catch (err: any) {
        return { success: false, action: 'none', filePath: resolved, existedInSnapshot: true };
      }
    }

    try {
      fs.accessSync(resolved);
      fs.unlinkSync(resolved);
      return { success: true, action: 'deleted', filePath: resolved, existedInSnapshot: false };
    } catch (err: any) {
      return { success: false, action: 'none', filePath: resolved, existedInSnapshot: false };
    }
  });

  ipcMain.handle('git:getStatus', async () => {
    return getGitStatus();
  });

  ipcMain.handle('git:stageFile', async (_event, repoRelativePath: string) => {
    if (!rootPath) return { success: false };
    const resolved = path.resolve(rootPath, repoRelativePath);
    safeResolvePath(resolved);
    try {
      execFileSync('git', ['add', '--', repoRelativePath], { cwd: rootPath, timeout: 10000 });
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('git:unstageFile', async (_event, repoRelativePath: string) => {
    if (!rootPath) return { success: false };
    const resolved = path.resolve(rootPath, repoRelativePath);
    safeResolvePath(resolved);
    try {
      execFileSync('git', ['reset', 'HEAD', '--', repoRelativePath], { cwd: rootPath, timeout: 10000 });
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('git:commit', async (_event, message: string) => {
    if (!rootPath) return { success: false, error: 'No project folder is open.' };
    if (!message || !message.trim()) return { success: false, error: 'Commit message is empty.' };
    try {
      execFileSync('git', ['commit', '-m', message.trim()], { cwd: rootPath, timeout: 30000, encoding: 'utf-8' });
      return { success: true };
    } catch (err: any) {
      const stderr = err.stderr?.trim();
      const stdout = err.stdout?.trim();
      const details = stderr || stdout || '';
      const errorMsg = details ? `Commit failed: ${details}` : 'Git commit failed.';
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('project:openPath', async (_event, folderPath: string) => {
    try {
      const resolved = path.resolve(folderPath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return { success: false, error: 'Folder no longer exists.' };
      }

      rootPath = resolved;
      fileCount = 0;
      const tree = buildFileTree(rootPath);
      startFileWatcher();

      return {
        success: true,
        rootPath: resolved,
        projectName: path.basename(resolved),
        tree,
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to open project.' };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Command Code IDE',
    backgroundColor: '#1e1e2e',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL) {
    const url = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(url);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    stopAllAgents();
    stopFileWatcher();
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  setupIPC();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
