import { ReplyWriter } from '../resp/reply-writer.js';
import type { CommandHandler } from './command.decorator.js';

/** Where a session's pushed output goes: its connection. */
export interface OutputSink {
  /** Queues bytes behind everything already sent, without ever blocking. */
  push(buf: Buffer): void;
}

export interface QueuedCommand {
  handler: CommandHandler;
  args: string[];
}

/**
 * One client's state. It is a plain object rather than a request-scoped
 * provider: a connection lives for many commands, and resolving providers per
 * command would cost more than the commands themselves.
 */
export class Session {
  /** Replies to the commands of the current batch. */
  readonly reply = new ReplyWriter();
  authenticated: boolean;
  /** QUIT was received: close once the replies are out. */
  quit = false;

  inMulti = false;
  /** A command was rejected while queueing, so EXEC must abort. */
  dirtyExec = false;
  queue: QueuedCommand[] = [];

  readonly channels = new Set<string>();

  constructor(
    readonly id: number,
    authenticated: boolean,
    private readonly sink: OutputSink | null,
  ) {
    this.authenticated = authenticated;
  }

  resetTx(): void {
    this.inMulti = false;
    this.dirtyExec = false;
    this.queue = [];
  }

  /** Delivers a pub/sub message, ordered after any reply already sent. */
  push(buf: Buffer): void {
    this.sink?.push(buf);
  }
}
