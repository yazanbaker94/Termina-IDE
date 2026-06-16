import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock ResizeObserver (used by xterm, Monaco, App)
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_cb: ResizeObserverCallback) {}
}
(globalThis as any).ResizeObserver = MockResizeObserver;

// Mock requestAnimationFrame / cancelAnimationFrame with controllable timers via fake timers
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number;
  }) as any;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id as unknown as NodeJS.Timeout)) as any;
}

// Mock matchMedia
if (!window.matchMedia) {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// Mock xterm so the Editor doesn't try to load the real WebGL terminal
const mockState: { terminals: any[]; fits: any[] } = { terminals: [], fits: [] };
(globalThis as any).__mockState = mockState;

vi.mock('@xterm/xterm', () => {
  return {
    Terminal: class FakeTerminal {
      cols = 80;
      rows = 24;
      open = vi.fn();
      focus = vi.fn();
      write = vi.fn();
      resize = vi.fn((cols: number, rows: number) => {
        this.cols = cols;
        this.rows = rows;
      });
      dispose = vi.fn();
      loadAddon = vi.fn();
      onData = vi.fn();
      getSelection = vi.fn(() => '');
      // The custom key event handler is what the AgentPanel uses to
      // intercept Ctrl+V. In real xterm, the handler is called when a
      // key event fires on xterm's internal input. In our mock we store
      // the handler and expose a helper to invoke it, so tests can
      // simulate Ctrl+V by calling the stored handler directly.
      _keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
      attachCustomKeyEventHandler = vi.fn((handler: (e: KeyboardEvent) => boolean) => {
        this._keyHandler = handler;
      });
      // Test helper: dispatch a key event through the custom handler.
      // Returns true if the handler consumed the event, false otherwise.
      _dispatchKeyForTest(e: KeyboardEvent): boolean {
        if (!this._keyHandler) return true;
        return this._keyHandler(e);
      }
      constructor() {
        mockState.terminals.push(this);
      }
    },
  };
});

vi.mock('@xterm/addon-fit', () => {
  return {
    FitAddon: class FakeFitAddon {
      proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
      fit = vi.fn();
      constructor() {
        mockState.fits.push(this);
      }
    },
  };
});

// Mock Monaco editor (the real one is too heavy for jsdom)
vi.mock('@monaco-editor/react', () => {
  return {
    default: function MockEditor(props: any) {
      return null;
    },
  };
});

// Mock window.electronAPI
const electronListeners: Record<string, Set<(...args: any[]) => void>> = {};
const noop = () => {};
(globalThis as any).window.electronAPI = {
  platform: 'test',
  openFolder: vi.fn(async () => null),
  openFiles: vi.fn(async () => ({ canceled: true })),
  readFile: vi.fn(async (p: string) => ({ filePath: p, content: 'hello world', language: 'typescript' })),
  saveFile: vi.fn(async () => ({ success: true })),
  startAgent: vi.fn(async () => ({ success: true })),
  writeAgent: vi.fn(async () => ({ success: true })),
  stopAgent: vi.fn(async () => ({ success: true })),
  restartAgent: vi.fn(async () => ({ success: true })),
  getAgentStatus: vi.fn(async () => ({ running: {} })),
  onAgentData: vi.fn((cb: any) => {
    (electronListeners.agentData ||= new Set()).add(cb);
    return () => electronListeners.agentData?.delete(cb);
  }),
  onAgentExit: vi.fn((cb: any) => {
    (electronListeners.agentExit ||= new Set()).add(cb);
    return () => electronListeners.agentExit?.delete(cb);
  }),
  onAgentError: vi.fn(() => noop),
  onFileChanged: vi.fn(() => noop),
  getFileDiff: vi.fn(async () => null),
  resizeAgent: vi.fn(async () => ({ success: true })),
  getFileTree: vi.fn(async () => null),
  revertFile: vi.fn(async () => ({ success: true, action: 'none', filePath: '', existedInSnapshot: false })),
  getGitStatus: vi.fn(async () => ({ isRepo: false, branch: null, files: [] })),
  stageFile: vi.fn(async () => ({ success: true })),
  unstageFile: vi.fn(async () => ({ success: true })),
  commitGit: vi.fn(async () => ({ success: true })),
  openProjectPath: vi.fn(async () => ({ success: false })),
  windowControl: vi.fn(async () => ({ success: true })),
  createFile: vi.fn(async () => ({ success: true })),
  createFolder: vi.fn(async () => ({ success: true })),
  renamePath: vi.fn(async () => ({ success: true })),
  deletePath: vi.fn(async () => ({ success: true })),
  revealInExplorer: vi.fn(async () => ({ success: true })),
  pasteFromClipboard: vi.fn(async () => ({ success: false })),
  copyExternalFiles: vi.fn(async () => ({ success: true })),
  getAssetDataUrl: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,', mime: 'image/png' })),
  getClipboardDebug: vi.fn(async () => ({ platform: 'test', formats: [], textLength: 0, htmlLength: 0, imageIsEmpty: true, bufferLengths: {} })),
  readClipboardText: vi.fn(async () => ''),
  writeClipboardText: vi.fn(async () => ({ success: true })),
  writePastedBuffer: vi.fn(async () => ({ success: true })),
  statFile: vi.fn(async () => ({ exists: false })),
  saveAgentImageAttachment: vi.fn(async (args: any) => {
    // Test-friendly: synthesize a successful result with a fake path so
    // components can exercise the happy path without an Electron main.
    const bytes: number[] = Array.isArray(args?.bytes) ? args.bytes : [];
    const ext = args?.filename ? (args.filename.split('.').pop() || 'png').toLowerCase() : 'png';
    const fileName = `pasted-test-${bytes.length}.${ext}`;
    return {
      success: true,
      absolutePath: `/tmp/.termina/clipboard/${fileName}`,
      relativePath: `.termina/clipboard/${fileName}`,
      agentRef: `@.termina/clipboard/${fileName}`,
      previewDataUrl: 'data:image/png;base64,',
    };
  }),
  saveDroppedImageAttachment: vi.fn(async (args: any) => {
    const sourcePath = String(args?.sourcePath || '');
    const fileName = sourcePath.split(/[\\/]/).pop() || 'dropped.png';
    return {
      success: true,
      absolutePath: `/tmp/.termina/clipboard/${fileName}`,
      relativePath: `.termina/clipboard/${fileName}`,
      agentRef: `@.termina/clipboard/${fileName}`,
      previewDataUrl: 'data:image/png;base64,',
    };
  }),
  readClipboardImageForAgent: vi.fn(async () => ({ success: false, error: 'No image on the system clipboard.' })),
};
