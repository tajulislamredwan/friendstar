/** Turns a User-Agent string into a short human label such as "Chrome on Android". */
export function describeDevice(ua: string): string {
  if (!ua) return 'Unknown device';
  const s = ua;
  const browser =
    /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /SamsungBrowser\//.test(s) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : /curl\//i.test(s) ? 'curl'
    : /node|undici/i.test(s) ? 'Script'
    : 'Browser';
  const os =
    /Android/.test(s) ? 'Android'
    : /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Linux/.test(s) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Normalises user input like "fs7k2qx9", "FS 7K2QX9" or "7k2qx9" to "FS-7K2QX9". Returns null if it is not an ID. */
export function normalizeFriendId(input: string): string | null {
  const t = input.trim().toUpperCase().replace(/[\s_]/g, '');
  const m = /^(?:FS-?)?([2-9A-HJ-NP-Z]{6})$/.exec(t);
  if (!m) return null;
  if (!t.startsWith('FS') && !/\d/.test(m[1]!)) return null; // plain words are names, not IDs
  return `FS-${m[1]}`;
}
