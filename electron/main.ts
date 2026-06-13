import { app, BrowserWindow, shell, dialog, ipcMain, clipboard } from 'electron';
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
const HIDDEN_EXTS = new Set([
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.webm',
  '.gz', '.zip', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.pyc', '.class', '.o', '.obj',
  '.db', '.sqlite', '.sqlite3',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
]);

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
]);

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

let fileCount = 0;

function uniquePath(targetDir: string, preferredName: string): string {
  const basePath = path.join(targetDir, preferredName);
  if (!fs.existsSync(basePath)) return basePath;
  const ext = path.extname(preferredName);
  const base = path.basename(preferredName, ext);
  let copyName = `${base} copy${ext}`;
  let copyIdx = 2;
  while (fs.existsSync(path.join(targetDir, copyName))) {
    copyName = `${base} copy ${copyIdx}${ext}`;
    copyIdx++;
  }
  return path.join(targetDir, copyName);
}

function writeImageBuffer(targetDir: string, buffer: Buffer, ext: string, baseName?: string): { success: boolean; path?: string } {
  if (!buffer || buffer.length === 0) return { success: false };
  const fileName = (baseName || 'pasted-image') + ext;
  const dest = uniquePath(targetDir, fileName);
  fs.writeFileSync(dest, buffer);
  return { success: true, path: dest };
}

function saveNativeImage(targetDir: string): { success: boolean; path?: string } {
  const img = clipboard.readImage();
  if (img.isEmpty()) return { success: false };
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const filePath = uniquePath(targetDir, `pasted-image-${stamp}.png`);
  fs.writeFileSync(filePath, img.toPNG());
  return { success: true, path: filePath };
}

function parseFileUri(uri: string): string | null {
  try {
    let normalized = uri.trim();
    if (normalized.startsWith('file://')) {
      normalized = normalized.slice(7);
    }
    // Handle Windows file:///C:/ style
    if (process.platform === 'win32' && normalized.match(/^\/[a-zA-Z]:/)) {
      normalized = normalized.slice(1);
    }
    normalized = decodeURIComponent(normalized);
    const resolved = path.resolve(normalized);
    if (fs.existsSync(resolved)) return resolved;
  } catch {}
  return null;
}

