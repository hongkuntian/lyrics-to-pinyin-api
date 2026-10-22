These eight executor sources are byte-for-byte fixtures from backend
`b746419ffe9084de3010830c1b7c1986d30aa432`. They are retained only to test
validation/replay of an old frozen journal prefix under its own code hashes.
The test constructs a private selective executable with the current unchanged
production builders/parsers and fixtures, then injects synthetic responses.
They do not provide a live build entry or new Batch reconciliation proof.
The new executor refuses old-plan suffix events after explicit handover.
