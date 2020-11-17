// #region imports
    // #region external
    import {
        StringbaseOptions,
    } from '#data/interfaces';

    import {
        stringbaseDefaultPath,
    } from '#data/constants';

    import * as optionsLogic from '#services/logic/options';

    import {
        parseLocator,
    } from '#services/utilities/locator';
    // #endregion external
// #endregion imports



// #region module
class Stringbase {
    // storing add the data to the unstored map
    // periodically, the unstored map is saved to file
    // obliterating adds the entity to destored
    // periodically, the destored is cleared from the file

    private options: StringbaseOptions;
    private unstored: Map<any, any> = new Map();
    private destored: Map<any, any> = new Map();
    private cache: Map<any, any> = new Map();


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
        locator: string,
    ) {
        const parsedLocator = parseLocator(locator);
        console.log('parsedLocator', parsedLocator);

        return this.unstored;
    }

    public async store(
        locator: string,
        data: any,
    ) {
        this.storeBatch(
            locator,
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
            cache: options?.cache || 'in-memory-all',
        };

        return resolvedOptions;
    }

    private storeBatch(
        locator: string,
        data: any,
    ) {
        const current = this.unstored.get(locator);

        if (!current) {
            // add new data
            this.unstored.set(
                locator,
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
            locator,
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
