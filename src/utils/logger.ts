/* eslint-disable no-console */
// Define allowed primitive types for log data values
type LogDataValue = string | number | boolean | null | undefined | Error | unknown;

// Define recursive type for nested objects
type LogDataObject = {
  [key: string]: LogDataValue | LogDataObject | Array<LogDataValue | LogDataObject>;
};

export interface LoggerTypes {
  debug(message: string, data?: LogDataObject): void;
  info(message: string, data?: LogDataObject): void;
  warn(message: string, data?: LogDataObject): void;
  error(message: string, data?: LogDataObject): void;
}

// Helper function to safely serialize error objects and unknown values
function serializeLogData(data: LogDataValue | LogDataObject) {
  if (data instanceof Error) {
    return {
      message: data.message,
      name: data.name,
      stack: data.stack,
      ...(data as unknown as Record<string, unknown>),
    };
  }
  return data;
}

function formatLog(level: string, message: string, data?: LogDataObject): string {
  const serviceStr = '[indexing-worker]';

  let dataString = '';
  if (data) {
    try {
      // Use a more robust approach to handle circular references
      const cache = new Set();
      dataString = JSON.stringify(data, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          // Detect circular reference
          if (cache.has(value)) {
            return '[Circular Reference]';
          }
          cache.add(value);
        }
        return serializeLogData(value);
      });
    } catch (error) {
      dataString = JSON.stringify({
        error: 'Error stringifying log data',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return `[${level}] ${serviceStr} ${message} ${dataString}`;
}

export const logger = {
  debug(message: string, data?: LogDataObject): void {
    console.debug(formatLog('DEBUG', message, data));
  },

  info(message: string, data?: LogDataObject): void {
    console.info(formatLog('INFO', message, data));
  },

  warn(message: string, data?: LogDataObject): void {
    console.warn(formatLog('WARN', message, data));
  },

  error(message: string, data?: LogDataObject): void {
    console.error(formatLog('ERROR', message, data));
  },
};
