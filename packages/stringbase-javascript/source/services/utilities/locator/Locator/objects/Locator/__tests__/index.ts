// #region imports
    // #region external
    import {
        LocatorCollection,
        LocatorDocument,
    } from '#data/interfaces';

    import Locator from '../';
    // #endregion external
// #endregion imports



// #region module
describe('parseLocator', () => {
    it.only('collection', () => {
        const location = 'one';
        const locator = new Locator();
        const data = locator.parse(location);

        expect(data.length).toEqual(1);

        expect(data[0].type).toEqual('collection');
        expect(data[0].value).toEqual('one');
    });



    it('collection document', () => {
        const location = 'one.id:two';
        const locator = new Locator();
        const data = locator.parse(location);

        expect(data.length).toEqual(2);

        expect(data[0].type).toEqual('collection');
        expect(data[0].value).toEqual('one');

        expect(data[1].type).toEqual('document');
        expect((data[1] as LocatorDocument).key).toEqual('id');
        expect(data[1].value).toEqual('two');
    });



    it('collection document collection', () => {
        const location = 'one.id:two.three';
        const locator = new Locator();
        const data = locator.parse(location);

        expect(data.length).toEqual(3);

        expect(data[0].type).toEqual('collection');
        expect(data[0].value).toEqual('one');

        expect(data[1].type).toEqual('document');
        expect((data[1] as LocatorDocument).key).toEqual('id');
        expect(data[1].value).toEqual('two');

        expect(data[2].type).toEqual('collection');
        expect(data[2].value).toEqual('three');
    });
});
// #endregion module
