#!/usr/bin/env bash
# The Linux app as people get it, on a runner with nothing of OwnBase's on it:
# the .deb installs where its launcher, links and AppArmor profile say it
# does, and the installed app and the AppImage each start with Chromium's
# sandbox and say which build they are. Ubuntu 24.04 refuses unprivileged
# user namespaces to programs without an AppArmor profile, which the sandbox
# needs where it cannot be setuid (an AppImage), so each start is tried with
# that restriction on, as a fresh Ubuntu has it, and the AppImage without it.
#
#   scripts/release-linux-gates.sh <AppImage> <deb> <version> <revision>
set -euo pipefail

appimage=$(realpath "$1")
deb=$(realpath "$2")
version=$3
revision=$4
fail() {
  echo "::error::$1"
  exit 1
}

restriction=kernel.apparmor_restrict_unprivileged_userns
restrict() {
  if sysctl -n "$restriction" >/dev/null 2>&1; then
    sudo sysctl -q -w "$restriction=$1"
    echo "$restriction=$(sysctl -n "$restriction")"
  else
    echo "This kernel has no $restriction."
  fi
}

# Starts the app under a virtual display, waits for it to say which data
# folder it uses and which build it is, then stops it. Exit status 0 when it
# said so with the right version and revision, with Chromium's sandbox on:
# no process of it started with --no-sandbox, and every renderer under a
# seccomp filter (mode 2). 1 when it did not start, 2 when it ran unsandboxed.
launch() {
  local data report pid said="" processes="" renderers="" unsandboxed=""
  data=$(mktemp -d)
  report="$data.report.json"
  # A session of its own, so stopping it stops every process it started.
  OWNBASE_USER_DATA_DIR="$data" OWNBASE_RELEASE_GATE_REPORT="$report" \
    setsid xvfb-run --auto-servernum "$@" >"$data.log" 2>&1 &
  pid=$!
  for _ in $(seq 60); do
    sleep 1
    kill -0 "$pid" 2>/dev/null || break
    # Taken once Chromium has written the profile too, a moment after.
    if [ -s "$report" ] && [ -e "$data/Local State" ]; then
      said=$(cat "$report")
      break
    fi
  done
  # Its processes, by the session it was started in, once a page has a renderer.
  if [ -n "$said" ]; then
    for _ in $(seq 15); do
      processes=$(ps -o pid=,args= -s "$pid" || true)
      renderers=$(awk '/--type=renderer/ { print $1 }' <<<"$processes")
      [ -n "$renderers" ] && break
      sleep 1
    done
    if grep -q -- "--no-sandbox" <<<"$processes"; then
      echo "It was started with --no-sandbox:"
      grep -- "--no-sandbox" <<<"$processes" | cut -c1-200 | head -n 3
      unsandboxed=1
    fi
    [ -n "$renderers" ] || { echo "No renderer process was found."; unsandboxed=1; }
    for renderer in $renderers; do
      grep -q "^Seccomp:[[:space:]]*2$" "/proc/$renderer/status" 2>/dev/null ||
        { echo "Renderer $renderer runs without a seccomp filter."; unsandboxed=1; }
    done
  fi
  kill -TERM -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$pid" 2>/dev/null || true
  if [ -z "$said" ]; then
    echo "It did not start. Its output:"
    tail -n 20 "$data.log"
    return 1
  fi
  node -e '
    const [said, version, revision] = process.argv.slice(1);
    const report = JSON.parse(said);
    if (report.version !== version) throw new Error(`it is ${report.version}, not ${version}`);
    if (report.revision !== revision) throw new Error(`it was built from ${report.revision}, not ${revision}`);
    console.log(`Started: ${report.version} from ${report.revision.slice(0, 12)}, data in ${report.userData}`);
  ' "$said" "$version" "$revision" || return 1
  if [ -n "$unsandboxed" ]; then return 2; fi
  echo "Sandboxed: no --no-sandbox, and renderers $(echo $renderers) under seccomp."
}

echo "::group::Install the .deb"
dpkg-deb --info "$deb"
if ! sudo dpkg -i "$deb"; then
  # Only what this runner lacks of its dependencies.
  sudo apt-get update -q
  sudo apt-get install -f -y -q
fi
echo "::endgroup::"

[ -x /opt/OwnBase/ownbase ] || fail "the .deb put no app at /opt/OwnBase/ownbase"
[ "$(readlink -f /usr/bin/ownbase)" = /opt/OwnBase/ownbase ] ||
  fail "/usr/bin/ownbase does not lead to the app"
desktop=/usr/share/applications/ownbase.desktop
[ -f "$desktop" ] || fail "the .deb added no launcher at $desktop"
grep -q '^MimeType=.*x-scheme-handler/ownbase' "$desktop" ||
  fail "the launcher does not open ownbase:// links: $(grep MimeType "$desktop" || echo none)"
package=$(dpkg-deb -f "$deb" Package)
# As the .deb's own install script asks.
if sudo apparmor_status --enabled 2>/dev/null; then
  [ -f /etc/apparmor.d/ownbase ] || fail "AppArmor is on, and the .deb installed no profile for the app"
  sudo aa-status | grep -q ownbase || fail "the app's AppArmor profile is not loaded"
  echo "AppArmor profile loaded."
fi

echo "::group::The installed app, with user namespaces restricted"
restrict 1
launch /usr/bin/ownbase || fail "the installed app did not start where user namespaces are restricted"
echo "::endgroup::"

# No FUSE needed: the AppImage unpacks itself and runs from there, which a
# runner can do without libfuse2.
echo "::group::The AppImage"
chmod +x "$appimage"
restrict 0
APPIMAGE_EXTRACT_AND_RUN=1 launch "$appimage" || fail "the AppImage did not start"
echo "::endgroup::"

# What the release notes and DEPLOYMENT.md tell people of Ubuntu 24.04: said
# here as it is, so the words can be checked against a real start.
echo "::group::The AppImage, with user namespaces restricted"
restrict 1
started=0
APPIMAGE_EXTRACT_AND_RUN=1 launch "$appimage" || started=$?
case $started in
  0) echo "::notice::The AppImage starts, sandboxed, even where user namespaces are restricted." ;;
  1) echo "::notice::As expected, the AppImage does not start where user namespaces are restricted; the .deb does." ;;
  *) fail "the AppImage ran without Chromium's sandbox where user namespaces are restricted" ;;
esac
echo "::endgroup::"

sudo dpkg -r "$package"
[ ! -e /opt/OwnBase/ownbase ] || fail "removing the .deb left the app behind"
