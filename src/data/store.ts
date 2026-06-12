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
}

export interface AppData {
  projects: StoredProject[];
  sessions: StoredSession[];
  activeProjectId: string | null;
  activeSessionId: string | null;
}

const STORAGE_KEY = 'command-code-ide-data';

export function loadAppData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as AppData;
      if (data.projects && data.sessions && 'activeProjectId' in data) {
        return data;
      }
    }
  } catch {}
  return { projects: [], sessions: [], activeProjectId: null, activeSessionId: null };
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
