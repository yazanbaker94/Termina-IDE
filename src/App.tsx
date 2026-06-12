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

  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
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
  const [rejectingAll, setRejectingAll] = useState(false);

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

        const sid = generateId();
        setSessions([{ id: sid, projectId: project.id, label: 'Chat 1', createdAt: Date.now() }]);
        setActiveSessionId(sid);
        setSessionRuntime({});

        await reconcileAgentStatus();
        setGitStatus(null);
        refreshGitStatus();

        await startAgentWithListeners(sid);
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
    agentListenersAttachedRef.current = false;
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
        for (const [sid, rt] of Object.entries(next)) {
          if (runningIds.has(sid)) {
            next[sid] = { ...rt, agentStatus: 'running', exitCode: null, error: '' };
          } else if (rt.agentStatus === 'running' || rt.agentStatus === 'starting') {
            next[sid] = { ...rt, agentStatus: 'idle' };
          }
        }
        return next;
      });
    } catch {}
  }, []);

  const setupAgentListeners = useCallback(() => {
    if (agentListenersAttachedRef.current) return;
    agentListenersAttachedRef.current = true;

    cleanAgentListeners();

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
  }, [cleanAgentListeners, appendTerminalBuffer, updateSessionRuntime]);

  const startAgentWithListeners = useCallback(async (sessionId: string) => {
    updateSessionRuntime(sessionId, { agentStatus: 'starting', error: '', changedFiles: [], restartCount: (sessionRuntimeRef.current[sessionId]?.restartCount ?? 0) + 1 });
    setupAgentListeners();

    const result = await window.electronAPI.startAgent(sessionId);
    if (!result.success) {
      updateSessionRuntime(sessionId, { agentStatus: 'error', error: result.error ?? 'Failed to start agent.' });
      return;
    }

    updateSessionRuntime(sessionId, { agentStatus: 'running', exitCode: null });
    await reconcileAgentStatus();
  }, [setupAgentListeners, updateSessionRuntime, reconcileAgentStatus]);

  const handleSelectProject = useCallback(
    async (project: StoredProject) => {
      if (project.id === activeProjectId && hasProject) return;

      try {
        const result = await window.electronAPI.openProjectPath(project.rootPath);
        if (!result.success || !result.rootPath) {
          setSaveStatus('Project folder not found');
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

        const updated = {
          ...appData,
          activeProjectId: project.id,
          projects: appData.projects.map((p) =>
            p.id === project.id ? { ...p, openedAt: Date.now() } : p,
          ),
        };
        persist(updated);

        // Preserve existing project chats; create Chat 1 only if none exist
        const existingSessions = sessionsRef.current.filter((s) => s.projectId === project.id);
        let targetSessionId: string | null = null;
        if (existingSessions.length > 0) {
          // Restore last active session for this project if tracked
          const cached = activeSessionByProjectIdRef.current[project.id];
          targetSessionId = (cached && existingSessions.some((s) => s.id === cached))
            ? cached
            : existingSessions[existingSessions.length - 1].id;
          setActiveSessionId(targetSessionId);
        } else {
          const sid = generateId();
          const newSession: StoredSession = { id: sid, projectId: project.id, label: 'Chat 1', createdAt: Date.now() };
          setSessions((prev) => [...prev, newSession]);
          setActiveSessionId(sid);
          targetSessionId = sid;
        }
        if (targetSessionId) {
          activeSessionByProjectIdRef.current[project.id] = targetSessionId;
        }

        setGitStatus(null);
        refreshGitStatus();

        if (targetSessionId && !existingSessions.some((s) => s.id === targetSessionId)) {
          await startAgentWithListeners(targetSessionId);
        } else {
          await reconcileAgentStatus();
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
    },
    [activeProjectId, hasProject, appData, persist, cleanAllListeners, refreshFileTree, refreshGitStatus, updateSessionRuntime, startAgentWithListeners],
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

      // Track last active session per project
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (session && activeProjectId) {
        activeSessionByProjectIdRef.current[activeProjectId] = sessionId;
      }

      const nextRuntime = sessionRuntime[sessionId];
      setActiveDiff(null);
      setActiveSessionId(sessionId);

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
    [activeSessionId, sessionRuntime, updateSessionRuntime],
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
      id: sessionId, projectId: activeProjectId,
      label: `Chat ${projectChats.length + 1}`, createdAt: Date.now(),
    };
    setSessions((prev) => [...prev, newSession]);
    setActiveSessionId(sessionId);
    if (activeProjectId) {
      activeSessionByProjectIdRef.current[activeProjectId] = sessionId;
    }

    setActiveFile(null); setSavedContent(''); setActiveDiff(null);
    await startAgentWithListeners(sessionId);
  }, [activeProjectId, sessions, updateSessionRuntime, startAgentWithListeners]);

  const handleOpenFolder = useCallback(async () => {
    try {
      cleanAllListeners();
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

      // Preserve existing project chats; create Chat 1 only if none exist
      const existingSessions = sessionsRef.current.filter((s) => s.projectId === projectId);
      let targetSessionId: string | null = null;
      if (existingSessions.length > 0) {
        const cached = activeSessionByProjectIdRef.current[projectId];
        targetSessionId = (cached && existingSessions.some((s) => s.id === cached))
          ? cached
          : existingSessions[existingSessions.length - 1].id;
        setActiveSessionId(targetSessionId);
      } else {
        const sid = generateId();
        const newSession: StoredSession = { id: sid, projectId, label: 'Chat 1', createdAt: Date.now() };
        setSessions((prev) => [...prev, newSession]);
        setActiveSessionId(sid);
        targetSessionId = sid;
      }

      setGitStatus(null);
      refreshGitStatus();

      if (targetSessionId && !existingSessions.some((s) => s.id === targetSessionId)) {
        await startAgentWithListeners(targetSessionId);
      } else {
        await reconcileAgentStatus();
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
  }, [appData, persist, cleanAllListeners, refreshFileTree, refreshGitStatus, updateSessionRuntime, startAgentWithListeners]);

  const handleFileSelect = useCallback(async (node: FileNode) => {
    if (node.type === 'directory') return;
    setActiveDiff(null); setFilesDrawerVisible(false); setIsLoading(true);
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

  const handleCloseDiff = useCallback(() => setActiveDiff(null), []);

  const handleOpenFile = useCallback(async (filePath: string) => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.readFile(filePath);
      setActiveFile({ name: filePath.split(/[\\/]/).pop() || 'untitled', path: result.filePath, content: result.content, language: result.language });
      setSavedContent(result.content); setActiveDiff(null);
    } catch (err) { console.error('Failed to open file:', err); }
    finally { setIsLoading(false); }
  }, []);

  const handleAcceptFile = useCallback((filePath: string) => {
    if (!activeSessionId) return;
    updateSessionRuntime(activeSessionId, {
      changedFiles: (sessionRuntimeRef.current[activeSessionId]?.changedFiles ?? []).filter((f) => f.path !== filePath),
    });
    setActiveDiff(null); refreshGitStatus();
    setSaveStatus(`Accepted ${filePath.split(/[\\/]/).pop() || filePath}`);
    setTimeout(() => setSaveStatus(''), 2000);
  }, [activeSessionId, updateSessionRuntime, refreshGitStatus]);

  const handleRejectFile = useCallback(async (filePath: string) => {
    if (!activeSessionId) return;
    try {
      const result = await window.electronAPI.revertFile(activeSessionId, filePath);
      if (!result.success) {
        setSaveStatus(`Failed to revert ${filePath.split(/[\\/]/).pop() || filePath}`);
        setTimeout(() => setSaveStatus(''), 3000); return;
      }
      updateSessionRuntime(activeSessionId, {
        changedFiles: (sessionRuntimeRef.current[activeSessionId]?.changedFiles ?? []).filter((f) => f.path !== filePath),
      });
      setActiveDiff(null); refreshFileTree(); refreshGitStatus();
      setSaveStatus(`Rejected ${filePath.split(/[\\/]/).pop() || filePath}`);
      setTimeout(() => setSaveStatus(''), 2000);
    } catch (err) { console.error('Failed to reject file:', err); }
  }, [activeSessionId, updateSessionRuntime, refreshFileTree, refreshGitStatus]);

  const handleAcceptAll = useCallback(() => {
    if (!activeSessionId) return;
    const files = sessionRuntimeRef.current[activeSessionId]?.changedFiles ?? [];
    updateSessionRuntime(activeSessionId, { changedFiles: [] });
    setActiveDiff(null); refreshGitStatus();
    setSaveStatus(`Accepted ${files.length} file${files.length !== 1 ? 's' : ''}`);
    setTimeout(() => setSaveStatus(''), 2000);
  }, [activeSessionId, updateSessionRuntime, refreshGitStatus]);

  const handleRejectAll = useCallback(async () => {
    if (!activeSessionId) return;
    setRejectingAll(true);
    const sessionId = activeSessionId;
    const files = [...(sessionRuntimeRef.current[sessionId]?.changedFiles ?? [])];
    let successCount = 0;
    const failedPaths: string[] = [];

    for (const evt of files) {
      try {
        const result = await window.electronAPI.revertFile(sessionId, evt.path);
        if (result.success) successCount++;
        else failedPaths.push(evt.path);
      } catch { failedPaths.push(evt.path); }
    }

    updateSessionRuntime(sessionId, { changedFiles: files.filter((f) => failedPaths.includes(f.path)) });
    setActiveDiff(null); refreshFileTree(); refreshGitStatus();
    setRejectingAll(false);

    if (failedPaths.length > 0) {
      setSaveStatus(`Rejected ${successCount} files, ${failedPaths.length} could not be reverted`);
    } else {
      setSaveStatus(`Rejected ${successCount} file${successCount !== 1 ? 's' : ''}`);
    }
    setTimeout(() => setSaveStatus(''), 3000);
  }, [activeSessionId, updateSessionRuntime, refreshFileTree, refreshGitStatus]);

  const handleWriteAgent = useCallback(async (sessionId: string, input: string) => {
    try { await window.electronAPI.writeAgent(sessionId, input); }
    catch (err) { console.error('Failed to write to agent:', err); }
  }, []);

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

  return (
    <div className="app-container">
      <Toolbar onOpenFolder={handleOpenFolder} onToggleFiles={handleToggleFiles} />
      <div className="app-body">
        <SessionRail projects={projects} sessions={activeProjectSessions} activeProjectId={activeProjectId} activeSessionId={activeSessionId}
          hasProject={hasProject} sessionRuntime={sessionRuntime}
          onNewChat={handleNewChat} onSelectSession={handleSelectSession} onSelectProject={handleSelectProject}
          onOpenFolder={handleOpenFolder} />

        <div className="app-main">
          {hasProject && !activeSessionId && (
            <div className="app-no-session">
              <div className="app-no-session-icon"><MessageSquarePlus size={40} /></div>
              <p className="app-no-session-text">No active chat session</p>
              <p className="app-no-session-sub">Start a new chat to begin working with the agent.</p>
            </div>
          )}

          {activeSessionId && showEditor && (
            <div className="app-editor-pane">
              {activeDiff ? (
                <DiffViewer diff={activeDiff} onClose={handleCloseDiff} onOpenFile={handleOpenFile} onRevertFile={handleRejectFile} onAcceptFile={handleAcceptFile} />
              ) : (
                <Editor file={activeFile} isLoading={isLoading} isDirty={isDirty} hasProject={hasProject} onChange={handleEditorChange} onSave={handleSave} />
              )}
            </div>
          )}

          {activeSessionId && (
            <div className={`app-agent-pane ${showEditor ? 'with-editor' : ''}`}>
              <AgentPanel sessionId={activeSessionId}
                status={activeRuntime?.agentStatus ?? 'idle'} exitCode={activeRuntime?.exitCode ?? null}
                error={activeRuntime?.error ?? ''} changedFiles={activeRuntime?.changedFiles ?? []}
                terminalBuffer={activeRuntime?.terminalBuffer ?? ''} restartCount={activeRuntime?.restartCount ?? 0}
                hasProject={hasProject} sessionLabel={activeSession?.label ?? null}
                onRenameSession={handleRenameSession}
                onWrite={(input) => handleWriteAgent(activeSessionId, input)}
                onChangedFileClick={handleChangedFileClick} onAcceptFile={handleAcceptFile} onRejectFile={handleRejectFile}
                onAcceptAll={handleAcceptAll} onRejectAll={handleRejectAll} rejectingAll={rejectingAll}
                onXtermWriteReady={handleXtermWriteReady} />
            </div>
          )}
        </div>

        <FilesDrawer visible={filesDrawerVisible} projectName={hasProject ? (projectName || '') : null}
          rootTree={rootTree} activeFilePath={activeFile?.path || ''}
          onClose={() => setFilesDrawerVisible(false)} onFileSelect={handleFileSelect} onRefreshTree={handleRefreshTree} onOpenFolder={handleOpenFolder} />
      </div>
      <BottomBar projectName={hasProject ? (projectName || '') : null} fileName={activeFile?.name || ''}
        language={activeFile?.language || ''} saveStatus={saveStatus} branch={gitStatus?.isRepo ? gitStatus.branch : null} />
    </div>
  );
};

export default App;
export type { FileState };
