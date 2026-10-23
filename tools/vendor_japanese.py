"""Rebuild the bundled Japanese assets (Python standard library only).

python tools/vendor_japanese.py --cache-dir .git
python tools/vendor_japanese.py --refresh-jmdict --cache-dir .git

The first command uses pinned releases; the second deliberately updates JMdict.
Review the resulting source metadata, data diff and tests before publishing.
"""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
KUROMOJI_URL = "https://registry.npmjs.org/kuromoji/-/kuromoji-0.1.2.tgz"
KUROMOJI_SHA = "ccf8778839df92ae3a3d64a93998ac92d1e92c7f73fe6193295a5258c98308b4"
JMDICT_RELEASE = "3.6.2+20261019180022"
JMDICT_SHA = "e4e88340e86470bec9ac1d2718d96d59af8491243827aab41ef99ae5fc269bbc"


def download(url, filename, expected=None):
    data = filename.read_bytes() if filename.exists() else None
    if data is None or (expected and hashlib.sha256(data).hexdigest() != expected):
        request = urllib.request.Request(url, headers={"User-Agent": "LinguaMate-vendor/1.9.0"})
        data = urllib.request.urlopen(request, timeout=90).read()
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_bytes(data)
    if expected and hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Checksum mismatch: {url}")
    return data


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=pathlib.Path, default=ROOT / ".git" / "japanese-vendor-cache")
    parser.add_argument("--refresh-jmdict", action="store_true")
    args = parser.parse_args()
    cache = args.cache_dir.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    library = ROOT / "src/vendor/kuromoji"
    library.mkdir(parents=True, exist_ok=True)
    archive = download(KUROMOJI_URL, cache / "kuromoji-0.1.2.tgz", KUROMOJI_SHA)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            relative = pathlib.PurePosixPath(member.name).relative_to("package")
            if str(relative) == "build/kuromoji.js":
                source = tar.extractfile(member).read().decode("utf-8")
                replacement = '''BrowserDictionaryLoader.prototype.loadArrayBuffer = function (url, callback) {
    // LinguaMate: MV3 service workers have fetch, not XMLHttpRequest.
    fetch(url).then(function (response) {
        if (!response.ok) throw new Error("Dictionary HTTP " + response.status);
        return response.arrayBuffer();
    }).then(function (arraybuffer) {
        var gz = new zlib.Zlib.Gunzip(new Uint8Array(arraybuffer));
        var typed_array = gz.decompress();
        callback(null, typed_array.buffer);
    }).catch(function (error) { callback(error, null); });
};'''
                source, count = re.subn(r"BrowserDictionaryLoader\.prototype\.loadArrayBuffer = function \(url, callback\) \{[\s\S]*?\n\};", lambda _: replacement, source, count=1)
                if count != 1:
                    raise ValueError("Kuromoji loader changed; review the MV3 patch")
                (library / "kuromoji.js").write_text(source, encoding="utf-8", newline="\n")
            elif relative.parts[0] == "dict" and relative.name.endswith(".dat.gz"):
                target = library / str(relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
            elif str(relative) in ("LICENSE-2.0.txt", "NOTICE.md"):
                (library / relative.name).write_bytes(tar.extractfile(member).read())
    write_json(library / "SOURCE.json", {"package": "kuromoji", "version": "0.1.2", "url": KUROMOJI_URL,
               "sha256": KUROMOJI_SHA, "modification": "BrowserDictionaryLoader: XMLHttpRequest replaced with fetch for MV3 workers; no other changes"})

    release = JMDICT_RELEASE
    if args.refresh_jmdict:
        request = urllib.request.Request("https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest", headers={"User-Agent": "LinguaMate-vendor"})
        release = json.load(urllib.request.urlopen(request, timeout=30))["tag_name"]
    from urllib.parse import quote
    url = f"https://github.com/scriptin/jmdict-simplified/releases/download/{quote(release, safe='')}/jmdict-eng-common-{quote(release, safe='')}.json.tgz"
    data = download(url, cache / ("jmdict-common.tgz" if not args.refresh_jmdict else f"jmdict-{release}.tgz"), None if args.refresh_jmdict else JMDICT_SHA)
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        members = [member for member in tar.getmembers() if member.name.endswith(".json")]
        if len(members) != 1:
            raise ValueError("Unexpected JMdict archive layout")
        full = json.load(tar.extractfile(members[0]))
    words = [{"id": row["id"], "k": [item["text"] for item in row["kanji"]],
              "r": [{"t": item["text"], "a": item["appliesToKanji"]} for item in row["kana"]],
              "s": [{"p": sense["partOfSpeech"], "k": sense["appliesToKanji"], "r": sense["appliesToKana"],
                     "g": [gloss["text"] for gloss in sense["gloss"] if gloss["lang"] == "eng"], "i": sense["info"]}
                    for sense in row["sense"]]} for row in full["words"]]
    compact = {"source": "JMdict / EDRDG; JSON distribution by scriptin/jmdict-simplified", "date": full["dictDate"],
               "version": full["version"], "tags": full["tags"], "words": words}
    directory = ROOT / "src/vendor/jmdict"
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "common.json.gz"
    output.write_bytes(gzip.compress(json.dumps(compact, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), compresslevel=9, mtime=0))
    write_json(directory / "SOURCE.json", {"source": "JMdict / EDRDG", "sourceUrl": "https://www.edrdg.org/jmdict/j_jmdict.html",
               "distribution": "scriptin/jmdict-simplified", "release": release, "url": url,
               "archiveSha256": hashlib.sha256(data).hexdigest(), "dataDate": full["dictDate"], "entries": len(words),
               "license": "CC-BY-SA-4.0", "modification": "Common English entries only; compact keys; preserves reading and sense applicability; gzip",
               "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest()})
    download("https://www.edrdg.org/edrdg/licence.html", directory / "EDRDG-LICENCE.html")
    download("https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt", directory / "CC-BY-SA-4.0.txt")
    print(f"Kuromoji 0.1.2; JMdict {full['dictDate']}: {len(words)} common entries, {output.stat().st_size:,} bytes")
    if args.refresh_jmdict:
        print("Review SOURCE.json, update the pinned JMDICT_RELEASE/JMDICT_SHA, then run node --test tests/*.test.cjs")


if __name__ == "__main__":
    main()
