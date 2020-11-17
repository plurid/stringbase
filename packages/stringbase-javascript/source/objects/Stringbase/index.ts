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
    private unstored: Map<any, any> = new Map();


    constructor(
        options?: Partial<StringbaseOptions>,
    ) {
        this.options = this.resolveOptions(
            options,
        );
    }


    public async initialize() {
    }

    public async get(
        entity: string,
    ) {
        return this.unstored;
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
        options?: Partial<StringbaseOptions>,
    ) {
        const resolvedOptions: StringbaseOptions = {
            ...options,
            filepath: options?.filepath || stringbaseDefaultPath,
        };

        return resolvedOptions;
    }

    private storeBatch(
        entity: string,
        data: any,
    ) {
        const current = this.unstored.get(entity);

        if (!current) {
            // add new data
            this.unstored.set(
                entity,
                data,
            );
            return;
        }

        // merge data
        const update = [
            current,
            data,
        ];
        this.unstored.set(
            entity,
            update,
        );
    }

    private recordBatch() {

    }
}
// #endregion module



// #region exports
export default Stringbase;
// #endregion exports
