import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cliDebug } from '../src/debug/cliDebug';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';
import { CliDebugOverlay } from '../src/debug/CliDebugOverlay';

describe('cliDebug', () => {
  beforeEach(() => {
    cliDebug.clear();
    cliDebug.disable();
    // Make sure localStorage is clean
    try { localStorage.removeItem('termina-debug-cli'); } catch {}
    // Clean URL params
    if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  });

  afterEach(() => {
    cleanup();
  });

  it('is disabled by default (no URL param, no localStorage flag)', () => {
    expect(cliDebug.isEnabled()).toBe(false);
    cliDebug.log('test', { x: 1 });
    expect(cliDebug.snapshot()).toEqual([]);
  });

  it('captures events when manually enabled and reports a per-event delta', () => {
    cliDebug.enable();
    expect(cliDebug.isEnabled()).toBe(true);
    cliDebug.log('e1', { a: 1 });
    cliDebug.log('e2', { b: 2 });
    const snap = cliDebug.snapshot();
    // enable() also logs a 'debugEnabled' event, plus the two we added
    expect(snap.length).toBe(3);
    expect(snap[0].kind).toBe('debugEnabled');
    expect(snap[1].kind).toBe('e1');
    expect(snap[2].kind).toBe('e2');
    expect(snap[0].dt).toBeGreaterThanOrEqual(0);
    expect(snap[1].dt).toBeGreaterThanOrEqual(0);
    expect(snap[2].dt).toBeGreaterThanOrEqual(0);
  });

  it('clear() resets the buffer', () => {
    cliDebug.enable();
    cliDebug.log('a');
    cliDebug.log('b');
    expect(cliDebug.snapshot().length).toBeGreaterThan(0);
    cliDebug.clear();
    expect(cliDebug.snapshot().length).toBe(0);
  });

  it('subscribers receive live updates', () => {
    cliDebug.enable();
    const updates: any[] = [];
    const unsub = cliDebug.subscribe((evts) => updates.push(evts.length));
    cliDebug.log('a');
    cliDebug.log('b');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toBeGreaterThanOrEqual(2);
    unsub();
  });

  it('enables automatically when ?debug=cli is in the URL', () => {
    window.history.replaceState({}, '', '?debug=cli');
    cliDebug.init();
    expect(cliDebug.isEnabled()).toBe(true);
  });

  it('renders the overlay only when enabled', () => {
    cliDebug.disable();
    const { container: c1 } = render(<CliDebugOverlay />);
    expect(c1.querySelector('[data-debug-overlay="cli"]')).toBeNull();

    cliDebug.enable();
    cliDebug.log('hello', { foo: 'bar' });
    const { container: c2 } = render(<CliDebugOverlay />);
    const overlay = c2.querySelector('[data-debug-overlay="cli"]');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toContain('hello');
  });
});
