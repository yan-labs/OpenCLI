import { describe, expect, it } from 'vitest';

import {
  SESSION_LEASE_TTL_MS,
  SessionLeaseRegistry,
  buildSessionBusyFailure,
  getSessionLeaseKey,
  isSessionLeaseCommand,
  parsePidFromRunId,
} from './session-lease.js';

const T0 = 1_000_000;

function writeCommand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surface: 'adapter',
    siteSession: 'persistent',
    access: 'write',
    session: 'site:chatgpt',
    runId: 'run_111_1_a',
    command: 'chatgpt ask',
    ...over,
  };
}

describe('getSessionLeaseKey', () => {
  it('partitions by profile, surface, and encoded session', () => {
    expect(getSessionLeaseKey('default', 'adapter', 'site:chatgpt')).toBe('default␟adapter␟site%3Achatgpt');
    expect(getSessionLeaseKey('default', 'adapter', 'site:x')).not.toBe(getSessionLeaseKey('default', 'browser', 'site:x'));
  });
  it('keeps the same session in different Chrome profiles on different keys', () => {
    expect(getSessionLeaseKey('work', 'adapter', 'site:chatgpt'))
      .not.toBe(getSessionLeaseKey('personal', 'adapter', 'site:chatgpt'));
  });
});

describe('parsePidFromRunId', () => {
  it('recovers the pid from a run id', () => {
    expect(parsePidFromRunId('run_4242_1700000000000_7')).toBe(4242);
  });
  it('returns null for a malformed run id', () => {
    expect(parsePidFromRunId('cmd_4242_1_7')).toBeNull();
    expect(parsePidFromRunId('run_0_1_7')).toBeNull();
  });
});

describe('isSessionLeaseCommand', () => {
  it('matches an adapter persistent write with identity', () => {
    expect(isSessionLeaseCommand(writeCommand())).toBe(true);
  });
  it('excludes read commands (a user mid-ask can still check state)', () => {
    expect(isSessionLeaseCommand(writeCommand({ access: 'read' }))).toBe(false);
  });
  it('excludes ephemeral adapter sessions and includes browser writes', () => {
    expect(isSessionLeaseCommand(writeCommand({ siteSession: 'ephemeral' }))).toBe(false);
    expect(isSessionLeaseCommand(writeCommand({ surface: 'browser', siteSession: undefined }))).toBe(true);
    expect(isSessionLeaseCommand(writeCommand({ surface: 'browser', siteSession: undefined, access: 'read' }))).toBe(false);
  });
  it('excludes commands without identity or session', () => {
    expect(isSessionLeaseCommand(writeCommand({ runId: undefined }))).toBe(false);
    expect(isSessionLeaseCommand(writeCommand({ session: '' }))).toBe(false);
  });
});

