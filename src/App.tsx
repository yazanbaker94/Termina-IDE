import React, { useState, useCallback, useRef, useEffect } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import Toolbar from './components/Toolbar';
import SessionRail from './components/SessionRail';
import Editor from './components/Editor';
import DiffViewer from './components/DiffViewer';
import AgentPanel from './components/AgentPanel';
import FilesDrawer from './components/FilesDrawer';
import BottomBar from './components/BottomBar';
import { loadAppData, saveAppData, generateId, StoredProject, StoredSession, AppData } from './data/store';
import { FileNode, FileState, OpenFolderResult, FileChangeEvent, FileDiff, GitStatus, SessionRuntimeState } from './types';

const MAX_TERMINAL_BUFFER = 200000;

const defaultRuntime = (): SessionRuntimeState => ({
  agentStatus: 'idle',
  exitCode: null,
  error: '',
  terminalBuffer: '',
  changedFiles: [],
  restartCount: 0,
  activeFilePath: null,
  activeFileName: null,
  diffPath: null,
});

const App: React.FC = () => {
  const [appData, setAppData] = useState<AppData>(loadAppData);
  const { projects, activeProjectId } = appData;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // Runtime-only sessions — never persisted
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const [projectName, setProjectName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootTree, setRootTree] = useState<FileNode | null>(null);
  const [hasProject, setHasProject] = useState(false);
  const [activeFile, setActiveFile] = useState<FileState | null>(null);
  const [savedContent, setSavedContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [activeDiff, setActiveDiff] = useState<FileDiff | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [filesDrawerVisible, setFilesDrawerVisible] = useState(false);

  const [sessionRuntime, setSessionRuntime] = useState<Record<string, SessionRuntimeState>>({});
  const [dockChangeCount, setDockChangeCount] = useState(0);

  const activeRuntime = activeSessionId ? sessionRuntime[activeSessionId] : null;

  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const hasProjectRef = useRef(hasProject);
  hasProjectRef.current = hasProject;
  const isDirtyRef = useRef(false);
  const activeDiffRef = useRef<FileDiff | null>(null);
  activeDiffRef.current = activeDiff;
  const fsListenerRef = useRef<(() => void) | null>(null);
  const agentListenersRef = useRef<(() => void)[]>([]);
  const agentListenersAttachedRef = useRef(false);
  const agentHasRunRef = useRef(false);
  const xtermWriteRef = useRef<{ sessionId: string | null; write: ((data: string) => void) | null }>({ sessionId: null, write: null });
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangedPathsRef = useRef<Set<string>>(new Set());
  const pendingDeletedPathsRef = useRef<Set<string>>(new Set());

  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const activeSessionByProjectIdRef = useRef<Record<string, string>>({});
  const sessionRuntimeRef = useRef(sessionRuntime);
  sessionRuntimeRef.current = sessionRuntime;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const isDirty = activeFile ? activeFile.content !== savedContent : false;
  isDirtyRef.current = isDirty;

  // Auto-reopen active project on startup
  useEffect(() => {
    const reopenProject = async () => {
      const initialData = loadAppData();
      if (!initialData.activeProjectId) return;
      const project = initialData.projects.find((p) => p.id === initialData.activeProjectId);
      if (!project) return;

      try {
        const result = await window.electronAPI.openProjectPath(project.rootPath);
        if (!result.success || !result.rootPath) {
          setSaveStatus('Project folder not found');
          setTimeout(() => setSaveStatus(''), 3000);
          return;
        }

        setProjectName(result.projectName ?? project.name);
        setRootPath(result.rootPath);
        setRootTree(result.tree ?? null);
        setHasProject(true);
        setActiveFile(null);
        setSavedContent('');
        setActiveDiff(null);
        setFilesDrawerVisible(false);
        agentHasRunRef.current = false;

        setGitStatus(null);
        refreshGitStatus();
      } catch (err) {
        console.error('Failed to reopen project:', err);
      }
    };

    reopenProject();
  }, []);

  const persist = useCallback((data: AppData) => {
    setAppData(data);
    saveAppData(data);
  }, []);

  const updateSessionRuntime = useCallback((sessionId: string, update: Partial<SessionRuntimeState>) => {
    setSessionRuntime((prev) => {
      const current = prev[sessionId] ?? defaultRuntime();
      return { ...prev, [sessionId]: { ...current, ...update } };
    });
  }, []);

  const appendTerminalBuffer = useCallback((sessionId: string, data: string) => {
    setSessionRuntime((prev) => {
      const current = prev[sessionId];
      const existing = current?.terminalBuffer ?? '';
      let buf = existing + data;
      if (buf.length > MAX_TERMINAL_BUFFER) {
        buf = buf.slice(buf.length - MAX_TERMINAL_BUFFER);
      }
      return { ...prev, [sessionId]: { ...(current ?? defaultRuntime()), terminalBuffer: buf } };
    });
  }, []);

  const cleanAgentListeners = useCallback(() => {
    agentListenersRef.current.forEach((fn) => fn());
    agentListenersRef.current = [];
  }, []);

  const cleanAllListeners = useCallback(() => {
    fsListenerRef.current?.();
    fsListenerRef.current = null;
    cleanAgentListeners();
    agentListenersAttachedRef.current = false;
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, [cleanAgentListeners]);

  const refreshFileTree = useCallback(async () => {
    try {
      const tree = await window.electronAPI.getFileTree();
      if (tree) setRootTree(tree);
    } catch (err) {
      console.error('Failed to refresh file tree:', err);
    }
  }, []);

  const refreshGitStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.getGitStatus();
      setGitStatus(status);
    } catch (err) {
      console.error('Failed to refresh git status:', err);
    }
  }, []);

  const reconcileAgentStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI.getAgentStatus();
      const runningIds = new Set(Object.keys(status.running));
      setSessionRuntime((prev) => {
        const next = { ...prev };
        // Set running for sessions whose PTY is alive
        for (const id of runningIds) {
          const current = next[id] ?? defaultRuntime();
          next[id] = { ...current, agentStatus: 'running', exitCode: null, error: '' };
        }
        // Mark sessions that think they're running/starting but PTY is gone as exited
        for (const [sid, rt] of Object.entries(next)) {
          if (!runningIds.has(sid) && (rt.agentStatus === 'running' || rt.agentStatus === 'starting')) {
            next[sid] = { ...rt, agentStatus: 'exited' };
          }
        }
        return next;
      });
    } catch {}
  }, []);

  const setupAgentListeners = useCallback(() => {
    if (agentListenersAttachedRef.current) return;
    agentListenersAttachedRef.current = true;

    const unsubData = window.electronAPI.onAgentData(({ sessionId, data }) => {
      appendTerminalBuffer(sessionId, data);
      if (
        xtermWriteRef.current.write &&
        xtermWriteRef.current.sessionId === sessionId &&
        activeSessionIdRef.current === sessionId
      ) {
        xtermWriteRef.current.write(data);
      }
    });

    const unsubExit = window.electronAPI.onAgentExit(({ sessionId, exitCode }) => {
      if (exitCode >= 0) {
        updateSessionRuntime(sessionId, { agentStatus: 'exited', exitCode });
      }
    });

    agentListenersRef.current = [unsubData, unsubExit];
  }, [appendTerminalBuffer, updateSessionRuntime]);

  const startAgentWithListeners = useCallback(async (sessionId: string, cwd: string) => {
    updateSessionRuntime(sessionId, { agentStatus: 'starting', error: '', changedFiles: [], restartCount: (sessionRuntimeRef.current[sessionId]?.restartCount ?? 0) + 1 });
    setupAgentListeners();

    const result = await window.electronAPI.startAgent(sessionId, cwd);
    if (!result.success) {
      updateSessionRuntime(sessionId, { agentStatus: 'error', error: result.error ?? 'Failed to start agent.' });
      return;
    }

    updateSessionRuntime(sessionId, { agentStatus: 'running', exitCode: null });
    await reconcileAgentStatus();
  }, [setupAgentListeners, updateSessionRuntime, reconcileAgentStatus]);

  const selectProjectCore = useCallback(async (project: StoredProject, targetSessionId?: string | null) => {
    try {
      const result = await window.electronAPI.openProjectPath(project.rootPath);
      if (!result.success || !result.rootPath) {
        setSaveStatus('Project folder not found');
        setTimeout(() => setSaveStatus(''), 3000);
        return;
      }

      fsListenerRef.current?.();
      fsListenerRef.current = null;
      setProjectName(result.projectName ?? project.name);
      setRootPath(result.rootPath);
      setRootTree(result.tree ?? null);
      setHasProject(true);
      setActiveFile(null);
      setSavedContent('');
      setActiveDiff(null);
      setFilesDrawerVisible(false);
      agentHasRunRef.current = false;

      const updated = {
        ...appData,
        activeProjectId: project.id,
        projects: appData.projects.map((p) =>
          p.id === project.id ? { ...p, openedAt: Date.now() } : p,
        ),
      };
      persist(updated);

      // Select target session or restore last active from runtime
      const projectSessions = sessionsRef.current.filter((s) => s.projectId === project.id);
      let finalSessionId: string | null = null;
      if (targetSessionId && projectSessions.some((s) => s.id === targetSessionId)) {
        finalSessionId = targetSessionId;
      } else if (projectSessions.length > 0) {
        const cached = activeSessionByProjectIdRef.current[project.id];
        finalSessionId = (cached && projectSessions.some((s) => s.id === cached))
          ? cached
          : projectSessions[projectSessions.length - 1].id;
      }
      setActiveSessionId(finalSessionId);
      if (finalSessionId) {
        activeSessionByProjectIdRef.current[project.id] = finalSessionId;
      }

      setGitStatus(null);
      refreshGitStatus();
      await reconcileAgentStatus();

      const unsubFs = window.electronAPI.onFileChanged((evt: FileChangeEvent) => {
        // TODO: attribute to correct session when multi-agent file tracking is implemented
        const owningId = activeSessionIdRef.current;
        if (owningId) {
          const rt = sessionRuntimeRef.current[owningId];
          const prev = rt?.changedFiles ?? [];
          if (!prev.some((f) => f.path === evt.path)) {
            updateSessionRuntime(owningId, { changedFiles: [...prev, evt] });
          }
        }
        if (evt.changeType === 'deleted') {
          pendingDeletedPathsRef.current.add(evt.path);
          pendingChangedPathsRef.current.delete(evt.path);
        } else {
          pendingChangedPathsRef.current.add(evt.path);
          pendingDeletedPathsRef.current.delete(evt.path);
        }
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(async () => {
          refreshFileTree();
          refreshGitStatus();
          const changedSet = new Set(pendingChangedPathsRef.current);
          const deletedSet = new Set(pendingDeletedPathsRef.current);
          pendingChangedPathsRef.current.clear();
          pendingDeletedPathsRef.current.clear();
          const currentFile = activeFileRef.current;
          const currentDiff = activeDiffRef.current;
          const dirty = isDirtyRef.current;
          if (currentFile) {
            if (deletedSet.has(currentFile.path)) {
              setActiveFile(null); setSavedContent('');
            } else if (changedSet.has(currentFile.path)) {
              if (dirty) {
                setSaveStatus('File changed on disk');
                setTimeout(() => setSaveStatus(''), 3000);
              } else {
                try {
                  const reloaded = await window.electronAPI.readFile(currentFile.path);
                  setActiveFile({ name: currentFile.name, path: reloaded.filePath, content: reloaded.content, language: reloaded.language });
                  setSavedContent(reloaded.content);
                } catch { setActiveFile(null); setSavedContent(''); }
              }
            }
          }
          if (currentDiff && changedSet.has(currentDiff.filePath)) {
            const owningId2 = activeSessionIdRef.current;
            if (owningId2) {
              try {
                const refreshed = await window.electronAPI.getFileDiff(owningId2, currentDiff.filePath);
                if (refreshed) setActiveDiff(refreshed);
                else setActiveDiff(null);
              } catch { setActiveDiff(null); }
            }
          }
        }, 300);
      });
      fsListenerRef.current = unsubFs;
    } catch (err) {
      console.error('Failed to open project:', err);
      setSaveStatus('Failed to open project');
      setTimeout(() => setSaveStatus(''), 3000);
    }
  }, [appData, persist, refreshFileTree, refreshGitStatus, updateSessionRuntime, reconcileAgentStatus]);

  const handleSelectProject = useCallback(
    async (project: StoredProject) => {
      if (project.id === activeProjectId && hasProject) return;
      await selectProjectCore(project, null);
    },
    [activeProjectId, hasProject, selectProjectCore],
  );

  const handleSelectProjectSession = useCallback(
    async (project: StoredProject, sessionId: string) => {
      if (project.id !== activeProjectId) {
        await selectProjectCore(project, sessionId);
        return;
      }
      handleSelectSession(sessionId);
    },
    [activeProjectId, selectProjectCore],
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId) return;
      const prevId = activeSessionId;
      if (prevId) {
        updateSessionRuntime(prevId, {
          activeFilePath: activeFileRef.current?.path ?? null,
          activeFileName: activeFileRef.current?.name ?? null,
          diffPath: activeDiffRef.current?.filePath ?? null,
        });
      }

      const selectedSession = sessionsRef.current.find((s) => s.id === sessionId);
      if (selectedSession && activeProjectId) {
        activeSessionByProjectIdRef.current[activeProjectId] = sessionId;
      }

      const nextRuntime = sessionRuntime[sessionId];
      setActiveDiff(null);
      setActiveSessionId(sessionId);

      // Ensure runtime status is accurate for this session
      reconcileAgentStatus();

      if (nextRuntime?.activeFilePath) {
        window.electronAPI.readFile(nextRuntime.activeFilePath).then((result) => {
          setActiveFile({
            name: nextRuntime.activeFileName ?? nextRuntime.activeFilePath!.split(/[\\/]/).pop() ?? 'untitled',
            path: result.filePath, content: result.content, language: result.language,
          });
          setSavedContent(result.content);
        }).catch(() => { setActiveFile(null); setSavedContent(''); });
      } else {
        setActiveFile(null); setSavedContent('');
      }
    },
    [activeSessionId, activeProjectId, sessionRuntime, updateSessionRuntime, reconcileAgentStatus],
  );

  const handleNewChat = useCallback(async () => {
    if (!activeProjectId) return;

    const prevId = activeSessionId;
    if (prevId) {
      updateSessionRuntime(prevId, {
        activeFilePath: activeFileRef.current?.path ?? null,
        activeFileName: activeFileRef.current?.name ?? null,
        diffPath: activeDiffRef.current?.filePath ?? null,
      });
    }

    const sessionId = generateId();
    const projectChats = sessions.filter((s) => s.projectId === activeProjectId);
    const newSession: StoredSession = {
      id: sessionId,
      projectId: activeProjectId,
      rootPath: rootPath ?? '',
      label: `Chat ${projectChats.length + 1}`,
      createdAt: Date.now(),
    };
    const newSessions = [...sessions, newSession];
    setSessions(newSessions);
    setActiveSessionId(sessionId);
    if (activeProjectId) {
      activeSessionByProjectIdRef.current[activeProjectId] = sessionId;
    }

    setActiveFile(null); setSavedContent(''); setActiveDiff(null);
    await startAgentWithListeners(sessionId, newSession.rootPath);
  }, [activeProjectId, rootPath, sessions, updateSessionRuntime, startAgentWithListeners]);

  const handleOpenFolder = useCallback(async () => {
    try {
      fsListenerRef.current?.();
      fsListenerRef.current = null;
      const result: OpenFolderResult | null = await window.electronAPI.openFolder();
      if (!result) return;

      setProjectName(result.projectName);
      setRootPath(result.rootPath);
      setRootTree(result.tree);
      setHasProject(true);
      setActiveFile(null); setSavedContent(''); setActiveDiff(null);
      setFilesDrawerVisible(false);
      agentHasRunRef.current = false;

      let current = { ...appData };
      const existingProject = current.projects.find((p) => p.rootPath === result.rootPath);
      let projectId: string;
      if (existingProject) {
        projectId = existingProject.id;
        existingProject.openedAt = Date.now();
      } else {
        projectId = generateId();
        current.projects = [...current.projects, { id: projectId, name: result.projectName, rootPath: result.rootPath, openedAt: Date.now() }];
      }

      current.activeProjectId = projectId;
      persist(current);

      // Select last active chat for this project from runtime state
      const projectSessions = sessionsRef.current.filter((s) => s.projectId === projectId);
      if (projectSessions.length > 0) {
        const cached = activeSessionByProjectIdRef.current[projectId];
        const targetId = (cached && projectSessions.some((s) => s.id === cached))
          ? cached
          : projectSessions[projectSessions.length - 1].id;
        setActiveSessionId(targetId);
        activeSessionByProjectIdRef.current[projectId] = targetId;
        await reconcileAgentStatus();
      } else {
        setActiveSessionId(null);
      }

      const unsubFs = window.electronAPI.onFileChanged((evt: FileChangeEvent) => {
        // TODO: attribute to correct session when multi-agent file tracking is implemented
        const owningId = activeSessionIdRef.current;
        if (owningId) {
          const rt = sessionRuntimeRef.current[owningId];
          const prev = rt?.changedFiles ?? [];
          if (!prev.some((f) => f.path === evt.path)) {
            updateSessionRuntime(owningId, { changedFiles: [...prev, evt] });
          }
        }
        if (evt.changeType === 'deleted') {
          pendingDeletedPathsRef.current.add(evt.path);
          pendingChangedPathsRef.current.delete(evt.path);
        } else {
          pendingChangedPathsRef.current.add(evt.path);
          pendingDeletedPathsRef.current.delete(evt.path);
        }
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(async () => {
          refreshFileTree(); refreshGitStatus();
          const changedSet = new Set(pendingChangedPathsRef.current);
          const deletedSet = new Set(pendingDeletedPathsRef.current);
          pendingChangedPathsRef.current.clear(); pendingDeletedPathsRef.current.clear();
          const currentFile = activeFileRef.current;
          const currentDiff = activeDiffRef.current;
          const dirty = isDirtyRef.current;
          if (currentFile) {
            if (deletedSet.has(currentFile.path)) { setActiveFile(null); setSavedContent(''); }
            else if (changedSet.has(currentFile.path)) {
              if (dirty) { setSaveStatus('File changed on disk'); setTimeout(() => setSaveStatus(''), 3000); }
              else {
                try {
                  const reloaded = await window.electronAPI.readFile(currentFile.path);
                  setActiveFile({ name: currentFile.name, path: reloaded.filePath, content: reloaded.content, language: reloaded.language });
                  setSavedContent(reloaded.content);
                } catch { setActiveFile(null); setSavedContent(''); }
              }
            }
          }
          if (currentDiff && changedSet.has(currentDiff.filePath)) {
            const owningId2 = activeSessionIdRef.current;
            if (owningId2) {
              try {
                const refreshed = await window.electronAPI.getFileDiff(owningId2, currentDiff.filePath);
                if (refreshed) setActiveDiff(refreshed); else setActiveDiff(null);
              } catch { setActiveDiff(null); }
            }
          }
        }, 300);
      });
      fsListenerRef.current = unsubFs;
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  }, [appData, persist, refreshFileTree, refreshGitStatus, updateSessionRuntime, reconcileAgentStatus]);

  const handleFileSelect = useCallback(async (node: FileNode) => {
    if (node.type === 'directory') return;
    setActiveDiff(null); setIsLoading(true);
    try {
      const result = await window.electronAPI.readFile(node.path);
      setActiveFile({ name: node.name, path: result.filePath, content: result.content, language: result.language });
      setSavedContent(result.content);
    } catch (err) { console.error('Failed to read file:', err); }
    finally { setIsLoading(false); }
  }, []);

  const handleEditorChange = useCallback((newContent: string | undefined) => {
    if (newContent === undefined || !activeFileRef.current) return;
    setActiveFile((prev) => prev ? { ...prev, content: newContent } : prev);
  }, []);

  const handleChangedFileClick = useCallback(async (evt: FileChangeEvent) => {
    if (!activeSessionId) return;
    setIsLoading(true);
    try {
      const diff = await window.electronAPI.getFileDiff(activeSessionId, evt.path);
      if (diff) setActiveDiff(diff);
    } catch (err) { console.error('Failed to get file diff:', err); }
    finally { setIsLoading(false); }
  }, [activeSessionId]);

  const handleCloseFile = useCallback(() => {
    const dirty = activeFile ? activeFile.content !== savedContent : false;
    if (dirty && !window.confirm('Close without saving?')) return;
    setActiveFile(null);
    setSavedContent('');
    setActiveDiff(null);
  }, [activeFile, savedContent]);

  const handleRemoveProject = useCallback(async (projectId: string) => {
    const projectSessions = sessions.filter((s) => s.projectId === projectId);
    for (const s of projectSessions) {
      try { await window.electronAPI.stopAgent(s.id); } catch {}
    }
    const cleanedRuntime = { ...sessionRuntimeRef.current };
    for (const s of projectSessions) {
      delete cleanedRuntime[s.id];
    }
    setSessionRuntime(cleanedRuntime);
    const remainingSessions = sessions.filter((s) => s.projectId !== projectId);
    setSessions(remainingSessions);
    const updatedProjects = appData.projects.filter((p) => p.id !== projectId);
    const newActiveId = projectId === activeProjectId
      ? (updatedProjects.length > 0 ? updatedProjects[0].id : null)
      : activeProjectId;
    const newData: AppData = { projects: updatedProjects, activeProjectId: newActiveId };
    setAppData(newData);
    saveAppData(newData);
    if (projectId === activeProjectId) {
      if (newActiveId) {
        handleSelectProject(updatedProjects.find((p) => p.id === newActiveId)!);
      } else {
        setActiveSessionId(null);
        setHasProject(false);
        setRootPath(null);
        setRootTree(null);
        setProjectName(null);
        setActiveFile(null);
        setSavedContent('');
        setActiveDiff(null);
      }
    }
  }, [projects, activeProjectId, sessions, appData, handleSelectProject]);

  const handleOpenFile = useCallback(async (filePath: string) => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.readFile(filePath);
      setActiveFile({ name: filePath.split(/[\\/]/).pop() || 'untitled', path: result.filePath, content: result.content, language: result.language });
      setSavedContent(result.content); setActiveDiff(null);
    } catch (err) { console.error('Failed to open file:', err); }
    finally { setIsLoading(false); }
  }, []);

  const handleWriteAgent = useCallback(async (sessionId: string, input: string) => {
    try {
      const result = await window.electronAPI.writeAgent(sessionId, input);
      if (!result.success) {
        updateSessionRuntime(sessionId, { agentStatus: 'exited', error: 'Agent process is no longer running.' });
        await reconcileAgentStatus();
      }
    } catch (err) {
      console.error('Failed to write to agent:', err);
    }
  }, [updateSessionRuntime, reconcileAgentStatus]);

  const handleRenameSession = useCallback((sessionId: string, newLabel: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, label: newLabel, renamedFromPrompt: true, updatedAt: Date.now() } : s,
      ),
    );
  }, []);

  const handleXtermWriteReady = useCallback((sessionId: string, writeFn: ((data: string) => void) | null) => {
    xtermWriteRef.current = { sessionId, write: writeFn };
  }, []);

  const handleSave = useCallback(async () => {
    if (!hasProjectRef.current || !activeFileRef.current) return;
    const file = activeFileRef.current;
    try {
      await window.electronAPI.saveFile(file.path, file.content);
      setSavedContent(file.content);
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(''), 2000);
    } catch (err) {
      console.error('Failed to save file:', err);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  useEffect(() => { return () => { cleanAllListeners(); }; }, [cleanAllListeners]);

  const handleRefreshTree = useCallback(() => refreshFileTree(), [refreshFileTree]);
  const handleToggleFiles = useCallback(() => setFilesDrawerVisible((v) => !v), []);

  const showEditor = !!activeFile || !!activeDiff;
  const rightDockOpen = filesDrawerVisible || showEditor;

  return (
    <div className="app-container">
      <Toolbar onOpenFolder={handleOpenFolder} onToggleFiles={handleToggleFiles} />
      <div className="app-body">
        <SessionRail projects={projects} sessions={sessions}
          activeProjectId={activeProjectId} activeSessionId={activeSessionId}
          hasProject={hasProject} sessionRuntime={sessionRuntime}
          onNewChat={handleNewChat}
          onSelectSession={handleSelectSession}
          onSelectProject={handleSelectProject}
          onSelectProjectSession={handleSelectProjectSession}
          onOpenFolder={handleOpenFolder}
          onRemoveProject={handleRemoveProject} />

        <div className="app-main">
          {hasProject && !activeSessionId && (
            <div className="app-no-session">
              <div className="app-no-session-icon"><MessageSquarePlus size={40} /></div>
              <p className="app-no-session-text">No active chat session</p>
              <p className="app-no-session-sub">Start a new chat to begin working with the agent.</p>
            </div>
          )}

          {activeSessionId && (
            <div className="agent-region">
              <AgentPanel sessionId={activeSessionId}
                status={activeRuntime?.agentStatus ?? 'idle'} exitCode={activeRuntime?.exitCode ?? null}
                error={activeRuntime?.error ?? ''} changedFiles={activeRuntime?.changedFiles ?? []}
                terminalBuffer={activeRuntime?.terminalBuffer ?? ''} restartCount={activeRuntime?.restartCount ?? 0}
                hasProject={hasProject} sessionLabel={activeSession?.label ?? null}
                onRenameSession={handleRenameSession}
                onWrite={(input) => handleWriteAgent(activeSessionId, input)}
                onChangedFileClick={handleChangedFileClick}
                onXtermWriteReady={handleXtermWriteReady} />
            </div>
          )}

          {rightDockOpen && (
            <div className="right-dock">
              {filesDrawerVisible && (
                <div className="dock-pane files-dock-pane">
                  <FilesDrawer visible={true} projectName={hasProject ? (projectName || '') : null}
                    rootTree={rootTree} activeFilePath={activeFile?.path || ''}
                    onClose={() => setFilesDrawerVisible(false)} onFileSelect={handleFileSelect}
                    onRefreshTree={handleRefreshTree} onOpenFolder={handleOpenFolder} />
                </div>
              )}

              {showEditor && (
                <div className="dock-pane code-dock-pane">
                  {activeDiff ? (
                    <DiffViewer diff={activeDiff} onClose={() => setActiveDiff(null)} onOpenFile={handleOpenFile} />
                  ) : (
                    <Editor file={activeFile} isLoading={isLoading} isDirty={isDirty} hasProject={hasProject}
                      onChange={handleEditorChange} onSave={handleSave} onClose={handleCloseFile} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <BottomBar projectName={hasProject ? (projectName || '') : null} fileName={activeFile?.name || ''}
        language={activeFile?.language || ''} saveStatus={saveStatus} branch={gitStatus?.isRepo ? gitStatus.branch : null} />
    </div>
  );
};

export default App;
export type { FileState };
