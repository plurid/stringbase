// #region imports
    // #region internal
    import Locator from './Locator';
    // #endregion internal
// #endregion imports



// #region module
const parseLocator = (
    value: string,
) => {
    const locator = new Locator();
    const data = locator.parse(value);

    return data;
}
// #endregion module



// #region exports
export {
    parseLocator,
};
// #endregion exports
