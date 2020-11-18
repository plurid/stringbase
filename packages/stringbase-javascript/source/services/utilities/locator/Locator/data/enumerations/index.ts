// #region module
export enum TokenType {
    // Single-character tokens.
    DOT, COLON, AMPERSAND, PIPE, BANG,
    LEFT_CURLY_BRACKET, RIGHT_CURLY_BRACKET,
    LESS_THAN, GREATER_THAN,


    // Entities.
    COLLECTION,
    DOCUMENT,
    CURSOR,
    KEY,
    VALUE,


    EOF,
}
// #endregion module
