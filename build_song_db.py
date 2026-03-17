#!/usr/bin/env python3
"""
Fetch musics.json and musicDifficulties.json from sekai-master-db-diff and build
songDatabase.json with id, title, and per-difficulty totalNoteCount.
Run periodically to update the song list (e.g. cron or manually).
"""
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MUSICS_URL = "https://raw.githubusercontent.com/Sekai-World/sekai-master-db-diff/main/musics.json"
DIFFICULTIES_URL = "https://raw.githubusercontent.com/Sekai-World/sekai-master-db-diff/main/musicDifficulties.json"
OUTPUT_PATH = Path(__file__).resolve().parent / "songDatabase.json"


def fetch_json(url: str) -> list:
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.load(resp)


def main() -> None:
    musics = fetch_json(MUSICS_URL)
    difficulties = fetch_json(DIFFICULTIES_URL)

    by_music_id: dict[int, dict] = {}
    for m in musics:
        mid = m.get("id")
        if mid is None:
            continue
        by_music_id[mid] = {
            "id": mid,
            "title": m.get("title") or "",
            "difficulties": {},
        }

    for d in difficulties:
        music_id = d.get("musicId")
        diff = d.get("musicDifficulty")
        total = d.get("totalNoteCount")
        play_level = d.get("playLevel")
        if music_id is None or not diff or total is None:
            continue
        if music_id not in by_music_id:
            continue
        by_music_id[music_id]["difficulties"][diff] = {
            "totalNoteCount": total,
            "playLevel": play_level if play_level is not None else 0,
        }

    songs = [v for v in by_music_id.values() if v["title"]]
    songs.sort(key=lambda s: (s["id"],))

    out = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "songs": songs,
    }

    OUTPUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(songs)} songs to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
