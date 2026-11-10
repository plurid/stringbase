import { isDeepStrictEqual } from 'node:util';

const writable = new Set(['description', 'category', 'tags', 'attributes']);

/** Reference host transaction. A real connector must perform these checks atomically in its database. */
export function publishReviewedChanges(source, exported, nextSourceRevision) {
    if (source.revision !== exported.sourceRevision) throw new Error('Source revision changed; import fresh data and obtain a new approval.');
    const products = structuredClone(source.products);
    const seen = new Set();
    for (const change of exported.changes) {
        if (change.collection !== 'products' || !writable.has(change.field)) throw new Error('Export contains a protected field.');
        const key = JSON.stringify([change.id, change.field]);
        if (seen.has(key)) throw new Error('Export contains duplicate changes.');
        seen.add(key);
        const product = products.find(product => product.id === change.id);
        if (!product) throw new Error('Source product disappeared.');
        const hasBefore = Object.hasOwn(change, 'before');
        if (hasBefore !== Object.hasOwn(product, change.field) || (hasBefore && !isDeepStrictEqual(product[change.field], structuredClone(change.before)))) throw new Error('Source field changed; nothing was published.');
        if (Object.hasOwn(change, 'after')) product[change.field] = structuredClone(change.after);
        else delete product[change.field];
    }
    return { ...source, products, revision: nextSourceRevision };
}
