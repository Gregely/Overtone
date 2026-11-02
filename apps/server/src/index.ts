import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, pkg.version);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const { app, services } = await buildApp({ config });
  await app.listen({ host: config.host, port: config.port });
  await services.startBackground();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    await app.close();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
