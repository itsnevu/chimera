/**
 * Request guards for the Studio's mutating endpoints.
 *
 * Studio is an unauthenticated local tool, which is fine as long as only the
 * Studio page can drive it. Nothing enforced that: a POST carrying
 * `Content-Type: text/plain` or `multipart/form-data` is a CORS-*simple*
 * request, so the browser sends it cross-origin with no preflight and no
 * consent. Any page open in another tab could therefore approve the style
 * reference, re-roll the plan, or start a paid run on the user's own key —
 * the response is invisible to the attacker, but every side effect lands.
 *
 * So mutating routes require a same-origin `Origin` header. Browsers set it on
 * every cross-origin request and forbid pages from overriding it, which is
 * exactly the property a CSRF check needs.
 */
import { NextResponse } from "next/server";

/**
 * The only names a browser may legitimately be serving the Studio page from.
 *
 * Exact matches only. `localhost.evil.com` and `127.0.0.1.evil.com` must not
 * pass, and neither must the shorthand IPv4 forms `127.1`, `0x7f.0.0.1` or
 * `2130706433` — WHATWG URL normalises all three to `127.0.0.1`, so matching
 * on the parsed host rather than the raw string handles them for free.
 */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * @param host  a parsed `URL.host`, i.e. hostname plus optional port, with
 *              any userinfo already stripped by the URL parser.
 */
const isLoopbackOrigin = (host: string) => {
  const match = /^(.*?)(?::(\d+))?$/.exec(host);
  if (!match) return false;
  const [, name, port] = match;
  if (!LOOPBACK_NAMES.has(name)) return false;
  // Port 0 is never a real listener, and a port is required to be sane when
  // present. Any other loopback port is accepted: the user may run Studio on
  // whichever port Next picked when 3000 was taken.
  if (port !== undefined && Number(port) === 0) return false;
  return true;
};

/**
 * @returns a 403 response when the request must be refused, else null.
 */
export function rejectCrossOrigin(req: Request): NextResponse | null {
  const origin = req.headers.get("origin");

  // Same-origin fetch() from our own page always carries Origin. A missing
  // one means curl or a server-side client — allowed, because those are not
  // the confused deputy CSRF exploits, and blocking them would break
  // scripting the local tool.
  if (!origin) return null;

  let originHost: string;
  try {
    const url = new URL(origin);
    // http for the local dev server, https for anyone fronting it with a
    // proxy or a local certificate. The host check below is what actually
    // decides; refusing https outright would 403 the real page and push
    // people toward turning this off.
    if (url.protocol !== "http:" && url.protocol !== "https:") return forbid();
    originHost = url.host;
  } catch {
    // An opaque origin serialises to the literal "null" — data:, blob:,
    // sandboxed frames, and cross-site form posts under a downgrade. new URL
    // throws on it, which is the refusal we want.
    return forbid();
  }

  // Deliberately NOT compared against the Host header. Host is supplied by
  // the client, so "Origin equals Host" reduces to "the caller agrees with
  // itself" — which is exactly what a DNS rebinding attack arranges: the
  // victim loads http://rebind.evil.com:3000, the name re-resolves to
  // 127.0.0.1, and the page's own same-origin fetches then carry a matching
  // Origin and Host pair while being fully readable by the attacker.
  // Only a fixed loopback allowlist is trustworthy here.
  if (isLoopbackOrigin(originHost)) return null;

  return forbid();
}

const forbid = () =>
  NextResponse.json(
    {
      error:
        "Refused: this request came from another site. Chimera Studio only " +
        "accepts commands from its own page.",
    },
    { status: 403 }
  );

/** Coerce an untrusted JSON value to a number within bounds, or undefined. */
export function boundedNumber(
  value: unknown,
  { min, max, integer = false }: { min: number; max: number; integer?: boolean }
): number | undefined {
  // Numbers only. Coercing meant `[5]`, `{valueOf(){return 5}}`, `true` and
  // `"0x10"` all became valid inputs, while `null`, `false`, `[]` and `""`
  // silently became a valid 0 — so `{"twinDistance": null}` set distance 0
  // instead of being rejected.
  if (typeof value !== "number") return undefined;
  const n = value;
  if (!Number.isFinite(n)) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
}
