import React, { useEffect, useState, useRef } from 'react';
import { cliDebug, CliDebugEvent } from './cliDebug';

/**
 * Fixed-position overlay that shows the most recent CLI debug events.
 * Only renders when debug mode is enabled. Toggles visibility with a
 * collapse/expand handle in the corner.
 */
export const CliDebugOverlay: React.FC = () => {
  const [events, setEvents] = useState<CliDebugEvent[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cliDebug.isEnabled()) return;
    return cliDebug.subscribe(setEvents);
  }, []);

  useEffect(() => {
    if (!autoScroll || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [events, autoScroll]);

  if (!cliDebug.isEnabled()) return null;

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    setAutoScroll(atBottom);
  };

  return (
    <div
      data-debug-overlay="cli"
      style={{
        position: 'fixed',
        right: 8,
        bottom: 32,
        width: collapsed ? 220 : 460,
        maxHeight: collapsed ? 28 : 360,
        background: 'rgba(10, 10, 20, 0.92)',
        color: '#cdd6f4',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: 10,
        lineHeight: 1.35,
        border: '1px solid #45475a',
        borderRadius: 6,
        boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        userSelect: 'text',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 8px',
          background: '#1e1e36',
          borderBottom: collapsed ? 'none' : '1px solid #313244',
          flexShrink: 0,
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        <span style={{ color: '#a78bfa', fontWeight: 700, letterSpacing: 1 }}>CLI DEBUG</span>
        <span style={{ marginLeft: 8, color: '#6c7086' }}>{events.length} events</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            onClick={(e) => { e.stopPropagation(); cliDebug.clear(); }}
            style={{
              background: 'transparent',
              color: '#6c7086',
              border: '1px solid #45475a',
              borderRadius: 3,
              fontSize: 9,
              padding: '0 6px',
              cursor: 'pointer',
            }}
            title="Clear events"
          >
            clear
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              cliDebug.disable();
              setEvents([]);
            }}
            style={{
              background: 'transparent',
              color: '#6c7086',
              border: '1px solid #45475a',
              borderRadius: 3,
              fontSize: 9,
              padding: '0 6px',
              cursor: 'pointer',
            }}
            title="Disable debug overlay"
          >
            off
          </button>
        </span>
      </div>
      {!collapsed && (
        <div
          ref={listRef}
          onScroll={onListScroll}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 6px',
          }}
        >
          {events.length === 0 && (
            <div style={{ color: '#6c7086', fontStyle: 'italic' }}>waiting for events...</div>
          )}
          {events.slice(-40).map((evt, i) => (
            <div
              key={`${evt.t}-${i}`}
              style={{
                display: 'flex',
                gap: 6,
                padding: '1px 0',
                borderBottom: '1px solid rgba(69, 71, 90, 0.2)',
                color: kindColor(evt.kind),
              }}
            >
              <span style={{ color: '#6c7086', minWidth: 32, textAlign: 'right' }}>
                {evt.dt > 0 ? `+${evt.dt}` : '·'}
              </span>
              <span style={{ minWidth: 110, fontWeight: 600 }}>{evt.kind}</span>
              {evt.data && (
                <span style={{ color: '#a6adc8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {summarizeData(evt.data)}
                </span>
              )}
            </div>
          ))}
          {!autoScroll && (
            <div style={{ color: '#f9e2af', fontStyle: 'italic', marginTop: 4 }}>
              scroll paused (auto-scroll resumes at bottom)
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function kindColor(kind: string): string {
  if (kind.startsWith('terminal:init')) return '#a6e3a1';
  if (kind.startsWith('terminal:dispose')) return '#f38ba8';
  if (kind.startsWith('terminal:resize')) return '#f9e2af';
  if (kind.startsWith('terminal:write')) return '#89b4fa';
  if (kind.startsWith('terminal:fit')) return '#cba6f7';
  if (kind.startsWith('dock:')) return '#94e2d5';
  if (kind === 'debugEnabled') return '#a78bfa';
  return '#cdd6f4';
}

function summarizeData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v}`);
    } else if (v === null) {
      parts.push(`${k}=null`);
    } else if (v === undefined) {
      // skip
    } else {
      try { parts.push(`${k}=${JSON.stringify(v)}`); } catch { parts.push(`${k}=?`); }
    }
  }
  return parts.join(' ');
}
