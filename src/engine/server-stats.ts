import { Injectable } from '@nestjs/common';

/** Counters reported by INFO and the admin endpoint. */
@Injectable()
export class ServerStats {
  readonly startedAt = Date.now();
  commands = 0;
  connections = 0;
  connectedClients = 0;
  expiredKeys = 0;
  /** Clients dropped for being too slow, or refused at the client limit. */
  rejectedClients = 0;
}
