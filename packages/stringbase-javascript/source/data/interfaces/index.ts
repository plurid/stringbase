// #region module
export interface StringbaseOptions {
    /**
     * The path to the `.deon` file containing the `stringbase` data.
     */
    filepath: string;

    /**
     * A `deon` typer function.
     */
    typer?: <T>(data: any) => T;
}
// #endregion module
