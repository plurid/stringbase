// #region imports
    // #region libraries
    import os from 'os';
    import path from 'path';
    // #endregion libraries
// #endregion imports



// #region module
const homeDirectory = os.homedir();

const STRINGBASE_DEFAULT_NAME = '.stringbase';
const STRINGBASE_DEFAULT_DEON_NAME = STRINGBASE_DEFAULT_NAME + '.deon';
const stringbaseDefaultPath = path.join(
    homeDirectory,
    STRINGBASE_DEFAULT_DEON_NAME,
);
// #endregion module



// #region exports
export {
    homeDirectory,

    STRINGBASE_DEFAULT_NAME,
    STRINGBASE_DEFAULT_DEON_NAME,
    stringbaseDefaultPath,
};
// #endregion exports
