import type { MessageRow, UserRow } from '../db/database.ts';

/**
 * Tiny extension points so optional features (bots) can react to core events
 * without the core services importing them (which would create import cycles).
 */
type MessageHook = (message: MessageRow, conversationId: string) => void;
type RegisterHook = (user: UserRow) => void;
type BackgroundRunner = (task: Promise<unknown>) => void;

const afterMessage: MessageHook[] = [];
const afterRegister: RegisterHook[] = [];
let runner: BackgroundRunner = (task) => {
  task.catch((err) => console.error('[background]', err));
};

export const hooks = {
  onMessage(fn: MessageHook) {
    afterMessage.push(fn);
  },
  onRegister(fn: RegisterHook) {
    afterRegister.push(fn);
  },
  emitMessage(message: MessageRow, conversationId: string) {
    for (const fn of afterMessage) safe(() => fn(message, conversationId));
  },
  emitRegister(user: UserRow) {
    for (const fn of afterRegister) safe(() => fn(user));
  },
  /** Platforms override this (the Durable Object keeps itself alive with waitUntil). */
  setBackgroundRunner(fn: BackgroundRunner) {
    runner = fn;
  },
  background(task: Promise<unknown>) {
    runner(task.catch((err) => console.error('[background]', err)));
  },
};

function safe(fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error('[hook]', err);
  }
}
