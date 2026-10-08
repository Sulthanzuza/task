import { ERROR_CODES, type ErrorCode } from '@tm/shared';

/** Every error the API answers with. The handler turns these into the documented body shape. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly expose = true;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request did not pass validation.', details?: unknown) {
    super(400, ERROR_CODES.VALIDATION_FAILED, message, details);
    this.name = 'ValidationError';
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Sign in to continue.') {
    super(401, ERROR_CODES.UNAUTHENTICATED, message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to that.') {
    super(403, ERROR_CODES.FORBIDDEN, message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'That') {
    super(404, ERROR_CODES.NOT_FOUND, what + ' was not found.');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, ERROR_CODES.CONFLICT, message, details);
    this.name = 'ConflictError';
  }
}

/** A status change the workflow table refuses. 409, because the task is in the wrong state. */
export class InvalidTransitionError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, ERROR_CODES.INVALID_TRANSITION, message, details);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * The task moved while somebody was reading a confirmation dialog.
 *
 * Distinct from InvalidTransitionError because the two need different
 * answers: an invalid transition is a mistake to explain, while this one is
 * nobody's mistake and the client should refresh and show what happened.
 * 409, and the details carry enough to say who and what.
 */
export class TaskChangedError extends AppError {
  constructor(message: string, details: { currentStatus: string; byName: string | null }) {
    super(409, ERROR_CODES.TASK_CHANGED, message, details);
    this.name = 'TaskChangedError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'That file is too large.') {
    super(413, ERROR_CODES.PAYLOAD_TOO_LARGE, message);
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'That file type is not allowed.') {
    super(415, ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message);
    this.name = 'UnsupportedMediaTypeError';
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
