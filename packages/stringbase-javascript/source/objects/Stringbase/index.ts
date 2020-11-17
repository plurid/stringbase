// #region imports
    // #region external
    import {
        StringbaseOptions,
    } from '#data/interfaces';

    import {
        stringbaseDefaultPath,
    } from '#data/constants';

    import * as optionsLogic from '#services/logic/options';
    // #endregion external
// #endregion imports



// #region module
class Stringbase {
    private options: StringbaseOptions;


    constructor(
        options: Partial<StringbaseOptions>,
    ) {
        this.options = this.resolveOptions(
            options,
        );
    }


    public async initialize() {

    }

    public async store(
        entity: string,
        data: any,
    ) {

    }

    public async obliterate(
        entity: string,
        field: string,
        value: any,
    ) {

    }


    private resolveOptions(
        options: Partial<StringbaseOptions>,
    ) {
        const resolvedOptions: StringbaseOptions = {
            ...options,
            filepath: options.filepath || stringbaseDefaultPath,
        };

        return resolvedOptions;
    }
}
// #endregion module



// #region exports
export default Stringbase;
// #endregion exports
