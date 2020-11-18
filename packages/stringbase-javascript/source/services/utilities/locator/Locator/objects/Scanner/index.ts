// #region imports
    // #region external
    // import {
    //     nonAlphanumericCharacters,
    // } from '../../data/constants';

    import {
        TokenType,
    } from '../../data/enumerations';

    import Token from '../Token';

    // import {
    //     inGroupClassify,
    // } from '../../utilities/general';
    // #endregion external


    // #region internal
    // #endregion internal
// #endregion imports



// #region module
class Scanner {
    private source: string;
    private tokens: Token[];
    private start: number = 0;
    private current: number = 0;
    private line: number = 1;
    private keywords: Record<string, TokenType>;
    private deonError: any;

    constructor(
        source: string,
        error: any,
    ) {
        this.source = source;
        this.tokens = [];
        this.deonError = error;

        this.keywords = {
        };
    }

    public scanTokens() {
        while (!this.isAtEnd()) {
            this.start = this.current;
            this.scanToken();
        }

        this.endScan();

        this.identify();

        return this.tokens;
    }


    private scanToken() {
        const character = this.advance();

        switch (character) {
            case '.':
                this.addToken(TokenType.DOT);
                break;
            case ':':
                this.addToken(TokenType.COLON);
                break;
            case '&':
                this.addToken(TokenType.AMPERSAND);
                break;
            case '|':
                this.addToken(TokenType.PIPE);
                break;
            case '!':
                this.addToken(TokenType.BANG);
                break;
            case '{':
                this.addToken(TokenType.LEFT_CURLY_BRACKET);
                break;
            case '}':
                this.addToken(TokenType.RIGHT_CURLY_BRACKET);
                break;
            // case '.':
            //     this.dot();
            //     break;
            case '/':
                this.slash();
                break;
            case '*':
                this.star();
                break;

            case ' ':
            case '\r':
            case '\t':
                // Ignore whitespace.
                break;

            // case '\'':
            //     this.singlelineString();
            //     break;
            // case '`':
            //     this.multilineString();
            //     break;
            case '\n':
                this.line++;
                break;

            default:
                this.signifier();
                break;
        }
    }


    private addToken(
        type: TokenType,
    ) {
        this.addTokenLiteral(type, null);
    }

    private addTokenLiteral(
        type: TokenType,
        literal: any,
    ) {
        const text = this.source.substring(this.start, this.current);

        const newToken = new Token(
            type,
            text,
            literal,
            this.line,
        );

        this.tokens.push(newToken);
    }

    private dot() {
        if (this.match('.')) {
            if (this.match('.')) {
                if (this.match('#')) {
                } else {
                    this.deonError(this.line, 'Can only spread leaflinks.');
                }
            } else {
                this.signifier();
            }
        } else {
            this.signifier();
        }
    }

    private slash() {
        if (this.match('/')) {
            // A comment goes until the end of the line.
            while (this.peek() !== '\n' && !this.isAtEnd()) {
                this.advance();
            }
        } else if (this.match('*')) {
            // A multline comment goes until starslash (*/).
            while (this.peek() !== '*' && !this.isAtEnd()) {
                this.advance();
            }
        } else {
            this.signifier();
        }
    }

    private star() {
        if (this.match('/')) {
            // End of multiline comment.
            this.advance();
        }
    }

    private signifier() {
        // while (
        //     this.isAlphaNumeric(this.peek())
        //     && !this.isAtEnd()
        // ) {
        //     this.advance();
        // }

        // // See if the signifier is a reserved word.
        // const text = this.source.substring(this.start, this.current);
        // let type = this.keywords[text];

        // if (!type) {
        //     type = TokenType.SIGNIFIER;
        // }

        // switch (type) {
        //     case TokenType.IMPORT: {
        //         const inGroup = this.inGroup(this.tokens.length - 1);

        //         if (
        //             inGroup
        //             && inGroup !== 'LEAFLINK'
        //         ) {
        //             type = TokenType.SIGNIFIER;
        //             break;
        //         }

        //         break;
        //     }
        //     case TokenType.INJECT: {
        //         const inGroup = this.inGroup(this.tokens.length - 1);

        //         if (
        //             inGroup
        //             && inGroup !== 'LEAFLINK'
        //         ) {
        //             type = TokenType.SIGNIFIER;
        //             break;
        //         }

        //         break;
        //     }
        //     case TokenType.FROM: {
        //         const inGroup = this.inGroup(this.tokens.length - 1);

        //         if (
        //             inGroup
        //             && inGroup !== 'LEAFLINK'
        //         ) {
        //             type = TokenType.SIGNIFIER;
        //             break;
        //         }

        //         break;
        //     }
        //     case TokenType.WITH: {
        //         const inGroup = this.inGroup(this.tokens.length - 1);

        //         if (
        //             inGroup
        //             && inGroup !== 'LEAFLINK'
        //         ) {
        //             type = TokenType.SIGNIFIER;
        //             break;
        //         }

        //         break;
        //     }
        // }

        // this.addToken(type);
    }

    private endScan() {
        const endOfFile = new Token(
            TokenType.EOF,
            '',
            null,
            this.line,
        );

        this.tokens.push(endOfFile);
    }

    private identify() {
        // const identifier = new Identifier(this.tokens);
        // const tokens = identifier.identify();

        // this.tokens = [
        //     // ...tokens,
        // ];
    }



    // Utilities
    private advance() {
        this.current += 1;
        return this.source.charAt(this.current - 1);
    }

    private advanceEscaped() {
        this.current += 2;
        return this.source.charAt(this.current - 1);
    }

    private match(
        expected: string,
    ) {
        if (this.isAtEnd()) {
            return false;
        }

        if (this.source.charAt(this.current) !== expected) {
            return false;
        }

        this.current += 1;
        return true;
    }

    private peek() {
        if (this.isAtEnd()) {
            return '\0';
        }

        return this.source.charAt(this.current);
    }

    private isAlpha(
        c: string,
    ) {
        return (c >= 'a' && c <= 'z')
            || (c >= 'A' && c <= 'Z')
            || c === '_'
            || c === '-'
            || c === '.'
            || c === '/'
            || c === '['
            || c === ']'
            || c === '$'
            || c === ':';
    }

    private isDigit(
        character: string,
    ) {
        return character >= '0' && character <= '9';
    }

    private isAlphaNumeric(
        c: string,
    ) {
        return false;
        // return !nonAlphanumericCharacters.includes(c);
    }

    private isAtEnd() {
        return this.current >= this.source.length;
    }

    private inGroup(
        position: number,
    ) {
        const tokens = this.tokens
            .slice(0, position)
            .reverse();

        return '';
        // return inGroupClassify(
        //     tokens,
        // );
    }
}
// #endregion module



// #region exports
export default Scanner;
// #endregion exports
