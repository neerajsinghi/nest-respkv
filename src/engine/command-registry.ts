import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import {
  COMMAND_METADATA,
  CommandFn,
  CommandHandler,
  CommandSpec,
} from './command.decorator.js';

/**
 * The command table, built at startup by finding every provider method marked
 * with @Command. Adding a command means adding a method to any provider; nothing
 * else needs registering.
 */
@Injectable()
export class CommandRegistry implements OnModuleInit {
  private readonly byName = new Map<string, CommandHandler>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;
      const proto = Object.getPrototypeOf(instance) as object;
      for (const method of this.scanner.getAllMethodNames(proto)) {
        const fn = (instance as Record<string, unknown>)[method];
        if (typeof fn !== 'function') continue;
        const specs: CommandSpec[] | undefined = Reflect.getMetadata(
          COMMAND_METADATA,
          fn,
        );
        if (!specs) continue;
        if (fn.constructor.name === 'AsyncFunction') {
          throw new Error(
            `${proto.constructor.name}.${method}: command handlers must be synchronous, ` +
              'or other commands could run in the middle of them',
          );
        }
        const bound = (fn as CommandFn).bind(instance);
        for (const spec of specs) this.add({ ...spec, fn: bound });
      }
    }
  }

  private add(handler: CommandHandler): void {
    if (this.byName.has(handler.name)) {
      throw new Error(`command ${handler.name} is defined twice`);
    }
    // Clients send either case, so both are indexed and the common lookups
    // don't allocate an upper-cased copy of the name.
    this.byName.set(handler.name, handler);
    this.byName.set(handler.name.toLowerCase(), handler);
  }

  /** Finds a command by name, in any case. */
  get(name: string): CommandHandler | undefined {
    return (
      this.byName.get(name) ??
      (name.length <= 32 ? this.byName.get(name.toUpperCase()) : undefined)
    );
  }

  get size(): number {
    return this.byName.size / 2;
  }
}

/** Reports whether n arguments, the name included, satisfy the command's arity. */
export function arityOk(handler: CommandSpec, n: number): boolean {
  return handler.arity >= 0 ? n === handler.arity : n >= -handler.arity;
}
