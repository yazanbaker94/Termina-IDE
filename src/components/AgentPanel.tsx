import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AlertTriangle, FilePlus, FileEdit, FileMinus, ChevronDown, ChevronRight, X, ClipboardPaste, Copy } from 'lucide-react';
import { FileChangeEvent, AgentStatus, AgentImageAttachmentResult } from '../types';
import { cliDebug } from '../debug/cliDebug';
import { extractTitleFromPrompt, isDefaultLabel, buildContextualTitle } from '../utils/sessionNaming';
import { AgentImagePreviewChip } from './AgentImagePreviewChip';

interface AgentPanelProps {
  sessionId: string;
  status: AgentStatus;
  exitCode: number | null;
  error: string;
  changedFiles: FileChangeEvent[];
  terminalBuffer: string;
  restartCount: number;
  resizeSignal: number;
  dockTransitioningRef?: React.MutableRefObject<boolean>;
  hasProject: boolean;
  sessionLabel: string | null;
  /** Absolute path of the project root, used to resolve image save location. */
  projectRoot?: string | null;
  onRenameSession: (sessionId: string, newLabel: string) => void;
  onWrite: (input: string) => void;
  onChangedFileClick: (evt: FileChangeEvent) => void;
  onXtermWriteReady: (sessionId: string, writeFn: ((data: string) => void) | null) => void;
  terminalRef?: React.RefObject<{ focus: () => void }>;
}

function changeIcon(changeType: string) {
  switch (changeType) {
    case 'added': return <FilePlus size={12} />;
    case 'changed': return <FileEdit size={12} />;
    case 'deleted': return <FileMinus size={12} />;
    default: return <FileEdit size={12} />;
  }
}

function normalizeTerminalPaste(text: string): string {
  let s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!s.includes('\n') && s.endsWith('\n')) {
    return s.slice(0, -1);
  }
  if (s.endsWith('\n')) {
    const lines = s.split('\n');
    const nonEmpty = lines.filter((l) => l.length > 0);
    if (nonEmpty.length === 1) {
      return nonEmpty[0];
    }
  }
  return s;
}

const ACCEPTED_IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
  'image/gif', 'image/bmp', 'image/x-icon', 'image/svg+xml', 'image/ico',
]);

const ACCEPTED_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.svg']);

function isImageFile(file: File): boolean {
  if (file.type && ACCEPTED_IMAGE_MIME.has(file.type.toLowerCase())) return true;
  const name = (file.name || '').toLowerCase();
  const idx = name.lastIndexOf('.');
  if (idx === -1) return false;
  return ACCEPTED_IMAGE_EXT.has(name.slice(idx));
}

function hasFilesInDataTransfer(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  // The 'Files' type is set when the user is dragging files from the OS
  // or from another app. We don't need to inspect the list to enable the
  // drop zone — just knowing files are present is enough.
  if (dt.types && Array.from(dt.types).includes('Files')) return true;
  // Some browsers expose file count directly.
  if (typeof dt.items !== 'undefined' && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      if (dt.items[i]?.kind === 'file') return true;
    }
  }
  return false;
}

