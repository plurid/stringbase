// #region imports
    // #region internal
    import Extractor from './Extractor';
    // #endregion internal
// #endregion imports



// #region module
const handleExtraction = (
    data: any,
    locator: any,
) => {
    const extractor = new Extractor(
        data,
        locator,
    );
    const result = extractor.extract();

    return result;
}
// #endregion module



// #region exports
export {
    handleExtraction,
};
// #endregion exports
