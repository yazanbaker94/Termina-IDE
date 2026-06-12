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

export interface AppData {
  projects: StoredProject[];
  sessions: StoredSession[];
  activeProjectId: string | null;
  activeSessionIdByProjectId?: Record<string, string>;
}

const STORAGE_KEY = 'command-code-ide-data';

export function loadAppData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Partial<AppData>;
      return {
        projects: data.projects ?? [],
        sessions: data.sessions ?? [],
        activeProjectId: data.activeProjectId ?? null,
        activeSessionIdByProjectId: data.activeSessionIdByProjectId ?? {},
      };
    }
  } catch {}
  return { projects: [], sessions: [], activeProjectId: null, activeSessionIdByProjectId: {} };
}

export function saveAppData(data: AppData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

let idCounter = Date.now();
export function generateId(): string {
  return (++idCounter).toString(36);
}
