"""Build a pinned full JMdict lookup supplement without loading it all at runtime.

python tools/vendor_japanese_extended.py
The common dictionary and its frequency classification are kept separately.
"""
import gzip
import hashlib
import io
import json
import pathlib
import tarfile
import unicodedata
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
RELEASE = "3.6.2%2B20261019180022"
URL = f"https://github.com/scriptin/jmdict-simplified/releases/download/{RELEASE}/jmdict-eng-{RELEASE}.json.tgz"
SHA256 = "1dca86908663dcddb8c3bcff9dc5e2bc73037bbdeed9c705c896a3845e7635a5"
BUCKETS = 32


def key(text):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c
                   for c in unicodedata.normalize("NFKC", text))


def bucket(text):
    value = 0
    # JS hashes UTF-16 code units, including surrogate pairs.
    encoded = text.encode("utf-16-le")
    for i in range(0, len(encoded), 2):
        value = (value * 31 + int.from_bytes(encoded[i:i + 2], "little")) & 0xffffffff
    return value % BUCKETS


def main():
    archive = ROOT / ".git/jmdict-full.tgz"
    if not archive.exists():
        with urllib.request.urlopen(URL, timeout=90) as response:
            archive.write_bytes(response.read())
    data = archive.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if SHA256 and digest != SHA256:
        raise ValueError("JMdict archive checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        member, = [entry for entry in tar.getmembers() if entry.name.endswith(".json")]
        full = json.load(tar.extractfile(member))
    shards = [{} for _ in range(BUCKETS)]
    nouns = {}
    for row in full["words"]:
        entry = {"id": row["id"], "k": [x["text"] for x in row["kanji"]],
                 "r": [{"t": x["text"], "a": x["appliesToKanji"]} for x in row["kana"]],
                 "s": [{"p": x["partOfSpeech"], "k": x["appliesToKanji"], "r": x["appliesToKana"],
                        "g": [g["text"] for g in x["gloss"] if g["lang"] == "eng"], "i": x["info"]}
                       for x in row["sense"]]}
        for index in {bucket(key(x)) for x in entry["k"] + [r["t"] for r in entry["r"]]}:
            shards[index][entry["id"]] = entry
        for form in entry["k"]:
            # Exact written noun compounds only; no fuzzy spelling replacement.
            if not (2 <= len(form) <= 16 and all("一" <= c <= "鿿" or c in "々ヶヵ" for c in form)):
                continue
            readings = [r["t"] for r in entry["r"] if ("*" in r["a"] or form in r["a"]) and any(
                "n" in sense["p"] and ("*" in sense["k"] or form in sense["k"]) and
                ("*" in sense["r"] or r["t"] in sense["r"]) for sense in entry["s"])]
            if readings:
                nouns.setdefault(form, set()).update(readings)
    directory = ROOT / "src/vendor/jmdict/extended"
    directory.mkdir(exist_ok=True)
    hashes = {}
    def save(name, value):
        content = gzip.compress(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)
        (directory / name).write_bytes(content)
        hashes[name] = hashlib.sha256(content).hexdigest()
    for i, entries in enumerate(shards):
        save(f"{i:02d}.json.gz", {"date": full["dictDate"], "tags": full["tags"], "words": list(entries.values())})
    save("compounds.json.gz", {form: sorted(readings) for form, readings in sorted(nouns.items())})
    metadata = {"source": "JMdict / EDRDG", "distribution": "scriptin/jmdict-simplified",
                "url": URL, "archiveSha256": digest, "dataDate": full["dictDate"],
                "entries": len(full["words"]), "license": "CC-BY-SA-4.0", "buckets": BUCKETS,
                "modification": "Full English entries; hashed lookup shards; exact written noun index; retains reading and sense restrictions",
                "outputSha256": hashes}
    (directory / "SOURCE.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"entries": len(full["words"]), "compounds": len(nouns), "sha256": digest,
                      "bytes": sum(p.stat().st_size for p in directory.glob("*.gz"))}))


if __name__ == "__main__":
    main()
