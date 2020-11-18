// #region imports
    // #region external
    import {
        LocatorCollection,
        LocatorDocument,
    } from '#data/interfaces';

    import {
        parseLocator,
    } from '../';
    // #endregion external
// #endregion imports



// #region module
describe('parseLocator', () => {
    it('collection', () => {
        const parsed = parseLocator('one');

        expect(parsed.length).toEqual(1);

        expect(parsed[0].type).toEqual('collection');
        expect(parsed[0].value).toEqual('one');
    });



    it('collection document', () => {
        const parsed = parseLocator('one.id:two');

        expect(parsed.length).toEqual(2);

        expect(parsed[0].type).toEqual('collection');
        expect(parsed[0].value).toEqual('one');

        expect(parsed[1].type).toEqual('document');
        expect((parsed[1] as LocatorDocument).key).toEqual('id');
        expect(parsed[1].value).toEqual('two');
    });



    it('collection document collection', () => {
        const parsed = parseLocator('one.id:two.three');

        expect(parsed.length).toEqual(3);

        expect(parsed[0].type).toEqual('collection');
        expect(parsed[0].value).toEqual('one');

        expect(parsed[1].type).toEqual('document');
        expect((parsed[1] as LocatorDocument).key).toEqual('id');
        expect(parsed[1].value).toEqual('two');

        expect(parsed[2].type).toEqual('collection');
        expect(parsed[2].value).toEqual('three');
    });
});
// #endregion module
