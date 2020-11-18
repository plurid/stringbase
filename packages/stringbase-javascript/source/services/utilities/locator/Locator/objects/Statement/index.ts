// #region imports
    // #region external
    import Token from '../Token';

    import {
        Expression,
    } from '../Expression';
    // #endregion external
// #endregion imports



// #region module
export abstract class Statement {
    abstract accept<T>(
        visitor: Visitor<T>,
    ): T;
}


export interface Visitor<T> {
    visitCollectionStatement: (collectionStatement: CollectionStatement) => T;
    visitDocumentStatement: (documentStatement: DocumentStatement) => T;
}


export class CollectionStatement extends Statement {
    public expression: Expression;

    constructor(
        expression: Expression,
    ) {
        super();

        this.expression = expression;
    }

    accept<T>(
        visitor: Visitor<T>,
    ) {
        return visitor.visitCollectionStatement(this);
    }
}


export class DocumentStatement extends Statement {
    public expression: Expression;

    constructor(
        expression: Expression,
    ) {
        super();

        this.expression = expression;
    }

    accept<T>(
        visitor: Visitor<T>,
    ) {
        return visitor.visitDocumentStatement(this);
    }
}
// #endregion module
