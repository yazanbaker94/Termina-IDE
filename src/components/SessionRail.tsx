import React from 'react';
import { MessageSquarePlus, FolderGit2, Hash, MessageSquare, Files, FolderOpen } from 'lucide-react';
import { StoredProject, StoredSession } from '../data/store';

interface SessionRailProps {
  projects: StoredProject[];
  sessions: StoredSession[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  hasProject: boolean;
  onNewChat: () => void;
  onToggleFiles: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectProject: (project: StoredProject) => void;
  onOpenFolder: () => void;
}

const SessionRail: React.FC<SessionRailProps> = ({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  hasProject,
  onNewChat,
  onToggleFiles,
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
        <button className="session-sidebar-icon-btn" onClick={onToggleFiles} title="Toggle Files">
          <Files size={15} />
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
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`session-chat-row ${s.id === activeSessionId ? 'active' : ''}`}
                      onClick={() => onSelectSession(s.id)}
                      title={s.label}
                    >
                      <MessageSquare size={13} className="session-chat-icon" />
                      <span className="session-chat-label">{s.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="session-sidebar-footer">
        {hasProject && activeProjectId && (
          <button className="session-new-chat-footer-btn" onClick={onNewChat}>
            <MessageSquarePlus size={14} />
            <span>New Chat</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default SessionRail;
