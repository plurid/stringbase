// #region imports
    // #region external
    import {
        Locator,
        LocatorDocument,
        LocatorCollection,
    } from '#data/interfaces';
    // #endregion external
// #endregion imports



// #region module
const parseLocator = (
    value: string,
) => {
    const elements = value.split('.');

    const locator: Locator[] = [];

    for (const element of elements) {
        if (element.includes(':')) {
            const split = element.split(':');
            const key = split[0];
            const value = split[1];

            const data: LocatorDocument = {
                type: 'document',
                key,
                value,
            };
            locator.push(data);

            continue;
        }

        const data: LocatorCollection = {
            type: 'collection',
            value: element,
        };
        locator.push(data);
    }

    return locator;
}
// #endregion module



// #region exports
export {
    parseLocator,
};
// #endregion exports
