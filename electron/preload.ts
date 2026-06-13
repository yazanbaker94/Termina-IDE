import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  saveFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:saveFile', filePath, content),
  startAgent: (sessionId: string, cwd: string) => ipcRenderer.invoke('agent:start', sessionId, cwd),
  writeAgent: (sessionId: string, input: string) => ipcRenderer.invoke('agent:write', sessionId, input),
  stopAgent: (sessionId?: string) => ipcRenderer.invoke('agent:stop', sessionId),
  restartAgent: (sessionId: string) => ipcRenderer.invoke('agent:restart', sessionId),
  getAgentStatus: () => ipcRenderer.invoke('agent:getStatus'),
  onAgentData: (cb: (data: { sessionId: string; data: string }) => void) => {
    const handler = (_event: any, data: { sessionId: string; data: string }) => cb(data);
    ipcRenderer.on('agent:onData', handler);
    return () => ipcRenderer.removeListener('agent:onData', handler);
  },
  onAgentExit: (cb: (data: { sessionId: string; exitCode: number }) => void) => {
    const handler = (_event: any, data: { sessionId: string; exitCode: number }) => cb(data);
    ipcRenderer.on('agent:onExit', handler);
    return () => ipcRenderer.removeListener('agent:onExit', handler);
  },
  onAgentError: (cb: (message: string) => void) => {
    const handler = (_event: any, message: string) => cb(message);
    ipcRenderer.on('agent:onError', handler);
    return () => ipcRenderer.removeListener('agent:onError', handler);
  },
  onFileChanged: (cb: (event: { path: string; changeType: string }) => void) => {
    const handler = (_event: any, data: { path: string; changeType: string }) => cb(data);
    ipcRenderer.on('fs:onFileChanged', handler);
    return () => ipcRenderer.removeListener('fs:onFileChanged', handler);
  },
  getFileDiff: (sessionId: string, filePath: string) => ipcRenderer.invoke('diff:getFileDiff', sessionId, filePath),
  resizeAgent: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('agent:resize', sessionId, cols, rows),
  getFileTree: () => ipcRenderer.invoke('fs:getFileTree'),
  revertFile: (sessionId: string, filePath: string) => ipcRenderer.invoke('diff:revertFile', sessionId, filePath),
  getGitStatus: () => ipcRenderer.invoke('git:getStatus'),
  stageFile: (filePath: string) => ipcRenderer.invoke('git:stageFile', filePath),
  unstageFile: (filePath: string) => ipcRenderer.invoke('git:unstageFile', filePath),
  commitGit: (message: string) => ipcRenderer.invoke('git:commit', message),
  openProjectPath: (folderPath: string) => ipcRenderer.invoke('project:openPath', folderPath),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeToggleWindow: () => ipcRenderer.invoke('window:maximizeToggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  createFile: (parentDir: string, name: string) => ipcRenderer.invoke('fs:createFile', parentDir, name),
  createFolder: (parentDir: string, name: string) => ipcRenderer.invoke('fs:createFolder', parentDir, name),
  renamePath: (oldPath: string, newName: string) => ipcRenderer.invoke('fs:renamePath', oldPath, newName),
  deletePath: (targetPath: string) => ipcRenderer.invoke('fs:deletePath', targetPath),
  revealInExplorer: (targetPath: string) => ipcRenderer.invoke('fs:revealInExplorer', targetPath),
  pasteFromClipboard: (targetDir: string) => ipcRenderer.invoke('fs:pasteFromClipboard', targetDir),
  copyExternalFiles: (targetDir: string, sourcePaths: string[]) => ipcRenderer.invoke('fs:copyExternalFiles', targetDir, sourcePaths),
});
