import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ServerStats } from '../engine/server-stats.js';
import { AofService } from '../persistence/aof.service.js';
import { PubSubService } from '../pubsub/pubsub.service.js';
import { Keyspace } from '../store/keyspace.js';
import { VERSION } from '../version.js';

/**
 * HTTP endpoints for operators and orchestrators, on their own port. They read
 * counters only, so they never get in the way of commands.
 */
@Controller()
export class AdminController {
  constructor(
    private readonly aof: AofService,
    private readonly keyspace: Keyspace,
    private readonly stats: ServerStats,
    private readonly pubsub: PubSubService,
  ) {}

  /**
   * 200 while the server can accept writes, 503 once the AOF has failed, so a
   * load balancer or orchestrator can take the instance out of service.
   */
  @Get('health')
  health(): { status: string; aof: string } {
    const aof = !this.aof.enabled
      ? 'disabled'
      : this.aof.failed === null
        ? 'ok'
        : 'failed';
    if (aof === 'failed') {
      throw new ServiceUnavailableException({ status: 'degraded', aof });
    }
    return { status: 'ok', aof };
  }

  @Get('stats')
  getStats(): Record<string, unknown> {
    return {
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.stats.startedAt) / 1000),
      keys: this.keyspace.size,
      keysWithTtl: this.keyspace.volatileSize,
      connectedClients: this.stats.connectedClients,
      totalConnections: this.stats.connections,
      totalCommands: this.stats.commands,
      expiredKeys: this.stats.expiredKeys,
      rejectedClients: this.stats.rejectedClients,
      pubsubChannels: this.pubsub.channelCount,
      heapUsedBytes: process.memoryUsage().heapUsed,
      aof: this.aof.enabled
        ? {
            sizeBytes: this.aof.size,
            policy: this.aof.policy,
            failed: this.aof.failed !== null,
          }
        : null,
    };
  }
}
