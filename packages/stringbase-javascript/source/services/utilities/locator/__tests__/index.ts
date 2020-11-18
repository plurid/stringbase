// #region imports
    // #region external
    import {
        parseLocator,
    } from '../';
    // #endregion external
// #endregion imports



// #region module
describe('parseLocator', () => {
    it('simple', () => {
        const parsed = parseLocator('one');

        expect(parsed.length).toEqual(1);
    });
});
// #endregion module
