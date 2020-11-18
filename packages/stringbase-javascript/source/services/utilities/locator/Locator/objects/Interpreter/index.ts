// #region imports
    // #region external
    import Locator from '../Locator';
    import * as Expression from '../Expression';
    import * as Statement from '../Statement';
    import Environment from '../Environment';
    import Token from '../Token';
    // #endregion external
// #endregion imports



// #region module
class Interpreter implements Expression.Visitor<any>, Statement.Visitor<any> {
    public globals: Environment = new Environment();
    public locals: Map<Expression.Expression, number> = new Map();
    private environment: Environment = this.globals;
    private leaflinks: Environment = new Environment();
    private rootEnvironment: Environment = new Environment();
    private rootKind = 'map';


    public interpret(
        statements: (Statement.Statement | Expression.Expression)[],
    ) {
        // try {
        //     let rootStatement;

        //     for (const statement of statements) {
        //         if (statement instanceof Statement.RootStatement) {
        //             rootStatement = statement;
        //         }
        //     }

        //     this.resolveRoot(rootStatement);

        //     return this.extract();
        // } catch (error) {
        //     return;
        // }
    }

    public execute(
        statement: Statement.Statement,
    ) {
        // if (statement instanceof Statement.ImportStatement) {
        //     await this.visitImportStatementAsynchronous(statement);
        //     return;
        // }

        // if (statement instanceof Statement.InjectStatement) {
        //     await this.visitInjectStatementAsynchronous(statement);
        //     return;
        // }

        // const value: any = await statement.accept(this);
        // return value;
    }

    public resolve(
        expression: Expression.Expression,
        depth: number,
    ) {
        this.locals.set(
            expression,
            depth,
        );
    }

    private extractFromValues(
        values: any,
    ) {
        let obj: any = {}

        for (const [key, value] of values) {
            if (value instanceof Environment) {
                const envValues = value.getAll();
                const keyValue = this.extractFromValues(envValues);
                obj[key] = keyValue;
            } else {
                obj[key] = value;
            }
        }

        return obj;
    }

    public extract() {
        const obj: any = this.rootKind === 'map' ? {} : [];

        const values = this.rootEnvironment.getAll();

        for (const [key, value] of values) {
            if (value instanceof Environment) {
                const envValues = value.getAll();
                obj[key] = this.extractFromValues(envValues);
            } else {
                obj[key] = value;
            }
        }

        return obj;
    }



    /** STATEMENTS */
    public visitCollectionStatement(
        statement: Statement.CollectionStatement,
    ) {
        // this.evaluate(statement.expression);

        return null;
    }

    public visitDocumentStatement(
        statement: Statement.DocumentStatement,
    ) {
        // this.evaluate(statement.expression);

        return null;
    }



    /** EXPRESSIONS */
    public visitLiteralExpression(
        literalExpression: Expression.LiteralExpression,
    ) {
        return literalExpression.value;
    }



    private executeBlock(
        statements: Statement.Statement[],
        environment: Environment,
        type?: string,
    ) {
        // const previous = this.environment;
        // let local;

        // try {
        //     this.environment = environment;

        //     for (const [index, statement] of statements.entries()) {
        //         const value: any = this.executeSynchronous(statement);

        //         if (value) {
        //             this.environment.define(
        //                 index + '',
        //                 value,
        //             );
        //         }
        //     }

        //     if (type === 'root') {
        //         this.rootEnvironment = this.environment;
        //     } else {
        //         local = this.environment;
        //     }
        // } catch (error) {
        //     this.environment = previous;
        //     throw error;
        // } finally {
        //     this.environment = previous;
        //     return local;
        // }
    }

    private evaluate(
        expression: Expression.Expression,
    ): any {
        return expression.accept(this);
    }
}
// #endregion module



// #region exports
export default Interpreter;
// #endregion exports
