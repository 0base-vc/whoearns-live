import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from './config.js';

export type { Logger };

export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: 'whoearns-live' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // SEC-L5 / OPS-L1 — redaction set. `ANTHROPIC_API_KEY` and
    // `POSTGRES_URL` are top-level `AppConfig` fields and the config
    // object is occasionally logged (startup diagnostics, error
    // context); without these paths a secret could land in the log
    // stream. The wildcard `*.<field>` forms catch the same secret
    // nested one level down (e.g. `{ config: { POSTGRES_URL } }`,
    // `{ err: { POSTGRES_PASSWORD } }`). pino only redacts paths it
    // can resolve, so listing keys that aren't present on a given
    // log object is a harmless no-op.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'ANTHROPIC_API_KEY',
        '*.ANTHROPIC_API_KEY',
        'POSTGRES_URL',
        '*.POSTGRES_URL',
        'POSTGRES_PASSWORD',
        '*.POSTGRES_PASSWORD',
        '*.apiKey',
        '*.password',
        '*.token',
        '*["x-api-key"]',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (config.NODE_ENV === 'development') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
    });
  }

  return pino(options);
}
