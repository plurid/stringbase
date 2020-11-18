// #region imports
    // #region external
    import Token from '../Token';

    import {
        Statement,
    } from '../Statement';
    // #endregion external
// #endregion imports



// #region module
export abstract class Expression {
    abstract accept<T>(
        visitor: Visitor<T>,
    ): T;
}


export interface Visitor<T> {
    visitLiteralExpression: (literalExpression: LiteralExpression) => T;
}


export class LiteralExpression extends Expression {
    public value: any;

    constructor(
        value: any,
    ) {
        super();

        this.value = value;
    }

    accept<T>(
        visitor: Visitor<T>,
    ) {
        return visitor.visitLiteralExpression(this);
    }
}


export class ASTPrinter implements Visitor<string> {
    public print(
        expresssion: Expression,
    ) {
        return expresssion.accept(this);
    }


    public visitLiteralExpression(
        literalExpression: LiteralExpression,
    ) {
        if (literalExpression.value == null) {
            return 'nil';
        }

        return literalExpression.value.toString();
    }


    private parenthesize(
        name: string,
        ...expressions: Expression[]
    ) {
        const builder: string[] = [];

        builder.push('(');
        builder.push(name);

        for (const expression of expressions) {
            builder.push(' ');
            builder.push(expression.accept(this));
        }

        builder.push(')');

        return builder.join('');
    }
}
// #endregion module
