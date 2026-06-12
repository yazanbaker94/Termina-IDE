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

const App: React.FC = () => {
  const [appData, setAppData] = useState<AppData>(loadAppData);
  const { projects, sessions, activeProjectId, activeSessionId } = appData;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const activeProjectSessions = sessions.filter((s) => s.projectId === activeProjectId);

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
  const [runningAgentSessionId, setRunningAgentSessionId] = useState<string | null>(null);
  const [pendingAutoStartSessionId, setPendingAutoStartSessionId] = useState<string | null>(null);

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
  const agentHasRunRef = useRef(false);
  const xtermWriteRef = useRef<((data: string) => void) | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangedPathsRef = useRef<Set<string>>(new Set());
  const pendingDeletedPathsRef = useRef<Set<string>>(new Set());

  const isDirty = activeFile ? activeFile.content !== savedContent : false;
  isDirtyRef.current = isDirty;

  const persist = useCallback((data: AppData) => {
    setAppData(data);
    saveAppData(data);
  }, []);

  const updateSessionRuntime = useCallback((sessionId: string, update: Partial<SessionRuntimeState>) => {
    setSessionRuntime((prev) => {
      const current = prev[sessionId] ?? {
        agentStatus: 'idle' as const,
        exitCode: null,
        error: '',
        terminalBuffer: '',
        changedFiles: [],
        restartCount: 0,
        activeFilePath: null,
        activeFileName: null,
        diffPath: null,
      };
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
      return { ...prev, [sessionId]: { ...(current ?? {
        agentStatus: 'idle' as const,
        exitCode: null,
        error: '',
        terminalBuffer: '',
        changedFiles: [],
        restartCount: 0,
        activeFilePath: null,
        activeFileName: null,
        diffPath: null,
      }), terminalBuffer: buf } };
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
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
  }, [cleanAgentListeners]);

  const refreshFileTree = useCallback(async () => {
    try {
      const tree = await window.electronAPI.getFileTree();
      if (tree) {
        setRootTree(tree);
      }
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

  const setupAgentListeners = useCallback((owningSessionId: string) => {
    cleanAgentListeners();

    const unsubData = window.electronAPI.onAgentData(({ sessionId, data }) => {
      if (sessionId !== owningSessionId) return;
      appendTerminalBuffer(sessionId, data);
      if (xtermWriteRef.current) {
        xtermWriteRef.current(data);
      }
    });

    const unsubExit = window.electronAPI.onAgentExit(({ sessionId, exitCode }) => {
      if (sessionId !== owningSessionId) return;
      if (exitCode >= 0) {
        updateSessionRuntime(sessionId, { agentStatus: 'exited', exitCode });
      }
      setRunningAgentSessionId(null);
      cleanAgentListeners();
    });

    agentListenersRef.current = [unsubData, unsubExit];
  }, [cleanAgentListeners, appendTerminalBuffer, updateSessionRuntime]);

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

  const handleRefreshTree = useCallback(() => {
    refreshFileTree();
  }, [refreshFileTree]);

  const handleToggleFiles = useCallback(() => {
    setFilesDrawerVisible((v) => !v);
  }, []);

  const handleSelectProject = useCallback(
    async (project: StoredProject) => {
      if (project.id === activeProjectId && hasProject) return;

      if (runningAgentSessionId) {
        try { await window.electronAPI.stopAgent(); } catch {}
        cleanAgentListeners();
        setRunningAgentSessionId(null);
      }

      try {
        const result = await window.electronAPI.openProjectPath(project.rootPath);
        if (!result.success || !result.rootPath) {
          setSaveStatus('Project no longer exists');
          setTimeout(() => setSaveStatus(''), 3000);
          return;
        }

        cleanAllListeners();
        setProjectName(result.projectName ?? project.name);
        setRootPath(result.rootPath);
        setRootTree(result.tree ?? null);
        setHasProject(true);
        setActiveFile(null);
        setSavedContent('');
        setActiveDiff(null);
        setFilesDrawerVisible(false);
        agentHasRunRef.current = false;

        let current = { ...appData };
        current.activeProjectId = project.id;
        current.projects = current.projects.map((p) =>
          p.id === project.id ? { ...p, openedAt: Date.now() } : p,
        );

        const projectSessions = current.sessions.filter((s) => s.projectId === project.id);
        if (projectSessions.length > 0) {
          current.activeSessionId = projectSessions[projectSessions.length - 1].id;
        } else {
          const sid = generateId();
          current.sessions = [
            ...current.sessions,
            { id: sid, projectId: project.id, label: 'Chat 1', createdAt: Date.now() },
          ];
          current.activeSessionId = sid;
        }

        setAppData(current);
        saveAppData(current);

        setGitStatus(null);
        refreshGitStatus();

        const unsubFs = window.electronAPI.onFileChanged((evt: FileChangeEvent) => {
          if (agentHasRunRef.current) {
            const owningId = runningAgentSessionId;
            if (owningId) {
              updateSessionRuntime(owningId, {
                changedFiles: (sessionRuntime[owningId]?.changedFiles ?? []).filter((f) => f.path !== evt.path).concat(
                  evt.changeType !== 'deleted' && !sessionRuntime[owningId]?.changedFiles.some((f) => f.path === evt.path)
                    ? [evt] : [],
                ),
              });
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
                setActiveFile(null);
                setSavedContent('');
              } else if (changedSet.has(currentFile.path)) {
                if (dirty) {
                  setSaveStatus('File changed on disk');
                  setTimeout(() => setSaveStatus(''), 3000);
                } else {
                  try {
                    const reloaded = await window.electronAPI.readFile(currentFile.path);
                    setActiveFile({ name: currentFile.name, path: reloaded.filePath, content: reloaded.content, language: reloaded.language });
                    setSavedContent(reloaded.content);
                  } catch {
                    setActiveFile(null);
                    setSavedContent('');
                  }
                }
              }
            }
            if (currentDiff && changedSet.has(currentDiff.filePath)) {
              const owningId = runningAgentSessionId;
              if (owningId) {
                try {
                  const refreshed = await window.electronAPI.getFileDiff(owningId, currentDiff.filePath);
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
    },
    [activeProjectId, hasProject, runningAgentSessionId, sessionRuntime, appData, cleanAllListeners, cleanAgentListeners, refreshFileTree, refreshGitStatus, updateSessionRuntime],
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

      const nextRuntime = sessionRuntime[sessionId];
      setActiveDiff(null);

      if (nextRuntime?.activeFilePath) {
        window.electronAPI.readFile(nextRuntime.activeFilePath).then((result) => {
          setActiveFile({
            name: nextRuntime.activeFileName ?? nextRuntime.activeFilePath!.split(/[\\/]/).pop() ?? 'untitled',
            path: result.filePath,
            content: result.content,
            language: result.language,
          });
          setSavedContent(result.content);
        }).catch(() => {
          setActiveFile(null);
          setSavedContent('');
        });
      } else {
        setActiveFile(null);
        setSavedContent('');
      }

      persist({ ...appData, activeSessionId: sessionId });
    },
    [activeSessionId, appData, sessionRuntime, persist, updateSessionRuntime],
  );

  const handleNewChat = useCallback(() => {
    if (!activeProjectId) return;

    if (runningAgentSessionId) {
      try { window.electronAPI.stopAgent().catch(() => {}); } catch {}
      cleanAgentListeners();
      setRunningAgentSessionId(null);
    }

    const sessionId = generateId();
    const projectChats = sessions.filter((s) => s.projectId === activeProjectId);
    const newSession: StoredSession = {
      id: sessionId,
      projectId: activeProjectId,
      label: `Chat ${projectChats.length + 1}`,
      createdAt: Date.now(),
    };
    persist({
      ...appData,
      sessions: [...appData.sessions, newSession],
      activeSessionId: sessionId,
    });

    setActiveFile(null);
    setSavedContent('');
    setActiveDiff(null);
    setPendingAutoStartSessionId(sessionId);
  }, [activeProjectId, runningAgentSessionId, appData, sessions, cleanAgentListeners, persist]);

  useEffect(() => {
    if (pendingAutoStartSessionId && activeSessionId === pendingAutoStartSessionId && hasProject) {
      const sessionId = pendingAutoStartSessionId;
      setPendingAutoStartSessionId(null);
      handleStartAgent(sessionId);
    }
  }, [pendingAutoStartSessionId, activeSessionId, hasProject]);

  const handleOpenFolder = useCallback(async () => {
    try {
      if (runningAgentSessionId) {
        await window.electronAPI.stopAgent().catch(() => {});
        cleanAgentListeners();
        setRunningAgentSessionId(null);
      }

      cleanAllListeners();

      const result: OpenFolderResult | null = await window.electronAPI.openFolder();
      if (!result) return;

      setProjectName(result.projectName);
      setRootPath(result.rootPath);
      setRootTree(result.tree);
      setHasProject(true);
      setActiveFile(null);
      setSavedContent('');
      setActiveDiff(null);
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
        current.projects = [
          ...current.projects,
          { id: projectId, name: result.projectName, rootPath: result.rootPath, openedAt: Date.now() },
        ];
      }

      const projectSessions = current.sessions.filter((s) => s.projectId === projectId);
      let sessionId: string;

      if (projectSessions.length > 0) {
        sessionId = projectSessions[projectSessions.length - 1].id;
      } else {
        sessionId = generateId();
        current.sessions = [
          ...current.sessions,
          { id: sessionId, projectId, label: 'Chat 1', createdAt: Date.now() },
        ];
      }

      current.activeProjectId = projectId;
      current.activeSessionId = sessionId;

      setAppData(current);
      saveAppData(current);

      const unsubFs = window.electronAPI.onFileChanged((evt: FileChangeEvent) => {
        if (agentHasRunRef.current) {
          const owningId = runningAgentSessionId;
          if (owningId) {
            updateSessionRuntime(owningId, {
              changedFiles: (sessionRuntime[owningId]?.changedFiles ?? []).filter((f) => f.path !== evt.path).concat(
                evt.changeType !== 'deleted' && !sessionRuntime[owningId]?.changedFiles.some((f) => f.path === evt.path)
                  ? [evt] : [],
              ),
            });
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
              setActiveFile(null);
              setSavedContent('');
            } else if (changedSet.has(currentFile.path)) {
              if (dirty) {
                setSaveStatus('File changed on disk');
                setTimeout(() => setSaveStatus(''), 3000);
              } else {
                try {
                  const reloaded = await window.electronAPI.readFile(currentFile.path);
                  setActiveFile({ name: currentFile.name, path: reloaded.filePath, content: reloaded.content, language: reloaded.language });
                  setSavedContent(reloaded.content);
                } catch {
                  setActiveFile(null);
                  setSavedContent('');
                }
              }
            }
          }
          if (currentDiff && changedSet.has(currentDiff.filePath)) {
            const owningId = runningAgentSessionId;
            if (owningId) {
              try {
                const refreshed = await window.electronAPI.getFileDiff(owningId, currentDiff.filePath);
                if (refreshed) setActiveDiff(refreshed);
                else setActiveDiff(null);
              } catch { setActiveDiff(null); }
            }
          }
        }, 300);
      });
      fsListenerRef.current = unsubFs;

      setGitStatus(null);
      refreshGitStatus();
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  }, [runningAgentSessionId, sessionRuntime, appData, cleanAllListeners, cleanAgentListeners, refreshFileTree, refreshGitStatus, updateSessionRuntime]);

  const handleFileSelect = useCallback(async (node: FileNode) => {
    if (node.type === 'directory') return;
    setActiveDiff(null);
    setFilesDrawerVisible(false);
    setIsLoading(true);
    try {
      const result = await window.electronAPI.readFile(node.path);
      setActiveFile({ name: node.name, path: result.filePath, content: result.content, language: result.language });
      setSavedContent(result.content);
    } catch (err) {
      console.error('Failed to read file:', err);
    } finally {
      setIsLoading(false);
    }
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
      if (activeSessionId) {
        updateSessionRuntime(activeSessionId, {
          changedFiles: (sessionRuntime[activeSessionId]?.changedFiles ?? []).filter((f) => f.path !== evt.path),
        });
      }
    } catch (err) {
      console.error('Failed to get file diff:', err);
    } finally {
      setIsLoading(false);
    }
  }, [activeSessionId, sessionRuntime, updateSessionRuntime]);

  const handleCloseDiff = useCallback(() => setActiveDiff(null), []);

  const handleOpenFile = useCallback(async (filePath: string) => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.readFile(filePath);
      setActiveFile({ name: filePath.split(/[\\/]/).pop() || 'untitled', path: result.filePath, content: result.content, language: result.language });
      setSavedContent(result.content);
      setActiveDiff(null);
    } catch (err) {
      console.error('Failed to open file:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleRevertFile = useCallback(async (filePath: string) => {
    if (!activeSessionId) return;
    try {
      const result = await window.electronAPI.revertFile(activeSessionId, filePath);
      if (!result.success) {
        setSaveStatus('Revert failed');
        setTimeout(() => setSaveStatus(''), 2000);
        return;
      }
      updateSessionRuntime(activeSessionId, {
        changedFiles: (sessionRuntime[activeSessionId]?.changedFiles ?? []).filter((f) => f.path !== filePath),
      });
      setActiveDiff(null);
      await refreshFileTree();
      if (result.action === 'restored') {
        if (activeFileRef.current && activeFileRef.current.path === filePath) { setActiveFile(null); setSavedContent(''); }
        try {
          const fileResult = await window.electronAPI.readFile(filePath);
          setActiveFile({ name: filePath.split(/[\\/]/).pop() || 'untitled', path: fileResult.filePath, content: fileResult.content, language: fileResult.language });
          setSavedContent(fileResult.content);
        } catch { setActiveFile(null); setSavedContent(''); }
      } else if (result.action === 'deleted') {
        if (activeFileRef.current && activeFileRef.current.path === filePath) { setActiveFile(null); setSavedContent(''); }
      }
      setSaveStatus('Reverted');
      setTimeout(() => setSaveStatus(''), 2000);
      refreshGitStatus();
    } catch (err) {
      console.error('Failed to revert file:', err);
    }
  }, [activeSessionId, sessionRuntime, refreshFileTree, updateSessionRuntime]);

  const handleStageFile = useCallback(async (filePath: string) => { await window.electronAPI.stageFile(filePath); refreshGitStatus(); }, [refreshGitStatus]);
  const handleUnstageFile = useCallback(async (filePath: string) => { await window.electronAPI.unstageFile(filePath); refreshGitStatus(); }, [refreshGitStatus]);

  const handleCommitGit = useCallback(async (message: string): Promise<boolean> => {
    try {
      const result = await window.electronAPI.commitGit(message);
      if (result.success) {
        setSaveStatus('Committed');
        setTimeout(() => setSaveStatus(''), 2000);
        refreshGitStatus();
        refreshFileTree();
        return true;
      } else {
        setSaveStatus(result.error ?? 'Commit failed');
        setTimeout(() => setSaveStatus(''), 4000);
        refreshGitStatus();
        return false;
      }
    } catch (err) {
      console.error('Failed to commit:', err);
      setSaveStatus('Commit failed');
      setTimeout(() => setSaveStatus(''), 3000);
      return false;
    }
  }, [refreshGitStatus, refreshFileTree]);

  const handleStartAgent = useCallback(async (sessionId: string) => {
    if (runningAgentSessionId && runningAgentSessionId !== sessionId) {
      const runningLabel = sessions.find((s) => s.id === runningAgentSessionId)?.label ?? 'another chat';
      const errorMsg = `Agent is already running in ${runningLabel}. Stop it before starting a new one.`;
      updateSessionRuntime(sessionId, { error: errorMsg });
      setSaveStatus(errorMsg);
      setTimeout(() => setSaveStatus(''), 4000);
      return;
    }

    updateSessionRuntime(sessionId, { error: '', changedFiles: [], restartCount: (sessionRuntime[sessionId]?.restartCount ?? 0) + 1 });

    setupAgentListeners(sessionId);

    const result = await window.electronAPI.startAgent(sessionId);
    if (!result.success) {
      updateSessionRuntime(sessionId, { agentStatus: 'idle', error: result.error ?? 'Failed to start agent.' });
      cleanAgentListeners();
      return;
    }

    updateSessionRuntime(sessionId, { agentStatus: 'running', exitCode: null });
    setRunningAgentSessionId(sessionId);
  }, [runningAgentSessionId, sessions, sessionRuntime, setupAgentListeners, cleanAgentListeners, updateSessionRuntime]);

  const handleWriteAgent = useCallback(async (input: string) => {
    if (!runningAgentSessionId || !activeSessionId) return;
    if (runningAgentSessionId !== activeSessionId) return;
    try {
      await window.electronAPI.writeAgent(input);
    } catch (err) {
      console.error('Failed to write to agent:', err);
    }
  }, [runningAgentSessionId, activeSessionId]);

  const handleStopAgent = useCallback(async () => {
    try {
      await window.electronAPI.stopAgent();
      cleanAgentListeners();
      setRunningAgentSessionId(null);
      if (activeSessionId) {
        updateSessionRuntime(activeSessionId, { agentStatus: 'idle' });
      }
    } catch (err) {
      console.error('Failed to stop agent:', err);
    }
  }, [activeSessionId, cleanAgentListeners, updateSessionRuntime]);

  const handleRestartAgent = useCallback(async () => {
    if (!activeSessionId) return;
    cleanAgentListeners();
    setRunningAgentSessionId(null);
    updateSessionRuntime(activeSessionId, { error: '', changedFiles: [], restartCount: (sessionRuntime[activeSessionId]?.restartCount ?? 0) + 1 });
    setupAgentListeners(activeSessionId);
    const result = await window.electronAPI.restartAgent(activeSessionId);
    if (!result.success) {
      updateSessionRuntime(activeSessionId, { agentStatus: 'idle', error: result.error ?? 'Failed to restart agent.' });
      cleanAgentListeners();
      return;
    }
    updateSessionRuntime(activeSessionId, { agentStatus: 'running', exitCode: null });
    setRunningAgentSessionId(activeSessionId);
  }, [activeSessionId, sessionRuntime, setupAgentListeners, cleanAgentListeners, updateSessionRuntime]);

  const handleRenameSession = useCallback((sessionId: string, newLabel: string) => {
    setAppData((prev) => {
      const updated = {
        ...prev,
        sessions: prev.sessions.map((s) =>
          s.id === sessionId ? { ...s, label: newLabel, renamedFromPrompt: true, updatedAt: Date.now() } : s,
        ),
      };
      saveAppData(updated);
      return updated;
    });
  }, []);

  const handleXtermWriteReady = useCallback((writeFn: (data: string) => void) => {
    xtermWriteRef.current = writeFn;
  }, []);

  useEffect(() => { return () => { cleanAllListeners(); }; }, [cleanAllListeners]);

  const showEditor = !!activeFile || !!activeDiff;

  return (
    <div className="app-container">
      <Toolbar
        onOpenFolder={handleOpenFolder}
        onRunAgent={() => activeSessionId && handleStartAgent(activeSessionId)}
        onToggleFiles={handleToggleFiles}
        agentDisabled={!hasProject || !activeSessionId}
        agentRunning={runningAgentSessionId === activeSessionId && (activeRuntime?.agentStatus === 'running' || activeRuntime?.agentStatus === 'starting')}
        otherChatRunning={!!runningAgentSessionId && runningAgentSessionId !== activeSessionId}
      />
      <div className="app-body">
        <SessionRail
          projects={projects}
          sessions={activeProjectSessions}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          hasProject={hasProject}
          runningSessionId={runningAgentSessionId}
          sessionRuntime={sessionRuntime}
          onNewChat={handleNewChat}
          onToggleFiles={handleToggleFiles}
          onSelectSession={handleSelectSession}
          onSelectProject={handleSelectProject}
          onOpenFolder={handleOpenFolder}
        />

        <div className="app-main">
          {hasProject && !activeSessionId && (
            <div className="app-no-session">
              <div className="app-no-session-icon">
                <MessageSquarePlus size={40} />
              </div>
              <p className="app-no-session-text">No active chat session</p>
              <p className="app-no-session-sub">Start a new chat to begin working with the agent.</p>
            </div>
          )}

          {activeSessionId && showEditor && (
            <div className="app-editor-pane">
              {activeDiff ? (
                <DiffViewer diff={activeDiff} onClose={handleCloseDiff} onOpenFile={handleOpenFile} onRevertFile={handleRevertFile} />
              ) : (
                <Editor file={activeFile} isLoading={isLoading} isDirty={isDirty} hasProject={hasProject} onChange={handleEditorChange} onSave={handleSave} />
              )}
            </div>
          )}

          {activeSessionId && (
            <div className={`app-agent-pane ${showEditor ? 'with-editor' : ''}`}>
              <AgentPanel
                sessionId={activeSessionId}
                status={activeRuntime?.agentStatus ?? 'idle'}
                exitCode={activeRuntime?.exitCode ?? null}
                error={activeRuntime?.error ?? ''}
                changedFiles={activeRuntime?.changedFiles ?? []}
                terminalBuffer={activeRuntime?.terminalBuffer ?? ''}
                restartCount={activeRuntime?.restartCount ?? 0}
                hasProject={hasProject}
                gitStatus={gitStatus}
                sessionLabel={activeSession?.label ?? null}
                runningSessionId={runningAgentSessionId}
                onRenameSession={handleRenameSession}
                onWrite={handleWriteAgent}
                onStop={handleStopAgent}
                onRestart={handleRestartAgent}
                onChangedFileClick={handleChangedFileClick}
                onStageFile={handleStageFile}
                onUnstageFile={handleUnstageFile}
                onCommitGit={handleCommitGit}
                onRefreshGit={refreshGitStatus}
                onXtermWriteReady={handleXtermWriteReady}
              />
            </div>
          )}
        </div>

        <FilesDrawer
          visible={filesDrawerVisible}
          projectName={hasProject ? (projectName || '') : null}
          rootTree={rootTree}
          activeFilePath={activeFile?.path || ''}
          onClose={() => setFilesDrawerVisible(false)}
          onFileSelect={handleFileSelect}
          onRefreshTree={handleRefreshTree}
          onOpenFolder={handleOpenFolder}
        />
      </div>
      <BottomBar
        projectName={hasProject ? (projectName || '') : null}
        fileName={activeFile?.name || ''}
        language={activeFile?.language || ''}
        saveStatus={saveStatus}
        branch={gitStatus?.isRepo ? gitStatus.branch : null}
      />
    </div>
  );
};

export default App;

export type { FileState };
