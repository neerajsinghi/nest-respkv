import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { PubSubService } from '../pubsub/pubsub.service.js';

/** Channel pub/sub. There are no pattern subscriptions. */
@Injectable()
export class PubSubCommands {
  constructor(private readonly pubsub: PubSubService) {}

  @Command('SUBSCRIBE', { arity: -2, noMulti: true, pubsub: true })
  subscribe(s: Session, args: string[]): void {
    for (let i = 1; i < args.length; i++) {
      this.pubsub.subscribe(s, args[i]);
      s.reply.array(3);
      s.reply.bulk('subscribe');
      s.reply.bulk(args[i]);
      s.reply.int(s.channels.size);
    }
  }

  @Command('UNSUBSCRIBE', { arity: -1, noMulti: true, pubsub: true })
  unsubscribe(s: Session, args: string[]): void {
    const names = args.length > 1 ? args.slice(1) : [...s.channels];
    if (names.length === 0) {
      // Not subscribed to anything: one reply with a null channel.
      s.reply.array(3);
      s.reply.bulk('unsubscribe');
      s.reply.null();
      s.reply.int(0);
      return;
    }
    for (const name of names) {
      this.pubsub.unsubscribe(s, name);
      s.reply.array(3);
      s.reply.bulk('unsubscribe');
      s.reply.bulk(name);
      s.reply.int(s.channels.size);
    }
  }

  @Command('PUBLISH', { arity: 3 })
  publish(s: Session, args: string[]): void {
    s.reply.int(this.pubsub.publish(args[1], args[2]));
  }
}
