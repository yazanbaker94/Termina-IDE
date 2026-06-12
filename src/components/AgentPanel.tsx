import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { StopCircle, RotateCcw, Clock, AlertTriangle, FilePlus, FileEdit, FileMinus, RefreshCw, PlusCircle, MinusCircle } from 'lucide-react';
import { AgentStatus, FileChangeEvent, GitStatus } from '../types';

interface AgentPanelProps {
  status: AgentStatus;
  exitCode: number | null;
  error: string;
  changedFiles: FileChangeEvent[];
  restartCount: number;
  hasProject: boolean;
  gitStatus: GitStatus | null;
  sessionLabel: string | null;
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

const AgentPanel: React.FC<AgentPanelProps> = ({
  status,
  exitCode,
  error,
  changedFiles,
  restartCount,
  hasProject,
  gitStatus,
  sessionLabel,
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

    setTimeout(() => {
      syncResize();
    }, 50);

    term.onData((data: string) => {
      onWrite(data);
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    onXtermWriteReady((data: string) => {
      term.write(data);
    });
  }, [onWrite, onXtermWriteReady, syncResize]);

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
    if (status === 'running') {
      if (terminalRef.current) {
        destroyTerminal();
      }
      if (containerRef.current) {
        initTerminal();
      }
    }
    if (status !== 'running' && terminalRef.current) {
      destroyTerminal();
    }
  }, [status, restartCount, initTerminal, destroyTerminal]);

  useEffect(() => {
    const handleResize = () => {
      syncResize();
    };

    window.addEventListener('resize', handleResize);

    const observer = new ResizeObserver(() => {
      syncResize();
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [syncResize, status]);

  useEffect(() => {
    return () => {
      destroyTerminal();
    };
  }, [destroyTerminal]);

  return (
    <div className="agent-panel">
      <div className="agent-header">
        <span className="agent-title">{sessionLabel ? sessionLabel : 'AGENT'}</span>
        <div className="agent-header-actions">
          {status === 'running' && (
            <>
              <button className="agent-action-btn" onClick={onRestart} title="Restart Agent">
                <RotateCcw size={13} />
              </button>
              <button className="agent-action-btn" onClick={onStop} title="Stop Agent">
                <StopCircle size={13} />
              </button>
            </>
          )}
          {(status === 'exited' || status === 'idle') && (
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
                  <span className={`git-status ${statusClass}`}>
                    {f.status}
                  </span>
                  <span className="agent-changed-name" title={f.path}>
                    {f.gitPath}
                  </span>
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
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCommit();
              }
            }}
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

      {status === 'running' && (
        <div className="agent-terminal-container" ref={containerRef} />
      )}

      {status === 'exited' && !error && (
        <div className="agent-content">
          <div className="agent-empty">
            <div className="agent-empty-icon">
              <Clock size={32} />
            </div>
            <p className="agent-empty-text">Agent exited{exitCode !== null && exitCode >= 0 ? ` with code ${exitCode}` : ''}</p>
            <p className="agent-empty-sub">Click Restart to run again.</p>
          </div>
        </div>
      )}

      {status === 'exited' && error && (
        <div className="agent-content">
          <div className="agent-empty">
            <p className="agent-empty-text">Agent failed to start</p>
            <p className="agent-empty-sub">Click Restart to try again.</p>
          </div>
        </div>
      )}

      {status === 'idle' && !error && (
        <div className="agent-content">
          <div className="agent-empty">
            <div className="agent-empty-icon">
              <Clock size={32} />
            </div>
            <p className="agent-empty-text">
              {hasProject ? 'Agent not running' : 'No folder open'}
            </p>
            <p className="agent-empty-sub">
              {hasProject
                ? 'Click Run Agent to start.'
                : 'Open a folder to start the agent.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentPanel;
