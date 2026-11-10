# Declarative batches, version 1

Pass an object to `applyBatch(database, payload)` or a UTF-8 JSON file to
`stringbase batch app.deon --operations batch.json`. The envelope has exactly
`version: 1` and an `operations` array, containing at most 256 operations.

```json
{
  "version": 1,
  "operations": [
    { "op": "createCollection", "collection": "events" },
    { "op": "insertOne", "collection": "records", "document": { "id": "1", "active": "false" } },
    { "op": "insertOne", "collection": "events", "document": { "id": "event-1", "recordId": "1" } }
  ]
}
```

Every operation requires `op` and `collection`. Additional required properties:

| op | Properties |
| --- | --- |
| createCollection, dropCollection | none |
| insertOne | document |
| insertMany | documents |
| updateOne, replaceOne | id, fields |
| deleteOne | id |
| updateMany | query, fields; optional view |
| deleteMany | query; optional view |

Unknown properties, operation names, and versions are errors. `document`,
`documents`, and `fields` use the SDK's Deon value model: JSON numbers, booleans,
and null are not stored values. ID and field-update rules are the same as the SDK.
`query` is a Loque v1 QueryIR with document-level where/sort/skip/limit steps;
judgments and traversal steps are rejected. `view` is raw or typed, default raw.

Validation precedes the transaction. Operations execute in array order, reading
earlier staged changes. A failure publishes nothing; an effective successful batch
publishes once. The result array has one result per operation; collection creation
and removal produce JSON null in CLI output. No JavaScript is evaluated from a
payload. `STRINGBASE_COMMIT_UNCERTAIN` requires close/reopen and must not be retried
as if the entire batch had rolled back.
