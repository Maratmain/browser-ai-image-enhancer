export class EnhancerError extends Error {
    code;
    recoverable;
    stage;
    details;
    constructor(code, message, options = {}) {
        super(message, { cause: options.cause });
        this.name = "EnhancerError";
        this.code = code;
        this.recoverable = options.recoverable ?? false;
        this.stage = options.stage;
        this.details = options.details;
    }
    toTaskError() {
        return {
            code: this.code,
            message: this.message,
            recoverable: this.recoverable,
            ...(this.stage === undefined ? {} : { stage: this.stage }),
            ...(this.details === undefined ? {} : { details: this.details })
        };
    }
}
export function normalizeError(error, fallbackCode = "INTERNAL_ERROR", stage) {
    if (error instanceof EnhancerError) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new EnhancerError(fallbackCode, message || "Unexpected internal error", {
        ...(stage === undefined ? {} : { stage }),
        cause: error
    });
}
export function taskErrorToException(error) {
    return new EnhancerError(error.code, error.message, {
        recoverable: error.recoverable,
        ...(error.stage === undefined ? {} : { stage: error.stage }),
        ...(error.details === undefined ? {} : { details: error.details })
    });
}
