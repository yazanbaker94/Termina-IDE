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
  '.gz', '.zip', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.pyc', '.class', '.o', '.obj',
  '.db', '.sqlite', '.sqlite3',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
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

// Maximum allowed image attachment size (20 MB) to avoid OOM or runaway storage.
const AGENT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// Acceptable image MIME types and their canonical extension.
const AGENT_IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/svg+xml': '.svg',
  'image/ico': '.ico',
};

const AGENT_IMAGE_ACCEPTED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg']);

function sanitizeImageFilename(name: string): string {
  // Strip directory traversal and reserved characters. Keep it ASCII-safe.
  let s = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  s = s.replace(/^\.+/, '');
  s = s.replace(/\s+/g, '-');
  if (s.length > 100) s = s.slice(0, 100);
  if (!s) s = 'image';
  return s;
}

function buildPastedImageBasename(prefix: string, hash: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `${prefix}-${stamp}-${hash}`;
}

function shortHash(bytes: Buffer): string {
  // FNV-1a 32-bit, hex-encoded (6 chars). Deterministic and dependency-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).slice(0, 6);
}

/**
 * Resolve the directory where agent image attachments should be saved.
 * - If a project root is open, use <rootPath>/.termina/clipboard/ (created on demand).
 * - Otherwise fall back to <osTemp>/termina/clipboard/ so the feature still works.
 * Returns { dir, isProjectRelative }.
 */
function resolveAgentClipboardDir(): { dir: string; isProjectRelative: boolean } {
  if (rootPath) {
    const dir = path.join(rootPath, '.termina', 'clipboard');
    return { dir, isProjectRelative: true };
  }
  const dir = path.join(app.getPath('temp'), 'termina', 'clipboard');
  return { dir, isProjectRelative: false };
}

function ensureAgentClipboardDir(): { dir: string; isProjectRelative: boolean; error?: string } {
  const r = resolveAgentClipboardDir();
  try {
    fs.mkdirSync(r.dir, { recursive: true });
  } catch (err: any) {
    return { ...r, error: `Could not create clipboard directory: ${err.message}` };
  }
  return r;
}

function bufferToDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function extensionForMime(mime: string): string {
  return AGENT_IMAGE_MIME_TO_EXT[mime.toLowerCase()] || '.png';
}

