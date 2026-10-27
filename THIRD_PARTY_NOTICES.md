# Japanese analysis and dictionary data

## Kuromoji.js 0.1.2 and IPADIC

[Kuromoji.js](https://github.com/takuyaa/kuromoji.js), copyright Takuya Asano and contributors, is distributed under the Apache License 2.0. The bundled code includes its original dependency notices. Its only LinguaMate modification is replacing the browser dictionary loader's XMLHttpRequest with fetch so it runs inside a Manifest V3 service worker. Dictionary files are unchanged.

- [Apache License](src/vendor/kuromoji/LICENSE-2.0.txt)
- [IPADIC / NAIST / ICOT copyright and conditions](src/vendor/kuromoji/NOTICE.md)
- [Exact package source and SHA-256](src/vendor/kuromoji/SOURCE.json)

## JMdict

This package uses the [JMdict Japanese-English dictionary](https://www.edrdg.org/jmdict/j_jmdict.html), created by the Electronic Dictionary Research and Development Group (EDRDG) and its contributors, distributed as JSON by [scriptin/jmdict-simplified](https://github.com/scriptin/jmdict-simplified). The common English subset (22,647 entries) supplies frequency classification and fast lookups. Since 1.10.0, the full English snapshot (218,930 entries) supplements missing lookups through 32 compressed shards. A separate exact written-noun index supports compound segmentation; no fuzzy correction of source captions is performed. Both snapshots are dated 2026-10-19.

The data and LinguaMate's compact derivative are licensed under [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/). LinguaMate shortens field names and removes unused fields, retaining headword, reading, sense restrictions and English glosses; no machine translation is added to the dictionary file. The runtime marks generated translations separately from dictionary definitions.

- [EDRDG licence statement](src/vendor/jmdict/EDRDG-LICENCE.html)
- [CC BY-SA 4.0 legal text](src/vendor/jmdict/CC-BY-SA-4.0.txt)
- [Snapshot date, source archive and checksums](src/vendor/jmdict/SOURCE.json)
- [Full English supplement source and per-file checksums](src/vendor/jmdict/extended/SOURCE.json)

### Rebuild and update

Python 3.10+ can rebuild the pinned assets without additional packages:

```sh
python tools/vendor_japanese.py --cache-dir .git
python tools/vendor_japanese_extended.py
```

Before publishing a release containing Japanese data, check for an updated JMdict snapshot (the upstream distribution normally updates weekly). To select the latest snapshot explicitly:

```sh
python tools/vendor_japanese.py --refresh-jmdict --cache-dir .git
node --test tests/*.test.cjs
```

Review the generated `SOURCE.json` and dictionary tests, then update the script's pinned release and SHA-256. Publish the refreshed data, these notices and the licence files together. Existing installed extensions receive new data with extension updates; analysis never downloads executable code or sends captions to the dictionary supplier.