describe('SessionLeaseRegistry', () => {
  const KEY = getSessionLeaseKey('default', 'adapter', 'site:chatgpt');

  it('grants the first write and rejects a concurrent write on the same key', () => {
    const reg = new SessionLeaseRegistry();
    const first = reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    expect(first.granted).toBe(true);

    const second = reg.touch(KEY, { runId: 'run_222_2_b', command: 'chatgpt ask', now: T0 + 1000 });
    expect(second.granted).toBe(false);
    expect(second.holder.runId).toBe('run_111_1_a');
    expect(second.holder.pid).toBe(111);
  });

  it('does not block a write on a different session key', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    const other = reg.touch(getSessionLeaseKey('default', 'adapter', 'site:claude'), {
      runId: 'run_222_2_b',
      command: 'claude ask',
      now: T0,
    });
    expect(other.granted).toBe(true);
  });

  it('does not block the same session in a different Chrome profile', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(getSessionLeaseKey('work', 'adapter', 'site:chatgpt'), {
      runId: 'run_111_1_a', command: 'chatgpt ask', now: T0,
    });
    // Same session name, different profile → different browser → no conflict.
    const other = reg.touch(getSessionLeaseKey('personal', 'adapter', 'site:chatgpt'), {
      runId: 'run_222_2_b', command: 'chatgpt ask', now: T0,
    });
    expect(other.granted).toBe(true);
    // But a rival within the SAME profile is still busy.
    const rival = reg.touch(getSessionLeaseKey('work', 'adapter', 'site:chatgpt'), {
      runId: 'run_333_3_c', command: 'chatgpt ask', now: T0 + 1,
    });
    expect(rival.granted).toBe(false);
    expect(rival.holder.runId).toBe('run_111_1_a');
  });

  it('treats same-runId execs as heartbeats that keep the holder alive past the TTL', () => {
    const reg = new SessionLeaseRegistry();
    const acquired = reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    expect(acquired.granted).toBe(true);

    // Heartbeat just before expiry keeps startedAt but advances lastSeenAt.
    const beat = reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 + SESSION_LEASE_TTL_MS });
    expect(beat.granted).toBe(true);
    expect(beat.holder.startedAt).toBe(T0);

    // A rival long after the original acquire is still blocked because the
    // holder kept refreshing.
    const rival = reg.touch(KEY, { runId: 'run_222_2_b', command: 'chatgpt ask', now: T0 + SESSION_LEASE_TTL_MS + 1 });
    expect(rival.granted).toBe(false);
    expect(rival.holder.runId).toBe('run_111_1_a');
  });

  it('lets a retry re-acquire after the holder dies and the TTL lapses', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });

    // No heartbeats — the holder was killed. Past the TTL the lease is stale.
    const retry = reg.touch(KEY, { runId: 'run_222_2_b', command: 'chatgpt ask', now: T0 + SESSION_LEASE_TTL_MS + 1 });
    expect(retry.granted).toBe(true);
    expect(retry.holder.runId).toBe('run_222_2_b');
  });

  it('releases by runId alone so a retry succeeds immediately on normal completion', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    // No key/contextId needed — the profile may have disconnected by now.
    reg.releaseByRunId('run_111_1_a');

    const retry = reg.touch(KEY, { runId: 'run_222_2_b', command: 'chatgpt ask', now: T0 + 1 });
    expect(retry.granted).toBe(true);
  });

  it('ignores a release from a run that holds nothing', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    // A stale/late release from a different run must not free the live holder.
    reg.releaseByRunId('run_999_9_z');

    const rival = reg.touch(KEY, { runId: 'run_222_2_b', command: 'chatgpt ask', now: T0 + 1 });
    expect(rival.granted).toBe(false);
  });

  it('keeps a TTL-stale holder with an in-flight command alive against a challenger', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });

    // One slow exec (e.g. a long navigate) produces no heartbeat past the TTL,
    // but the daemon reports it as pending work — the challenger stays blocked.
    const rival = reg.touch(KEY, {
      runId: 'run_222_2_b',
      command: 'chatgpt ask',
      now: T0 + SESSION_LEASE_TTL_MS + 10_000,
      hasPendingWork: (runId) => runId === 'run_111_1_a',
    });
    expect(rival.granted).toBe(false);
    expect(rival.holder.runId).toBe('run_111_1_a');
  });

  it('lets a challenger acquire once the pending command settled and the TTL truly lapsed', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });

    // The slow exec settles → the daemon heartbeats the lease → TTL restarts.
    const settledAt = T0 + SESSION_LEASE_TTL_MS + 10_000;
    reg.heartbeat(KEY, 'run_111_1_a', settledAt);

    // Just after settle the holder is fresh again.
    const early = reg.touch(KEY, {
      runId: 'run_222_2_b', command: 'chatgpt ask', now: settledAt + 1, hasPendingWork: () => false,
    });
    expect(early.granted).toBe(false);

    // With no further activity and no pending work, the TTL finally expires.
    const late = reg.touch(KEY, {
      runId: 'run_222_2_b', command: 'chatgpt ask', now: settledAt + SESSION_LEASE_TTL_MS + 1, hasPendingWork: () => false,
    });
    expect(late.granted).toBe(true);
    expect(late.holder.runId).toBe('run_222_2_b');
  });

  it('heartbeat never lets a non-owner resurrect or steal the lease', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    reg.heartbeat(KEY, 'run_999_9_z', T0 + 1);

    const holder = reg.get(KEY, T0 + 2);
    expect(holder?.runId).toBe('run_111_1_a');
    expect(holder?.lastSeenAt).toBe(T0);
  });

  it('lists and evicts holders by liveness for status surfaces', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    expect(reg.list(T0)).toEqual([
      expect.objectContaining({ key: KEY, runId: 'run_111_1_a', command: 'chatgpt ask', pid: 111 }),
    ]);
    expect(reg.get(KEY, T0 + SESSION_LEASE_TTL_MS + 1)).toBeUndefined();
    expect(reg.list(T0 + SESSION_LEASE_TTL_MS + 1)).toEqual([]);
  });

  it('lists a TTL-stale holder that still has pending work (matches touch aliveness)', () => {
    const reg = new SessionLeaseRegistry();
    reg.touch(KEY, { runId: 'run_111_1_a', command: 'chatgpt ask', now: T0 });
    const staleNow = T0 + SESSION_LEASE_TTL_MS + 10_000;

    // Without the predicate the TTL-stale holder is hidden, so /status would
    // wrongly show no holder while a long exec still rejects challengers.
    expect(reg.list(staleNow)).toEqual([]);

    // With a pending in-flight command it stays listed, matching touch()'s
    // aliveness rule so /status and arbitration agree.
    expect(reg.list(staleNow, (runId) => runId === 'run_111_1_a')).toEqual([
      expect.objectContaining({ key: KEY, runId: 'run_111_1_a' }),
    ]);

    // A predicate that reports no pending work drops the stale holder again.
    expect(reg.list(staleNow, () => false)).toEqual([]);
  });
});

