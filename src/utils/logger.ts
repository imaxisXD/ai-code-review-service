// src/utils/logger.ts

/* eslint-disable no-console */
// Define allowed primitive types for log data values
type LogDataValue = string | number | boolean | null | undefined | Error | unknown;

// Define recursive type for nested objects
type LogDataObject = {
  [key: string]: LogDataValue | LogDataObject | Array<LogDataValue | LogDataObject>;
};

// Helper function to safely serialize error objects and unknown values
function serializeLogData(data: LogDataValue | LogDataObject) {
  if (data instanceof Error) {
    return {
      message: data.message,
      name: data.name,
      stack: data.stack,
      ...(data as unknown as Record<string, unknown>), // Include any custom properties
    };
  }
  return data;
}

interface LoggerOptions {
  service: string;
  level?: LogLevel;
  colorize?: boolean;
  transport?: LogTransport;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Interface for log transport implementations
interface LogTransport {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// Default console transport implementation
class ConsoleTransport implements LogTransport {
  debug(message: string): void {
    console.debug(message);
  }

  info(message: string): void {
    console.info(message);
  }

  warn(message: string): void {
    console.warn(message);
  }

  error(message: string): void {
    console.error(message);
  }
}

export class Logger {
  private service: string;
  private level: LogLevel;
  private colorize: boolean;
  private transport: LogTransport;
  private levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  // Colors for terminal output
  private colors: Record<LogLevel | 'reset', string> = {
    reset: '\x1b[0m',
    debug: '\x1b[36m', // Cyan
    info: '\x1b[32m', // Green
    warn: '\x1b[33m', // Yellow
    error: '\x1b[31m', // Red
  };

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.level = options.level || 'info';
    this.colorize = options.colorize ?? true;
    this.transport = options.transport || new ConsoleTransport();
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levels[level] >= this.levels[this.level];
  }

  private formatLog(level: LogLevel, message: string, data?: LogDataObject): string {
    const timestamp = new Date().toISOString();
    const logLevel = level.toUpperCase();
    const levelStr = this.colorize
      ? `${this.colors[level]}[${logLevel}]${this.colors.reset}`
      : `[${logLevel}]`;

    const serviceStr = `[${this.service}]`;
    const dataString = data ? JSON.stringify(data, (_, value) => serializeLogData(value)) : '';

    return `${timestamp} ${levelStr} ${serviceStr} ${message} ${dataString}`;
  }

  public debug(message: string, data?: LogDataObject): void {
    if (this.shouldLog('debug')) {
      this.transport.debug(this.formatLog('debug', message, data));
    }
  }

  public info(message: string, data?: LogDataObject): void {
    if (this.shouldLog('info')) {
      this.transport.info(this.formatLog('info', message, data));
    }
  }

  public warn(message: string, data?: LogDataObject): void {
    if (this.shouldLog('warn')) {
      this.transport.warn(this.formatLog('warn', message, data));
    }
  }

  public error(message: string, data?: LogDataObject): void {
    if (this.shouldLog('error')) {
      this.transport.error(this.formatLog('error', message, data));
    }
  }
}
/* eslint-enable no-console */
