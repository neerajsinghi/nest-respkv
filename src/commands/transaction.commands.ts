import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Engine } from '../engine/engine.service.js';
import { Session } from '../engine/session.js';

/**
 * MULTI/EXEC. The engine queues commands between the two; EXEC then runs the
 * queue in one synchronous call, so no other client's command can run in the
 * middle of it. There's no WATCH.
 */
@Injectable()
export class TransactionCommands {
  constructor(private readonly engine: Engine) {}

  @Command('MULTI', { arity: 1, noMulti: true })
  multi(s: Session): void {
    s.inMulti = true;
    s.reply.simple('OK');
  }

  @Command('EXEC', { arity: 1 })
  exec(s: Session): void {
    if (!s.inMulti) s.reply.error('ERR EXEC without MULTI');
    else this.engine.exec(s);
  }

  @Command('DISCARD', { arity: 1 })
  discard(s: Session): void {
    if (!s.inMulti) {
      s.reply.error('ERR DISCARD without MULTI');
      return;
    }
    s.resetTx();
    s.reply.simple('OK');
  }
}