function readAgentClipboardImage(): { success: boolean; buffer?: Buffer; mime?: string; error?: string } {
  try {
    // 1) Native bitmap (screenshots, "Copy Image" from browsers, etc.)
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const buf = img.toPNG();
      return { success: true, buffer: Buffer.from(buf), mime: 'image/png' };
    }

    // 2) Raw image/* format buffers
    const formats = clipboard.availableFormats('clipboard');
    const candidates: { fmt: string; mime: string }[] = [
      { fmt: 'image/png', mime: 'image/png' },
      { fmt: 'image/jpeg', mime: 'image/jpeg' },
      { fmt: 'image/webp', mime: 'image/webp' },
      { fmt: 'image/gif', mime: 'image/gif' },
      { fmt: 'image/bmp', mime: 'image/bmp' },
      { fmt: 'public.png', mime: 'image/png' },
      { fmt: 'public.jpeg', mime: 'image/jpeg' },
      { fmt: 'PNG', mime: 'image/png' },
    ];
    for (const { fmt, mime } of candidates) {
      if (formats.includes(fmt)) {
        try {
          const buf = clipboard.readBuffer(fmt);
          if (buf && buf.length > 0) {
            return { success: true, buffer: Buffer.from(buf), mime };
          }
        } catch {}
      }
    }

    return { success: false, error: 'No image on the system clipboard.' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
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

function classifyClipboardUri(uri: string): { kind: 'file'; path: string } | { kind: 'remote'; url: string } | null {
  const trimmed = uri.trim();
  // Strip surrounding quotes
  const unquoted = trimmed.replace(/^["']|["']$/g, '');
  if (unquoted.startsWith('file://')) {
    const resolved = parseFileUri(unquoted);
    if (resolved) return { kind: 'file', path: resolved };
    return null;
  }
  if (unquoted.match(/^https?:\/\//i)) {
    return { kind: 'remote', url: unquoted };
  }
  // Plain absolute path (Windows drive letter or Unix /)
  if (unquoted.match(/^[a-zA-Z]:[\\/]/) || unquoted.startsWith('/')) {
    try {
      const resolved = path.resolve(decodeURIComponent(unquoted));
      if (fs.existsSync(resolved)) return { kind: 'file', path: resolved };
    } catch {}
  }
  return null;
}

function parseUriList(text: string): string[] {
  const lines = text.split(/[\n\r]+/);
  const uris: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === 'copy' || trimmed === 'cut') continue;
    uris.push(trimmed);
  }
  return uris;
}

function readClipboardFormatText(format: string): string {
  // Try all known approaches to extract text from a clipboard format
  const best: string[] = [];

  // 1. clipboard.read() — may return string for custom formats
  try {
    const val = clipboard.read(format);
    if (typeof val === 'string') {
      const s = val.trim();
      if (s) best.push(s);
    }
  } catch {}

  // 2. clipboard.readBuffer() — raw buffer, try multiple encodings
  try {
    const buf = clipboard.readBuffer(format);
    if (buf && buf.length > 0) {
      // Try UTF-8
      try { const s = Buffer.from(buf).toString('utf8').trim(); if (s) best.push(s); } catch {}
      // Try UTF-16LE
      try { const s = Buffer.from(buf).toString('utf16le').trim(); if (s) best.push(s); } catch {}
      // Try Latin-1
      try { const s = Buffer.from(buf).toString('latin1').trim(); if (s) best.push(s); } catch {}
    }
  } catch {}

  // 3. clipboard.readText() as last resort for generic text
  try {
    const s = clipboard.readText('clipboard');
    if (s && s.trim()) best.push(s.trim());
  } catch {}

  // Return the first string that looks like it contains useful content
  for (const s of best) {
    if (s.match(/^(file|https?):\/\//i)) return s;
    if (s.match(/^[a-zA-Z]:[\\/]/)) return s;
    if (s.startsWith('/')) return s;
    if (s.match(/data:image\//)) return s;
  }
  // Fallback: return longest string
  return best.reduce((a, b) => (b.length > a.length ? b : a), best[0] ?? '');
}

function normalizeClipboardText(text: string): string {
  if (!text) return '';
  let s = text.replace(/^\0+/, '').replace(/\0+$/, ''); // strip leading/trailing NULs
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); // normalize line endings
  // Replace NULs with spaces only when they separate path components
  // But keep them intact for file name lists (split later with \0)
  return s;
}

function getClipboardFilePaths(formats: string[]): { paths: string[]; remoteUrls: string[]; debug: { uriListPreview?: string; uriListBufferLen?: number } } {
  const localPaths: string[] = [];
  const remoteUrls: string[] = [];
  const seen = new Set<string>();
  const debug: { uriListPreview?: string; uriListBufferLen?: number } = {};

  const addItem = (item: NonNullable<ReturnType<typeof classifyClipboardUri>>) => {
    if (item.kind === 'file') {
      const lower = item.path.toLowerCase();
      if (!seen.has(lower)) { seen.add(lower); localPaths.push(item.path); }
    } else if (item.kind === 'remote') {
      if (!seen.has(item.url)) { seen.add(item.url); remoteUrls.push(item.url); }
    }
  };

  // FileNameW / FileName — Windows Explorer file copy
  const fileFormats = formats.filter((f: string) => f.toLowerCase().includes('filename'));
  for (const fmt of fileFormats) {
    try {
      const raw = clipboard.readBuffer(fmt);
      if (raw && raw.length > 0) {
        // Try UTF-16LE first (FileNameW on Windows)
        const text16 = Buffer.from(raw).toString('utf16le');
        
        // Split by NUL characters — each is a separate path
        const entries = text16.split('\0').map(e => e.trim()).filter(Boolean);
        
        for (const entry of entries) {
          const classified = classifyClipboardUri(entry);
          if (classified) {
            addItem(classified);
          } else {
            // Try plain path fallback — some formats give bare Windows paths
            try {
              const resolved = path.resolve(entry);
              if (fs.existsSync(resolved)) {
                addItem({ kind: 'file', path: resolved });
              }
            } catch {}
          }
        }

        // Also try UTF-8 (FileName on older Windows or non-Windows)
        if (localPaths.length === 0) {
          const text8 = Buffer.from(raw).toString('utf8');
          for (const entry of text8.split('\0').map(e => e.trim()).filter(Boolean)) {
            const classified = classifyClipboardUri(entry);
            if (classified) addItem(classified);
          }
        }
      }
    } catch {}
  }

  // text/uri-list — all platforms
  if (formats.includes('text/uri-list')) {
    try {
      const text = readClipboardFormatText('text/uri-list');
      debug.uriListPreview = text ? text.slice(0, 500) : undefined;
      try {
        const buf = clipboard.readBuffer('text/uri-list');
        debug.uriListBufferLen = buf?.length ?? 0;
      } catch {}

      if (text) {
        const uris = parseUriList(text);
        for (const uri of uris) {
          const classified = classifyClipboardUri(uri);
          if (classified) addItem(classified);
        }
      }
    } catch {}
  }

  // x-special/gnome-copied-files
  if (formats.includes('x-special/gnome-copied-files')) {
    try {
      const text = readClipboardFormatText('x-special/gnome-copied-files');
      if (text) for (const uri of parseUriList(text)) { const r = classifyClipboardUri(uri); if (r) addItem(r); }
    } catch {}
  }

  // public.file-url
  if (formats.includes('public.file-url')) {
    try {
      const text = readClipboardFormatText('public.file-url');
      if (text) for (const line of text.split(/[\n\r]+/).filter(Boolean)) { const r = classifyClipboardUri(line.trim()); if (r) addItem(r); }
    } catch {}
  }

  // public.url
  if (formats.includes('public.url')) {
    try {
      const text = readClipboardFormatText('public.url');
      if (text) for (const line of text.split(/[\n\r]+/).filter(Boolean)) { const r = classifyClipboardUri(line.trim()); if (r) addItem(r); }
    } catch {}
  }

  // NSFilenamesPboardType
  const nsFormat = formats.find((f: string) => f.includes('NSFilenamesPboard') || f.includes('NSFilenames'));
  if (nsFormat) {
    try {
      const raw = clipboard.readBuffer(nsFormat);
      if (raw) {
        const text = raw.toString('utf8');
        const stringMatches = text.match(/<string>([^<]+)<\/string>/g);
        if (stringMatches) for (const m of stringMatches) { const r = classifyClipboardUri(m.replace(/<\/?string>/g, '').trim()); if (r) addItem(r); }
        else for (const line of text.split(/[\n\r\0]+/)) { const r = classifyClipboardUri(line.trim()); if (r) addItem(r); }
      }
    } catch {}
  }

  // clipboard.readText() scan
  try {
    const text = clipboard.readText();
    if (text) {
      const urlRegex = /(?:https?|file):\/\/[^\s]+/gi;
      let match;
      while ((match = urlRegex.exec(text)) !== null) { const r = classifyClipboardUri(match[0]); if (r) addItem(r); }
      for (const line of text.split(/[\n\r]+/).filter(Boolean)) {
        if (line.trim().match(/^[a-zA-Z]:[\\/]/) || line.trim().startsWith('/')) { const r = classifyClipboardUri(line.trim()); if (r) addItem(r); }
      }
    }
  } catch (e) {}

  // HTML scan
  try {
    const html = clipboard.readHTML();
    if (html) {
      const srcRegex = /(?:src|href)=["']([^"']+)["']/gi;
      let match;
      while ((match = srcRegex.exec(html)) !== null) { const r = classifyClipboardUri(match[1]); if (r) addItem(r); }
    }
  } catch (e) {}

  return { paths: localPaths, remoteUrls, debug };
}

async function downloadRemoteImageToDir(targetDir: string, url: string): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!url.match(/^https?:\/\//i)) return { success: false, error: 'Unsupported URL protocol.' };

  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? require('https') : require('http');
    const req = proto.get(url, { timeout: 15000, headers: { 'User-Agent': 'Termina/1.0' } }, (res: any) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        req.destroy();
        downloadRemoteImageToDir(targetDir, redirectUrl).then(resolve);
        return;
      }

      const contentType = (res.headers['content-type'] || '').toLowerCase();
      const safeImageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-icon'];
      const isImageMime = safeImageTypes.some((t) => contentType.startsWith(t));

      let ext = '';
      if (isImageMime) {
        if (contentType.includes('png')) ext = '.png';
        else if (contentType.includes('jpeg') || contentType.includes('jpg')) ext = '.jpg';
        else if (contentType.includes('webp')) ext = '.webp';
        else if (contentType.includes('gif')) ext = '.gif';
        else if (contentType.includes('bmp')) ext = '.bmp';
        else if (contentType.includes('icon')) ext = '.ico';
        else ext = '.png';
      } else {
        // Check URL extension as fallback
        const urlPath = url.split('?')[0].split('#')[0];
        const urlExt = path.extname(urlPath).toLowerCase();
        const safeExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico'];
        if (safeExts.includes(urlExt)) {
          ext = urlExt;
        } else {
          req.destroy();
          resolve({ success: false, error: 'Clipboard contains a URL that does not appear to be an image.' });
          return;
        }
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      const maxSize = 20 * 1024 * 1024; // 20 MB

      res.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          req.destroy();
          resolve({ success: false, error: 'Remote image exceeds 20 MB limit.' });
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) {
            resolve({ success: false, error: 'Downloaded image is empty.' });
            return;
          }
          const urlPath = url.split('?')[0].split('#')[0];
          let baseName = path.basename(urlPath) || 'pasted-image';
          if (!path.extname(baseName)) baseName += ext;
          const result = writeImageBuffer(targetDir, buffer, path.extname(baseName) || ext, baseName.replace(/\.[^.]+$/, ''));
          resolve(result);
        } catch (e: any) {
          resolve({ success: false, error: e.message });
        }
      });

      res.on('error', (e: any) => {
        resolve({ success: false, error: `Download failed: ${e.message}` });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Download timed out.' });
    });

    req.on('error', (e: any) => {
      resolve({ success: false, error: `Download failed: ${e.message}` });
    });
  });
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
      } catch {}
    }
  }
  return null;
}

