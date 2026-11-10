export { Stringbase as default, Stringbase } from './database';
export type { Collection, Transaction, TransactionCollection } from './database';
export { StringbaseError } from './errors';
export type { ErrorCode } from './errors';
export { parseLocator } from './locator';
export { applyBatch, validateBatch } from './batch';
export type * from './types';
export { query, fromIR, current, field, literal, eq, ne, lt, lte, gt, gte, isIn, exists, and, or, not } from '@plurid/loque';
export type { Query, QueryIR, PredicateIR, PathSegment } from '@plurid/loque';
