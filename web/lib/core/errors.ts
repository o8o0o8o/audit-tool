/** Error codes shared by MCP tools (§5 "Errors"), REST routes and the internal UI. */
export type CoreErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'forbidden_mode'
  | 'not_found'
  | 'invalid_input'
  | 'rate_limited'
  | 'audit_not_ready'
  | 'do_not_contact'
  | 'not_generated'
  | 'conflict'
  | 'stale_attempt';

const HTTP_STATUS: Record<CoreErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  forbidden_mode: 403,
  not_found: 404,
  invalid_input: 400,
  rate_limited: 429,
  audit_not_ready: 409,
  do_not_contact: 403,
  not_generated: 404,
  conflict: 409,
  stale_attempt: 409,
};

export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'CoreError';
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

/** JSON response for a route handler; unknown errors become 500 without detail. */
export function errorResponse(err: unknown): Response {
  if (err instanceof CoreError) return Response.json({ error: err.code, message: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: 'internal', message: 'internal error' }, { status: 500 });
}