describe('buildSessionBusyFailure', () => {
  it('names the holder, its pid, and how long it has held the lease', () => {
    const failure = buildSessionBusyFailure(
      'site:chatgpt',
      { runId: 'run_111_1_a', command: 'chatgpt ask', pid: 111, startedAt: T0, lastSeenAt: T0 + 40_000 },
      T0 + 42_000,
    );
    expect(failure.status).toBe(409);
    expect(failure.errorCode).toBe('session_busy');
    expect(failure.message).toContain('chatgpt ask');
    expect(failure.message).toContain('pid 111');
    expect(failure.message).toContain('42s');
    expect(failure.errorHint).toContain('kill 111');
    expect(failure.errorHint).toContain('Read-only commands are not blocked');
  });

  it('degrades gracefully when the pid is unknown', () => {
    const failure = buildSessionBusyFailure(
      'site:chatgpt',
      { runId: 'x', command: 'chatgpt ask', pid: null, startedAt: T0, lastSeenAt: T0 },
      T0 + 5_000,
    );
    expect(failure.message).not.toContain('pid');
    expect(failure.errorHint).not.toContain('kill');
  });

  it('releases a lease whose client died mid-exec, so dialog accept can get through', () => {
    // The deadlock this guards against, measured 2026-08-28: a native alert()
    // blocks the renderer, so the exec never settles and `hasPendingWork` stays
    // true forever. Without a liveness probe the lease outlives the CLI process
    // that took it, and `dialog accept` — the only command that clears the
    // alert — queues behind it indefinitely.
    const leases = new SessionLeaseRegistry();
    const held = leases.touch('k', { runId: 'run_49191_1_a', command: 'browser eval', now: 0 });
    expect(held.granted).toBe(true);

    const wayPastTtl = SESSION_LEASE_TTL_MS * 3;
    const stillPending = () => true;

    // Client alive: pending work protects it, exactly as before.
    expect(leases.touch('k', {
      runId: 'run_222_2_b', command: 'browser dialog', now: wayPastTtl,
      hasPendingWork: stillPending, isClientAlive: () => true,
    }).granted).toBe(false);

    // Client dead: pending work no longer protects it.
    const reclaimed = leases.touch('k', {
      runId: 'run_222_2_b', command: 'browser dialog', now: wayPastTtl,
      hasPendingWork: stillPending, isClientAlive: () => false,
    });
    expect(reclaimed.granted).toBe(true);
    // The queued command can log who it took the lock from and why, without
    // re-deriving it from the registry's internal state.
    expect(reclaimed.reclaimedFrom).toMatchObject({ runId: 'run_49191_1_a', command: 'browser eval', pid: 49191 });
    expect(reclaimed.reclaimReason).toBe('client_dead');
  });

  it('labels a reclaim from a merely TTL-expired (but not confirmed-dead) holder differently', () => {
    const leases = new SessionLeaseRegistry();
    leases.touch('k', { runId: 'run_1_1_a', command: 'browser eval', now: 0 });
    const reclaimed = leases.touch('k', {
      runId: 'run_2_2_b', command: 'browser click', now: SESSION_LEASE_TTL_MS + 1,
    });
    expect(reclaimed.granted).toBe(true);
    expect(reclaimed.reclaimedFrom?.runId).toBe('run_1_1_a');
    expect(reclaimed.reclaimReason).toBe('ttl_expired');
  });

  it('does not set reclaimedFrom on a first acquire or a same-runId heartbeat', () => {
    const leases = new SessionLeaseRegistry();
    const first = leases.touch('k', { runId: 'run_1_1_a', command: 'browser eval', now: 0 });
    expect(first.reclaimedFrom).toBeUndefined();
    const heartbeat = leases.touch('k', { runId: 'run_1_1_a', command: 'browser eval', now: 1_000 });
    expect(heartbeat.reclaimedFrom).toBeUndefined();
  });

  it('a dead client still keeps its lease inside the TTL', () => {
    // Only the pending-work protection is bypassed. Inside the TTL the lease
    // stands regardless, so this fix cannot shorten normal arbitration.
    const leases = new SessionLeaseRegistry();
    leases.touch('k', { runId: 'run_49191_1_a', command: 'browser eval', now: 0 });
    expect(leases.touch('k', {
      runId: 'run_222_2_b', command: 'browser dialog', now: SESSION_LEASE_TTL_MS - 1,
      hasPendingWork: () => true, isClientAlive: () => false,
    }).granted).toBe(false);
  });
});
