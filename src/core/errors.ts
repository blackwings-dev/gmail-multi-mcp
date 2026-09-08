/**
 * The error taxonomy for the whole server, and the translation from Google's
 * HTTP failures into it.
 *
 * This lives in `core/` rather than under `gmail/` because Drive and Calendar
 * fail in exactly the same ways and must be actionable in exactly the same
 * terms. `gmail/types.ts` re-exports it so nothing that already imported it
 * from there had to change.
 *
 * The class name still says "Gmail" — see the renaming note in the README.
 */

/** An account is identified by its email address. It is the primary key everywhere. */
export type AccountId = string;

export type GmailMcpErrorCode =
  | 'NO_CREDENTIALS'
  | 'NO_ACCOUNTS'
  | 'UNKNOWN_ACCOUNT'
  | 'NOT_AUTHORIZED'
  /** The account is authorised, but not for the API being called. Needs re-consent. */
  | 'MISSING_SCOPE'
  | 'TOKEN_REFRESH_FAILED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'API_ERROR';

/**
 * A failure that is safe and useful to show the model.
 *
 * Anything thrown as `GmailMcpError` is rendered as a tool error with its
 * message intact; anything else is reported generically, so unexpected
 * internals never leak into a response.
 */
export class GmailMcpError extends Error {
  readonly code: GmailMcpErrorCode;
  readonly account?: AccountId;

  constructor(code: GmailMcpErrorCode, message: string, account?: AccountId) {
    super(message);
    this.name = 'GmailMcpError';
    this.code = code;
    if (account !== undefined) this.account = account;
  }
}

interface HttpishError {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  response?: { status?: unknown; data?: unknown };
}

function statusOf(error: HttpishError): number | undefined {
  if (typeof error?.response?.status === 'number') return error.response.status;
  if (typeof error?.status === 'number') return error.status;
  if (typeof error?.code === 'number') return error.code;
  return undefined;
}

/**
 * Turns a Gaxios/Google failure into something an agent can act on.
 *
 * The distinction that matters is 401/403 (re-authorise) versus 429/5xx (retry
 * later) versus 404 (the id is wrong): an agent that cannot tell them apart
 * will retry the one case that will never succeed.
 *
 * `service` is the human name of the API — "Gmail", "Drive", "Calendar" — so
 * the message says which one refused, which matters now that one account can
 * be authorised for some of them and not others.
 */
export function mapGoogleError(
  error: unknown,
  service: string,
  account?: AccountId,
): GmailMcpError {
  if (error instanceof GmailMcpError) return error;

  const e = error as HttpishError;
  const status = statusOf(e);
  const detail = typeof e?.message === 'string' ? e.message : String(error);

  switch (status) {
    case 401:
      return new GmailMcpError(
        'NOT_AUTHORIZED',
        `${service} rejected the credentials for ${account ?? 'this account'}. ` +
          `The refresh token may have been revoked — re-run "gmail-multi-mcp setup".`,
        account,
      );
    case 403:
      return new GmailMcpError(
        'NOT_AUTHORIZED',
        `Access denied by ${service}: ${detail}. This is usually a missing scope or a ` +
          `disabled ${service} API in the Google Cloud project.`,
        account,
      );
    case 404:
      return new GmailMcpError('NOT_FOUND', `Not found: ${detail}`, account);
    case 429:
      return new GmailMcpError(
        'RATE_LIMITED',
        `${service} rate limit hit for ${account ?? 'this account'}. Wait and retry.`,
        account,
      );
    default:
      if (typeof status === 'number' && status >= 500) {
        return new GmailMcpError(
          'API_ERROR',
          `${service} is failing (HTTP ${status}): ${detail}. This is transient; retry.`,
          account,
        );
      }
      return new GmailMcpError('API_ERROR', detail, account);
  }
}
