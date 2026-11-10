import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Compatibility fixes for the pinned 1fab7fb Deon source. These operate only
 * on the temporary build copy. Assert exact matches so a new pin cannot silently
 * inherit obsolete patches. Regressions are exercised by the storage tests. */
export async function patchDeon(directory) {
    const replace = async (file, before, after) => {
        const filename = resolve(directory, file);
        const source = await readFile(filename, 'utf8');
        assert.equal(source.split(before).length, 2, `Deon compatibility patch changed: ${file}`);
        await writeFile(filename, source.replace(before, after));
    };
    const scanner = 'source/objects/Scanner/index.ts';
    // An unpaired surrogate is outside UTF-8 Deon's value domain, unlike the
    // original NUL-delimited marker, which collided with a valid user string.
    await replace(scanner,
        String.raw`export const ESCAPED_INTERPOLATION = '\u0000deon-interpolation\u0000';`,
        String.raw`export const ESCAPED_INTERPOLATION = '\uD800deon-interpolation\uD800';`);
    await replace(scanner, 'KEYWORDS[lexeme] ?? TokenType.SIGNIFIER',
        '(Object.hasOwn(KEYWORDS, lexeme) ? KEYWORDS[lexeme] : TokenType.SIGNIFIER)');
    const stringifier = 'source/objects/Stringifier/index.ts';
    await replace(stringifier, 'interface LinkValue {',
        "const GENERATED_LINK = Symbol('deon-generated-link');\n\ninterface LinkValue {\n    readonly [GENERATED_LINK]: true;");
    await replace(stringifier, "    && 'kind' in value\n    && value.kind === 'link';",
        '    && GENERATED_LINK in value\n    && value[GENERATED_LINK] === true;');
    await replace(stringifier, "                kind: 'link',\n                name: generatedName,",
        "                kind: 'link',\n                name: generatedName,\n                [GENERATED_LINK]: true,");
}
