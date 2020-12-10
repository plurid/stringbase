// #region imports
    // #region libraries
    import ttypescript from 'ttypescript';
    import commonjs from '@rollup/plugin-commonjs';
    import typescript from 'rollup-plugin-typescript2';
    import json from '@rollup/plugin-json';
    // #endregion libraries


    // #region external
    import pkg from '../package.json';
    // #endregion external
// #endregion imports



// #region module
const common = {
    plugins: [
        json(),
        typescript({
            typescript: ttypescript,
            useTsconfigDeclarationDir: true,
            tsconfig: './tsconfig.json',
        }),
        commonjs(),
    ]
};


const cli = {
    input: './source/index.ts',
    output: [
        {
            file: pkg.main,
            format: 'cjs',
            exports: 'named',
        },
    ],
    external: [
        'os',
        'path',
        'commander',
        '@plurid/deon',
        '@plurid/loque',
    ],
    plugins: [
        ...common.plugins,
    ],
};
// #endregion module



// #region exports
export default [
    cli,
];
// #endregion exports
