export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
}

export interface FileState {
  name: string;
  path: string;
  content: string;
  language: string;
}

export interface OpenFolderResult {
  rootPath: string;
  projectName: string;
  tree: FileNode;
}

export interface ReadFileResult {
  filePath: string;
  content: string;
  language: string;
}

export interface AgentStartResult {
  success: boolean;
  error?: string;
}

export interface FileChangeEvent {
  path: string;
  changeType: 'added' | 'changed' | 'deleted';
}

export interface FileDiff {
  filePath: string;
  fileName: string;
  beforeContent: string;
  afterContent: string;
  changeType: 'added' | 'changed' | 'deleted';
  language: string;
}

export interface RevertResult {
  success: boolean;
  action: 'none' | 'restored' | 'deleted';
  filePath: string;
  existedInSnapshot: boolean;
}

export interface GitFileEntry {
  path: string;
  absolutePath: string;
  gitPath: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  files: GitFileEntry[];
}

export interface GitCommitResult {
  success: boolean;
  error?: string;
}

export interface OpenProjectPathResult {
  success: boolean;
  error?: string;
  rootPath?: string;
  projectName?: string;
  tree?: FileNode;
}

export type AgentStatus = 'idle' | 'running' | 'exited';

export interface ElectronAPI {
  platform: string;
  openFolder: () => Promise<OpenFolderResult | null>;
  readFile: (filePath: string) => Promise<ReadFileResult>;
  saveFile: (filePath: string, content: string) => Promise<{ success: boolean }>;
  startAgent: () => Promise<AgentStartResult>;
  writeAgent: (input: string) => Promise<{ success: boolean }>;
  stopAgent: () => Promise<{ success: boolean }>;
  restartAgent: () => Promise<AgentStartResult>;
  onAgentData: (cb: (data: string) => void) => () => void;
  onAgentExit: (cb: (exitCode: number) => void) => () => void;
  onAgentError: (cb: (message: string) => void) => () => void;
  onFileChanged: (cb: (event: FileChangeEvent) => void) => () => void;
  getFileDiff: (filePath: string) => Promise<FileDiff | null>;
  resizeAgent: (cols: number, rows: number) => Promise<{ success: boolean }>;
  getFileTree: () => Promise<FileNode | null>;
  revertFile: (filePath: string) => Promise<RevertResult>;
  getGitStatus: () => Promise<GitStatus>;
  stageFile: (filePath: string) => Promise<{ success: boolean }>;
  unstageFile: (filePath: string) => Promise<{ success: boolean }>;
  commitGit: (message: string) => Promise<GitCommitResult>;
  openProjectPath: (folderPath: string) => Promise<OpenProjectPathResult>;
}
