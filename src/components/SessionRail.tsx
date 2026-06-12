import React, { useState, useMemo } from 'react';
import { MessageSquarePlus, FolderGit2, MessageSquare, FolderOpen, MoreHorizontal, X, ChevronRight } from 'lucide-react';
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
  onSelectProjectSession: (project: StoredProject, sessionId: string) => void;
  onOpenFolder: () => void;
  onRemoveProject: (projectId: string) => void;
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
  onSelectProjectSession,
  onOpenFolder,
  onRemoveProject,
}) => {
  const [contextProjectId, setContextProjectId] = useState<string | null>(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set(projects.map((p) => p.id)));

  const sessionsByProjectId = useMemo(() => {
    const map: Record<string, StoredSession[]> = {};
    for (const s of sessions) {
      if (!map[s.projectId]) map[s.projectId] = [];
      map[s.projectId].push(s);
    }
    return map;
  }, [sessions]);

  const toggleExpand = (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  return (
    <div className="session-sidebar" onClick={() => setContextProjectId(null)}>
      <div className="session-sidebar-header">
        <button className="session-new-chat-btn" onClick={onNewChat} title="New Chat" disabled={!activeProjectId}>
          <MessageSquarePlus size={16} />
          <span>New Chat</span>
        </button>
      </div>

      <div className="session-sidebar-body">
        {projects.length === 0 && !hasProject && (
          <div className="session-sidebar-empty">
            <p className="session-sidebar-empty-text">No recent projects</p>
            <button className="session-sidebar-open-btn" onClick={onOpenFolder}>
              <FolderOpen size={14} />
              <span>Open Folder</span>
            </button>
          </div>
        )}

        {projects.map((p) => {
          const isActiveProject = p.id === activeProjectId;
          const isExpanded = expandedProjectIds.has(p.id);
          const projectSessions = sessionsByProjectId[p.id] ?? [];
          const hasSessions = projectSessions.length > 0;

          return (
            <div key={p.id} className="session-project-group" onContextMenu={(e) => { e.preventDefault(); setContextProjectId(p.id); }}>
              <button
                className={`session-project-row ${isActiveProject ? 'active' : ''}`}
                onClick={() => { onSelectProject(p); if (!isExpanded) setExpandedProjectIds((prev) => new Set(prev).add(p.id)); }}
                title={p.name}
              >
                <span
                  className="project-disclosure"
                  onClick={(e) => toggleExpand(p.id, e)}
                  style={{ opacity: hasSessions ? 1 : 0.3 }}
                >
                  <ChevronRight size={12} style={{ transform: isExpanded ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s ease' }} />
                </span>
                <FolderGit2 size={14} className="session-project-icon" />
                <span className="session-project-name">{p.name}</span>
                <button
                  className="session-project-menu-btn"
                  onClick={(e) => { e.stopPropagation(); setContextProjectId(contextProjectId === p.id ? null : p.id); }}
                  title="Project options"
                >
                  <MoreHorizontal size={12} />
                </button>
              </button>

              {contextProjectId === p.id && (
                <div className="session-context-menu" onClick={(e) => e.stopPropagation()}>
                  <button className="session-context-menu-item" onClick={() => { onRemoveProject(p.id); setContextProjectId(null); }}>
                    <X size={12} />
                    <span>Remove Folder from Sidebar</span>
                    <span className="session-context-menu-hint">Does not delete files from disk</span>
                  </button>
                </div>
              )}

              {isExpanded && hasSessions && (
                <div className="project-sessions">
                  {projectSessions.map((s) => {
                    const runtime = sessionRuntime[s.id];
                    const agentStatus = runtime?.agentStatus ?? 'idle';
                    const isRunning = agentStatus === 'running';
                    return (
                      <button
                        key={s.id}
                        className={`session-chat-row ${s.id === activeSessionId && isActiveProject ? 'active' : ''}`}
                        onClick={() => {
                          if (isActiveProject) {
                            onSelectSession(s.id);
                          } else {
                            onSelectProjectSession(p, s.id);
                          }
                        }}
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

      <div className="session-sidebar-footer" />
    </div>
  );
};

export default SessionRail;
