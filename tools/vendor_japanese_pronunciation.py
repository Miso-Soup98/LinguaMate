"""Build the offline pronunciation index from two pinned CC BY-SA sources."""
import gzip
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from urllib.request import Request, urlopen

KANJIUM_REV = "9ebca4589565c696e7c39e089e2e928ad65f678c"
ACCENT_PATH = "data/source_files/raw/accents.txt"
ACCENT_URL = f"https://raw.githubusercontent.com/mifunetoshiro/kanjium/{KANJIUM_REV}/{ACCENT_PATH}"
ACCENT_SHA = "8bd0dd127dab32ceec94cb03ab1ba6b68858ea73421dfa1731af2f373deb4f20"
TOFUGU_REV = "9725e0e7d628ab616e8b14e126d3daa33eba8d36"
TOFUGU_REPO = "tofugu/japanese-vocabulary-pronunciation-audio"
TREE_URL = f"https://api.github.com/repos/{TOFUGU_REPO}/git/trees/{TOFUGU_REV}?recursive=1"
DEST = Path(__file__).resolve().parents[1] / "src/vendor/japanese-pronunciation"


def download(url):
    request = Request(url, headers={"User-Agent": "LinguaMate-pronunciation-data"})
    with urlopen(request, timeout=30) as response:
        return response.read()


def key(value):
    return unicodedata.normalize("NFKC", value.strip())


def reading(value):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in key(value))


def build():
    accents = download(ACCENT_URL)
    if hashlib.sha256(accents).hexdigest() != ACCENT_SHA:
        raise ValueError("Unexpected Kanjium source checksum")
    pitch = {}
    for line in accents.decode("utf-8-sig").splitlines():
        word, kana, numbers = line.split("\t")
        normalized_kana = reading(kana)
        if re.fullmatch(r"[ぁ-ゖー]+", normalized_kana) and re.fullmatch(r"\d+(?:,\d+)*", numbers):
            values = pitch.setdefault(key(word), {}).setdefault(normalized_kana, [])
            for number in map(int, numbers.split(",")):
                if number not in values:
                    values.append(number)

    tree = json.loads(download(TREE_URL))
    if tree["sha"] != TOFUGU_REV or tree.get("truncated"):
        raise ValueError("Unexpected Tofugu source tree")
    recordings = {}
    for blob in tree["tree"]:
        path = blob["path"]
        if not path.startswith("lib/mp3/") or blob["type"] != "blob":
            continue
        file = path.removeprefix("lib/mp3/")
        match = re.fullmatch(r"(.+)【([^【】]+)】\.mp3", file)
        if not match:
            continue
        word, kana = match.groups()
        normalized_kana = reading(kana)
        if re.fullmatch(r"[ぁ-ゖー]+", normalized_kana):
            recordings.setdefault(key(word), {}).setdefault(normalized_kana, file)

    DEST.mkdir(parents=True, exist_ok=True)
    data = {"pitch": pitch, "recordings": recordings, "audioRevision": TOFUGU_REV}
    payload = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    (DEST / "index.json.gz").write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
    metadata = {"pitchSource": ACCENT_URL, "pitchSourceSha256": ACCENT_SHA, "audioSource": TREE_URL,
                "license": "CC-BY-SA-4.0", "pitchPairs": sum(map(len, pitch.values())),
                "recordingPairs": sum(map(len, recordings.values()))}
    (DEST / "SOURCE.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(metadata)


if __name__ == "__main__":
    build()
