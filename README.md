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
- Flow plugins: `/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/<category>/<name>/<version>/index.js`

Copy them in preserving that structure — local flow plugins use the same
`<category>/<name>/<version>/` layout as `CommunityFlowPlugins`, so the relative
`require`s are identical: `../../../../FlowHelpers/...` and
`../../../../../methods/lib`.

Two different consumers resolve these paths, and they fail differently:

- The **server** scans for plugins to populate the editor sidebar. Wrong depth
  shows up in the server log as
  `Cannot find module .../<name>/<version>/index.js/index.js` — it walked three
  levels, ran out, and appended `index.js` to a file.
- The **node** loads the plugin to run it, from
  `/app/Tdarr_Node/assets/app/plugins/...`, not from the server directory. Nodes
  sync their copy from the server, so a newly added local plugin needs a node
  restart before it can run.

A node-side error like
`Plugin does not exist: .../LocalFlowPlugins///<name>/<version>/index.js`
means the **flow node JSON is missing fields**, not that the directory is wrong
— the empty segments are unpopulated category values. Add the node from the
editor sidebar rather than hand-writing it into the flow JSON.

Flow plugins are loaded as compiled JavaScript, so the files here are plain JS
written in the same CommonJS shape the community plugins compile to. Local flow
plugin nodes reference `"sourceRepo": "Local"` in the flow.

Keep every `require` **inside** the plugin function, never at module top level.
The UI reads the file to render a node's inputs, and that happens in a context
where the relative paths to `FlowHelpers` and `methods/lib` do not resolve — a
top-level require makes the whole module unloadable and the editor shows
"Unable to read this plugin during loading". Several community plugins
(`checkAudioCodec`, `checkChannelCount`) follow the same deferred pattern.
Runtime is unaffected either way, so this fails only in the editor.

Local flow plugins:

- `normaliseAudioTracks` — reduces the audio streams to at most one surround
  track and one stereo/mono track, preferring the target codec, and puts
  surround first. No stock plugin can do this: `Drop Incompatible Audio` works
  by codec so it cannot express "keep two", and `Reorder Streams` only knows
  8/6/2/1 channels so it mis-sorts a 4-channel track.
- `keepOneAudioStream` — **no longer used by the flow.** It reduced audio to a
  single track, which the surround+stereo policy replaced. Left in place in case
  it is wanted again.

## Deploying a change

Flow edits take effect on import. **Local plugin changes do not** — nodes load
plugins from their own synced copy at
`/app/Tdarr_Node/assets/app/plugins/...`, not from the server directory. So a
new or edited local plugin needs:

1. Copy the file to the server, preserving the directory layout above.
2. **Restart the Tdarr node**, not just the server. Until you do, the node
   reports `Plugin does not exist` and the flow fails at that node.
3. Import the flow: Flows tab → import → `flows/transcode-pipeline.json`.

Verify before a bulk run:

```sh
pnpm test        # 52 assertions against the real flow and real plugin source
pnpm lint:flow   # structural lint
pnpm fuzz        # 8,568 synthetic files through the flow
```

---

# Transcode Pipeline

The single flow (`a_CeSjPzb`), applied to both the TV and Film libraries. Its job: get every file
to MKV + HEVC video + exactly one English audio track in a directly playable
codec + English subtitles, in that stream order, with accurate track statistics.
Audio is left alone wherever it already direct-plays.

## Stages

**1. Container.** `Remux & Heal Container` runs the local `RemuxMKV` plugin,
which no-ops when the file is already MKV. On failure the flow falls through
`Reset Flow Error` → `Force Remux` (`ForceRemuxMKV`), then `Run MKVPropEdit`.

`RemuxMKV` passes `-fflags +genpts`. DivX-packed AVI carries packets with no
timestamps; without generated timestamps the matroska muxer rejects them
(`Can't write packet with unknown timestamp`) and writes a truncated stub — on
one test file, 7 KB and 0.5 s instead of 91 MB and 13 minutes. ffmpeg still
exits non-zero, so the flow takes the error branch, but the failure is silent
in the sense that nothing downstream knows the container never converted.

