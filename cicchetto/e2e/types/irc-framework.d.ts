// Types for `irc-framework@4.14.0`, which ships none (TS7016).
//
// Why ours and not `@types/irc-framework`: there is no such package —
// `bun info @types/irc-framework` answers 404 from the npm registry
// (2026-08-09). The alternatives were a bare `declare module "irc-framework";`
// (implicit `any` for the whole peer fixture — the escape hatch #484 exists to
// remove) or this: the slice of the library `fixtures/ircClient.ts` actually
// drives. Same shape as the `PrivmsgSource` slice `fixtures/privmsgWait.ts`
// already declares for its two methods.
//
// `IrcEventName` is the load-bearing part. irc-framework is an EventEmitter
// with untyped, stringly-named events, and a listener on a name the library
// never emits is silently dead — `ircClient.ts:oper()` waited on an
// `rpl_youreoper` event that does not exist and hung until its timeout for as
// long as it had no caller (fixed in #367 by matching the raw 381 line). That
// is the same defect class as #484's `msg.type() === "warn"`. A closed union of
// event names makes it a compile error instead.
//
// Payload shapes are transcribed from the library's own `emit` sites:
//   src/connection.js                    raw, close, socket close
//   src/commands/handlers/registration.js  registered
//   src/commands/handlers/user.js          nick, nick in use
//   src/commands/handlers/channel.js       join, part, kick, topic
//   src/commands/handlers/misc.js          mode
//   src/commands/handlers/messaging.js     notice, privmsg
// Only the fields the fixture reads are declared; the library sends more
// (`tags`, `batch`, `time`, …). Add an event here when a spec needs one.

declare module "irc-framework" {
  export interface IrcEventMap {
    // connection.js — `from_server` false for our own outbound frames.
    raw: { line: string; from_server: boolean };
    // connection.js / transports — the argument is an error-or-false whose
    // shape the library does not commit to; no caller reads it.
    close: unknown;
    "socket close": unknown;

    registered: { nick: string };
    nick: { nick: string; ident: string; hostname: string; new_nick: string };
    "nick in use": { nick: string; reason: string };

    join: { nick: string; ident: string; hostname: string; gecos: string; channel: string };
    part: { nick: string; ident: string; hostname: string; channel: string; message: string };
    kick: {
      kicked: string;
      nick: string;
      ident: string;
      hostname: string;
      channel: string;
      message: string;
    };
    topic: { channel: string; topic: string };

    mode: {
      target: string;
      nick: string;
      raw_modes: string;
      raw_params: string[];
      modes: { mode: string; param: string | null }[];
    };

    notice: {
      from_server: boolean;
      nick: string;
      ident: string;
      hostname: string;
      target: string;
      message: string;
    };
    privmsg: {
      from_server: boolean;
      nick: string;
      ident: string;
      hostname: string;
      target: string;
      message: string;
    };
  }

  export type IrcEventName = keyof IrcEventMap;

  export interface IrcConnectOptions {
    host: string;
    port: number;
    nick: string;
    username?: string;
    gecos?: string;
    password?: string;
    tls?: boolean;
    auto_reconnect?: boolean;
  }

  export class Client {
    constructor(options?: Partial<IrcConnectOptions>);

    readonly user: { nick: string; username: string; gecos: string };

    on<E extends IrcEventName>(event: E, handler: (payload: IrcEventMap[E]) => void): this;
    once<E extends IrcEventName>(event: E, handler: (payload: IrcEventMap[E]) => void): this;
    removeListener<E extends IrcEventName>(
      event: E,
      handler: (payload: IrcEventMap[E]) => void,
    ): this;

    connect(options?: IrcConnectOptions): void;
    quit(message?: string): void;

    // `raw(array)` adds the IRC trailing-param `:` itself; the varargs form
    // joins on spaces. Both are used by the fixture.
    raw(input: string[] | string, ...rest: (string | number)[]): void;

    say(target: string, message: string): void;
    action(target: string, message: string): void;
    notice(target: string, message: string): void;
    join(channel: string, key?: string): void;
    part(channel: string, message?: string): void;
    mode(channel: string, mode: string, extraArgs?: string | string[]): void;
    changeNick(nick: string): void;
  }
}
