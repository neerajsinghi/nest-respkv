import { Injectable } from '@nestjs/common';
import { encodeCommand } from '../resp/reply-writer.js';
import type { Session } from '../engine/session.js';

/** Channel subscriptions, and delivery of published messages. */
@Injectable()
export class PubSubService {
  private readonly channels = new Map<string, Set<Session>>();

  get channelCount(): number {
    return this.channels.size;
  }

  subscribe(session: Session, channel: string): void {
    if (session.channels.has(channel)) return;
    session.channels.add(channel);
    let subs = this.channels.get(channel);
    if (subs === undefined) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(session);
  }

  unsubscribe(session: Session, channel: string): void {
    session.channels.delete(channel);
    const subs = this.channels.get(channel);
    if (subs === undefined) return;
    subs.delete(session);
    if (subs.size === 0) this.channels.delete(channel);
  }

  unsubscribeAll(session: Session): void {
    // Copied, because unsubscribe removes from the set being iterated.
    for (const channel of Array.from(session.channels)) {
      this.unsubscribe(session, channel);
    }
  }

  /**
   * Encodes the message once and hands the same bytes to every subscriber.
   * Delivery never blocks: a subscriber that has fallen too far behind is
   * disconnected by its connection instead. Returns the number of receivers.
   */
  publish(channel: string, message: string): number {
    const subs = this.channels.get(channel);
    if (subs === undefined) return 0;
    const n = subs.size;
    const buf = encodeCommand(['message', channel, message]);
    // Copied, in case delivering drops a subscriber from the set.
    for (const s of Array.from(subs)) s.push(buf);
    return n;
  }
}
