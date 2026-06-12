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
import { FileNode, FileState, OpenFolderResult, FileChangeEvent, FileDiff, GitStatus, AgentStatus } from './types';

interface SessionState {
  activeFilePath: string | null;
  activeFileName: string | null;
  diffPath: string | null;
  changedFiles: FileChangeEvent[];
}

const App: React.FC = () => {
  const [appData, setAppData] = useState<AppData>(loadAppData);
  const { projects, sessions, activeProjectId, activeSessionId } = appData;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;

  const [projectName, setProjectName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootTree, setRootTree] = useState<FileNode | null>(null);
  const [hasProject, setHasProject] = useState(false);
  const [activeFile, setActiveFile] = useState<FileState | null>(null);
  const [savedContent, setSavedContent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string>('');

  const [agentStatus, setAgentStatus] = useState<AgentStatus>('idle');
  const [agentExitCode, setAgentExitCode] = useState<number | null>(null);
  const [agentError, setAgentError] = useState<string>('');
  const [changedFiles, setChangedFiles] = useState<FileChangeEvent[]>([]);
  const [restartCount, setRestartCount] = useState(0);
  const [activeDiff, setActiveDiff] = useState<FileDiff | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [filesDrawerVisible, setFilesDrawerVisible] = useState(false);

  const sessionStateMap = useRef<Map<string, SessionState>>(new Map());

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
  const xtermWriteBufferedRef = useRef<string[]>([]);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangedPathsRef = useRef<Set<string>>(new Set());
  const pendingDeletedPathsRef = useRef<Set<string>>(new Set());
  const startAgentRef = useRef<() => Promise<void>>(async () => {});

  const isDirty = activeFile ? activeFile.content !== savedContent : false;
  isDirtyRef.current = isDirty;

  const persist = useCallback((data: AppData) => {
    setAppData(data);
    saveAppData(data);
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

  const setupAgentListeners = useCallback(() => {
    cleanAgentListeners();

    const unsubData = window.electronAPI.onAgentData((data: string) => {
      if (xtermWriteRef.current) {
        xtermWriteRef.current(data);
      } else {
        xtermWriteBufferedRef.current.push(data);
      }
    });

    const unsubExit = window.electronAPI.onAgentExit((exitCode: number) => {
      if (exitCode >= 0) {
        setAgentStatus('exited');
        setAgentExitCode(exitCode);
      }
      cleanAgentListeners();
    });

    agentListenersRef.current = [unsubData, unsubExit];
  }, [cleanAgentListeners]);

  const snapshotSessionState = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    sessionStateMap.current.set(sessionId, {
      activeFilePath: activeFileRef.current?.path ?? null,
      activeFileName: activeFileRef.current?.name ?? null,
      diffPath: activeDiffRef.current?.filePath ?? null,
      changedFiles: [...changedFiles],
    });
  }, [changedFiles]);

  const restoreSessionState = useCallback((sessionId: string | null, cb: (state: SessionState) => void) => {
    if (!sessionId) return;
    const state = sessionStateMap.current.get(sessionId);
    if (state) cb(state);
  }, []);

  const handleSelectProject = useCallback(
    async (project: StoredProject) => {
      if (project.id === activeProjectId && hasProject) return;

      if (agentStatus === 'running') {
        try {
          await window.electronAPI.stopAgent();
        } catch {}
        cleanAgentListeners();
      }

      snapshotSessionState(activeSessionId);

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
        setAgentStatus('idle');
        setAgentExitCode(null);
        setAgentError('');
        setChangedFiles([]);
        setActiveDiff(null);
        setActiveFile(null);
        setSavedContent('');
        setFilesDrawerVisible(false);
        agentHasRunRef.current = false;
        xtermWriteRef.current = null;

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
            setChangedFiles((prev) => {
              const filtered = prev.filter((f) => f.path !== evt.path);
              if (evt.changeType === 'deleted') return [...filtered, evt];
              return [...filtered, evt];
            });
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
              try {
                const refreshed = await window.electronAPI.getFileDiff(currentDiff.filePath);
                if (refreshed) setActiveDiff(refreshed);
                else setActiveDiff(null);
              } catch { setActiveDiff(null); }
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
    [activeProjectId, hasProject, agentStatus, activeSessionId, appData, cleanAllListeners, cleanAgentListeners, snapshotSessionState, refreshFileTree, refreshGitStatus],
  );

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

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId) return;

      const prevId = activeSessionId;

      if (agentStatus === 'running') {
        window.electronAPI.stopAgent().catch(() => {});
        cleanAgentListeners();
        setAgentStatus('idle');
      }

      snapshotSessionState(prevId);

      persist({ ...appData, activeSessionId: sessionId });

      restoreSessionState(sessionId, (state) => {
        if (state.changedFiles.length > 0) {
          setChangedFiles(state.changedFiles);
        } else {
          setChangedFiles([]);
        }
        setActiveDiff(null);

        const filePath = state.activeFilePath;
        if (filePath) {
          window.electronAPI.readFile(filePath).then((result) => {
            setActiveFile({
              name: state.activeFileName ?? filePath.split(/[\\/]/).pop() ?? 'untitled',
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
      });
    },
    [activeSessionId, agentStatus, appData, cleanAgentListeners, persist, snapshotSessionState, restoreSessionState],
  );

  const handleNewChat = useCallback(async () => {
    if (!activeProjectId) return;

    const prevId = activeSessionId;

    if (agentStatus === 'running') {
      try { await window.electronAPI.stopAgent(); } catch {}
      cleanAgentListeners();
      setAgentStatus('idle');
    }

    snapshotSessionState(prevId);

    setActiveFile(null);
    setSavedContent('');
    setChangedFiles([]);
    setActiveDiff(null);

    const sessionId = generateId();
    const newSession: StoredSession = {
      id: sessionId,
      projectId: activeProjectId,
      label: `Chat ${sessions.filter((s) => s.projectId === activeProjectId).length + 1}`,
      createdAt: Date.now(),
    };
    persist({
      ...appData,
      sessions: [...appData.sessions, newSession],
      activeSessionId: sessionId,
    });

    // Auto-start agent for the new session
    setTimeout(() => {
      startAgentRef.current();
    }, 100);
  }, [activeProjectId, activeSessionId, agentStatus, appData, sessions, cleanAgentListeners, persist, snapshotSessionState]);

  const handleOpenFolder = useCallback(async () => {
    try {
      if (agentStatus === 'running') {
        await window.electronAPI.stopAgent().catch(() => {});
        cleanAgentListeners();
        setAgentStatus('idle');
      }

      snapshotSessionState(activeSessionId);
      cleanAllListeners();

      const result: OpenFolderResult | null = await window.electronAPI.openFolder();
      if (!result) return;

      setProjectName(result.projectName);
      setRootPath(result.rootPath);
      setRootTree(result.tree);
      setHasProject(true);
      setAgentStatus('idle');
      setAgentExitCode(null);
      setAgentError('');
      setActiveFile(null);
      setSavedContent('');
      setChangedFiles([]);
      setActiveDiff(null);
      setFilesDrawerVisible(false);
      agentHasRunRef.current = false;
      xtermWriteRef.current = null;

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
          setChangedFiles((prev) => {
            const filtered = prev.filter((f) => f.path !== evt.path);
            if (evt.changeType === 'deleted') return [...filtered, evt];
            return [...filtered, evt];
          });
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
            try {
              const refreshed = await window.electronAPI.getFileDiff(currentDiff.filePath);
              if (refreshed) setActiveDiff(refreshed);
              else setActiveDiff(null);
            } catch { setActiveDiff(null); }
          }
        }, 300);
      });
      fsListenerRef.current = unsubFs;

      setGitStatus(null);
      refreshGitStatus();
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  }, [agentStatus, activeSessionId, appData, cleanAllListeners, cleanAgentListeners, snapshotSessionState, refreshFileTree, refreshGitStatus]);

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
    setIsLoading(true);
    try {
      const diff = await window.electronAPI.getFileDiff(evt.path);
      if (diff) setActiveDiff(diff);
      setChangedFiles((prev) => prev.filter((f) => f.path !== evt.path));
    } catch (err) {
      console.error('Failed to get file diff:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

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
    try {
      const result = await window.electronAPI.revertFile(filePath);
      if (!result.success) {
        setSaveStatus('Revert failed');
        setTimeout(() => setSaveStatus(''), 2000);
        return;
      }
      setChangedFiles((prev) => prev.filter((f) => f.path !== filePath));
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
  }, [refreshFileTree]);

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

  const handleStartAgent = useCallback(async () => {
    try {
      setAgentError('');
      setChangedFiles([]);
      setActiveDiff(null);
      xtermWriteBufferedRef.current = [];
      agentHasRunRef.current = true;
      setupAgentListeners();
      const result = await window.electronAPI.startAgent();
      if (!result.success) { setAgentError(result.error || 'Failed to start agent.'); cleanAgentListeners(); return; }
      setAgentStatus('running');
      setAgentExitCode(null);
    } catch (err) { console.error('Failed to start agent:', err); setAgentError(String(err)); cleanAgentListeners(); }
  }, [setupAgentListeners, cleanAgentListeners]);
  startAgentRef.current = handleStartAgent;

  const handleWriteAgent = useCallback(async (input: string) => { try { await window.electronAPI.writeAgent(input); } catch (err) { console.error('Failed to write to agent:', err); } }, []);
  const handleStopAgent = useCallback(async () => { try { await window.electronAPI.stopAgent(); cleanAgentListeners(); setAgentStatus('idle'); setAgentError(''); } catch (err) { console.error('Failed to stop agent:', err); } }, [cleanAgentListeners]);

  const handleRestartAgent = useCallback(async () => {
    try {
      cleanAgentListeners();
      setAgentError('');
      setChangedFiles([]);
      setActiveDiff(null);
      xtermWriteBufferedRef.current = [];
      agentHasRunRef.current = true;
      setRestartCount((n) => n + 1);
      setupAgentListeners();
      const result = await window.electronAPI.restartAgent();
      if (!result.success) { setAgentError(result.error || 'Failed to restart agent.'); cleanAgentListeners(); return; }
      setAgentStatus('running');
      setAgentExitCode(null);
    } catch (err) { console.error('Failed to restart agent:', err); setAgentError(String(err)); cleanAgentListeners(); }
  }, [setupAgentListeners, cleanAgentListeners]);

  const handleXtermWriteReady = useCallback((writeFn: (data: string) => void) => {
    xtermWriteRef.current = writeFn;
    const buffered = xtermWriteBufferedRef.current;
    xtermWriteBufferedRef.current = [];
    for (const data of buffered) writeFn(data);
  }, []);

  useEffect(() => { return () => { cleanAllListeners(); }; }, [cleanAllListeners]);

  const showEditor = !!activeFile || !!activeDiff;
  const projectSessions = sessions.filter((s) => s.projectId === activeProjectId);

  return (
    <div className="app-container">
      <Toolbar
        onOpenFolder={handleOpenFolder}
        onRunAgent={activeSession ? handleStartAgent : handleNewChat}
        onToggleFiles={handleToggleFiles}
        agentDisabled={!hasProject || !activeSession}
        agentRunning={agentStatus === 'running'}
      />
      <div className="app-body">
        <SessionRail
          projects={projects}
          sessions={projectSessions}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          hasProject={hasProject}
          onNewChat={handleNewChat}
          onToggleFiles={handleToggleFiles}
          onSelectSession={handleSelectSession}
          onSelectProject={handleSelectProject}
          onOpenFolder={handleOpenFolder}
        />

        <div className="app-main">
          {hasProject && !activeSession && (
            <div className="app-no-session">
              <div className="app-no-session-icon">
                <MessageSquarePlus size={40} />
              </div>
              <p className="app-no-session-text">No active chat session</p>
              <p className="app-no-session-sub">Start a new chat to begin working with the agent.</p>
            </div>
          )}

          {activeSession && showEditor && (
            <div className="app-editor-pane">
              {activeDiff ? (
                <DiffViewer diff={activeDiff} onClose={handleCloseDiff} onOpenFile={handleOpenFile} onRevertFile={handleRevertFile} />
              ) : (
                <Editor file={activeFile} isLoading={isLoading} isDirty={isDirty} hasProject={hasProject} onChange={handleEditorChange} onSave={handleSave} />
              )}
            </div>
          )}

          {activeSession && (
            <div className={`app-agent-pane ${showEditor ? 'with-editor' : ''}`}>
              <AgentPanel
                status={agentStatus}
                exitCode={agentExitCode}
                error={agentError}
                changedFiles={changedFiles}
                restartCount={restartCount}
                hasProject={hasProject}
                gitStatus={gitStatus}
                sessionLabel={activeSession?.label ?? null}
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
