import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AlertTriangle, FilePlus, FileEdit, FileMinus, ChevronDown, ChevronRight, X, ClipboardPaste, Copy } from 'lucide-react';
import { FileChangeEvent, AgentStatus } from '../types';
import { cliDebug } from '../debug/cliDebug';
import { extractTitleFromPrompt, isDefaultLabel, buildContextualTitle } from '../utils/sessionNaming';

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
  const inputLineRef = useRef('');
  const renamedRef = useRef(false);
  const lastPasteRef = useRef<{ text: string; at: number } | null>(null);

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

  const handleTerminalPaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
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
    if (!text) return;
    const normalized = normalizeTerminalPaste(text);
    if (!normalized) return;
    sendTerminalInput(normalized, 'keyboard-paste');
    focusTerminal();
  }, [sendTerminalInput, focusTerminal]);

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
    if (!text) return;
    const normalized = normalizeTerminalPaste(text);
    if (!normalized) return;
    sendTerminalInput(normalized, 'context-menu-paste');
    focusTerminal();
  }, [sendTerminalInput, focusTerminal]);

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

      <div className="agent-terminal-container"
        ref={containerRef}
        onClick={focusTerminal}
        onContextMenu={handleTerminalContextMenu}
        onPasteCapture={handleTerminalPaste}
        tabIndex={0} />

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
