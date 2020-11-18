// #region imports
    // #region external
    import * as Expression from '../Expression';
    import * as Statement from '../Statement';
    import Interpreter from '../Interpreter';
    import Token from '../Token';
    // #endregion external
// #endregion imports



// #region module
class Resolver implements Expression.Visitor<any>, Statement.Visitor<any> {
    private interpreter: Interpreter;
    private scopes: Map<string, boolean>[] = [];
    private deonError: any;

    constructor(
        interpeter: Interpreter,
        error: any,
    ) {
        this.deonError = error;
        this.interpreter = interpeter;
    }


    public visitCollectionStatement(
        statement: Statement.CollectionStatement,
    ) {
        // this.beginScope();

        // // this.resolve(
        // //     statement.statements,
        // // );

        // this.endScope();

        return null;
    }

    public visitDocumentStatement(
        statement: Statement.DocumentStatement,
    ) {
        // this.beginScope();

        // // this.resolve(
        // //     statement.statements,
        // // );

        // this.endScope();

        return null;
    }

    // public visitMapStatement(
    //     statement: Statement.MapStatement,
    // ) {
    //     this.beginScope();

    //     // this.resolve(
    //     //     statement.statements,
    //     // );

    //     this.endScope();

    //     return null;
    // }

    // public visitListStatement(
    //     statement: Statement.ListStatement,
    // ) {
    //     this.beginScope();

    //     // this.resolve(
    //     //     statement.statements,
    //     // );

    //     this.endScope();

    //     return null;
    // }




    // public visitExpressionStatement(
    //     statement: Statement.ExpressionStatement,
    // ) {
    //     this.resolveExpression(statement.expression);
    //     return null;
    // }

    public visitLiteralExpression(
        expression: Expression.LiteralExpression,
    ) {
        return null;
    }



    public async resolve(
        statements: Statement.Statement[],
    ) {
        const orderedStatements = this.orderStatements(statements);
        console.log('orderedStatements', orderedStatements);

        for (const statement of orderedStatements) {
            this.resolveStatement(statement);
        }
    }

    public resolveStatement(
        statement: Statement.Statement,
    ) {
        statement.accept(this);
    }

    public resolveExpression(
        expression: Expression.Expression,
    ) {
        expression.accept(this);
    }



    private beginScope() {
        this.scopes.push(
            new Map(),
        );
    }

    private endScope() {
        this.scopes.pop();
    }

    private declare(
        name: Token,
    ) {
        if (
            this.scopes.length === 0
        ) {
            return;
        }

        const lastScopeIndex = this.scopes.length - 1;

        const scope = this.scopes[lastScopeIndex];

        if (scope.has(name.lexeme)) {
            this.deonError(
                name,
                'Variable with this name already declared in this scope.',
            );
        }

        scope.set(
            name.lexeme,
            false,
        );
        this.scopes[lastScopeIndex] = new Map(scope);
    }

    private define(
        name: Token,
    ) {
        if (
            this.scopes.length === 0
        ) {
            return;
        }

        const lastScopeIndex = this.scopes.length - 1;

        const scope = this.scopes[lastScopeIndex];
        scope.set(
            name.lexeme,
            true,
        );
        this.scopes[lastScopeIndex] = new Map(scope);
    }

    private resolveLocal(
        expression: Expression.Expression,
        name: Token,
    ) {
        for (const [key, scope] of this.scopes.entries()) {
            if (scope.has(name.lexeme)) {
                this.interpreter.resolve(
                    expression,
                    this.scopes.length - 1 - key,
                );
            }
        }

        // Not found. Assume it is global.
    }

    private orderStatements(
        statements: Statement.Statement[],
    ) {
        return statements;
    }
}
// #endregion module



// #region exports
export default Resolver;
// #endregion exports
