/**
 * A query that arrives over HTTP is field equality, nothing else.
 *
 * A CRUD `query` is handed to the database as a filter, and MongoDB reads any key starting with `$`
 * as an operator. Accepting them from the outside let anyone ask questions no contract was written
 * to answer: `?query={"slug":{"$ne":"platform"}}` walked every organization, one per request, with
 * no ticket at all (2026-09-26). In-process callers (`ctx.call`, `ctx.db`) never pass through here
 * and keep every operator.
 *
 * Returns the path of the first operator found, or `undefined` when the query is plain equality.
 */
export function firstOperator(query: unknown, path = 'query'): string | undefined {
    if (Array.isArray(query)) {
        for (const [i, item] of query.entries()) {
            const found = firstOperator(item, `${path}[${i}]`);
            if (found !== undefined) return found;
        }
        return undefined;
    }
    if (typeof query !== 'object' || query === null) return undefined;
    for (const [key, value] of Object.entries(query)) {
        if (key.startsWith('$')) return `${path}.${key}`;
        const found = firstOperator(value, `${path}.${key}`);
        if (found !== undefined) return found;
    }
    return undefined;
}
