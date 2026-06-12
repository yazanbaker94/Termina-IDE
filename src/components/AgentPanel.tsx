import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { StopCircle, RotateCcw, Clock, AlertTriangle, FilePlus, FileEdit, FileMinus, RefreshCw, PlusCircle, MinusCircle } from 'lucide-react';
import { FileChangeEvent, GitStatus, AgentStatus } from '../types';

interface AgentPanelProps {
  sessionId: string;
  status: AgentStatus;
  exitCode: number | null;
  error: string;
  changedFiles: FileChangeEvent[];
  terminalBuffer: string;
  restartCount: number;
  hasProject: boolean;
  gitStatus: GitStatus | null;
  sessionLabel: string | null;
  runningSessionId: string | null;
  onRenameSession: (sessionId: string, newLabel: string) => void;
  onWrite: (input: string) => void;
  onStop: () => void;
  onRestart: () => void;
  onChangedFileClick: (evt: FileChangeEvent) => void;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onCommitGit: (message: string) => Promise<boolean>;
  onRefreshGit: () => void;
  onXtermWriteReady: (writeFn: (data: string) => void) => void;
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
  const words = clean.split(' ').filter((w) => w.length > 0);
  const meaningful = words.slice(0, 7);
  let title = meaningful.join(' ');
  if (title.length > 42) {
    title = title.slice(0, 42).replace(/\s\S*$/, '');
  }
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || 'Chat';
}

