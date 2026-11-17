/**
 * Reports whether s matches a Redis glob pattern: `*`, `?`, `[abc]`, `[a-z]`,
 * `[^a]` and backslash escapes.
 */
export function globMatch(pattern: string, s: string): boolean {
  return match(pattern, 0, s, 0);
}

function match(p: string, pi: number, s: string, si: number): boolean {
  while (pi < p.length) {
    const c = p[pi];
    if (c === '*') {
      while (pi + 1 < p.length && p[pi + 1] === '*') pi++;
      if (pi + 1 === p.length) return true;
      for (let i = si; i <= s.length; i++) {
        if (match(p, pi + 1, s, i)) return true;
      }
      return false;
    }
    if (c === '?') {
      if (si >= s.length) return false;
      si++;
      pi++;
      continue;
    }
    if (c === '[') {
      if (si >= s.length) return false;
      const end = classEnd(p, pi);
      if (!matchClass(p.slice(pi + 1, end), s[si])) return false;
      si++;
      pi = Math.min(end + 1, p.length);
      continue;
    }
    let lit = c;
    if (c === '\\' && pi + 1 < p.length) {
      pi++;
      lit = p[pi];
    }
    if (si >= s.length || s[si] !== lit) return false;
    si++;
    pi++;
  }
  return si === s.length;
}

/** Index of the `]` closing the class at p[pi], or p.length if unterminated. */
function classEnd(p: string, pi: number): number {
  for (let i = pi + 1; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if (p[i] === ']') return i;
  }
  return p.length;
}

function matchClass(cls: string, c: string): boolean {
  const negate = cls.length > 0 && cls[0] === '^';
  if (negate) cls = cls.slice(1);
  let found = false;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === '\\' && i + 1 < cls.length) {
      i++;
      found ||= cls[i] === c;
    } else if (i + 2 < cls.length && cls[i + 1] === '-') {
      let lo = cls[i];
      let hi = cls[i + 2];
      if (lo > hi) [lo, hi] = [hi, lo];
      found ||= lo <= c && c <= hi;
      i += 2;
    } else {
      found ||= cls[i] === c;
    }
  }
  return found !== negate;
}
