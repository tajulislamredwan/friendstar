import type { Backend } from './backend.ts';
import { HttpBackend } from './http.ts';
import { DemoBackend } from './demo.ts';

export const isDemo = import.meta.env.VITE_DEMO === '1';

/** One backend instance for the whole app; the demo build runs entirely in the browser. */
export const backend: Backend = isDemo ? new DemoBackend() : new HttpBackend();

export { ApiError } from './backend.ts';
export type { Backend, ConnectionState } from './backend.ts';
