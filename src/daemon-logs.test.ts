import { describe, expect, it } from 'vitest';
import { classifyRecord, DAEMON_LOG_STREAMS } from './daemon-logs.js';

describe('daemon log classification', () => {
  it('routes relayed extension messages to their own stream', () => {
    expect(classifyRecord('info', '[ext] [opencli] Connected to daemon')).toBe('extension');
    expect(classifyRecord('warn', '[ext] [opencli] Navigate to https://x timed out after 15s')).toBe('extension');
  });

  it('routes command failures to the commands stream', () => {
    expect(classifyRecord('warn', '[daemon] Command timed out after dispatch (id=abc, action=navigate, timeout=15000ms)')).toBe('commands');
    expect(classifyRecord('warn', '[daemon] Failed to dispatch command abc: boom')).toBe('commands');
    expect(classifyRecord('warn', '[daemon] Command result unknown after extension disconnect (id=abc, action=eval, context=x)')).toBe('commands');
  });

  it('routes lifecycle records to the daemon stream', () => {
    expect(classifyRecord('info', '[daemon] Listening on http://127.0.0.1:19825')).toBe('daemon');
    expect(classifyRecord('info', '[daemon] Extension connected')).toBe('daemon');
  });

  it('never drops an unrecognised record', () => {
    // A new log line that matches no rule has to land somewhere readable rather
    // than vanish, so `daemon` is the catch-all.
    const stream = classifyRecord('info', 'something nobody has classified yet');
    expect(DAEMON_LOG_STREAMS).toContain(stream);
    expect(stream).toBe('daemon');
  });
});
