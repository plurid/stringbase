import type { PathSegment, Query, QueryIR } from '@plurid/loque';

export type Value = string | readonly Value[] | { readonly [key: string]: Value };
export type Fields = { readonly [key: string]: Value };
export interface Document extends Fields { readonly id: string }
export type DatabaseData = Readonly<Record<string, readonly Document[]>>;
export interface StringbaseOptions {
    readonly filepath: string;
    readonly mode?: 'readwrite' | 'readonly';
    readonly maxFileBytes?: number;
}
export type QueryInput = Query | QueryIR;
export interface QueryOptions { readonly view?: 'raw' | 'typed' }
export interface ReadOptions extends QueryOptions {
    readonly sort?: { readonly path: readonly PathSegment[]; readonly direction?: 'asc' | 'desc' };
    readonly skip?: number;
    readonly limit?: number;
}
export interface UpdateResult {
    readonly matchedCount: number;
    readonly modifiedCount: number;
    readonly ids: readonly string[];
}
export interface DeleteResult { readonly deletedCount: number; readonly ids: readonly string[] }

export type BatchOperation =
    | { readonly op: 'createCollection' | 'dropCollection'; readonly collection: string }
    | { readonly op: 'insertOne'; readonly collection: string; readonly document: Fields }
    | { readonly op: 'insertMany'; readonly collection: string; readonly documents: readonly Fields[] }
    | { readonly op: 'updateOne' | 'replaceOne'; readonly collection: string; readonly id: string; readonly fields: Fields }
    | { readonly op: 'deleteOne'; readonly collection: string; readonly id: string }
    | { readonly op: 'updateMany'; readonly collection: string; readonly query: QueryIR; readonly fields: Fields; readonly view?: 'raw' | 'typed' }
    | { readonly op: 'deleteMany'; readonly collection: string; readonly query: QueryIR; readonly view?: 'raw' | 'typed' };
export interface BatchPayload { readonly version: 1; readonly operations: readonly BatchOperation[] }