function getImageFromHtmlOrText(): { buffer?: Buffer; ext?: string; error?: string; remoteUrls?: string[] } {
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

    // Collect remote image URLs for later download attempt
    const remoteUrls: string[] = [];
    const imgSrcMatches = contentToSearch.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi);
    if (imgSrcMatches) {
      for (const m of imgSrcMatches) {
        const urlMatch = m.match(/src=["'](https?:\/\/[^"']+)["']/i);
        if (urlMatch) remoteUrls.push(urlMatch[1]);
      }
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

    if (remoteUrls.length > 0) return { remoteUrls };
  } catch {}

  return {};
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
    } catch {}
  }
  if (copiedPaths.length === 0) return { success: false, error: 'Could not copy any files.' };
  return { success: true, count: copiedPaths.length, paths: copiedPaths, path: copiedPaths[0] };
}

function getWindowsClipboardFileDropList(): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }';
    const output = execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!output) return [];
    const paths = output.split(/[\r\n]+/).map((l: string) => l.trim()).filter((p: string) => fs.existsSync(p));
    return paths;
  } catch {
    return [];
  }
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
  if (agentPtys.has(sessionId)) {
    return { success: true };
  }

  sessionRoots.set(sessionId, cwd);
  captureFileSnapshots(sessionId, cwd);

  const cols = 80;
  const rows = 24;
  const cmdInfo = resolveCommandCode();

  if (!cmdInfo) {
    return { success: false, error: 'Termina CLI not found. Install it and make sure command-code is in your PATH.' };
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

  ipcMain.handle('dialog:openFiles', async (_event, targetDir: string) => {
    try {
      safeResolvePath(targetDir);
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openFile', 'multiSelections'],
        title: 'Import Files',
        filters: [
          { name: 'Media Files', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'mov', 'webm', 'mkv', 'mp3'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      return { canceled: false, filePaths: result.filePaths };
    } catch (err: any) {
      return { canceled: false, filePaths: [], error: err.message };
    }
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

  ipcMain.handle('agent:saveImageAttachment', async (_event, args: { bytes: number[]; mimeType?: string; filename?: string; projectRoot?: string | null }) => {
    try {
      if (!args || !Array.isArray(args.bytes) || args.bytes.length === 0) {
        return { success: false, error: 'No image data provided.' };
      }
      if (args.bytes.length > AGENT_IMAGE_MAX_BYTES) {
        return { success: false, error: 'Image is over 20 MB. Attachments are limited to 20 MB.' };
      }

      const buffer = Buffer.from(args.bytes);
      if (buffer.length === 0) {
        return { success: false, error: 'Image is empty.' };
      }

      const mime = (args.mimeType || 'image/png').toLowerCase();
      let ext = extensionForMime(mime);
      // If caller passed a filename with a recognized image extension, prefer that.
      if (args.filename) {
        const fext = path.extname(args.filename).toLowerCase();
        if (AGENT_IMAGE_ACCEPTED_EXTS.has(fext)) {
          ext = fext === '.jpeg' ? '.jpg' : fext;
        }
      }
      if (!AGENT_IMAGE_ACCEPTED_EXTS.has(ext)) {
        return { success: false, error: `Unsupported image type: ${ext}` };
      }

      // If a projectRoot is provided (and we don't already have one), use it.
      const projectRoot = args.projectRoot && String(args.projectRoot).trim() ? path.resolve(args.projectRoot) : null;
      const useRoot = projectRoot || rootPath;
      const dirInfo = useRoot
        ? { dir: path.join(useRoot, '.termina', 'clipboard'), isProjectRelative: true }
        : { dir: path.join(app.getPath('temp'), 'termina', 'clipboard'), isProjectRelative: false };

      try {
        fs.mkdirSync(dirInfo.dir, { recursive: true });
      } catch (err: any) {
        return { success: false, error: `Could not create clipboard directory: ${err.message}` };
      }

      const safeBase = sanitizeImageFilename(
        args.filename ? path.basename(args.filename, path.extname(args.filename)) : ''
      );
      const baseName = buildPastedImageBasename(safeBase || 'pasted', shortHash(buffer));
      const dest = uniquePath(dirInfo.dir, baseName + ext);
      fs.writeFileSync(dest, buffer);

      const relativePath = dirInfo.isProjectRelative
        ? path.posix.join('.termina', 'clipboard', path.basename(dest))
        : dest;
      const agentRef = '@' + relativePath.replace(/\\/g, '/');
      const previewDataUrl = bufferToDataUrl(buffer, mime.startsWith('image/') ? mime : 'image/' + mime.replace(/^image\/?/, ''));

      return {
        success: true,
        absolutePath: dest,
        relativePath,
        agentRef,
        previewDataUrl,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('agent:saveDroppedImageAttachment', async (_event, args: { sourcePath: string; projectRoot?: string | null }) => {
    try {
      if (!args || !args.sourcePath) {
        return { success: false, error: 'No file path provided.' };
      }
      const resolved = path.resolve(args.sourcePath);
      if (!fs.existsSync(resolved)) {
        return { success: false, error: 'File does not exist.' };
      }
      const ext = path.extname(resolved).toLowerCase();
      if (!AGENT_IMAGE_ACCEPTED_EXTS.has(ext)) {
        return { success: false, error: `Unsupported file type: ${ext || '(none)'}` };
      }
      const stat = fs.statSync(resolved);
      if (stat.size > AGENT_IMAGE_MAX_BYTES) {
        return { success: false, error: 'Image is over 20 MB. Attachments are limited to 20 MB.' };
      }
      const buffer = fs.readFileSync(resolved);
      if (buffer.length === 0) {
        return { success: false, error: 'File is empty.' };
      }
      const mime = AGENT_IMAGE_MIME_TO_EXT[ext === '.jpeg' ? '.jpg' : ext] || 'image/png';

      // Restrict source files to be inside the project root when one is open.
      if (rootPath) {
        const lowerResolved = resolved.toLowerCase();
        const lowerRoot = path.resolve(rootPath).toLowerCase();
        if (!lowerResolved.startsWith(lowerRoot)) {
          return { success: false, error: 'Dropped file is outside the workspace folder.' };
        }
      }

      const projectRoot = args.projectRoot && String(args.projectRoot).trim() ? path.resolve(args.projectRoot) : null;
      const useRoot = projectRoot || rootPath;
      const dirInfo = useRoot
        ? { dir: path.join(useRoot, '.termina', 'clipboard'), isProjectRelative: true }
        : { dir: path.join(app.getPath('temp'), 'termina', 'clipboard'), isProjectRelative: false };

      try {
        fs.mkdirSync(dirInfo.dir, { recursive: true });
      } catch (err: any) {
        return { success: false, error: `Could not create clipboard directory: ${err.message}` };
      }

      const safeBase = sanitizeImageFilename(path.basename(resolved, ext));
      const baseName = buildPastedImageBasename(safeBase || 'pasted', shortHash(buffer));
      const dest = uniquePath(dirInfo.dir, baseName + ext);
      fs.writeFileSync(dest, buffer);

      const relativePath = dirInfo.isProjectRelative
        ? path.posix.join('.termina', 'clipboard', path.basename(dest))
        : dest;
      const agentRef = '@' + relativePath.replace(/\\/g, '/');
      const previewDataUrl = bufferToDataUrl(buffer, mime);

      return {
        success: true,
        absolutePath: dest,
        relativePath,
        agentRef,
        previewDataUrl,
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('agent:readClipboardImageAttachment', async (_event, args: { projectRoot?: string | null } | undefined) => {
    const result = readAgentClipboardImage();
    if (!result.success || !result.buffer) {
      return { success: false, error: result.error };
    }
    const buffer = result.buffer;
    if (buffer.length > AGENT_IMAGE_MAX_BYTES) {
      return { success: false, error: 'Clipboard image is over 20 MB.' };
    }
    const mime = result.mime || 'image/png';
    const ext = extensionForMime(mime);

    const projectRoot = args && args.projectRoot && String(args.projectRoot).trim() ? path.resolve(args.projectRoot) : null;
    const useRoot = projectRoot || rootPath;
    const dirInfo = useRoot
      ? { dir: path.join(useRoot, '.termina', 'clipboard'), isProjectRelative: true }
      : { dir: path.join(app.getPath('temp'), 'termina', 'clipboard'), isProjectRelative: false };

    try {
      fs.mkdirSync(dirInfo.dir, { recursive: true });
    } catch (err: any) {
      return { success: false, error: `Could not create clipboard directory: ${err.message}` };
    }

    const baseName = buildPastedImageBasename('pasted', shortHash(buffer));
    const dest = uniquePath(dirInfo.dir, baseName + ext);
    fs.writeFileSync(dest, buffer);

    const relativePath = dirInfo.isProjectRelative
      ? path.posix.join('.termina', 'clipboard', path.basename(dest))
      : dest;
    const agentRef = '@' + relativePath.replace(/\\/g, '/');
    const previewDataUrl = bufferToDataUrl(buffer, mime);

    return {
      success: true,
      absolutePath: dest,
      relativePath,
      agentRef,
      previewDataUrl,
    };
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

  ipcMain.handle('window:control', async (_event, action: string) => {
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
      // 1. Try native bitmap image FIRST (screenshot, browser Copy Image)
      const nativeResult = saveNativeImage(resolvedDir);
      if (nativeResult.success) return nativeResult;

      // 2. Try raw image buffers (e.g. image/png, image/jpeg, public.png)
      const imageBuffer = getClipboardImageBuffer(formats);
      if (imageBuffer) {
        return writeImageBuffer(resolvedDir, imageBuffer.buffer, imageBuffer.ext);
      }

      // 2b. Windows FileDropList fallback — reads actual Explorer-copied file paths
      const fileDropPaths = getWindowsClipboardFileDropList();
      if (fileDropPaths.length > 0) {
        return copyFilesToDir(resolvedDir, fileDropPaths);
      }

      // 3. Try file paths and remote URLs from all clipboard formats
      const { paths: localPaths, remoteUrls: uriListRemoteUrls, debug } = getClipboardFilePaths(formats);
      if (localPaths.length > 0) {
        return copyFilesToDir(resolvedDir, localPaths);
      }

      let uriListDebug: any = null;
      if (formats.includes('text/uri-list') && localPaths.length === 0 && uriListRemoteUrls.length === 0) {
        uriListDebug = { uriListPreview: debug.uriListPreview, uriListBufferLen: debug.uriListBufferLen };
      }

      // 4. Try downloading remote image URLs
      const allRemoteUrls = [...uriListRemoteUrls];
      if (allRemoteUrls.length === 0) {
        const htmlResult = getImageFromHtmlOrText();
        if (htmlResult.buffer) {
          return writeImageBuffer(resolvedDir, htmlResult.buffer, htmlResult.ext ?? '.png');
        }
        if (htmlResult.remoteUrls?.length) allRemoteUrls.push(...htmlResult.remoteUrls);
      }
      if (allRemoteUrls.length > 0) {
        const firstUrl = allRemoteUrls[0];
        const dlResult = await downloadRemoteImageToDir(resolvedDir, firstUrl);
        if (dlResult.success) return { success: true, path: dlResult.path };
        return { success: false, error: dlResult.error || 'Failed to download remote image.', formats };
      }

      // 5. Try plain text fallback
      const text = clipboard.readText();
      if (text) {
        const lines = text.split(/[\n\r]+/).filter(Boolean);
        const potentialPaths = lines.map((l: string) => l.trim()).filter((p: string) => fs.existsSync(p));
        if (potentialPaths.length > 0) {
          return copyFilesToDir(resolvedDir, potentialPaths);
        }
        if (text.trim().match(/^https?:\/\//)) {
          return { success: false, error: 'Clipboard contains a URL, but it is not an image.', formats };
        }
        const filePath = uniquePath(resolvedDir, 'pasted.txt');
        fs.writeFileSync(filePath, text, 'utf-8');
        return { success: true, path: filePath };
      }

      // Final failure
      if (uriListDebug) {
        return {
          success: false,
          error: 'Clipboard has text/uri-list but Termina could not parse it. Try pressing Ctrl+V in the Files panel instead.',
          formats,
          debug: uriListDebug,
        };
      }

      return { success: false, error: 'No pasteable content found.', formats };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:copyExternalFiles', async (_event, targetDir: string, sourcePaths: string[]) => {
    try {
      const resolvedDir = safeResolvePath(targetDir);
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
        } catch {}
      }
      return { success: true, count: copiedPaths.length, paths: copiedPaths, path: copiedPaths[0] };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:writePastedBuffer', async (_event, args: { targetDir: string; filename?: string; mimeType?: string; bytes: number[] }) => {
    try {
      const resolvedDir = safeResolvePath(args.targetDir);
      const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
      if (!args.bytes || args.bytes.length === 0 || args.bytes.length > MAX_SIZE) {
        return { success: false, error: 'Invalid or too large paste buffer.' };
      }

      const buffer = Buffer.from(args.bytes);
      if (buffer.length === 0) return { success: false, error: 'Empty paste buffer.' };

      // Determine extension from mimeType or filename
      let ext = '.png'; // default
      if (args.mimeType) {
        if (args.mimeType.includes('png')) ext = '.png';
        else if (args.mimeType.includes('jpeg') || args.mimeType.includes('jpg')) ext = '.jpg';
        else if (args.mimeType.includes('webp')) ext = '.webp';
        else if (args.mimeType.includes('gif')) ext = '.gif';
        else if (args.mimeType.includes('bmp')) ext = '.bmp';
        else if (args.mimeType.includes('icon')) ext = '.ico';
      }
      if (args.filename) {
        const fext = path.extname(args.filename).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg'].includes(fext)) ext = fext;
      }

      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      const baseName = args.filename ? path.basename(args.filename, path.extname(args.filename)) : `pasted-image-${stamp}`;
      // Sanitize filename
      const safeBase = baseName.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
      const dest = uniquePath(resolvedDir, safeBase + ext);
      fs.writeFileSync(dest, buffer);

      const nodeName = path.basename(dest);
      return {
        success: true,
        path: dest,
        paths: [dest],
        count: 1,
        items: [{ path: dest, name: nodeName, type: 'file' as const }],
      };
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
      const html = clipboard.readHTML();
      const bufLengths: Record<string, number> = {};
      for (const fmt of formats) {
        try {
          const buf = clipboard.readBuffer(fmt);
          const len = buf?.length ?? 0;
          bufLengths[fmt] = len;
        } catch { bufLengths[fmt] = -1; }
      }

      return {
        platform: process.platform,
        formats,
        textLength: text?.length ?? 0,
        htmlLength: html?.length ?? 0,
        imageIsEmpty: image.isEmpty(),
        bufferLengths: bufLengths,
      };
    } catch {
      return { platform: process.platform, formats: [], textLength: 0, htmlLength: 0, imageIsEmpty: true, bufferLengths: {} };
    }
  });

  ipcMain.handle('fs:readClipboardText', async () => {
    return clipboard.readText();
  });

  ipcMain.handle('clipboard:writeText', async (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return { success: true };
  });

  ipcMain.handle('fs:statFile', async (_event, filePath: string) => {
    try {
      const resolved = safeResolvePath(filePath);
      const stat = fs.statSync(resolved);
      return { exists: true, type: stat.isDirectory() ? 'directory' as const : 'file' as const, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return { exists: false };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Termina',
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

  // Allow clipboard-read permission for navigator.clipboard.read() in renderer
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
      callback(true);
    } else {
      callback(false);
    }
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
