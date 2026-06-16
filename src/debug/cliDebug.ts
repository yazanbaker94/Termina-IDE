/**
 * Lightweight debug logger for CLI/terminal smoothness investigations.
 *
 * Enable by appending `?debug=cli` to the app URL (or any URL containing
 * `debug=cli`). Once enabled, every event is pushed to an in-memory ring
 * buffer AND a fixed-position overlay is shown in the bottom-right of the
 * viewport so you can watch resize/init/transition/buffer-write events
 * live as you interact with the app.
 *
 * Usage:
 *   import { cliDebug } from '../debug/cliDebug';
 *   cliDebug.log('resize', { cols: 120, rows: 30 });
 *   cliDebug.mark('transitionStart');
 *   cliDebug.mark('transitionEnd');
 *
 * The overlay shows the last ~12 events. Each event is prefixed with a
 * millisecond delta from the previous event so you can see bursts.
 */

export type CliDebugEvent = {
  t: number; // wall-clock ms since epoch
  dt: number; // ms since previous event
  kind: string;
  data?: Record<string, unknown>;
};

const MAX_EVENTS = 64;
const listeners = new Set<(events: CliDebugEvent[]) => void>();
let events: CliDebugEvent[] = [];
let enabled = false;
let lastT = 0;

function detectEnabled(): boolean {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('debug') === 'cli') return true;
    if (url.searchParams.get('debug') === 'all') return true;
  } catch {}
  try {
    if (window.localStorage.getItem('termina-debug-cli') === '1') return true;
  } catch {}
  return false;
}

function emit() {
  for (const l of listeners) l(events.slice());
}

export const cliDebug = {
  init() {
    enabled = detectEnabled();
    if (enabled) {
      // Mark a single "enabled" event so the overlay shows it's live
      this.mark('debugEnabled');
    }
  },
  isEnabled(): boolean {
    return enabled;
  },
  enable() {
    enabled = true;
    try { window.localStorage.setItem('termina-debug-cli', '1'); } catch {}
    this.mark('debugEnabled');
    emit();
  },
  disable() {
    enabled = false;
    try { window.localStorage.removeItem('termina-debug-cli'); } catch {}
    emit();
  },
  /** Log a structured event. */
  log(kind: string, data?: Record<string, unknown>) {
    if (!enabled) return;
    const now = performance.now();
    const evt: CliDebugEvent = {
      t: Date.now(),
      dt: lastT === 0 ? 0 : Math.round(now - lastT),
      kind,
      data,
    };
    lastT = now;
    events.push(evt);
    if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
    emit();
  },
  /** Log a marker with no payload (e.g. "transitionStart"). */
  mark(kind: string) {
    this.log(kind);
  },
  clear() {
    events = [];
    lastT = 0;
    emit();
  },
  /** Subscribe to live event updates. */
  subscribe(cb: (events: CliDebugEvent[]) => void): () => void {
    listeners.add(cb);
    cb(events.slice());
    return () => listeners.delete(cb);
  },
  snapshot(): CliDebugEvent[] {
    return events.slice();
  },
};
