import 'reflect-metadata';
import type { Session } from './session.js';

export const COMMAND_METADATA = 'respkv:commands';

export interface CommandOptions {
  /** Like Redis: the exact argument count if positive, the minimum if negative. */
  arity: number;
  /** Mutates data, so it's refused when the AOF has failed. */
  write?: boolean;
  /** Allowed before AUTH. */
  noAuth?: boolean;
  /** Refused inside MULTI. */
  noMulti?: boolean;
  /** Allowed while subscribed to a channel. */
  pubsub?: boolean;
}

export interface CommandSpec extends CommandOptions {
  name: string;
}

/**
 * A command implementation. It must be synchronous: it runs to completion
 * before any other command starts, which is what makes it atomic. The command
 * registry refuses async handlers at startup.
 */
export type CommandFn = (session: Session, args: string[]) => void;

export interface CommandHandler extends CommandSpec {
  fn: CommandFn;
}

/**
 * Marks a provider method as the implementation of a command. A method can
 * carry several, as DEL and UNLINK share one. The method receives the session
 * and the arguments, with args[0] being the command name as the client sent it.
 */
export function Command(
  name: string,
  options: CommandOptions,
): MethodDecorator {
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const specs: CommandSpec[] =
      Reflect.getMetadata(COMMAND_METADATA, fn) ?? [];
    Reflect.defineMetadata(
      COMMAND_METADATA,
      [...specs, { name: name.toUpperCase(), ...options }],
      fn,
    );
  };
}
