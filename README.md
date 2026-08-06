# tdarr

Version-controlled Tdarr configuration.

Server: `tdarr-server:8266` (Tdarr 2.86.01), nodes `Nvidia` and `Intel`.

## Layout

```
flows/      Flow definitions, exported from the Tdarr UI as JSON.
plugins/    Local plugin source (.js), mirrors the server plugin folder.
```

## flows/

Flows are not files on the server — they live in SQLite at
`server/Tdarr/DB2/SQL/database.db`, table `flowsjsondb`, one JSON blob per row.
(The `DB2/FlowsJSONDB/` folder is an empty leftover from an older storage
format.) These files are therefore exported artifacts, not a source of truth.
The round trip is manual:

- **Export**: Flows tab → open the flow → export to JSON → save over the file here.
- **Import**: Flows tab → import → select the file.

Commit after every meaningful change so the repo stays a usable backup. If a
flow is edited in the UI and not re-exported, this repo is stale — re-export
before making changes on disk.

Note the DB row uses a slightly different key set than a UI export: `_id`,
`name`, `priority`, `flowPlugins`, `flowEdges`, `isUiLocked`, with no
`description` or `tags`. Edges carry `animated` and `type` fields that the UI
export strips. `flows/transcode-pipeline.json` is in DB shape and imports fine.

## plugins/

These are real source files. On the server they live under:

- Classic plugins: `/app/server/Tdarr/Plugins/Local/*.js`
- Flow plugins: `/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/<name>/<version>/index.js`

Copy them in preserving that structure. Note local flow plugins have **no
category directory**, unlike `CommunityFlowPlugins/<category>/<name>/<version>/`
— they sit directly under `LocalFlowPlugins/`. That makes them one level
shallower, so their relative `require`s differ from the community ones:
`../../../FlowHelpers/...` and `../../../../methods/lib`. Getting this wrong
fails at runtime with `Plugin does not exist: .../LocalFlowPlugins///<name>/...`
— the empty path segments in that message are the giveaway.

Plugins are resolved on the **node**, at
`/app/Tdarr_Node/assets/app/plugins/...`, not on the server. Nodes sync their
copy from the server, so a newly added local plugin may need a node restart
before it is visible.

Flow plugins are loaded as compiled JavaScript, so the files here are plain JS
written in the same CommonJS shape the community plugins compile to. Local flow
plugin nodes reference `"sourceRepo": "Local"` in the flow.

Currently one local flow plugin:

- `keepOneAudioStream` — keeps a single audio stream, removing the rest.
  Prefers the configured language tag, then the highest channel count, then the
  highest bitrate, then file order. No stock plugin does this.

---

# Transcode Pipeline

The single flow (`a_CeSjPzb`) applied to the TV library. Its job: get every file
to MKV + HEVC video + exactly one English audio track in a directly playable
codec + English subtitles, in that stream order, with accurate track statistics.
Audio is left alone wherever it already direct-plays.

## Stages

**1. Container.** `Remux & Heal Container` runs the local `RemuxMKV` plugin,
which no-ops when the file is already MKV. On failure the flow falls through
`Reset Flow Error` → `Force Remux` (`ForceRemuxMKV`), which rebuilds the
container unconditionally — the healing path for files with broken indexes.
`Run MKVPropEdit` then writes track statistics tags, but **only on the branch
where the remux actually processed the file**. `--add-track-statistics-tags`
reads the whole file, so running it on an untouched file is pure I/O for no
gain — at ~19,600 files that adds up on every scan.

**2. Size gate.** `File <= 100MB?` sends tiny files straight to the audio and
subtitle cleanup, skipping video transcode entirely — not worth the GPU time.

**3. Video.** `Is HEVC?` skips anything already HEVC. Otherwise the flow picks
an encoder by node name: `Nvidia?` routes to NVENC (`Migz1FFMPEG`), `Intel?` to
QuickSync (`Boosh_FFMPEG_QSV_HEVC`), and anything else falls back to a CPU
encode (`Migz1FFMPEG_CPU`) rather than being handed the wrong GPU path.
`Compare File Size Ratio` then guards the result — if the new file isn't
smaller, `Set Original File` discards it and the original is kept.

**4. Language cleanup.** `Remove Non English Audio` and `Remove Non English Subs`
(local `CleanAudio` / `CleanSubs`) strip non-English tracks and commentary. SDH
subtitles are kept.

**5. Audio.** An ffmpeg-command block that plans one command and executes it
once. The policy is **pass-through**: leave audio alone if it already
direct-plays, and only convert what doesn't. `Begin Command` snapshots the
streams, then:

- Three `checkAudioCodec` nodes ask in turn whether the file already has
  `eac3`, `ac3` or `aac`. Any hit skips straight to the drop step — no
  re-encode. This is the whole point of the design: a library sweep found ~90%
  of shows already carry one of those three, so normalising everything to a
  single codec meant re-encoding almost the entire library for no playback
  benefit.
- Only if none of the three is present does `Ensure EAC3 384k` run, cloning the
  highest-channel-count English stream into E-AC3. It requests 6 channels and
  the plugin clamps to `min(wanted, available)`, so 8ch → 5.1, 6ch → 5.1,
  2ch → stereo. In practice this fires on DTS, TrueHD, FLAC, Opus, Vorbis and
  MP3 sources.