const AgentPanel: React.FC<AgentPanelProps> = ({
  sessionId,
  status,
  exitCode,
  error,
  changedFiles,
  terminalBuffer,
  restartCount,
  hasProject,
  gitStatus,
  sessionLabel,
  runningSessionId,
  onRenameSession,
  onWrite,
  onStop,
  onRestart,
  onChangedFileClick,
  onStageFile,
  onUnstageFile,
  onCommitGit,
  onRefreshGit,
  onXtermWriteReady,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const inputLineRef = useRef('');
  const renamedRef = useRef(false);

  const isOwnAgentRunning = status === 'running' && runningSessionId === sessionId;

  const handleCommit = useCallback(async () => {
    const trimmed = commitMessage.trim();
    if (!trimmed || committing) return;
    setCommitting(true);
    try {
      const ok = await onCommitGit(trimmed);
      if (ok) {
        setCommitMessage('');
      }
    } finally {
      setCommitting(false);
    }
  }, [commitMessage, committing, onCommitGit]);

  const syncResize = useCallback(() => {
    if (!terminalRef.current || !fitAddonRef.current) return;
    try {
      fitAddonRef.current.fit();
      const cols = terminalRef.current.cols;
      const rows = terminalRef.current.rows;
      if (cols > 0 && rows > 0) {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          window.electronAPI.resizeAgent(cols, rows);
        }, 100);
      }
    } catch (_) {}
  }, []);

  const initTerminal = useCallback(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = '';

    const term = new Terminal({
      fontSize: 11,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      convertEol: false,
      theme: {
        background: '#181825',
        foreground: '#cdd6f4',
        cursor: '#cba6f7',
        cursorAccent: '#181825',
        selectionBackground: '#45475a',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#cdd6f4',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#cdd6f4',
      },
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: false,
      scrollback: 5000,
      rows: 24,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    if (terminalBuffer) {
      term.write(terminalBuffer);
    }

    setTimeout(() => {
      syncResize();
    }, 50);

    term.onData((data: string) => {
      for (const ch of data) {
        if (ch === '\r') {
          const line = inputLineRef.current;
          inputLineRef.current = '';

          if (
            line.length > 0 &&
            !renamedRef.current &&
            sessionLabel &&
            /^Chat \d+$/.test(sessionLabel)
          ) {
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

      onWrite(data);
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    onXtermWriteReady((data: string) => {
      if (terminalRef.current) {
        terminalRef.current.write(data);
      }
    });
  }, [onWrite, onXtermWriteReady, syncResize, terminalBuffer, sessionId, sessionLabel, onRenameSession]);

  const destroyTerminal = useCallback(() => {
    if (terminalRef.current) {
      try {
        terminalRef.current.dispose();
      } catch (_) {}
      terminalRef.current = null;
      fitAddonRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isOwnAgentRunning) {
      if (terminalRef.current) destroyTerminal();
      if (containerRef.current) initTerminal();
    }
    if (!isOwnAgentRunning && !terminalBuffer && terminalRef.current) {
      destroyTerminal();
    }
  }, [isOwnAgentRunning, terminalBuffer, restartCount]);

  useEffect(() => {
    if (!isOwnAgentRunning && terminalBuffer && !terminalRef.current && containerRef.current) {
      initTerminal();
    }
  }, [isOwnAgentRunning, terminalBuffer]);

  useEffect(() => {
    const handleResize = () => { syncResize(); };
    window.addEventListener('resize', handleResize);
    const observer = new ResizeObserver(() => { syncResize(); });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [syncResize]);

  useEffect(() => { return () => { destroyTerminal(); }; }, [destroyTerminal]);

  return (
    <div className="agent-panel">
      <div className="agent-header">
        <span className="agent-title">{sessionLabel ? sessionLabel : 'AGENT'}</span>
        <div className="agent-header-actions">
          {isOwnAgentRunning && (
            <>
              <button className="agent-action-btn" onClick={onRestart} title="Restart Agent">
                <RotateCcw size={13} />
              </button>
              <button className="agent-action-btn" onClick={onStop} title="Stop Agent">
                <StopCircle size={13} />
              </button>
            </>
          )}
          {runningSessionId && runningSessionId !== sessionId && (
            <span className="agent-blocked-hint">
              Agent running in another chat
            </span>
          )}
          {!runningSessionId && status !== 'running' && (
            <button className="agent-action-btn" onClick={onRestart} title="Restart Agent">
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="agent-error-banner">
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      )}

      {changedFiles.length > 0 && (
        <div className="agent-changed-files">
          <div className="agent-changed-title">CHANGED FILES</div>
          <div className="agent-changed-list">
            {changedFiles.map((evt) => (
              <button
                key={evt.path}
                className={`agent-changed-item agent-changed-${evt.changeType}`}
                onClick={() => onChangedFileClick(evt)}
                title={evt.path}
              >
                <span className="agent-changed-icon">{changeIcon(evt.changeType)}</span>
                <span className="agent-changed-name">
                  {evt.path.split(/[\\/]/).pop() || evt.path}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {gitStatus && gitStatus.isRepo && (
        <div className="agent-changed-files">
          <div className="agent-changed-title">
            {gitStatus.branch ? `${gitStatus.branch}` : 'GIT'}
            <button className="git-refresh-btn" onClick={onRefreshGit} title="Refresh git status">
              <RefreshCw size={10} />
            </button>
          </div>
          <div className="agent-changed-list">
            {gitStatus.files.length === 0 && (
              <div className="git-empty">Working tree clean</div>
            )}
            {gitStatus.files.map((f) => {
              const hasStaged = f.staged;
              const hasUnstaged = f.unstaged;
              let statusClass = '';
              if (f.untracked) statusClass = 'git-status-untracked';
              else if (hasStaged && hasUnstaged) statusClass = 'git-status-modified';
              else if (hasStaged) statusClass = 'git-status-staged';
              else statusClass = 'git-status-modified';
              return (
                <div key={f.path} className="git-file-row">
                  <span className={`git-status ${statusClass}`}>{f.status}</span>
                  <span className="agent-changed-name" title={f.path}>{f.gitPath}</span>
                  <div className="git-file-actions">
                    {(hasUnstaged || f.untracked) && (
                      <button className="git-action-btn" onClick={() => onStageFile(f.gitPath)} title="Stage">
                        <PlusCircle size={10} />
                      </button>
                    )}
                    {hasStaged && (
                      <button className="git-action-btn" onClick={() => onUnstageFile(f.gitPath)} title="Unstage">
                        <MinusCircle size={10} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {gitStatus && gitStatus.isRepo && (
        <div className="agent-commit-bar">
          <input
            className="git-commit-input"
            type="text"
            placeholder="Commit message"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCommit(); }}
          />
          <button
            className="git-commit-btn"
            disabled={!gitStatus.files.some((f) => f.staged) || !commitMessage.trim() || committing}
            onClick={handleCommit}
            title="Commit"
          >
            {committing ? '...' : 'Commit'}
          </button>
        </div>
      )}

      <div className="agent-terminal-container" ref={containerRef} />

      {status !== 'running' && !terminalBuffer && (
        <div className="agent-content">
          <div className="agent-empty">
            <div className="agent-empty-icon">
              <Clock size={32} />
            </div>
            <p className="agent-empty-text">
              {hasProject
                ? status === 'exited'
                  ? `Agent exited${exitCode !== null && exitCode >= 0 ? ` with code ${exitCode}` : ''}`
                  : 'Agent not running'
                : 'No folder open'}
            </p>
            <p className="agent-empty-sub">
              {hasProject
                ? status === 'exited'
                  ? 'Click Restart to run again.'
                  : runningSessionId && runningSessionId !== sessionId
                    ? 'Agent is running in another chat.'
                    : 'Click Restart to start the agent.'
                : 'Open a folder to start the agent.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentPanel;
