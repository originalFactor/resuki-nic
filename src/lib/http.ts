import "server-only";

import { NextResponse } from "next/server";

import { rateLimit } from "./kv";

export interface ApiErrorBody {
  error: string;
  code: string;
  details?: unknown;
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>({ error: message, code, details }, { status });
}

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json<T>(data, init);
}

/** Parses a JSON body with a hard size ceiling, so a public endpoint cannot
 * be used to make the function allocate unbounded memory. */
export async function readJsonBody<T>(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse<ApiErrorBody> }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      response: jsonError(413, "body_too_large", `Request body must be under ${maxBytes} bytes.`),
    };
  }

  const text = await request.text();
  if (text.length > maxBytes) {
    return {
      ok: false,
      response: jsonError(413, "body_too_large", `Request body must be under ${maxBytes} bytes.`),
    };
  }

  try {
    return { ok: true, body: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      response: jsonError(400, "invalid_json", "Request body must be valid JSON."),
    };
  }
}

export async function enforceRateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<NextResponse<ApiErrorBody> | null> {
  const result = await rateLimit(bucket, limit, windowSeconds);
  if (result.allowed) {
    return null;
  }
  return NextResponse.json<ApiErrorBody>(
    {
      error: `Too many requests. Try again in ${windowSeconds} seconds.`,
      code: "rate_limited",
      details: { used: result.used, limit: result.limit },
    },
    { status: 429, headers: { "Retry-After": String(windowSeconds) } },
  );
}