`Force Remux` (`ForceRemuxMKV`) is the escalation, and it accepts **any**
container. It used to decline anything that was not already Matroska, which
made it a no-op in exactly the case that needed healing: a failed container
conversion carried on in its original container with nothing having repaired
it. That is how one `.avi` reached the audio block still as AVI.

It also has to be more permissive than attempt 1, or it just re-runs the same
command and fails identically — the two presets used to be byte-identical. It
now adds `+igndts`, much larger `analyzeduration`/`probesize`, `-err_detect
ignore_err` and `-avoid_negative_ts make_zero` on top of `+genpts`. Still a
pure stream copy, so nothing is re-encoded and nothing is lost. On an MKV input
it keeps its original job of rewriting a structurally broken container.

**2. Video.** `Is HEVC?` skips anything already HEVC. Otherwise the flow picks
an encoder by node name: `Nvidia?` routes to NVENC (`Migz1FFMPEG`), `Intel?` to
QuickSync (`Boosh_FFMPEG_QSV_HEVC`), and anything else falls back to a CPU
encode (`Migz1FFMPEG_CPU`) rather than being handed the wrong GPU path.
`Compare File Size Ratio` then guards the result — if the new file isn't
smaller, `Set Original File` discards it and the original is kept.

**3. Language cleanup.** `Remove Non English Tracks` (local `CleanTracks`)
strips non-English audio and subtitles and commentary tracks in a **single
pass**. It replaces the earlier `CleanAudio` + `CleanSubs` pair, which were two
separate classic plugins and therefore two full read-and-rewrites of the file -
on a 30 GB remux, an entire wasted copy. Those two plugins are still in
`plugins/` but are no longer referenced by the flow.

It classifies a subtitle as SDH from either the `hearing_impaired` disposition
flag or an `sdh` in its title, and as commentary from either the `comment`
disposition flag or a `comment` in its title. The two are kept separate on
purpose: an earlier version folded the `sdh` title test into the commentary
test, so `remove_commentary: true` silently deleted SDH tracks and `remove_sdh`
was never consulted. Most releases label SDH in the title without setting the
disposition flag, so that path was the one that actually fired.

Streams with **no** language tag are kept - an untagged track is far more often
the main one than a foreign one. And it never strips the last audio stream:
better a foreign track than a silent file.

**4. Audio.** An ffmpeg-command block that plans one command and executes it
once. Every file ends with **at most two English E-AC3 tracks, surround first**:

| source audio | result |
|---|---|
| surround (4-8ch), with or without a stereo track | E-AC3 surround + E-AC3 2.0 |
| 7.1 | downmixed to 5.1, plus E-AC3 2.0 |
| stereo only | single E-AC3 2.0 @192k |
| mono only | single E-AC3 1.0 @96k, never upmixed |
| no English track | left untouched rather than made silent |

The layout is decided by **channel count alone**. There used to be three
`checkAudioCodec` gates asking "does the file already have eac3/ac3/aac?", and
any hit skipped conversion entirely. That is how a file carrying `DTS 5.1 +
AAC 2.0` ended up as **stereo**: some stream direct-played, so nothing ran, and
the codec drop then removed the surround track. Which track survived was decided
by how the release happened to be packaged. Those three gates are gone.

`Begin Command` snapshots the streams and `Force MKV Container` pins the output
container - not cosmetic, since `Begin Command` seeds the container from
whatever the working file currently is, so without it a failed stage-1 remux
would have the block write E-AC3 into an AVI. Then:

- `Surround Present?` (`checkStreamProperty` on `channels`, matching `4,5,6,7,8`)
  decides the shape. `checkChannelCount` could not express this - it matches one
  exact count - which is why the old design needed a four-node ladder.
- `Ensure E-AC3 Surround 384k` asks for 6 channels and the plugin clamps to
  `min(wanted, available)`, so 8ch → 5.1, 6ch → 5.1, 4ch → 4ch.
