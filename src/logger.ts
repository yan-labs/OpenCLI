/**
 * Unified logging for opencli.
 *
 * All framework output (warnings, debug info, errors) should go through
 * this module so that verbosity levels are respected consistently.
 */

function isVerbose(): boolean {
  return !!process.env.OPENCLI_VERBOSE;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'verbose';

/**
 * Optional second destination for log records.
 *
 * The daemon runs detached with no terminal attached to it, so everything it
 * prints — every dispatch, timeout, disconnect, and the extension messages it
 * relays — used to end at `stdio: 'ignore'`. That is precisely the material
 * someone wants an hour later, from a different task, once they notice their
 * browser automation misbehaved. A sink lets the daemon keep a copy on disk
 * without changing how anything else logs.
 */
export type LogSink = (level: LogLevel, msg: string) => void;

let sink: LogSink | null = null;

export function setLogSink(next: LogSink | null): void {
  sink = next;
}

function emit(level: LogLevel, msg: string): void {
  // A broken sink must never take the process down or swallow the message.
  if (sink) { try { sink(level, msg); } catch { /* keep going */ } }
}

export const log = {
  /** Informational message (always shown) */
  info(msg: string): void {
    emit('info', msg);
    process.stderr.write(`ℹ  ${msg}\n`);
  },

  /** Lightweight status line for adapter progress updates */
  status(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },

  /** Positive completion/status line without the heavier info prefix */
  success(msg: string): void {
    process.stderr.write(`${msg}\n`);
  },

  /** Warning (always shown) */
  warn(msg: string): void {
    emit('warn', msg);
    process.stderr.write(`⚠  ${msg}\n`);
  },

  /** Error (always shown) */
  error(msg: string): void {
    emit('error', msg);
    process.stderr.write(`✖  ${msg}\n`);
  },

  /** Verbose output (shown when -v flag or OPENCLI_VERBOSE is set) */
  verbose(msg: string): void {
    emit('verbose', msg);
    if (isVerbose()) {
      process.stderr.write(`[verbose] ${msg}\n`);
    }
  },

  /** Alias for verbose output. */
  debug(msg: string): void {
    this.verbose(msg);
  },

  /** Step-style debug (for pipeline steps, etc.) */
  step(stepNum: number, total: number, op: string, preview: string = ''): void {
    process.stderr.write(`  [${stepNum}/${total}] ${op}${preview}\n`);
  },

  /** Step result summary */
  stepResult(summary: string): void {
    process.stderr.write(`       → ${summary}\n`);
  },
};
