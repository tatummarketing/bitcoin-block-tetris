import { NextRequest, NextResponse } from "next/server";

const DEFAULT_ALLOWED_HOSTS = [
  "apps.tatum.io",
  "bitcoin-block-tetris.webflow.io",
  "localhost",
  "127.0.0.1",
];

type RateOpts = { limit?: number; windowMs?: number };

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

function allowedHosts(): Set<string> {
  const fromEnv = process.env.API_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set(fromEnv?.length ? fromEnv : DEFAULT_ALLOWED_HOSTS);
}

function hostnameFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostnameFromHostHeader(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim().toLowerCase();
  if (!first) return null;
  return first.split(":")[0] || null;
}

function isLocalHost(host: string) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".localhost")
  );
}

function requestHostCandidates(req: NextRequest): string[] {
  const out: string[] = [];
  for (const raw of [
    req.headers.get("x-forwarded-host"),
    req.headers.get("host"),
  ]) {
    const host = hostnameFromHostHeader(raw);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

function clientKey(req: NextRequest): string {
  const forwarded =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip");
  return forwarded || "unknown";
}

function forbidden(message = "Forbidden") {
  return NextResponse.json(
    { message },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}

function methodNotAllowed() {
  return NextResponse.json(
    { message: "Method not allowed" },
    {
      status: 405,
      headers: {
        Allow: "GET",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    }
  );
}

/**
 * Reject requests that aren't from an allowlisted browser origin/host.
 * Prefer Origin; fall back to Referer; then same-origin Host + Sec-Fetch-Site.
 */
export function assertAllowedHost(req: NextRequest): NextResponse | null {
  const hosts = allowedHosts();
  const candidates = requestHostCandidates(req);
  const originHost = hostnameFromUrl(req.headers.get("origin"));
  const refererHost = hostnameFromUrl(req.headers.get("referer"));
  const secFetchSite = (req.headers.get("sec-fetch-site") || "").toLowerCase();

  // If the browser sent Origin, it must be allowlisted (or local in dev).
  if (originHost) {
    if (hosts.has(originHost)) return null;
    if (
      process.env.NODE_ENV !== "production" &&
      isLocalHost(originHost)
    ) {
      return null;
    }
    return forbidden();
  }

  // Local/dev tooling (curl, Playwright) hitting localhost with no Origin.
  if (
    candidates.some(isLocalHost) &&
    process.env.NODE_ENV !== "production"
  ) {
    return null;
  }

  // No Origin (some navigations / older clients): allowlisted Referer.
  if (refererHost) {
    return hosts.has(refererHost) ? null : forbidden();
  }

  // Same-origin fetch metadata + allowlisted Host.
  if (
    secFetchSite === "same-origin" &&
    candidates.some((h) => hosts.has(h))
  ) {
    return null;
  }

  return forbidden();
}

/**
 * Best-effort in-memory rate limit (per Worker isolate / Node process).
 * Default: 60 requests / 60s per client IP + route path.
 */
export function assertRateLimit(
  req: NextRequest,
  opts?: RateOpts
): NextResponse | null {
  const limit = clamp(
    opts?.limit ?? Number(process.env.API_RATE_LIMIT || 60),
    1,
    1_000
  );
  const windowMs = clamp(
    opts?.windowMs ?? Number(process.env.API_RATE_WINDOW_MS || 60_000),
    1_000,
    3_600_000
  );
  const now = Date.now();
  const key = `${clientKey(req)}:${req.nextUrl.pathname}`;

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;

  if (buckets.size > 5_000) {
    for (const [k, b] of buckets) {
      if (now >= b.resetAt) buckets.delete(k);
    }
  }

  const remaining = Math.max(0, limit - bucket.count);
  const resetSec = Math.ceil(bucket.resetAt / 1000);

  if (bucket.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return NextResponse.json(
      { message: "Too many requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(resetSec),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  }

  // Stash for successful responses.
  (req as NextRequest & { __rate?: RateHeaders }).__rate = {
    limit,
    remaining,
    reset: resetSec,
  };

  return null;
}

type RateHeaders = { limit: number; remaining: number; reset: number };

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function rateHeaders(req: NextRequest): Record<string, string> {
  const rate = (req as NextRequest & { __rate?: RateHeaders }).__rate;
  if (!rate) return {};
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(rate.reset),
  };
}

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin");
  const originHost = hostnameFromUrl(origin);
  if (!origin || !originHost || !allowedHosts().has(originHost)) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    Vary: "Origin",
  };
}

/** Host allowlist + GET-only + rate limit. Returns a Response to short-circuit, or null. */
export function guardApiRequest(
  req: NextRequest,
  rate?: RateOpts
): NextResponse | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return methodNotAllowed();
  }
  return assertAllowedHost(req) || assertRateLimit(req, rate);
}

/** JSON success with rate-limit + CORS + nosniff headers. */
export function apiJson<T>(
  req: NextRequest,
  body: T,
  opts?: { status?: number; cacheControl?: string }
): NextResponse {
  return NextResponse.json(body, {
    status: opts?.status ?? 200,
    headers: {
      "Cache-Control":
        opts?.cacheControl ?? "public, s-maxage=60, stale-while-revalidate=120",
      "X-Content-Type-Options": "nosniff",
      ...rateHeaders(req),
      ...corsHeaders(req),
    },
  });
}

/** Safe error JSON — never leak upstream/stack details in production. */
export function apiError(
  req: NextRequest,
  err: unknown,
  fallback: string,
  status = 502
): NextResponse {
  const detail =
    process.env.NODE_ENV !== "production" && err instanceof Error
      ? err.message
      : fallback;
  return NextResponse.json(
    { message: detail },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...rateHeaders(req),
        ...corsHeaders(req),
      },
    }
  );
}

/** Pick only allowlisted keys (shallow). */
export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: readonly K[]
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    out[key] = obj[key];
  }
  return out;
}

/** Downsample a time series so proxies never dump full upstream history. */
export function downsampleSeries<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const out: T[] = [];
  const last = points.length - 1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i / (maxPoints - 1)) * last);
    out.push(points[idx]);
  }
  out[out.length - 1] = points[last];
  return out;
}
