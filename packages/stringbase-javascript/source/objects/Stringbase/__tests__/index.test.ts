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

        await stringbase.write(
            'one',
            'data',
        );

        const data = await stringbase.read('one');
        console.log('data', data);

        expect(true).toBeTruthy();
    });



    it(`simple`, async () => {
        const stringbase = await getStringbase();

        await stringbase.write(
            'records',
            {
                some: 'record',
            },
        );

        await stringbase.write(
            'records',
            {
                another: 'record',
            },
        );

        const data = await stringbase.read('records.another:record');

        expect(data.another).toEqual('record');
    });



    it(`simple`, async () => {
        const stringbase = await getStringbase();

        await stringbase.write(
            'records',
            {
                some: 'record',
            },
        );

        await stringbase.write(
            'records.some:record.comments',
            {
                value: 'comment',
                another: 'value',
            },
        );

        const data = await stringbase.read('records.some:record.comments.value:comment');
        console.log('data', data);

        // expect(data.another).toEqual('value');
    });


    it.only(`simple`, async () => {
        const stringbase = await getStringbase();

        const data = await stringbase.read(`
            records
                . some:record
                    . comments
                        . value:comment
        `);
        console.log('data', data);

        const data2 = await stringbase.read(`
            records
            . {
                notifyAt
                .events
                .login
            } : true
        `);
        console.log('data2', data2);

        // expect(data.another).toEqual('value');
    });
});
// #endregion module
