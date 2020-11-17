// #region imports
    import {
        StringbaseOptions,
    } from '#data/interfaces';
// #endregion imports



// #region module
class Stringbase {
    private options: StringbaseOptions;


    constructor(
        options: Partial<StringbaseOptions>,
    ) {
        this.options = options;
    }


    public store(
        entity: string,
        data: any,
    ) {

    }
}
// #endregion module



// #region exports
export default Stringbase;
// #endregion exports
