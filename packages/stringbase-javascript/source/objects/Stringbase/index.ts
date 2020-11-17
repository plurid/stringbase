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
    private unstored: WeakMap<any, any> = new WeakMap();


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
        this.storeBatch(
            entity,
            data,
        );
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

    private storeBatch(
        entity: string,
        data: any,
    ) {
        const current = this.unstored[entity];

        if (!current) {
            // add new data
        }

        // merge data
    }
}
// #endregion module



// #region exports
export default Stringbase;
// #endregion exports
