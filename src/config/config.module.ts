import { DynamicModule, Global, Module } from '@nestjs/common';
import { RESPKV_CONFIG, RespkvConfig } from './config.js';

@Global()
@Module({})
export class ConfigModule {
  static register(config: RespkvConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: RESPKV_CONFIG, useValue: config }],
      exports: [RESPKV_CONFIG],
    };
  }
}