- `Ensure E-AC3 Stereo 192k` then always runs, producing the stereo mate. On a
  stereo-only source it is a no-op, because Ensure matches on codec **and**
  exact channel count.
- Files with no surround take `Stereo Present?`, and mono-only files fall
  through to `Ensure E-AC3 Mono 96k`.
- `Normalise Audio Tracks` (local plugin) reduces to one surround and one
  stereo/mono track, preferring E-AC3, then channel count, then bitrate. Ensure
  only *adds*, so without this the original stereo track would survive beside
  the freshly generated one.
- It also **sets the audio order**, putting surround first. `Reorder Streams`
  cannot: its channel map only knows 8/6/2/1, so a 4-channel track sorts as an
  empty string and gets pulled behind a stereo one. `Reorder Streams` is now
  configured for `streamTypes` only.
- `Execute` builds and runs the command. Streams with no output args get
  `-c copy`, so video and subtitles are remuxed, never re-encoded.

The whole block is **idempotent**: on a file that already matches the policy,
both Ensure nodes report "File already has..." and nothing is re-encoded. This
matters, because the flow runs repeatedly over the library.

**5. Finalise.** `File Changed?` (stock `checkFileChanged`) compares the working
file against the original library file — by path *and* by size. If either
differs, something upstream rewrote the file, so `Run MKVPropEdit` re-stamps
statistics tags before `Replace Original File`. If nothing changed, the flow
goes straight to Replace, which also does nothing, and the file is left
byte-identical with its mtime intact.

Every `Run MKVPropEdit` sits behind an `Is MKV?` (`checkFileExtension`) guard.
mkvpropedit refuses anything that is not Matroska, and an unguarded call on a
non-MKV working file fails, sets `flowFailed`, and drags the whole job to a
`transcodeError` verdict even when the media itself is fine.

The final restamp has **no `err1` edge**. It previously routed to
`Replace Original File` on the theory that a tagging failure shouldn't discard
a good transcode — but it cannot distinguish a good transcode from a bad one,
so it committed whatever the pipeline produced, including results from runs
that had already failed upstream. A failed flow must leave the library file
alone; the working copy stays in cache and the job reports the error.

This gate must key off the **file**, not off `ffmpegCommand.shouldProcess`. An
earlier version tested that variable, which only reports whether the *audio*
block did anything. A file that got a video transcode but no audio change —
the common case, since ~90% of the library already carries a compatible audio
codec — took the "unchanged" branch and kept the stats from before the encode.
Such files ended up claiming their original h264 bitrate and byte count while
actually holding a much smaller HEVC stream.

Because the restamp now happens once at the very end, the two earlier
`Run MKVPropEdit` nodes on the remux branches are redundant: anything they
write is invalidated by the video transcode that follows. They are harmless but
each costs a full file read.

## Graph

