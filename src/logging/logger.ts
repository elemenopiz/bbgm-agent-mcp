/**
 * Stderr-only structured logger. Stdout is reserved exclusively for MCP
 * protocol traffic when serving over stdio, so nothing in this module may
 * write there.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = Record<
  LogLevel,
  (message: string, fields?: Record<string, unknown>) => void
>;

const write = (
  level: LogLevel,
  component: string,
  message: string,
  fields?: Record<string, unknown>,
): void => {
  const record = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(fields ?? {}),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

export const createLogger = (component: string): Logger => ({
  debug: (message, fields) => write("debug", component, message, fields),
  info: (message, fields) => write("info", component, message, fields),
  warn: (message, fields) => write("warn", component, message, fields),
  error: (message, fields) => write("error", component, message, fields),
});
