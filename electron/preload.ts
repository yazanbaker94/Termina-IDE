import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  saveFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:saveFile', filePath, content),
  startAgent: () => ipcRenderer.invoke('agent:start'),
  writeAgent: (input: string) => ipcRenderer.invoke('agent:write', input),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  restartAgent: () => ipcRenderer.invoke('agent:restart'),
  onAgentData: (cb: (data: string) => void) => {
    const handler = (_event: any, data: string) => cb(data);
    ipcRenderer.on('agent:onData', handler);
    return () => ipcRenderer.removeListener('agent:onData', handler);
  },
  onAgentExit: (cb: (exitCode: number) => void) => {
    const handler = (_event: any, exitCode: number) => cb(exitCode);
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
  getFileDiff: (filePath: string) => ipcRenderer.invoke('diff:getFileDiff', filePath),
  resizeAgent: (cols: number, rows: number) => ipcRenderer.invoke('agent:resize', cols, rows),
  getFileTree: () => ipcRenderer.invoke('fs:getFileTree'),
  revertFile: (filePath: string) => ipcRenderer.invoke('diff:revertFile', filePath),
  getGitStatus: () => ipcRenderer.invoke('git:getStatus'),
  stageFile: (filePath: string) => ipcRenderer.invoke('git:stageFile', filePath),
  unstageFile: (filePath: string) => ipcRenderer.invoke('git:unstageFile', filePath),
  commitGit: (message: string) => ipcRenderer.invoke('git:commit', message),
  openProjectPath: (folderPath: string) => ipcRenderer.invoke('project:openPath', folderPath),
});
