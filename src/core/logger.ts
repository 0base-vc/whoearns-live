import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from './config.js';

export type { Logger };

export function createLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: 'whoearns-live' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
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
