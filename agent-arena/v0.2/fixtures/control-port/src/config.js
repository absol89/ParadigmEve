export const defaults = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  retries: 3,
  timeoutMs: 15_000
});

export function loadConfig(env = {}) {
  return {
    host: env.APP_HOST ?? defaults.host,
    port: env.APP_PORT ? Number(env.APP_PORT) : defaults.port,
    retries: env.APP_RETRIES ? Number(env.APP_RETRIES) : defaults.retries,
    timeoutMs: defaults.timeoutMs
  };
}

export function serverUrl(config = loadConfig()) {
  return `http://${config.host}:${config.port}/`;
}
