// #region imports
    // #region external
    import Stringbase from '../';
    // #endregion external
// #endregion imports



// #region module
describe('Stringbase', async () => {
    const filepath = process.env.STRINGBASE_TEST_FILEPATH;
    const stringbase = new Stringbase({
        filepath,
    });
    await stringbase.initialize();

    it(`simple`, async () => {
        await stringbase.store(
            'one',
            'data',
        );

        const data = await stringbase.get('one');
        console.log('data', data);
    });
});
// #endregion module
