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

/** Hosts a browser may legitimately be serving the Studio page from. */
const isLocalHost = (host: string) => {
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
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
    // A page served over https cannot be this Studio; refuse rather than
    // matching on hostname alone.
    if (url.protocol !== "http:") return forbid();
    originHost = url.host;
  } catch {
    return forbid();
  }

  const host = req.headers.get("host");
  if (host && originHost === host) return null;

  // Fall back to a loopback check: the dev server binds 127.0.0.1, so any
  // legitimate Origin resolves there even if Host was rewritten by a proxy.
  if (isLocalHost(originHost) && (!host || isLocalHost(host))) return null;

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
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  if (n < min || n > max) return undefined;
  return n;
}
