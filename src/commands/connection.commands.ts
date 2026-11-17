import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RESPKV_CONFIG } from '../config/config.js';
import type { RespkvConfig } from '../config/config.js';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { VERSION } from '../version.js';
import { ERR_SYNTAX, is, parseInt64 } from './common.js';

const WRONGPASS =
  'WRONGPASS invalid username-password pair or user is disabled.';

@Injectable()
export class ConnectionCommands {
  private readonly passwordHash: Buffer | null;

  constructor(@Inject(RESPKV_CONFIG) config: RespkvConfig) {
    this.passwordHash =
      config.password === ''
        ? null
        : createHash('sha256').update(config.password).digest();
  }

  /**
   * Compares hashes in constant time, so neither the password's content nor
   * its length leaks through timing. The argument holds the client's raw bytes
   * as latin1, so it hashes the same as the UTF-8 configured password would.
   */
  private checkPassword(arg: string): boolean {
    if (this.passwordHash === null) return false;
    const sum = createHash('sha256')
      .update(Buffer.from(arg, 'latin1'))
      .digest();
    return timingSafeEqual(sum, this.passwordHash);
  }

  @Command('PING', { arity: -1, pubsub: true })
  ping(s: Session, args: string[]): void {
    if (args.length > 2) {
      s.reply.error("ERR wrong number of arguments for 'ping' command");
      return;
    }
    if (s.channels.size > 0) {
      // While subscribed, RESP2 replies in the shape of a pushed message.
      s.reply.array(2);
      s.reply.bulk('pong');
      s.reply.bulk(args[1] ?? '');
      return;
    }
    if (args.length === 2) s.reply.bulk(args[1]);
    else s.reply.simple('PONG');
  }

  @Command('ECHO', { arity: 2 })
  echo(s: Session, args: string[]): void {
    s.reply.bulk(args[1]);
  }

  @Command('QUIT', { arity: 1, noAuth: true, noMulti: true, pubsub: true })
  quit(s: Session): void {
    s.reply.simple('OK');
    s.quit = true;
  }

  /** AUTH [default] password. Only the default user exists. */
  @Command('AUTH', { arity: -2, noAuth: true, noMulti: true })
  auth(s: Session, args: string[]): void {
    if (args.length > 3) {
      s.reply.error(ERR_SYNTAX);
      return;
    }
    if (args.length === 3 && args[1] !== 'default') {
      s.reply.error(WRONGPASS);
      return;
    }
    if (this.passwordHash === null) {
      s.reply.error(
        'ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?',
      );
      return;
    }
    if (!this.checkPassword(args[args.length - 1])) {
      s.reply.error(WRONGPASS);
      return;
    }
    s.authenticated = true;
    s.reply.simple('OK');
  }

  /**
   * Lets modern clients negotiate. Only RESP2 is spoken, so asking for 3 gets
   * the NOPROTO error those clients are written to fall back from.
   */
  @Command('HELLO', { arity: -1, noAuth: true, noMulti: true })
  hello(s: Session, args: string[]): void {
    if (args.length >= 2) {
      const v = parseInt64(args[1]);
      if (v === null) {
        s.reply.error('ERR Protocol version is not an integer or out of range');
        return;
      }
      if (v !== 2n) {
        s.reply.error('NOPROTO unsupported protocol version');
        return;
      }
    }
    if (args.length > 2) {
      if (
        !is(args[2], 'AUTH') ||
        args.length !== 5 ||
        args[3] !== 'default' ||
        !this.checkPassword(args[4])
      ) {
        s.reply.error(WRONGPASS);
        return;
      }
      s.authenticated = true;
    }
    if (!s.authenticated) {
      s.reply.error(
        'NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time',
      );
      return;
    }
    const fields: [string, string | number][] = [
      ['server', 'respkv'],
      ['version', VERSION],
      ['proto', 2],
      ['id', s.id],
      ['mode', 'standalone'],
      ['role', 'master'],
    ];
    s.reply.array(fields.length * 2 + 2);
    for (const [k, v] of fields) {
      s.reply.bulk(k);
      if (typeof v === 'number') s.reply.int(v);
      else s.reply.bulk(v);
    }
    s.reply.bulk('modules');
    s.reply.array(0);
  }

  /** Accepts database 0 only, since clients often send SELECT 0 on connect. */
  @Command('SELECT', { arity: 2 })
  select(s: Session, args: string[]): void {
    const v = parseInt64(args[1]);
    if (v === null) s.reply.error('ERR invalid DB index');
    else if (v !== 0n) s.reply.error('ERR DB index is out of range');
    else s.reply.simple('OK');
  }

  /** Accepts the bookkeeping client libraries send on connect. */
  @Command('CLIENT', { arity: -2 })
  client(s: Session, args: string[]): void {
    if (is(args[1], 'SETNAME') || is(args[1], 'SETINFO')) s.reply.simple('OK');
    else if (is(args[1], 'GETNAME')) s.reply.null();
    else if (is(args[1], 'ID')) s.reply.int(s.id);
    else s.reply.error('ERR CLIENT subcommand not supported');
  }
}
