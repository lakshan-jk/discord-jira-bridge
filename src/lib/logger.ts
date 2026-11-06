/**
 * Minimal structured (JSON-line) logger. Level-aware, no dependencies. Its method
 * set is a superset of the per-module logger interfaces (IngestLogger, SyncLogger,
 * WorkerLogger), so a single instance satisfies all of them.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = ORDER[level];

  const emit = (lvl: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) {
      return;
    }
    const line = JSON.stringify({
      level: lvl,
      time: new Date().toISOString(),
      message,
      ...(meta ?? {}),
    });
    if (lvl === 'warn' || lvl === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}
