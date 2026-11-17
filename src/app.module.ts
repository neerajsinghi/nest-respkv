import { DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AdminController } from './admin/admin.controller.js';
import { ConnectionCommands } from './commands/connection.commands.js';
import { HashCommands } from './commands/hash.commands.js';
import { KeyCommands } from './commands/key.commands.js';
import { ListCommands } from './commands/list.commands.js';
import { PubSubCommands } from './commands/pubsub.commands.js';
import { ServerCommands } from './commands/server.commands.js';
import { SetCommands } from './commands/set.commands.js';
import { StringCommands } from './commands/string.commands.js';
import { TransactionCommands } from './commands/transaction.commands.js';
import { ZSetCommands } from './commands/zset.commands.js';
import { RespkvConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { CommandRegistry } from './engine/command-registry.js';
import { Engine } from './engine/engine.service.js';
import { ServerStats } from './engine/server-stats.js';
import { RespServer } from './network/resp-server.js';
import { AofService } from './persistence/aof.service.js';
import { Propagator } from './persistence/propagator.js';
import { PubSubService } from './pubsub/pubsub.service.js';
import { Keyspace } from './store/keyspace.js';

/** The keyspace and the AOF, which commands and the engine share. */
@Module({
  providers: [Keyspace, AofService, Propagator, PubSubService, ServerStats],
  exports: [Keyspace, AofService, Propagator, PubSubService, ServerStats],
})
export class CoreModule {}

/** Command dispatch, MULTI/EXEC, AOF replay and active expiry. */
@Module({
  imports: [DiscoveryModule, CoreModule],
  providers: [CommandRegistry, Engine],
  exports: [Engine],
})
export class EngineModule {}

/**
 * Every command. Each provider here groups related commands as methods marked
 * with @Command, which the registry finds at startup.
 */
@Module({
  imports: [CoreModule, EngineModule],
  providers: [
    ConnectionCommands,
    ServerCommands,
    KeyCommands,
    StringCommands,
    ListCommands,
    HashCommands,
    SetCommands,
    ZSetCommands,
    TransactionCommands,
    PubSubCommands,
  ],
})
export class CommandsModule {}

/** The RESP listener. */
@Module({
  imports: [CoreModule, EngineModule],
  providers: [RespServer],
  exports: [RespServer],
})
export class NetworkModule {}

/** HTTP health and stats. */
@Module({
  imports: [CoreModule],
  controllers: [AdminController],
})
export class AdminModule {}

@Module({})
export class AppModule {
  static register(config: RespkvConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        CoreModule,
        EngineModule,
        CommandsModule,
        NetworkModule,
        AdminModule,
      ],
    };
  }
}
