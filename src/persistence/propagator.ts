import { Injectable } from '@nestjs/common';
import { Keyspace } from '../store/keyspace.js';
import { AofService } from './aof.service.js';

/**
 * Records writes in the AOF. Handlers call propagate after a command has
 * succeeded and changed something, passing a form that replays
 * deterministically: an absolute expiry rather than a relative one, SREM rather
 * than SPOP, DEL for a key that expired.
 */
@Injectable()
export class Propagator {
  private inExec = false;
  private txLogged = false;

  constructor(
    private readonly aof: AofService,
    private readonly keyspace: Keyspace,
  ) {}

  propagate(...args: string[]): void {
    if (!this.aof.enabled || this.keyspace.loading) return;
    if (this.inExec && !this.txLogged) {
      this.aof.append(['MULTI']);
      this.txLogged = true;
    }
    this.aof.append(args);
  }

  /**
   * Runs an EXEC's commands. Their log records are bracketed by MULTI and EXEC,
   * so replay can drop a transaction a crash wrote only part of. A read-only
   * transaction logs nothing at all.
   */
  exec(run: () => void): void {
    this.inExec = true;
    this.txLogged = false;
    try {
      run();
    } finally {
      this.inExec = false;
      if (this.txLogged) this.aof.append(['EXEC']);
    }
  }
}
