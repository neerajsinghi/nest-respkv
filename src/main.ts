import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config/config.js';
import { RespServer } from './network/resp-server.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config));
  app.enableShutdownHooks();
  // init replays the AOF before anything listens.
  await app.init();
  await app.get(RespServer).listen();
  if (config.admin !== null) {
    await app.listen(config.admin.port, config.admin.host);
    Logger.log(
      `admin HTTP on ${config.admin.host}:${config.admin.port}`,
      'Bootstrap',
    );
  }
}

bootstrap().catch((err: unknown) => {
  Logger.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
    'Bootstrap',
  );
  process.exit(1);
});
