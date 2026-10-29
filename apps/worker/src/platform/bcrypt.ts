/**
 * bcryptjs for Workers. Workers forbid random numbers during global-scope startup, but the
 * shared auth service builds its timing-guard hash at import time. That hash only exists to
 * equalise timing for unknown users, so a precomputed one is used when called at startup.
 */
import real from 'bcryptjs';

const TIMING_GUARD_HASH = '$2b$10$Wc1ae9.B2clrhXA12duA8O4YnoOwGF48c53Y3nTAQy4X7QcjkmuoO';
let started = false;

const bcrypt = {
  ...real,
  hashSync(password: string, rounds?: number | string): string {
    if (!started && password === 'friendstar-timing-guard') return TIMING_GUARD_HASH;
    return real.hashSync(password, rounds as number);
  },
};

/** Called once the first request arrives; afterwards everything uses real bcrypt. */
export function markStarted() {
  started = true;
}

export default bcrypt;
