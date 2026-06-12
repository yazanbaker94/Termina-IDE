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
  activeProjectId: string | null;
}

const STORAGE_KEY = 'command-code-ide-data';

export function loadAppData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as AppData;
      if (data.projects && 'activeProjectId' in data) {
        return { projects: data.projects, activeProjectId: data.activeProjectId };
      }
    }
  } catch {}
  return { projects: [], activeProjectId: null };
}

export function saveAppData(data: AppData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ projects: data.projects, activeProjectId: data.activeProjectId }));
  } catch {}
}

let idCounter = Date.now();
export function generateId(): string {
  return (++idCounter).toString(36);
}
