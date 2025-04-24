// src/utils/logger.ts
interface LoggerOptions {
  service: string;
  level?: string;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private service: string;
  private level: LogLevel;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.level = (options.level as LogLevel) || 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  private formatLog(level: LogLevel, message: string, data?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const dataString = data ? JSON.stringify(data) : '';
    return `${timestamp} [${level.toUpperCase()}] [${this.service}] ${message} ${dataString}`;
  }

  public debug(message: string, data?: Record<string, any>): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatLog('debug', message, data));
    }
  }

  public info(message: string, data?: Record<string, any>): void {
    if (this.shouldLog('info')) {
      console.info(this.formatLog('info', message, data));
    }
  }

  public warn(message: string, data?: Record<string, any>): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatLog('warn', message, data));
    }
  }

  public error(message: string, data?: Record<string, any>): void {
    if (this.shouldLog('error')) {
      console.error(this.formatLog('error', message, data));
    }
  }
}