import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AlertTriangle, FilePlus, FileEdit, FileMinus, ChevronDown, ChevronRight, X, ClipboardPaste, Copy } from 'lucide-react';
import { FileChangeEvent, AgentStatus } from '../types';

interface AgentPanelProps {
  sessionId: string;
  status: AgentStatus;
  exitCode: number | null;
  error: string;
  changedFiles: FileChangeEvent[];
  terminalBuffer: string;
  restartCount: number;
  resizeSignal: number;
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

function buildChatTitle(prompt: string): string {
  const clean = prompt.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return '';
  const words = clean.split(' ').filter((w) => w.length > 0);
  if (words.length < 2) return '';
  const knownNoise = new Set(['?', '/help', 'help', 'exit', 'clear', 'cls', 'ls', 'dir', 'pwd', 'cd', 'whoami']);
  if (knownNoise.has(words[0].toLowerCase())) return '';
  const meaningful = words.slice(0, 7);
  let title = meaningful.join(' ');
  if (title.length > 42) {
    title = title.slice(0, 42).replace(/\s\S*$/, '');
  }
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || '';
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
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [termMenu, setTermMenu] = useState<{ x: number; y: number } | null>(null);
  const inputLineRef = useRef('');
  const renamedRef = useRef(false);
  const lastPasteRef = useRef<{ text: string; at: number } | null>(null);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

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

  const syncResize = useCallback(() => {
    if (!terminalRef.current || !fitAddonRef.current) return;
    try {
      fitAddonRef.current.fit();
      const cols = terminalRef.current.cols;
      const rows = terminalRef.current.rows;
      if (cols > 0 && rows > 0) {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          window.electronAPI.resizeAgent(sessionId, cols, rows);
        }, 100);
      }
    } catch (_) {}
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
        if (line.length >= 8 && !renamedRef.current && sessionLabel && /^Chat \d+$/.test(sessionLabel)) {
          const title = buildChatTitle(line);
          if (title.length > 0 && title !== 'Chat') {
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

  const initTerminal = useCallback(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = '';

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

    if (terminalBuffer) {
      term.write(terminalBuffer);
    }

    setTimeout(() => syncResize(), 50);

    term.onData((data: string) => {
      sendTerminalInput(data, 'xterm-data');
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    onXtermWriteReady(sessionId, (data: string) => {
      if (terminalRef.current) terminalRef.current.write(data);
    });
  }, [onXtermWriteReady, sessionId, syncResize, terminalBuffer, sendTerminalInput]);

  const destroyTerminal = useCallback(() => {
    if (terminalRef.current) {
      try { terminalRef.current.dispose(); } catch (_) {}
      terminalRef.current = null;
      fitAddonRef.current = null;
    }
  }, []);

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
    onXtermWriteReady(sessionId, null);
    destroyTerminal();
    if (containerRef.current) initTerminal();
    return () => { onXtermWriteReady(sessionId, null); destroyTerminal(); };
  }, [sessionId, restartCount]);

  useEffect(() => {
    if (isOwnAgentRunning) {
      focusTerminal();
    }
  }, [isOwnAgentRunning, focusTerminal]);

  useEffect(() => {
    requestAnimationFrame(() => syncResize());
    const t = setTimeout(() => syncResize(), 100);
    return () => clearTimeout(t);
  }, [resizeSignal, syncResize]);

  useEffect(() => {
    const handleResize = () => syncResize();
    window.addEventListener('resize', handleResize);
    const observer = new ResizeObserver(() => syncResize());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
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
