import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { StopCircle, RotateCcw, Play, Clock, AlertTriangle, FilePlus, FileEdit, FileMinus, RefreshCw, PlusCircle, MinusCircle, ChevronDown, ChevronRight } from 'lucide-react';
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
  onStart: () => void;
  onChangedFileClick: (evt: FileChangeEvent) => void;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onCommitGit: (message: string) => Promise<boolean>;
  onRefreshGit: () => void;
  onXtermWriteReady: (sessionId: string, writeFn: ((data: string) => void) | null) => void;
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
  onStart,
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
  const [changesExpanded, setChangesExpanded] = useState(false);
  const inputLineRef = useRef('');
  const renamedRef = useRef(false);

  const isOwnAgentRunning = runningSessionId === sessionId && status === 'running';
  const otherChatRunning = !!runningSessionId && runningSessionId !== sessionId;

  const statusLabel = status === 'running'
    ? 'Running'
    : status === 'starting'
    ? 'Starting...'
    : status === 'exited'
    ? `Exited${exitCode !== null && exitCode >= 0 ? ` (${exitCode})` : ''}`
    : status === 'error'
    ? 'Error'
    : 'Idle';

  const handleCommit = useCallback(async () => {
    const trimmed = commitMessage.trim();
    if (!trimmed || committing) return;
    setCommitting(true);
    try {
      const ok = await onCommitGit(trimmed);
      if (ok) setCommitMessage('');
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
    term.focus();

    if (terminalBuffer) {
      term.write(terminalBuffer);
    }

    setTimeout(() => syncResize(), 50);

    term.onData((data: string) => {
      for (const ch of data) {
        if (ch === '\r') {
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
      onWrite(data);
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    onXtermWriteReady(sessionId, (data: string) => {
      if (terminalRef.current) terminalRef.current.write(data);
    });
  }, [onWrite, syncResize, terminalBuffer, sessionId, sessionLabel, onRenameSession, onXtermWriteReady]);

  const destroyTerminal = useCallback(() => {
    if (terminalRef.current) {
      try { terminalRef.current.dispose(); } catch (_) {}
      terminalRef.current = null;
      fitAddonRef.current = null;
    }
  }, []);

  const focusTerminal = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  }, []);

  useEffect(() => {
    onXtermWriteReady(sessionId, null);
    destroyTerminal();
    if (containerRef.current) {
      initTerminal();
    }
    return () => {
      onXtermWriteReady(sessionId, null);
      destroyTerminal();
    };
  }, [sessionId, restartCount]);

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
  const hasGitChanges = !!(gitStatus?.isRepo && gitStatus.files.length > 0);
  const shouldShowChangesPanel = hasAgentChanges || hasGitChanges;
  const hasStagedFiles = gitStatus?.isRepo && gitStatus.files.some((f) => f.staged);

  return (
    <div className="agent-panel">
      <div className="agent-header">
        <div className="agent-header-left">
          <span className="agent-title">{sessionLabel ? sessionLabel : 'AGENT'}</span>
          <span className={`agent-status-badge agent-status-${status}`}>
            {statusLabel}
            {isOwnAgentRunning && ' — PTY connected'}
          </span>
        </div>
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
          {otherChatRunning && (
            <span className="agent-blocked-hint">
              Agent running in another chat
            </span>
          )}
          {!runningSessionId && status !== 'running' && status !== 'error' && (
            <button className="agent-action-btn agent-start-btn" onClick={onStart} title="Start Agent">
              <Play size={13} />
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

      {shouldShowChangesPanel && (
        <div className="agent-changes-panel" data-cy="changes-panel">
          <button
            className="agent-changes-toggle"
            onClick={() => setChangesExpanded((v) => !v)}
          >
            {changesExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="agent-changes-toggle-label">
              Changes{hasAgentChanges ? `: ${changedFiles.length} file${changedFiles.length !== 1 ? 's' : ''}` : ''}
              {!hasAgentChanges && hasGitChanges ? ` (${gitStatus!.files.length} git)` : ''}
            </span>
          </button>

          {changesExpanded && (
            <div className="agent-changes-content">
              {hasAgentChanges && (
                <div className="agent-changed-files">
                  <div className="agent-changed-title">AGENT CHANGES</div>
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

              {gitStatus && gitStatus.isRepo && (
                <div className="agent-changed-files">
                  <div className="agent-changed-title">
                    {gitStatus.branch ?? 'GIT'}
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
                      let sc = '';
                      if (f.untracked) sc = 'git-status-untracked';
                      else if (hasStaged && hasUnstaged) sc = 'git-status-modified';
                      else if (hasStaged) sc = 'git-status-staged';
                      else sc = 'git-status-modified';
                      return (
                        <div key={f.path} className="git-file-row">
                          <span className={`git-status ${sc}`}>{f.status}</span>
                          <span className="agent-changed-name" title={f.path}>{f.gitPath}</span>
                          <div className="git-file-actions">
                            {(hasUnstaged || f.untracked) && (
                              <button className="git-action-btn" onClick={() => onStageFile(f.gitPath)} title="Stage"><PlusCircle size={10} /></button>
                            )}
                            {hasStaged && (
                              <button className="git-action-btn" onClick={() => onUnstageFile(f.gitPath)} title="Unstage"><MinusCircle size={10} /></button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {changesExpanded && hasGitChanges && (
                <div className="agent-commit-bar">
                  <span className="git-commit-section-label">Commit</span>
                  <input
                    className="git-commit-input"
                    type="text"
                    placeholder={hasStagedFiles ? "Commit message" : "Stage files to commit"}
                    value={commitMessage}
                    onChange={(e) => setCommitMessage(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCommit(); }}
                  />
                  <button
                    className="git-commit-btn"
                    disabled={!hasStagedFiles || !commitMessage.trim() || committing}
                    onClick={handleCommit}
                    title="Commit"
                  >
                    {committing ? '...' : 'Commit'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="agent-terminal-container" ref={containerRef} onClick={focusTerminal} />

      {!terminalBuffer && status === 'idle' && !isOwnAgentRunning && (
        <div className="agent-content">
          <div className="agent-empty">
            <div className="agent-empty-icon"><Clock size={32} /></div>
            <p className="agent-empty-text">
              {hasProject ? 'Agent not running' : 'No folder open'}
            </p>
            <p className="agent-empty-sub">
              {hasProject
                ? otherChatRunning
                  ? 'Agent is running in another chat.'
                  : 'Click Start Agent to start.'
                : 'Open a folder to start the agent.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentPanel;
