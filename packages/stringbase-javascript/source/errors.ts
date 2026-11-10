export type ErrorCode =
    | 'INVALID_OPTIONS' | 'INVALID_DATA' | 'INVALID_QUERY' | 'INVALID_LOCATOR'
    | 'FILE_NOT_FOUND' | 'FILE_EXISTS' | 'FILE_FORMAT' | 'IO' | 'LOCKED' | 'CONFLICT'
    | 'READ_ONLY' | 'CLOSED' | 'COLLECTION_EXISTS' | 'COLLECTION_NOT_FOUND'
    | 'DUPLICATE_ID' | 'BATCH_FAILED' | 'LIMIT_EXCEEDED' | 'COMMIT_UNCERTAIN'
    | 'CAPABILITY_DENIED' | 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE';

export class StringbaseError extends Error {
    readonly code: `STRINGBASE_${ErrorCode}`;
    constructor(code: ErrorCode, message: string, readonly details: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'StringbaseError';
        this.code = `STRINGBASE_${code}`;
    }
}

export function fail(code: ErrorCode, message: string, details: Record<string, unknown> = {}): never {
    throw new StringbaseError(code, message, details);
}

export function hasCode(error: unknown, code: string): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

export function io(error: unknown, filepath: string): StringbaseError {
    if (error instanceof StringbaseError) return error;
    return new StringbaseError(hasCode(error, 'ENOENT') ? 'FILE_NOT_FOUND' : 'IO',
        `Unable to access '${filepath}'.`, { filepath }, error);
}
