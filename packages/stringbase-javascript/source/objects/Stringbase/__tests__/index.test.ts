// #region imports
    // #region external
    import Stringbase from '..';
    // #endregion external
// #endregion imports



// #region module
const getStringbase = async () => {
    const filepath = process.env.STRINGBASE_TEST_FILEPATH;
    const stringbase = new Stringbase({
        filepath,
    });
    await stringbase.initialize();

    return stringbase;
}


describe('Stringbase', () => {
    it(`simple`, async () => {
        const stringbase = await getStringbase();

        await stringbase.store(
            'one',
            'data',
        );

        const data = await stringbase.get('one');
        console.log('data', data);

        expect(true).toBeTruthy();
    });



    it.only(`simple`, async () => {
        const stringbase = await getStringbase();

        await stringbase.store(
            'records',
            {
                some: 'record',
            },
        );

        await stringbase.store(
            'records',
            {
                another: 'record',
            },
        );

        const data = await stringbase.get('records.another:record');
        console.log('data', data);

        expect(true).toBeTruthy();
    });
});
// #endregion module