- `Drop Incompatible Audio` then removes any audio stream whose `codec_name` is
  not one of `eac3,ac3,aac`. The condition must be **`not_equals`**, not
  `not_includes` — the plugin does substring matching for `includes`, and
  `"eac3".includes("ac3")` is true, which would silently keep the wrong
  streams.
- `Keep One Audio Stream` (local plugin) then reduces whatever survived to a
  single track. It runs *after* the codec drop deliberately: picking a favourite
  first could select a DTS track that the drop step then removes, leaving the
  file with no audio at all.
- Files keep whatever bitrate they arrived with. Nothing is normalised
  downwards; the flow preserves rather than re-encodes.
- `Reorder Streams` sorts to video → audio → subtitles, highest channel count
  first within audio.
- `Execute` builds and runs the command. Streams with no output args get
  `-c copy`, so video and subtitles are remuxed, never re-encoded. If nothing
  changed, it skips ffmpeg entirely.

**6. Finalise.** `Unchanged?` tests `ffmpegCommand.shouldProcess`; if the command
did nothing, the flow goes straight to `Replace Original File` (which then also
does nothing, since the file is byte-identical). Otherwise a second
`Run MKVPropEdit` re-stamps statistics tags so the new audio track reports its
real bitrate and size. Its `err1` output also goes to Replace — a tagging
failure shouldn't discard a good transcode.

The check is deliberately phrased as *Unchanged?* (`== false`) rather than
*Changed?*: if the template ever fails to resolve, the empty value won't match,
so the flow falls through to restamping. Wrong-but-safe beats silently skipping
stats after a real change.

## Graph

```mermaid
flowchart TD
    IN[Input File] --> REMUX[Remux & Heal Container]
    REMUX -->|processed| PROP1[Run MKVPropEdit]
    REMUX -->|no change| SIZE
    REMUX -.->|err| RST1[Reset Flow Error]
    RST1 --> FORCE[Force Remux]
    FORCE --> PROP2[Run MKVPropEdit]
    FORCE -.->|err| RST2[Reset Flow Error]
    PROP2 -.->|err| RST2
    RST2 --> SIZE
    PROP1 --> SIZE{File &lt;= 100MB?}
    PROP2 --> SIZE

    SIZE -->|yes| CLEANA
    SIZE -->|no| HEVC{Is HEVC?}
    HEVC -->|yes| CLEANA
    HEVC -->|no| NV{Nvidia?}
    NV -->|yes| ENC1[Transcode HEVC NVENC]
    NV -->|no| INTEL{Intel?}
    INTEL -->|yes| ENC2[Transcode HEVC QuickSync]
    INTEL -->|no| ENC3[Transcode HEVC CPU]
    ENC1 --> RATIO{Smaller?}
    ENC2 --> RATIO
    ENC3 --> RATIO
    RATIO -->|yes| CLEANA
    RATIO -->|no| ORIG[Set Original File]
    ORIG --> CLEANA

    CLEANA[Remove Non English Audio] --> CLEANS[Remove Non English Subs]
    CLEANS --> START[Begin Command]

    START --> K1{Has EAC3?}
    K1 -->|yes| DROP[Drop Incompatible Audio]
    K1 -->|no| K2{Has AC3?}
    K2 -->|yes| DROP
    K2 -->|no| K3{Has AAC?}
    K3 -->|yes| DROP
    K3 -->|no| ENS[Ensure EAC3 384k]
    ENS --> DROP
    DROP --> KEEP[Keep One Audio Stream]
    KEEP --> ORDER[Reorder Streams]
    ORDER --> EXEC[Execute]
    EXEC --> CHG{Unchanged?}
    CHG -->|yes| REPL[Replace Original File]
    CHG -->|no| PROP3[Run MKVPropEdit]
    PROP3 --> REPL

    subgraph audio [Audio ffmpeg command block]
        START
        K1
        K2
        K3
        ENS
        DROP
        KEEP
        ORDER
        EXEC
    end
```

## Known wrinkles

- **The three encoder paths use different plugins.** NVENC and CPU use
  `Migz1FFMPEG` / `Migz1FFMPEG_CPU`; QuickSync uses `Boosh_FFMPEG_QSV_HEVC`.
  They have different bitrate logic, so output size varies by which node picks
  up a file. All three are now pinned explicitly.
- **`keepOneAudioStream` is a local plugin**, so it lives only in this repo and
  on the server — it is not maintained upstream and will not survive a plugin
  folder wipe. Re-copy it from `plugins/` if the server is rebuilt.
- **Already-processed files are never downgraded in channel count.** Ensure only
  adds a track when none matches; it won't rebuild a stereo track from a
  surround source after the fact.
- **E-AC3 cannot be bitstreamed over optical/S/PDIF**, which carries only AC3
  and DTS. Over HDMI/eARC this is a non-issue. If a client can't handle E-AC3 it
  transcodes server-side — a performance cost, not a broken file.
- **AV1 sources are transcoded to HEVC**, which is backwards efficiency-wise.
  One show in the library is affected.
- **A file with no English audio keeps its foreign track.** `CleanAudio` refuses
  to strip the last audio stream, and `keepOneAudioStream` then keeps whatever
  survived. Better than a silent file, but "one English track" is not guaranteed
  library-wide.
