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

export interface AgentStatusResult {
  running: Record<string, { pid?: number }>;
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

export interface AgentDataEvent {
  sessionId: string;
  data: string;
}

export interface AgentExitEvent {
  sessionId: string;
  exitCode: number;
}

export type AgentStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error';

export interface SessionRuntimeState {
  agentStatus: AgentStatus;
  exitCode: number | null;
  error: string;
  terminalBuffer: string;
  changedFiles: FileChangeEvent[];
  restartCount: number;
  activeFilePath: string | null;
  activeFileName: string | null;
  diffPath: string | null;
}

export interface ElectronAPI {
  platform: string;
  openFolder: () => Promise<OpenFolderResult | null>;
  readFile: (filePath: string) => Promise<ReadFileResult>;
  saveFile: (filePath: string, content: string) => Promise<{ success: boolean }>;
  startAgent: (sessionId: string, cwd: string) => Promise<AgentStartResult>;
  writeAgent: (sessionId: string, input: string) => Promise<{ success: boolean }>;
  stopAgent: (sessionId?: string) => Promise<{ success: boolean; error?: string }>;
  restartAgent: (sessionId: string) => Promise<AgentStartResult>;
  getAgentStatus: () => Promise<AgentStatusResult>;
  onAgentData: (cb: (event: AgentDataEvent) => void) => () => void;
  onAgentExit: (cb: (event: AgentExitEvent) => void) => () => void;
  onAgentError: (cb: (message: string) => void) => () => void;
  onFileChanged: (cb: (event: FileChangeEvent) => void) => () => void;
  getFileDiff: (sessionId: string, filePath: string) => Promise<FileDiff | null>;
  resizeAgent: (sessionId: string, cols: number, rows: number) => Promise<{ success: boolean }>;
  getFileTree: () => Promise<FileNode | null>;
  revertFile: (sessionId: string, filePath: string) => Promise<RevertResult>;
  getGitStatus: () => Promise<GitStatus>;
  stageFile: (filePath: string) => Promise<{ success: boolean }>;
  unstageFile: (filePath: string) => Promise<{ success: boolean }>;
  commitGit: (message: string) => Promise<GitCommitResult>;
  openProjectPath: (folderPath: string) => Promise<OpenProjectPathResult>;
}
