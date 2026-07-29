import type { TaskError, TaskErrorCode, TaskStatus } from "../api/types.js";

export class EnhancerError extends Error {
  readonly code: TaskErrorCode;
  readonly recoverable: boolean;
  readonly stage: TaskStatus | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: TaskErrorCode,
    message: string,
    options: {
      recoverable?: boolean;
      stage?: TaskStatus;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "EnhancerError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
    this.stage = options.stage;
    this.details = options.details;
  }

  toTaskError(): TaskError {
    return {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      ...(this.stage === undefined ? {} : { stage: this.stage }),
      ...(this.details === undefined ? {} : { details: this.details })
    };
  }
}

export function normalizeError(
  error: unknown,
  fallbackCode: TaskErrorCode = "INTERNAL_ERROR",
  stage?: TaskStatus
): EnhancerError {
  if (error instanceof EnhancerError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new EnhancerError(fallbackCode, message || "Unexpected internal error", {
    ...(stage === undefined ? {} : { stage }),
    cause: error
  });
}

export function taskErrorToException(error: TaskError): EnhancerError {
  return new EnhancerError(error.code, error.message, {
    recoverable: error.recoverable,
    ...(error.stage === undefined ? {} : { stage: error.stage }),
    ...(error.details === undefined ? {} : { details: error.details })
  });
}
