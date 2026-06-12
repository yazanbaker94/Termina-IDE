import React from 'react';
import { MessageSquarePlus, FolderGit2, MessageSquare, FolderOpen } from 'lucide-react';
import { StoredProject, StoredSession } from '../data/store';
import { SessionRuntimeState } from '../types';

interface SessionRailProps {
  projects: StoredProject[];
  sessions: StoredSession[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  hasProject: boolean;
  sessionRuntime: Record<string, SessionRuntimeState>;
  onNewChat: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectProject: (project: StoredProject) => void;
  onOpenFolder: () => void;
}

const statusColors: Record<string, string> = {
  running: '#a6e3a1',
  starting: '#f9e2af',
  exited: '#f38ba8',
  idle: 'transparent',
};

const SessionRail: React.FC<SessionRailProps> = ({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  hasProject,
  sessionRuntime,
  onNewChat,
  onSelectSession,
  onSelectProject,
  onOpenFolder,
}) => {
  const sortedProjects = [...projects].sort((a, b) => b.openedAt - a.openedAt);

  return (
    <div className="session-sidebar">
      <div className="session-sidebar-header">
        <button className="session-new-chat-btn" onClick={onNewChat} title="New Chat">
          <MessageSquarePlus size={16} />
          <span>New Chat</span>
        </button>
      </div>

      <div className="session-sidebar-body">
        {sortedProjects.length === 0 && !hasProject && (
          <div className="session-sidebar-empty">
            <p className="session-sidebar-empty-text">No recent projects</p>
            <button className="session-sidebar-open-btn" onClick={onOpenFolder}>
              <FolderOpen size={14} />
              <span>Open Folder</span>
            </button>
          </div>
        )}

        {sortedProjects.map((p) => {
          const isActiveProject = p.id === activeProjectId;
          return (
            <div key={p.id} className="session-project-group">
              <button
                className={`session-project-row ${isActiveProject ? 'active' : ''}`}
                onClick={() => onSelectProject(p)}
                title={p.name}
              >
                <FolderGit2 size={14} className="session-project-icon" />
                <span className="session-project-name">{p.name}</span>
              </button>

              {isActiveProject && (
                <div className="session-sessions-list">
                  {sessions.map((s) => {
                    const runtime = sessionRuntime[s.id];
                    const agentStatus = runtime?.agentStatus ?? 'idle';
                    const isRunning = agentStatus === 'running';
                    return (
                      <button
                        key={s.id}
                        className={`session-chat-row ${s.id === activeSessionId ? 'active' : ''}`}
                        onClick={() => onSelectSession(s.id)}
                        title={s.label}
                      >
                        <span
                          className="session-chat-status-dot"
                          style={{
                            backgroundColor: isRunning ? statusColors.running : agentStatus === 'exited' ? statusColors.exited : agentStatus === 'starting' ? statusColors.starting : 'transparent',
                            border: (!isRunning && agentStatus === 'idle') ? '1px solid var(--text-muted)' : 'none',
                          }}
                        />
                        <MessageSquare size={13} className="session-chat-icon" />
                        <span className="session-chat-label">{s.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="session-sidebar-footer">
      </div>
    </div>
  );
};

export default SessionRail;
