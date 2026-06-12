export interface StoredProject {
  id: string;
  name: string;
  rootPath: string;
  openedAt: number;
}

export interface StoredSession {
  id: string;
  projectId: string;
  label: string;
  createdAt: number;
  updatedAt?: number;
  renamedFromPrompt?: boolean;
}

export interface StoredSessionRuntime {
  terminalBuffer: string;
  agentStatus: string;
  exitCode: number | null;
  error: string;
}

export interface AppData {
  projects: StoredProject[];
  sessions: StoredSession[];
  activeProjectId: string | null;
  activeSessionId: string | null;
  sessionRuntime: Record<string, StoredSessionRuntime>;
}

const STORAGE_KEY = 'command-code-ide-data';
const MAX_STORED_BUFFER = 200000;

function trimBuffer(buf: string): string {
  if (buf.length > MAX_STORED_BUFFER) {
    return buf.slice(buf.length - MAX_STORED_BUFFER);
  }
  return buf;
}

export function loadAppData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as AppData;
      if (data.projects && data.sessions && 'activeProjectId' in data) {
        return {
          ...data,
          sessionRuntime: data.sessionRuntime ?? {},
        };
      }
    }
  } catch {}
  return { projects: [], sessions: [], activeProjectId: null, activeSessionId: null, sessionRuntime: {} };
}

export function saveAppData(data: AppData, sessionRuntime?: Record<string, StoredSessionRuntime>): void {
  try {
    const runtimeToStore: Record<string, StoredSessionRuntime> = {};
    if (sessionRuntime) {
      for (const [sid, rt] of Object.entries(sessionRuntime)) {
        if (rt.terminalBuffer) {
          runtimeToStore[sid] = {
            terminalBuffer: trimBuffer(rt.terminalBuffer),
            agentStatus: rt.agentStatus,
            exitCode: rt.exitCode,
            error: rt.error,
          };
        }
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, sessionRuntime: runtimeToStore }));
  } catch {}
}

let idCounter = Date.now();
export function generateId(): string {
  return (++idCounter).toString(36);
}
