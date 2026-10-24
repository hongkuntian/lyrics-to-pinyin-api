# Lyrica pronunciation source references

This is a finite source-availability capsule, not a deployable backend or a
complete runtime dependency closure. It contains26 exact source/metadata files
from backend9e6cab8c14d4e6238b37f402fe83e5baf6cb5d1d, plus this README,
PROVENANCE.json and CONTENTS.json. Original paths and bytes are preserved.
The synthetic Git author/time are deterministic preparation metadata, not an
upstream signature or a claim of public end-to-end reproducibility.

## Exact data and identity crosswalk

The separate [immutable data snapshot](https://github.com/hongkuntian/lyrics-to-pinyin-api/blob/ed7601457279239de1c6d901f85e49680f978d74/README.md)
contains the compiled TH/HI/VI data, source lock, schema, full notices, dependency
file pins and engine manifest. Its entire217-file content has been byte-verified.
Combine matching paths in an owned scratch directory only; never modify either
published snapshot. PROVENANCE.json maps each of these26 files to its original
Git blob, SHA-256 and byte count. CONTENTS.json pins every other capsule member;
its own content is separately pinned by the publication receipt.

Engine data revision remains
`b6d045a2b1ea62ab8124b19c3d845ebd4fb669f6acbc9fa08f41ab5cd5a58965`.
The two written revisions and all source/data/candidate namespaces are unchanged.
Publishing this source does not enable a profile or change frozen inactive BUILD
provenance, lexical IDs, annotations, saved keys, speech or runtime policy.

## Compilers and limits

The exact Node24 compilers are [compile-language-lexicons.mjs](scripts/compile-language-lexicons.mjs)
and [compile-written-pronunciation-data.mjs](scripts/compile-written-pronunciation-data.mjs).
They use Node builtins and never download input. With both snapshots overlaid in
disposable scratch, the written manifest can be checked without installing packages:

```sh
node scripts/compile-written-pronunciation-data.mjs --check
```

Lexical reconstruction additionally requires the exact retained source snapshots
from the published source lock and the private175-case adjudication input:

```sh
node scripts/compile-language-lexicons.mjs --input-root /exact/retained-inputs --output-root /owned/new-output
```

The private adjudication input is deliberately not included. Its hash remains
7f6ed16c45c5ff0a4dd9e55486ea493dc28c3fbcceec61d1438d9b787046fc07.
Current upstream downloads may differ from those frozen snapshots. Full public
regeneration and dependency download availability are not established here.
The engine-manifest-only operation also needs the exact pinned installed
dependency bytes; a fresh npm install is not evidence that those pins match.

These sources cover the owned engine and written-revision hashing inputs. They
are not the complete server import graph. In particular, pronunciation-aids.js
references the backend store outside this capsule; do not claim the Japanese
runtime can be executed from these files alone. Package files preserve exact
dependency metadata; their generic test/build scripts require the full project.
No dependency installation, compiler or dictionary runtime was executed as part
of preparing this source capsule.

## Licenses and finite qualification

Lyrica wrapper/compiler code retains its [MIT license](api/utils/pronunciation-v2/LICENSE)
and [NOTICE](api/utils/pronunciation-v2/NOTICE). The vendored Sanscript body retains
its [exact license](api/utils/pronunciation-v2/vendor/sanscript-1.3.3/LICENSE)
and [provenance](api/utils/pronunciation-v2/vendor/sanscript-1.3.3/provenance.json).
Other dependency bodies are not republished here. Their exact notices and public
source locators are retained in the linked data snapshot. Dictionary data remain
CC-BY-SA; wrapper terms do not relabel them. The exact upstream Koroman notice
with conflict markers is preserved and disclosed there, without author correction
or legal-clearance claims.

Thai qualification remains48 exact forms/72 references with explicit boundary
confirmation. Hindi aliases require contextual choice and separate native-script
speech confirmation. Vietnamese remains lexical/manual-range data, with no
pronunciation profile. Japanese147 retained probes are bounded text-beta evidence,
not fluent, acoustic or catalog-wide qualification. No commercial lyrics, raw
corpus, private adjudication bodies, evaluation outputs, credentials, workflow,
deployment configuration or real-account material are included.
