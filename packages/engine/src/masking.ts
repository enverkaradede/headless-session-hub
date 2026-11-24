/**
 * Secret masking applied to everything that leaves the device (peers, webhooks, logs).
 * Over-masking is acceptable; under-masking is not.
 */

export const REDACTED = "[REDACTED]";

/** Names whose values are treated as secrets (env vars, JSON keys, key=value pairs). */
const SECRET_NAME = String.raw`[A-Za-z0-9_.-]*(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|psk|passphrase|auth(?:orization)?|cookie|session[_-]?id|signature)[A-Za-z0-9_.-]*`;
const SECRET_NAME_RE = new RegExp(`^${SECRET_NAME}$`, "i");

/** Values that are clearly not secrets even under a secret-looking key (e.g. max_tokens: 100). */
const HARMLESS_VALUE_RE = /^(?:true|false|null|none|undefined|bearer|basic|token|digest|negotiate|-?\d{1,9}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\[REDACTED\]|\*+)$/i;

/** Ordered rules; the first ones remove whole multi-line structures before line rules run. */
const PATTERN_RULES: ReadonlyArray<{ re: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  {
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: () => `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`,
  },
  { re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, replace: () => REDACTED },
  {
    re: /\b((?:Proxy-)?Authorization)(["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Token|Digest|Negotiate)\s+)?[^\s"',;]+/gi,
    replace: (_m, header, sep, scheme) => `${header}${sep}${scheme ? `${scheme} ` : ""}${REDACTED}`,
  },
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: (_m, scheme) => `${scheme} ${REDACTED}` },
  {
    re: /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{50,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g,
    replace: () => REDACTED,
  },
  {
    // scheme://user:password@host → keep user and host, drop the password.
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^:/\s@]+):([^@\s/]+)@/gi,
    replace: (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`,
  },
  {
    // ADO.NET / Azure style connection-string fields.
    re: /\b(Password|Pwd|AccountKey|SharedAccessKey|SharedAccessSignature|ClientSecret)(\s*=\s*)("[^"]*"|'[^']*'|[^;"'\s]+)/gi,
    replace: (_m, key, sep) => `${key}${sep}${REDACTED}`,
  },
];

/** `name: value`, `name=value`, `"name": "value"` on one line. */
const INLINE_ASSIGNMENT_RE = new RegExp(
  String.raw`(["']?)(${SECRET_NAME})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}\]]+)`,
  "gi",
);

/** `name:` (or `name: |`) at end of line — the value sits on the following indented line(s). */
const BLOCK_KEY_RE = new RegExp(String.raw`^(\s*)(?:-\s+)?["']?(${SECRET_NAME})["']?\s*:\s*(?:[|>][-+]?\s*)?$`, "i");

function maskInlineAssignments(text: string): string {
  return text.replace(INLINE_ASSIGNMENT_RE, (match, quote: string, name: string, sep: string, value: string) => {
    const bare = value.replace(/^["']|["']$/g, "");
    if (bare.length === 0 || HARMLESS_VALUE_RE.test(bare)) return match;
    const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    return `${quote}${name}${quote}${sep}${valueQuote}${REDACTED}${valueQuote}`;
  });
}

/** Masks YAML-style values that follow their key on the next, more-indented lines. */
function maskBlockValues(text: string): string {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const keyMatch = BLOCK_KEY_RE.exec(lines[index] ?? "");
    if (!keyMatch) continue;
    const keyIndent = keyMatch[1]?.length ?? 0;
    let next = index + 1;
    while (next < lines.length) {
      const line = lines[next] ?? "";
      if (line.trim() === "") { next++; continue; }
      const indent = line.length - line.trimStart().length;
      if (indent <= keyIndent) break;
      lines[next] = `${line.slice(0, indent)}${REDACTED}`;
      next++;
    }
    index = next - 1;
  }
  return lines.join("\n");
}

/** Literal values of secret-named environment variables, longest first so substrings don't win. */
export function collectEnvSecrets(env: Record<string, string | undefined>, minLength = 6): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= minLength && SECRET_NAME_RE.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function maskLiterals(text: string, literals: readonly string[]): string {
  let out = text;
  for (const literal of literals) {
    if (out.includes(literal)) out = out.split(literal).join(REDACTED);
  }
  return out;
}

let processEnvSecrets: readonly string[] = collectEnvSecrets(process.env);

/** Re-reads secret env values (call after the environment changes; used by tests). */
export function refreshEnvSecrets(env: Record<string, string | undefined> = process.env): void {
  processEnvSecrets = collectEnvSecrets(env);
}

/** Masks secrets in free text. */
export function maskText(text: string, extraLiterals: readonly string[] = []): string {
  if (text.length === 0) return text;
  let out = maskLiterals(text, [...extraLiterals, ...processEnvSecrets]);
  for (const rule of PATTERN_RULES) out = out.replace(rule.re, rule.replace as (substring: string, ...args: string[]) => string);
  out = maskBlockValues(out);
  return maskInlineAssignments(out);
}

const MAX_MASK_DEPTH = 32;

/** Deep-masks a JSON-like value: secret-named keys lose their values, every string is text-masked. */
export function maskValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_MASK_DEPTH) return REDACTED;
  if (typeof value === "string") return maskText(value);
  if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const secretKey = SECRET_NAME_RE.test(key) && typeof inner === "string" && !HARMLESS_VALUE_RE.test(inner);
      out[key] = secretKey ? REDACTED : maskValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}
