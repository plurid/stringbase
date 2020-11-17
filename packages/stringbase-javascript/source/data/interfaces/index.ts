// #region module
export interface StringbaseOptions {
    /**
     * The path to the `.deon` file containing the `stringbase` data.
     */
    filepath: string;

    /**
     * The caching strategy.
     *
     * + `'in-memory-session'` caches only new entries;
     * + `'in-memory-all'` caches all at start;
     * + `none` caches nothing.
     *
     * Default: `'in-memory-all'`
     */
    cache: 'in-memory-session' | 'in-memory-all' | 'none';

    /**
     * A `deon` typer function.
     */
    typer?: <T>(data: any) => T;
}


export interface LocatorDocument {
    type: 'document',
    key: string,
    value: string,
}

export interface LocatorCollection {
    type: 'collection',
    value: string,
}

export type Locator = LocatorDocument | LocatorCollection;
// #endregion module
