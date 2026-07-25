const levels = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger({
  level = 'info',
  destination = process.stdout,
  clock = () => new Date(),
} = {}) {
  const threshold = levels[level] ?? levels.info;

  function write(logLevel, fields, message) {
    if (levels[logLevel] < threshold) {
      return;
    }

    destination.write(`${JSON.stringify({
      timestamp: clock().toISOString(),
      level: logLevel,
      message,
      ...fields,
    })}\n`);
  }

  return {
    debug: (fields, message) => write('debug', fields, message),
    info: (fields, message) => write('info', fields, message),
    warn: (fields, message) => write('warn', fields, message),
    error: (fields, message) => write('error', fields, message),
  };
}