```mermaid
flowchart TD
    IN[Input File] --> MED{Readable Video?}
    MED -->|other / audio-only| STOP([end, file untouched])
    MED -->|video| REMUX[Remux & Heal Container]
    REMUX -->|processed| PROP1[Run MKVPropEdit]
    REMUX -->|no change| HEVC
    REMUX -.->|err| RST1[Reset Flow Error]
    RST1 --> FORCE[Force Remux]
    FORCE --> PROP2[Run MKVPropEdit]
    FORCE -.->|err| RST2[Reset Flow Error]
    PROP2 -.->|err| RST2
    RST2 --> HEVC
    PROP1 --> HEVC
    PROP2 --> HEVC

    HEVC{Is HEVC?}
    HEVC -->|yes| CLEAN
    HEVC -->|no| NV{Nvidia?}
    NV -->|yes| ENC1[Transcode NVENC]
    NV -->|no| INTEL{Intel?}
    INTEL -->|yes| ENC2[Transcode QuickSync]
    INTEL -->|no| ENC3[Transcode CPU]
    ENC1 -.->|err| ENC3
    ENC2 -.->|err| ENC3
    ENC3 -.->|err| RST3[Reset Flow Error]
    RST3 --> ORIG
    ENC1 --> RATIO{Smaller?}
    ENC2 --> RATIO
    ENC3 --> RATIO
    RATIO -->|yes| CLEAN
    RATIO -->|larger| ORIG[Set Original File]
    ORIG --> CLEAN

    CLEAN[Remove Non English Tracks] --> START[Begin Command]
    CLEAN -.->|err| RST4[Reset Flow Error] --> START

    START --> CONT[Force MKV Container]
    CONT --> SURR{Surround Present?}
    SURR -->|yes| ENSS[Ensure E-AC3 Surround 384k]
    ENSS --> ENST[Ensure E-AC3 Stereo 192k]
    SURR -->|no| ST{Stereo Present?}
    ST -->|yes| ENST
    ST -->|no| ENSM[Ensure E-AC3 Mono 96k]
    ENST --> NORM[Normalise Audio Tracks]
    ENSM --> NORM
    NORM --> ORDER[Reorder Streams]
    ORDER --> EXEC[Execute]

    EXEC --> CHG{File Changed?}
    CHG -->|no| REPL[Replace Original File]
    CHG -->|yes| PROP3[Run MKVPropEdit]
    PROP3 --> REPL

    subgraph audio [Audio ffmpeg command block]
        START
        CONT
        SURR
        ST
        ENSS
        ENST
        ENSM
        NORM
        ORDER
        EXEC
    end
```

## Known wrinkles

- **Enabling the two-track policy means re-encoding essentially the whole
  library.** Every previously-processed file has exactly one audio track, so all
  of them need a stereo mate; AC3 and AAC sources become E-AC3 as well. This is
  a full sweep, not an incremental one.
- **A stereo mate costs roughly 65 MB per 45-minute episode** at 192k. If every
  client you use direct-plays E-AC3 5.1, that second track buys nothing.
- **The three encoder paths use different plugins.** NVENC and CPU use
  `Migz1FFMPEG` / `Migz1FFMPEG_CPU`; QuickSync uses `Boosh_FFMPEG_QSV_HEVC`.
  They have different bitrate logic, so output size varies by which node picks
  up a file. NVENC and QuickSync now fall back to the CPU encoder on failure,
  and a CPU failure reverts to the original and carries on without a transcode.
- **`Execute` deliberately has no error edge.** If ffmpeg fails the working file
  is bad, and every onward path eventually commits it, so failing the job is the
  only safe outcome. Same reasoning as the final `Run MKVPropEdit`.
- **Audio-only files are skipped entirely.** `Readable Video?` routes them to a
  dead end. This is a video pipeline, and the surround+stereo pair makes no
  sense for a music file.
- **Unreadable files are skipped, not repaired.** A truncated download whose
  `moov` atom is missing has no `fileMedium`, so it exits at `Readable Video?`
  with the library file untouched. Previously it burned two failed remuxes and a
  transcode attempt before crashing in `Begin Command`, which has no error edge.
- **A file with no English audio keeps its original track, unconverted.**
  `Ensure Audio Stream` matches the configured language and then falls back to
  `und` for untagged streams, but never to "any language", so a French-only file
  gets nothing generated and `Normalise Audio Tracks` keeps what was there. It
  is not silent and not lost, but it is not normalised either. Converting those
  properly needs a custom plugin.
- **Setting a plugin input to `""` does not mean "unset".** The server's
  `loadDefaultValues` rewrites an empty string to the plugin's default, so a
  blank `language` silently reads as `eng`.
- **The local flow plugins live only in this repo and on the server.** They are
  not maintained upstream and will not survive a plugin folder wipe.
- **E-AC3 cannot be bitstreamed over optical/S/PDIF**, which carries only AC3
  and DTS. Over HDMI/eARC this is a non-issue.
- **AV1 sources are transcoded to HEVC**, which is backwards efficiency-wise.
- **Nothing escalates past `Force Remux`.** If the permissive second attempt
  also fails, the file continues in its original container.