function getClipboardFilePaths(formats: string[]): string[] {
  const paths: string[] = [];

  if (process.platform === 'win32') {
    // Find the actual FileNameW format name (could be "FileNameW" or "FileName")
    const fileFormat = formats.find((f: string) => f.includes('FileName'));
    if (fileFormat) {
      try {
        const raw = clipboard.readBuffer(fileFormat);
        if (raw && raw.length > 0) {
          const text = Buffer.from(raw).toString('utf16le');
          const entries = text.split('\0').filter(Boolean);
          for (const entry of entries) {
            const trimmed = entry.trim();
            if (trimmed && fs.existsSync(trimmed)) {
              paths.push(trimmed);
            }
          }
        }
      } catch (e) { console.log('[paste] file readBuffer failed:', e); }
    }
  }

  if (process.platform === 'darwin') {
    if (formats.includes('public.file-url')) {
      try {
        const text = clipboard.read('public.file-url');
        if (text) {
          for (const line of text.toString().split(/[\n\r]+/)) {
            const resolved = parseFileUri(line.trim());
            if (resolved) paths.push(resolved);
          }
        }
      } catch (e) { console.log('[paste] public.file-url failed:', e); }
    }
    // NSFilenamesPboardType
    const nsFormat = formats.find((f: string) => f.includes('NSFilenamesPboard') || f.includes('NSFilenames'));
    if (nsFormat) {
      try {
        const raw = clipboard.readBuffer(nsFormat);
        if (raw) {
          // Try simple parse: extract <string>...</string> or split by newlines
          const text = raw.toString('utf8');
          const stringMatches = text.match(/<string>([^<]+)<\/string>/g);
          if (stringMatches) {
            for (const m of stringMatches) {
              const content = m.replace(/<\/?string>/g, '');
              const resolved = parseFileUri(content.trim());
              if (resolved) paths.push(resolved);
            }
          } else {
            // Try plain split
            for (const line of text.split(/[\n\r\0]+/)) {
              const resolved = parseFileUri(line.trim());
              if (resolved) paths.push(resolved);
            }
          }
        }
      } catch (e) { console.log('[paste] NSFilenames failed:', e); }
    }
  }

  if (process.platform === 'linux') {
    if (formats.includes('text/uri-list')) {
      try {
        const text = clipboard.read('text/uri-list');
        if (text) {
          for (const line of text.toString().split(/[\n\r]+/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const resolved = parseFileUri(trimmed);
            if (resolved) paths.push(resolved);
          }
        }
      } catch (e) { console.log('[paste] text/uri-list failed:', e); }
    }
    if (formats.includes('x-special/gnome-copied-files')) {
      try {
        const text = clipboard.read('x-special/gnome-copied-files');
        if (text) {
          const lines = text.toString().split(/[\n\r]+/).filter(Boolean);
          for (const line of lines) {
            if (line.startsWith('copy') || line.startsWith('cut')) continue;
            const resolved = parseFileUri(line.trim());
            if (resolved) paths.push(resolved);
          }
        }
      } catch (e) { console.log('[paste] gnome-copied-files failed:', e); }
    }
  }

  return paths;
}

function getClipboardImageBuffer(formats: string[]): { buffer: Buffer; ext: string } | null {
  const candidates = [
    { fmt: 'image/png', ext: '.png' },
    { fmt: 'image/jpeg', ext: '.jpg' },
    { fmt: 'image/webp', ext: '.webp' },
    { fmt: 'image/gif', ext: '.gif' },
    { fmt: 'image/jpg', ext: '.jpg' },
    { fmt: 'public.png', ext: '.png' },
    { fmt: 'public.jpeg', ext: '.jpg' },
    { fmt: 'PNG', ext: '.png' },
  ];

  for (const { fmt, ext } of candidates) {
    if (formats.includes(fmt)) {
      try {
        const buffer = clipboard.readBuffer(fmt);
        if (buffer && buffer.length > 0) {
          return { buffer, ext };
        }
      } catch (e) { console.log(`[paste] readBuffer(${fmt}) failed:`, e); }
    }
  }
  return null;
}

function getImageFromHtmlOrText(): { buffer?: Buffer; ext?: string; error?: string } {
  try {
    const html = clipboard.readHTML();
    const text = clipboard.readText();

    const contentToSearch = `${html || ''}\n${text || ''}`;

    // Match data:image/{type};base64,{data}
    const dataUriMatch = contentToSearch.match(/data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/);
    if (dataUriMatch) {
      const type = dataUriMatch[1];
      const base64Data = dataUriMatch[2];
      const ext = type === 'jpeg' ? '.jpg' : `.${type}`;
      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.length > 0) return { buffer, ext };
    }

    // Check for remote image URLs (http://...)
    if (contentToSearch.match(/<img[^>]+src=["']https?:\/\//i)) {
      return { error: 'Clipboard contains a remote image URL, but remote image download is not supported yet.' };
    }

    // Check for file:// image src
    const fileSrcMatch = contentToSearch.match(/<img[^>]+src=["'](file:\/\/[^"']+)["']/i);
    if (fileSrcMatch) {
      const resolved = parseFileUri(fileSrcMatch[1]);
      if (resolved) {
        try {
          const buffer = fs.readFileSync(resolved);
          const ext = path.extname(resolved).toLowerCase();
          if (buffer.length > 0) return { buffer, ext };
        } catch {}
      }
    }
  } catch (e) { console.log('[paste] HTML/text parse failed:', e); }

  return {};
}

function logClipboardDebug(formats: string[]) {
  console.log('[paste] platform:', process.platform);
  console.log('[paste] formats:', formats);
  try {
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    console.log('[paste] readText length:', text?.length ?? 0);
    console.log('[paste] readHTML length:', html?.length ?? 0);
    console.log('[paste] readImage isEmpty:', clipboard.readImage().isEmpty());
  } catch {}
  for (const fmt of formats) {
    try {
      const buf = clipboard.readBuffer(fmt);
      console.log(`[paste] buffer[${fmt}] length:`, buf?.length ?? 0);
    } catch {}
  }
}

function copyFilesToDir(resolvedDir: string, sourcePaths: string[]): { success: boolean; error?: string; path?: string; paths?: string[]; count?: number } {
  const copiedPaths: string[] = [];
  for (const src of sourcePaths) {
    try {
      const srcName = path.basename(src);
      const dest = uniquePath(resolvedDir, srcName);
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true, errorOnExist: false });
      } else {
        fs.copyFileSync(src, dest);
      }
      copiedPaths.push(dest);
    } catch (e) { console.log('[copy] failed:', src, e); }
  }
  if (copiedPaths.length === 0) return { success: false, error: 'Could not copy any files.' };
  return { success: true, count: copiedPaths.length, paths: copiedPaths, path: copiedPaths[0] };
}

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
      if (HIDDEN_EXTS.has(ext)) continue;
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
    const changeType = eventType === 'add' || eventType === 'addDir' ? 'added' : eventType === 'change' ? 'changed' : 'deleted';
    sendToRenderer('fs:onFileChanged', { path: filePath, changeType, isDirectory: eventType === 'addDir' || eventType === 'unlinkDir' });
  };

  fileWatcher.on('add', (p) => emit('add', p));
  fileWatcher.on('addDir', (p) => emit('addDir', p));
  fileWatcher.on('change', (p) => emit('change', p));
  fileWatcher.on('unlink', (p) => emit('unlink', p));
  fileWatcher.on('unlinkDir', (p) => emit('unlinkDir', p));
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
  console.log(`[PTY] start session=${sessionId} cwd=${cwd}`);

  if (agentPtys.has(sessionId)) {
    console.log(`[PTY] start session=${sessionId} already running, idempotent`);
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
    console.log(`[PTY] started session=${sessionId} pid=${(spawnedPty as any).pid} cwd=${cwd}`);
  } catch (err: any) {
    sessionRoots.delete(sessionId);
    return { success: false, error: `Failed to spawn agent: ${err.message}` };
  }

  agentPtys.set(sessionId, spawnedPty);
  agentStopRequested.set(sessionId, false);
  console.log(`[PTY] running sessions=[${[...agentPtys.keys()].join(', ')}]`);

  const owningSession = sessionId;

  spawnedPty.onData((data: string) => {
    sendToRenderer('agent:onData', { sessionId: owningSession, data });
  });

  spawnedPty.onExit(({ exitCode }: { exitCode: number }) => {
    const wasStopRequested = agentStopRequested.get(owningSession);
    console.log(`[PTY] exit session=${owningSession} exitCode=${exitCode} stopRequested=${wasStopRequested}`);
    if (wasStopRequested) {
      sendToRenderer('agent:onExit', { sessionId: owningSession, exitCode: -1 });
    } else {
      sendToRenderer('agent:onExit', { sessionId: owningSession, exitCode });
    }
    agentPtys.delete(owningSession);
    agentStopRequested.delete(owningSession);
    sessionRoots.delete(owningSession);
    console.log(`[PTY] running sessions=[${[...agentPtys.keys()].join(', ')}]`);
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
    console.log(`[PTY] write session=${sessionId} exists=${!!p}`);
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
    console.log(`[PTY] project switch to ${folderPath}, running=[${[...agentPtys.keys()].join(', ')}]`);
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

  ipcMain.handle('window:control', async (_event, action: string) => {
    console.log('[window-control]', action);
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win) return { success: false, error: 'No window' };
    if (action === 'minimize') win.minimize();
    else if (action === 'maximizeToggle') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close();
    else return { success: false, error: 'Unknown action' };
    return { success: true };
  });

  ipcMain.handle('fs:createFile', async (_event, parentDir: string, name: string) => {
    try {
      const resolved = safeResolvePath(path.join(parentDir, name));
      if (fs.existsSync(resolved)) return { success: false, error: 'File already exists.' };
      fs.writeFileSync(resolved, '', 'utf-8');
      return { success: true, path: resolved };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:createFolder', async (_event, parentDir: string, name: string) => {
    try {
      const resolved = safeResolvePath(path.join(parentDir, name));
      if (fs.existsSync(resolved)) return { success: false, error: 'Folder already exists.' };
      fs.mkdirSync(resolved, { recursive: true });
      return { success: true, path: resolved };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:renamePath', async (_event, oldPath: string, newName: string) => {
    try {
      const resolved = safeResolvePath(oldPath);
      const parent = path.dirname(resolved);
      const newPath = path.join(parent, newName);
      const safeNewPath = safeResolvePath(newPath);
      if (fs.existsSync(safeNewPath)) return { success: false, error: 'A file or folder with that name already exists.' };
      fs.renameSync(resolved, safeNewPath);
      return { success: true, path: safeNewPath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:deletePath', async (_event, targetPath: string) => {
    try {
      const resolved = safeResolvePath(targetPath);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
      } else {
        fs.unlinkSync(resolved);
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:revealInExplorer', async (_event, targetPath: string) => {
    try {
      const resolved = safeResolvePath(targetPath);
      shell.showItemInFolder(resolved);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:pasteFromClipboard', async (_event, targetDir: string) => {
    try {
      const resolvedDir = safeResolvePath(targetDir);
      const formats = clipboard.availableFormats('clipboard');
      logClipboardDebug(formats);

      // 1. Try copied file paths (explorer/finder file copy)
      const filePaths = getClipboardFilePaths(formats);
      if (filePaths.length > 0) {
        console.log('[paste] found file paths:', filePaths);
        return copyFilesToDir(resolvedDir, filePaths);
      }

      // 2. Try native bitmap image (screenshot / browser copy image)
      const nativeResult = saveNativeImage(resolvedDir);
      if (nativeResult.success) return nativeResult;

      // 3. Try raw image buffers (e.g. Ctrl+C image in some apps)
      const imageBuffer = getClipboardImageBuffer(formats);
      if (imageBuffer) {
        console.log('[paste] found image buffer, ext:', imageBuffer.ext);
        return writeImageBuffer(resolvedDir, imageBuffer.buffer, imageBuffer.ext);
      }

      // 4. Try data: URI from HTML or text
      const htmlResult = getImageFromHtmlOrText();
      if (htmlResult.buffer) {
        console.log('[paste] found data URI image');
        return writeImageBuffer(resolvedDir, htmlResult.buffer, htmlResult.ext ?? '.png');
      }
      if (htmlResult.error) return { success: false, error: htmlResult.error, formats };

      // 5. Try plain text fallback
      const text = clipboard.readText();
      if (text) {
        // Try interpreting as file paths
        const lines = text.split(/[\n\r]+/).filter(Boolean);
        const potentialPaths = lines.map((l: string) => l.trim()).filter((p: string) => fs.existsSync(p));
        if (potentialPaths.length > 0) {
          return copyFilesToDir(resolvedDir, potentialPaths);
        }
        const filePath = uniquePath(resolvedDir, 'pasted.txt');
        fs.writeFileSync(filePath, text, 'utf-8');
        return { success: true, path: filePath };
      }

      return { success: false, error: `No pasteable content found. Clipboard formats: ${formats.join(', ')}`, formats };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:copyExternalFiles', async (_event, targetDir: string, sourcePaths: string[]) => {
    try {
      const resolvedDir = safeResolvePath(targetDir);
      let count = 0;
      for (const src of sourcePaths) {
        try {
          const srcName = path.basename(src);
          let dest = path.join(resolvedDir, srcName);
          if (fs.existsSync(dest)) {
            const ext = path.extname(srcName);
            const base = path.basename(srcName, ext);
            let copyName = `${base} copy${ext}`;
            let copyIdx = 2;
            while (fs.existsSync(path.join(resolvedDir, copyName))) {
              copyName = `${base} copy ${copyIdx}${ext}`;
              copyIdx++;
            }
            dest = path.join(resolvedDir, copyName);
          }
          const stat = fs.statSync(src);
          if (stat.isDirectory()) {
            fs.cpSync(src, dest, { recursive: true, errorOnExist: false });
          } else {
            fs.copyFileSync(src, dest);
          }
          count++;
        } catch {}
      }
      return { success: true, count };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:getAssetDataUrl', async (_event, filePath: string) => {
    try {
      const resolved = safeResolvePath(filePath);
      const ext = path.extname(resolved).toLowerCase();
      const mime = IMAGE_MIME[ext];
      if (!mime) throw new Error('Not a supported image format.');
      const buffer = fs.readFileSync(resolved);
      const base64 = buffer.toString('base64');
      return { dataUrl: `data:${mime};base64,${base64}`, mime };
    } catch (err: any) {
      throw new Error(`Cannot read image: ${err.message}`);
    }
  });

  ipcMain.handle('fs:getClipboardDebug', async () => {
    try {
      const formats = clipboard.availableFormats('clipboard');
      const text = clipboard.readText();
      const image = clipboard.readImage();
      const bufLengths: Record<string, number> = {};
      for (const fmt of formats) {
        try { bufLengths[fmt] = clipboard.readBuffer(fmt)?.length ?? 0; } catch { bufLengths[fmt] = -1; }
      }
      return {
        platform: process.platform,
        formats,
        textLength: text?.length ?? 0,
        htmlLength: clipboard.readHTML()?.length ?? 0,
        imageIsEmpty: image.isEmpty(),
        bufferLengths: bufLengths,
      };
    } catch {
      return { platform: process.platform, formats: [], textLength: 0, htmlLength: 0, imageIsEmpty: true, bufferLengths: {} };
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
