/**
 * On-disk daemon logs, split by kind.
 *
 * Why split rather than one file: these get read by a person or an agent trying
 * to answer one narrow question — "did my command time out?", "did the extension
 * drop?", "what went wrong an hour ago?". A single stream forces every such
 * question to page in everything, which is slow to read and expensive in tokens.
 * Four small files let the reader open only the one that can hold the answer.
 *
 * `errors.log` deliberately duplicates: a warning also lands in its own category
 * file. Duplication costs a few kilobytes; the alternative is knowing which
 * category failed before you know what failed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setLogSink, type LogLevel } from './logger.js';

/**
 * - `errors`    every warning and failure, whatever produced it. The first place to look.
 * - `commands`  commands that went wrong: timeouts, dispatch failures, results lost to a
 *               disconnect. There is no per-command success record — the daemon does not
 *               write one, and a line per call would bury the failures that matter.
 * - `extension` messages the browser extension sent up, prefixed `[ext]`.
 * - `daemon`    lifecycle: startup, shutdown, extension connect and disconnect.
 */
export type DaemonLogStream = 'daemon' | 'commands' | 'extension' | 'errors';

export const DAEMON_LOG_STREAMS: DaemonLogStream[] = ['daemon', 'commands', 'extension', 'errors'];

/** One generation of history is enough to answer "what happened an hour ago". */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function daemonLogDir(): string {
  return path.join(os.homedir(), '.opencli', 'logs');
}

export function daemonLogPath(stream: DaemonLogStream): string {
  return path.join(daemonLogDir(), `${stream}.log`);
}

/**
 * Which file does this record belong in?
 *
 * Matched on the prefixes the daemon actually writes. A record that matches
 * nothing lands in `daemon`, so a new log line is never silently dropped —
 * it just starts out in the lifecycle file until someone classifies it.
 */
export function classifyRecord(level: LogLevel, msg: string): DaemonLogStream {
  if (msg.startsWith('[ext]')) return 'extension';
  if (/\(id=|\baction=|Command (result|timed out|dispatch)|Failed to dispatch/.test(msg)) return 'commands';
  return 'daemon';
}

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or another process rotated first. Appending still works.
  }
}

function append(stream: DaemonLogStream, line: string): void {
  const file = daemonLogPath(stream);
  rotate(file);
  fs.appendFileSync(file, line);
}

/**
 * Start writing the daemon's log records to disk. Call once, from the daemon
 * process only — the CLI keeps logging to stderr as before.
 */
export function installDaemonLogSink(): void {
  try {
    fs.mkdirSync(daemonLogDir(), { recursive: true });
  } catch {
    // Read-only home, sandbox, or a permissions problem. Logging to disk is a
    // diagnostic aid; failing to get it must never stop the daemon from serving.
    return;
  }
  setLogSink((level: LogLevel, msg: string) => {
    if (level === 'verbose') return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}\n`;
    append(classifyRecord(level, msg), line);
    if (level === 'warn' || level === 'error') append('errors', line);
  });
}
