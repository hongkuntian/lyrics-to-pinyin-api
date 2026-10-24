# Packaged JSON-lines lexicons, version 1

index.json pins dataset manifests. A manifest pins all 64 raw JSONL shards by byte
length and SHA256; bucket is SHA256(original UTF8 lookup key)[0] modulo 64. Each
line is canonical JSON `[lookup, tuples]`, LF terminated. Runtime caches raw shard
bytes, parses only the selected line and expands common source provenance from
the manifest. IDs use SHA256(JSON.stringify(["entry-1", datasetID, locator, lookup,
value])). Complete alternatives in the pinned snapshot are preserved; this is not
an exhaustive language inventory or a contextual correctness assertion.

Tuple columns:

- Thai: `[id, rawIPA, recordSHA256, soundSHA256, line, byteOffset, byteLength,
  soundIndex, POS, soundQualifiers]`. Dataset ID is `kaikki-th-` plus the first 16
  hex digits of expanded input SHA. Locator is
  `input:{inputSHA}:record:{recordSHA}:sound:{canonicalSoundSHA}`; column is
  `sounds[index].ipa`. Record SHA includes the original LF; byte offsets address
  expanded original JSONL. Sound SHA uses sorted-object-key canonical JSON.
- Hindi: `[id, nativeValue, memberIndex, line, byteOffset, byteLength, recordSHA256,
  attestedAlias, attestationCount]`. Dataset ID is `dakshina-hi-v1.0`. Member index
  refers to source.members. Locator is `member:{path}:row:{line}:columns:native,romanization,count`.
  Offsets address exact member bytes; record SHA includes LF. Columns are 1/2/3.
- Vietnamese: `[id, originalHeadword, POS, line, byteOffset, byteLength, recordSHA256]`.
  Dataset ID is `kaikki-vi-` plus 16 hex digits of compressed input SHA. Locator is
  `compressed-input:{SHA}:line:{line}:column:word`. Offsets address expanded JSONL;
  record SHA excludes LF, matching retained baseline extraction. Lines start at 1.

Every expanded entry includes ID/value, dataset, snapshot, input SHA, source entry
locator, source URL, line/column and reviewStatus. Stable IDs distinguish rows;
candidate engines group identical values while retaining every entry association.
No source example/lyric/definition field is included.

Runtime hard bounds: <=4 cached plus active shards; <=8 MiB per shard; <=32 MiB
serialized cached plus reserved loading bytes; <=64 queued distinct loads; 512
UTF8 lookup bytes; 128 lookup batch items; 128 KiB selected row; 512 entries/row.
Matching loads coalesce. Four fixed reusable slots are sized to the exact pinned
maximum shard byte length plus one sentinel byte; leases prevent reuse while a
lookup is parsing. This avoids leaving evicted per-read buffers to GC churn. Manifest and shard pins reject missing/corrupt data.
Serialized limits are not a hard RSS guarantee; actual Node24 measurements are
required. Root's complete ready envelope cap is independently 1,800,000 bytes.
