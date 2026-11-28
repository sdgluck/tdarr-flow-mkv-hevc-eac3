#!/bin/sh
# Radarr/Sonarr "Custom Script" connection: on import or upgrade, ask Tdarr to
# scan the new file so it is queued straight away instead of waiting for the
# library's scheduled find-new scan. See "Queueing new imports" in the README.
#
# Copy into each app's config folder (e.g. /config/scripts/tdarr-scan.sh),
# make it executable, and fill in the settings below.

# ---- settings ---------------------------------------------------------------
TDARR_URL="${TDARR_URL:-http://tdarr:8265}"
# Optional "host:port:address" handed to curl --resolve, for when the arr
# container's DNS cannot resolve TDARR_URL's host (e.g. a name only your LAN's
# DNS knows). TLS still verifies against the real hostname.
TDARR_RESOLVE="${TDARR_RESOLVE:-}"
FILM_DB="${FILM_DB:-replace-with-film-library-id}"   # Tdarr library for Radarr
TV_DB="${TV_DB:-replace-with-tv-library-id}"         # Tdarr library for Sonarr
# Root folder as Radarr/Sonarr see it -> the same folder as Tdarr sees it.
RADARR_FROM="${RADARR_FROM:-/movies/}"; RADARR_TO="${RADARR_TO:-/mnt/media/film/}"
SONARR_FROM="${SONARR_FROM:-/tv/}";     SONARR_TO="${SONARR_TO:-/mnt/media/tv/}"
# -----------------------------------------------------------------------------

post() {
  curl -fsS -m 30 ${TDARR_RESOLVE:+--resolve "$TDARR_RESOLVE"} -X POST "$TDARR_URL/api/v2/$1" \
    -H 'Content-Type: application/json' -d "$2"
}

# JSON-escape a path: backslashes and double quotes.
json_str() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

scan() {
  db="$1"; shift
  list=""
  for p in "$@"; do
    [ -n "$p" ] || continue
    list="$list${list:+,}\"$(json_str "$p")\""
  done
  [ -n "$list" ] || { echo "tdarr-scan: no file paths in event"; exit 0; }
  post scan-files "{\"data\":{\"scanConfig\":{\"dbID\":\"$db\",\"arrayOrPath\":[$list],\"mode\":\"scanFindNew\"}}}" \
    && echo "tdarr-scan: asked Tdarr to scan $*"
}

# Test button: prove Tdarr is reachable from inside this container.
if [ "$radarr_eventtype" = "Test" ] || [ "$sonarr_eventtype" = "Test" ]; then
  post cruddb '{"data":{"collection":"LibrarySettingsJSONDB","mode":"getAll"}}' >/dev/null \
    && echo "tdarr-scan: Tdarr reachable at $TDARR_URL" && exit 0
  echo "tdarr-scan: cannot reach Tdarr at $TDARR_URL" >&2
  exit 1
fi

if [ "$radarr_eventtype" = "Download" ]; then
  scan "$FILM_DB" "$(printf '%s' "$radarr_moviefile_path" | sed "s#^$RADARR_FROM#$RADARR_TO#")"
elif [ "$sonarr_eventtype" = "Download" ]; then
  # A season pack imports several files in one event, joined by "|".
  paths="${sonarr_episodefile_paths:-$sonarr_episodefile_path}"
  old_ifs="$IFS"; IFS='|'
  # shellcheck disable=SC2086
  set -- $paths
  IFS="$old_ifs"
  mapped=""
  for p in "$@"; do
    mapped="$mapped|$(printf '%s' "$p" | sed "s#^$SONARR_FROM#$SONARR_TO#")"
  done
  IFS='|'
  # shellcheck disable=SC2086
  set -- ${mapped#|}
  IFS="$old_ifs"
  scan "$TV_DB" "$@"
fi
exit 0