const AgentPanel: React.FC<AgentPanelProps> = ({
  sessionId,
  status,
  exitCode,
  error,
  changedFiles,
  terminalBuffer,
  restartCount,
  resizeSignal,
  dockTransitioningRef,
  hasProject,
  sessionLabel,
  projectRoot,
  onRenameSession,
  terminalRef: externalTerminalRef,
  onWrite,
  onChangedFileClick,
  onXtermWriteReady,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [termMenu, setTermMenu] = useState<{ x: number; y: number } | null>(null);
  const [imageAttachments, setImageAttachments] = useState<AgentImageAttachmentResult[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputLineRef = useRef('');
  const renamedRef = useRef(false);
  const lastPasteRef = useRef<{ text: string; at: number } | null>(null);
  // Tracks recent image-attachment attempts to suppress double-fires from
  // both the DOM paste handler and the keyboard paste fallback running back
  // to back. Same pattern as lastPasteRef for text pastes.
  const lastImageAttachRef = useRef<{ signature: string; at: number } | null>(null);
  const imageErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragCounterRef = useRef(0);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Keep latest buffer available to initTerminal without making it re-create
  const terminalBufferRef = useRef(terminalBuffer);
  terminalBufferRef.current = terminalBuffer;
  const onXtermWriteReadyRef = useRef(onXtermWriteReady);
  onXtermWriteReadyRef.current = onXtermWriteReady;
  const onWriteRef = useRef(onWrite);
  onWriteRef.current = onWrite;
  const onRenameSessionRef = useRef(onRenameSession);
  onRenameSessionRef.current = onRenameSession;

  const isOwnAgentRunning = status === 'running';

  const statusLabel = status === 'running'
    ? 'Running'
    : status === 'starting'
    ? 'Starting...'
    : status === 'exited'
    ? `Exited${exitCode !== null && exitCode >= 0 ? ` (${exitCode})` : ''}`
    : status === 'error'
    ? 'Error'
    : 'Idle';

  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const syncResize = useCallback(() => {
    if (!terminalRef.current || !fitAddonRef.current) return;
    if (resizeRafRef.current !== null) return;
    // Skip mid-transition refits. While the right-dock is sliding in/out,
    // the agent-region's width is changing on every frame and calling
    // term.resize() would rewrap the buffer repeatedly — that's the
    // "CLI restarts for a sec" feel. We refit once, at the end of the
    // transition, via the resizeSignal prop.
    if (dockTransitioningRef?.current) {
      cliDebug.log('terminal:fitSkipped', { sessionId, reason: 'dockTransitioning' });
      return;
    }
    cliDebug.log('terminal:fitRequested', { sessionId });
    resizeRafRef.current = requestAnimationFrame(() => {
      resizeRafRef.current = null;
      if (!terminalRef.current || !fitAddonRef.current) return;
      try {
        const term = terminalRef.current;
        const proposed = fitAddonRef.current.proposeDimensions();
        if (!proposed || !proposed.cols || !proposed.rows) {
          return;
        }
        const cols = proposed.cols;
        const rows = proposed.rows;
        const fromCols = term.cols;
        const fromRows = term.rows;
        if (fromCols === cols && fromRows === rows) {
          cliDebug.log('terminal:fitNoop', { sessionId, cols, rows });
          return;
        }
        term.resize(cols, rows);
        cliDebug.log('terminal:resize', { sessionId, fromCols, fromRows, toCols: cols, toRows: rows });
        const last = lastSentSizeRef.current;
        const isSmallColumnChange = last && Math.abs(last.cols - cols) <= 1 && last.rows === rows;
        if (isSmallColumnChange) {
          return;
        }
        lastSentSizeRef.current = { cols, rows };
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          const t = terminalRef.current;
          if (!t) return;
          window.electronAPI.resizeAgent(sessionId, t.cols, t.rows);
        }, 120);
      } catch (_) {}
    });
  }, [sessionId]);

  const focusTerminal = useCallback(() => {
    if (terminalRef.current) terminalRef.current.focus();
  }, []);

  useEffect(() => {
    if (externalTerminalRef) {
      (externalTerminalRef as any).current = { focus: focusTerminal };
    }
  }, [externalTerminalRef, focusTerminal]);

  const recordTerminalInputForTitle = useCallback((data: string) => {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = inputLineRef.current;
        inputLineRef.current = '';
        if (!renamedRef.current && isDefaultLabel(sessionLabel) && line.length > 0) {
          const title = extractTitleFromPrompt(line);
          if (title.length > 0) {
            renamedRef.current = true;
            onRenameSession(sessionId, title);
          }
        }
      } else if (ch === '\x7f') {
        if (inputLineRef.current.length > 0) {
          inputLineRef.current = inputLineRef.current.slice(0, -1);
        }
      } else if (ch >= ' ') {
        inputLineRef.current += ch;
      }
    }
  }, [sessionId, sessionLabel, onRenameSession]);

  const sendTerminalInput = useCallback((data: string, source: string) => {
    if (!data) return;

    if (data.length > 1) {
      const now = Date.now();
      const last = lastPasteRef.current;
      if (last && last.text === data && now - last.at < 500) {
        return;
      }
      lastPasteRef.current = { text: data, at: now };
    }

    recordTerminalInputForTitle(data);
    onWrite(data);
  }, [onWrite, recordTerminalInputForTitle]);

  // --- Image attachment helpers ---
  // These are defined in terms of refs that point to the latest handler
  // implementations. This lets the DOM paste / keyboard paste / drop
  // handlers (which are defined earlier in the file and reference these
  // via the refs) stay stable across re-renders.

  const showImageError = useCallback((msg: string) => {
    setImageError(msg);
    if (imageErrorTimerRef.current) clearTimeout(imageErrorTimerRef.current);
    imageErrorTimerRef.current = setTimeout(() => setImageError(null), 4000);
  }, []);

  const attachResult = useCallback(async (result: AgentImageAttachmentResult, dedupeKey: string) => {
    if (!result.success || !result.agentRef) {
      showImageError(result.error || 'Could not attach image.');
      return;
    }
    // Dedupe identical recent attachments (avoids double-fire from DOM +
    // keyboard paste handlers both triggering on the same paste).
    const now = Date.now();
    const last = lastImageAttachRef.current;
    if (last && last.signature === dedupeKey && now - last.at < 800) {
      return;
    }
    lastImageAttachRef.current = { signature: dedupeKey, at: now };

    setImageAttachments((prev) => {
      // Don't add a duplicate of the same absolute path.
      if (prev.some((p) => p.absolutePath && p.absolutePath === result.absolutePath)) {
        return prev;
      }
      return [...prev, result];
    });
    // Insert the @path into the active CLI input. Use the same code path
    // as text paste so the agent sees exactly the @path string with no
    // base64 or structured wrapper. We do NOT auto-submit.
    sendTerminalInput(result.agentRef, 'image-attach');
    cliDebug.log('agent:imageAttached', { agentRef: result.agentRef, dedupeKey });
    focusTerminal();
  }, [sendTerminalInput, showImageError, focusTerminal]);

  // File from DOM paste: read as ArrayBuffer, send to main for save.
  const attachPastedImageFileRef = useRef<((file: File, dedupeKey: string) => void) | null>(null);
  const attachPastedImageFile = useCallback(async (file: File, dedupeKey: string) => {
    try {
      if (file.size > 20 * 1024 * 1024) {
        showImageError('Image is over 20 MB. Attachments are limited to 20 MB.');
        return;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      const result = await window.electronAPI.saveAgentImageAttachment({
        bytes: Array.from(buf),
        mimeType: file.type || 'image/png',
        filename: file.name,
        projectRoot: projectRoot,
      });
      await attachResult(result, dedupeKey);
    } catch (err: any) {
      showImageError(err?.message || 'Could not read pasted image.');
    }
  }, [attachResult, showImageError, projectRoot]);
  attachPastedImageFileRef.current = attachPastedImageFile;

  // File from drag-and-drop: hand the source path to main for copying.
  const attachDroppedImageFile = useCallback(async (file: File, dedupeKey: string) => {
    try {
      if (file.size > 20 * 1024 * 1024) {
        showImageError('Image is over 20 MB. Attachments are limited to 20 MB.');
        return;
      }
      // Use the dropped file's path when available (Electron exposes
      // file.path on dropped files). The main process re-reads the file
      // and copies it into .termina/clipboard/.
      const sourcePath = (file as any).path || '';
      if (!sourcePath) {
        // Fallback: read bytes and re-save via saveAgentImageAttachment.
        const buf = new Uint8Array(await file.arrayBuffer());
        const result = await window.electronAPI.saveAgentImageAttachment({
          bytes: Array.from(buf),
          mimeType: file.type || 'image/png',
          filename: file.name,
          projectRoot: projectRoot,
        });
        await attachResult(result, dedupeKey);
        return;
      }
      const result = await window.electronAPI.saveDroppedImageAttachment({
        sourcePath,
        projectRoot: projectRoot,
      });
      await attachResult(result, dedupeKey);
    } catch (err: any) {
      showImageError(err?.message || 'Could not attach dropped image.');
    }
  }, [attachResult, showImageError, projectRoot]);

  // Native (system) clipboard image — used by Ctrl/Cmd+V fallback when
  // no text is on the system clipboard.
  const readNativeClipboardImage = useCallback(async () => {
    try {
      const result = await window.electronAPI.readClipboardImageForAgent({ projectRoot: projectRoot });
      await attachResult(result, 'native-clipboard');
    } catch (err: any) {
      showImageError(err?.message || 'Could not read clipboard image.');
    }
  }, [attachResult, showImageError, projectRoot]);

  const removeImageAttachment = useCallback((idx: number) => {
    setImageAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleTerminalPaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // 1) Check for image/* items in the clipboard. We do this FIRST so
    //    that pasting a screenshot or "Copy Image" never falls through
    //    to the text path. The clipboard may carry both an image and a
    //    text/uri-list of file paths; in that case we still treat it as
    //    an image paste because the user clearly meant the image.
    const items = e.clipboardData?.items;
    if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            void attachPastedImageFileRef.current?.(file, 'dom-paste');
            return;
          }
        }
      }
    }

    // 2) No image — fall back to the original text path.
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const normalized = normalizeTerminalPaste(text);
    if (!normalized) return;
    sendTerminalInput(normalized, 'dom-paste');
    focusTerminal();
  }, [sendTerminalInput, focusTerminal]);

  const performTerminalPaste = useCallback(async () => {
    let text = '';
    try {
      if (typeof navigator?.clipboard?.readText === 'function') {
        text = await navigator.clipboard.readText();
      }
    } catch {}
    if (!text) {
      try { text = await window.electronAPI.readClipboardText(); } catch {}
    }
    if (!text) {
      // No text on the system clipboard — try a native clipboard image
      // (screenshot tool, browser "Copy Image", etc.).
      await readNativeClipboardImage();
      return;
    }
    const normalized = normalizeTerminalPaste(text);
    if (!normalized) return;
    sendTerminalInput(normalized, 'keyboard-paste');
    focusTerminal();
  }, [sendTerminalInput, focusTerminal, readNativeClipboardImage]);

  const performTerminalCopy = useCallback(async () => {
    if (!terminalRef.current) return;
    const sel = terminalRef.current.getSelection();
    if (!sel) return false;
    try { await window.electronAPI.writeClipboardText(sel); } catch { return false; }
    return true;
  }, []);

  const contextMenuPaste = useCallback(async () => {
    let text = '';
    try {
      if (typeof navigator?.clipboard?.readText === 'function') {
        text = await navigator.clipboard.readText();
      }
    } catch {}
    if (!text) {
      try { text = await window.electronAPI.readClipboardText(); } catch {}
    }
    if (!text) {
      // No text on the clipboard — try a native clipboard image instead.
      await readNativeClipboardImage();
      return;
    }
    const normalized = normalizeTerminalPaste(text);
    if (!normalized) return;
    sendTerminalInput(normalized, 'context-menu-paste');
    focusTerminal();
  }, [sendTerminalInput, focusTerminal, readNativeClipboardImage]);

  // Refs to the latest handler functions so initTerminal stays stable
  const performTerminalPasteRef = useRef(performTerminalPaste);
  performTerminalPasteRef.current = performTerminalPaste;
  const performTerminalCopyRef = useRef(performTerminalCopy);
  performTerminalCopyRef.current = performTerminalCopy;
  const sendTerminalInputRef = useRef(sendTerminalInput);
  sendTerminalInputRef.current = sendTerminalInput;

  const initTerminal = useCallback(() => {
    if (!containerRef.current) return;
    const bufferLen = terminalBufferRef.current?.length ?? 0;
    cliDebug.log('terminal:initStart', { sessionId, bufferLen });
    containerRef.current.innerHTML = '';
    cliDebug.log('terminal:innerHTMLCleared', { sessionId });

    const term = new Terminal({
      fontSize: 11,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      convertEol: false,
      theme: {
        background: '#181825', foreground: '#cdd6f4', cursor: '#cba6f7', cursorAccent: '#181825',
        selectionBackground: '#45475a', black: '#45475a', red: '#f38ba8', green: '#a6e3a1',
        yellow: '#f9e2af', blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#cdd6f4',
        brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
        brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#cdd6f4',
      },
      cursorBlink: true, allowProposedApi: true, allowTransparency: false,
      scrollback: 5000, rows: 24,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    term.focus();

    const pasteHandler = performTerminalPasteRef.current;
    const copyHandler = performTerminalCopyRef.current;
    const sendHandler = sendTerminalInputRef.current;

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      const key = e.key.toLowerCase();
      if (key === 'v' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        void pasteHandler();
        return false;
      }
      if (key === 'c' && !e.shiftKey && !e.altKey) {
        const sel = term.getSelection();
        if (sel && sel.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          void copyHandler();
          return false;
        }
      }
      if (key === 'insert' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        void pasteHandler();
        return false;
      }
      return true;
    });

    if (terminalBufferRef.current) {
      term.write(terminalBufferRef.current);
      cliDebug.log('terminal:bufferWritten', { sessionId, len: terminalBufferRef.current.length });
    }

    setTimeout(() => syncResize(), 50);

    term.onData((data: string) => {
      sendHandler(data, 'xterm-data');
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    cliDebug.log('terminal:initDone', { sessionId });

    onXtermWriteReadyRef.current(sessionId, (data: string) => {
      if (terminalRef.current) {
        terminalRef.current.write(data);
        // Log write bursts from the live data stream (sampled, not every chunk)
        cliDebug.log('terminal:dataWrite', { sessionId, len: data.length });
      }
    });
  }, [sessionId, syncResize]);

  const destroyTerminal = useCallback(() => {
    if (terminalRef.current) {
      cliDebug.log('terminal:dispose', { sessionId });
      try { terminalRef.current.dispose(); } catch (_) {}
      terminalRef.current = null;
      fitAddonRef.current = null;
    }
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }
  }, [sessionId]);

  const copyTerminalSelection = useCallback(async () => {
    if (!terminalRef.current) return;
    const sel = terminalRef.current.getSelection();
    if (sel) {
      try { await window.electronAPI.writeClipboardText(sel); } catch {}
    }
  }, []);

  const handleTerminalContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setTermMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeTermMenu = useCallback(() => setTermMenu(null), []);

  useEffect(() => {
    if (!termMenu) return;
    const close = () => setTermMenu(null);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const click = (e: MouseEvent) => {
      const el = document.querySelector('.term-context-menu');
      if (el && !el.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', esc);
    document.addEventListener('click', click, true);
    return () => {
      document.removeEventListener('keydown', esc);
      document.removeEventListener('click', click, true);
    };
  }, [termMenu]);

  useEffect(() => {
    cliDebug.log('terminal:effectRun', { sessionId, restartCount });
    onXtermWriteReady(sessionId, null);
    destroyTerminal();
    if (containerRef.current) initTerminal();
    return () => {
      cliDebug.log('terminal:effectCleanup', { sessionId });
      onXtermWriteReady(sessionId, null);
      destroyTerminal();
    };
  }, [sessionId, restartCount]);

  useEffect(() => {
    if (isOwnAgentRunning) {
      focusTerminal();
    }
  }, [isOwnAgentRunning, focusTerminal]);

  useEffect(() => {
    cliDebug.log('terminal:resizeSignalEffect', { sessionId, resizeSignal });
    requestAnimationFrame(() => syncResize());
    const t = setTimeout(() => syncResize(), 100);
    return () => clearTimeout(t);
  }, [resizeSignal, syncResize, sessionId]);

  useEffect(() => {
    let pendingRaf: number | null = null;
    const handleResize = () => {
      if (pendingRaf !== null) return;
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = null;
        syncResize();
      });
    };
    window.addEventListener('resize', handleResize);
    const observer = new ResizeObserver(() => {
      if (pendingRaf !== null) return;
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = null;
        syncResize();
      });
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (resizeRafRef.current !== null) cancelAnimationFrame(resizeRafRef.current);
      if (pendingRaf !== null) cancelAnimationFrame(pendingRaf);
    };
  }, [syncResize]);

  const hasAgentChanges = changedFiles.length > 0;

  return (
    <div className="agent-panel">
      <div className="agent-header">
        <div className="agent-header-left">
          <span className="agent-title">{sessionLabel ? sessionLabel : 'AGENT'}</span>
          <span className={`agent-status-badge agent-status-${status}`}>
            {sessionId.slice(-6)} · {statusLabel}
          </span>
        </div>
      </div>

      {(status === 'exited' || status === 'error') && (
        <div className="agent-ended-banner">
          <span>Agent process ended. Start a new chat.</span>
        </div>
      )}

      {error && (
        <div className="agent-error-banner">
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      )}

      {hasAgentChanges && (
        <div className="agent-changes-panel">
          <button className="agent-changes-toggle" onClick={() => setChangesExpanded((v) => !v)}>
            {changesExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="agent-changes-toggle-label">
              Changes: {changedFiles.length} file{changedFiles.length !== 1 ? 's' : ''}
            </span>
          </button>

          {changesExpanded && (
            <div className="agent-changes-content">
              <div className="agent-changed-list">
                {changedFiles.map((evt) => (
                  <button
                    key={evt.path}
                    className={`agent-changed-item agent-changed-${evt.changeType}`}
                    onClick={() => onChangedFileClick(evt)}
                    title={evt.path}
                  >
                    <span className="agent-changed-icon">{changeIcon(evt.changeType)}</span>
                    <span className="agent-changed-name">{evt.path.split(/[\\/]/).pop() || evt.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div
        className={`agent-terminal-container${isDragOver ? ' is-drag-over' : ''}`}
        ref={containerRef}
        onClick={focusTerminal}
        onContextMenu={handleTerminalContextMenu}
        onPasteCapture={handleTerminalPaste}
        onDragEnter={(e) => {
          if (!hasFilesInDataTransfer(e.dataTransfer)) return;
          e.preventDefault();
          dragCounterRef.current += 1;
          setIsDragOver(true);
        }}
        onDragOver={(e) => {
          if (!hasFilesInDataTransfer(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (!hasFilesInDataTransfer(e.dataTransfer)) return;
          dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
          if (dragCounterRef.current === 0) setIsDragOver(false);
        }}
        onDrop={(e) => {
          dragCounterRef.current = 0;
          setIsDragOver(false);
          if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          const files = Array.from(e.dataTransfer.files);
          const imageFiles = files.filter(isImageFile);
          if (imageFiles.length === 0) {
            showImageError('Only image files can be attached (png, jpg, jpeg, webp, gif, bmp, svg).');
            return;
          }
          for (const f of imageFiles) {
            void attachDroppedImageFile(f, `drop:${f.name}:${f.size}:${f.lastModified}`);
          }
          focusTerminal();
        }}
        tabIndex={0}
      >
        {imageError && (
          <div className="agent-error-banner" role="alert">
            <AlertTriangle size={13} />
            <span>{imageError}</span>
          </div>
        )}
      </div>

      {imageAttachments.length > 0 && (
        <div className="agent-image-attachments" data-testid="agent-image-attachments">
          {imageAttachments.map((att, idx) => (
            <AgentImagePreviewChip
              key={(att.absolutePath || att.agentRef || '') + idx}
              agentRef={att.agentRef || ''}
              previewDataUrl={att.previewDataUrl}
              fileName={att.relativePath?.split(/[\\/]/).pop()}
              onRemove={() => removeImageAttachment(idx)}
            />
          ))}
        </div>
      )}

      {termMenu && (
        <div className="term-context-menu" style={{ position: 'fixed', left: termMenu.x, top: termMenu.y, zIndex: 101 }}
          onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <button className="file-context-item" onClick={async () => { closeTermMenu(); await contextMenuPaste(); }}>
            <ClipboardPaste size={11} /><span>Paste</span>
          </button>
          <button className="file-context-item" onClick={async () => { closeTermMenu(); await copyTerminalSelection(); }}>
            <Copy size={11} /><span>Copy Selection</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default AgentPanel;
