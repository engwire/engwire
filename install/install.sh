#!/bin/sh
# Engwire installer — downloads a release binary and puts it on PATH.
#
# Deliberately small: everything beyond fetching the right artifact belongs in
# the binary, where it can be tested, rather than in a script that is piped into
# a shell. Service installation is `engwire service install`.
set -eu

REPO="engwire/engwire"
PREFIX="${ENGWIRE_PREFIX:-$HOME/.local/bin}"
VERSION="${ENGWIRE_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "Unsupported OS: $(uname -s). Windows is not supported yet." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Releases ship gzipped: the binary carries its own runtime, so compressing it
# saves about 60% of every install and upgrade. There is no checksum to publish
# alongside it — it would come from the same origin over the same TLS, and gzip
# already refuses a truncated download.
asset="engwire-${os}-${arch}.gz"
# Releases are tagged `v<version>`, but a version is what people have in hand.
case "$VERSION" in
  latest) url="https://github.com/${REPO}/releases/latest/download/${asset}" ;;
  *)      want="${VERSION#v}"
          url="https://github.com/${REPO}/releases/download/v${want}/${asset}" ;;
esac

# Staged inside the destination so the install is one rename on one filesystem.
# Downloading to /tmp and moving would fall back to copy-and-delete whenever
# $HOME is a separate mount, and an interrupted upgrade would leave a truncated
# binary where a working one used to be.
[ -e "$PREFIX/engwire" ] && upgrade=yes || upgrade=no
mkdir -p "$PREFIX"
tmp="$(mktemp -d "$PREFIX/.engwire-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset}..."
curl -fsSL "$url" -o "$tmp/engwire.gz"
gzip -d "$tmp/engwire.gz"
chmod +x "$tmp/engwire"

# Run it before it replaces anything. Staging in $PREFIX already means "do not
# destroy the old executable until the replacement is ready", and decompressed
# is not ready: an unsupported CPU or libc, or a packaging mistake, would
# otherwise trade a working install for one that cannot start.
reported="$("$tmp/engwire" --version)"

# And since it just said which version it is, ENGWIRE_VERSION can mean something
# rather than only choosing a URL: a pin is worth checking against what arrived
# rather than inferring from the address it came from.
if [ "$VERSION" != latest ] && [ "$reported" != "$want" ]; then
  echo "Asked for Engwire $want, but the download reports $reported." >&2
  exit 1
fi

# A rename, so a running runner keeps the binary it started with and finishes
# the review it may be in the middle of.
mv "$tmp/engwire" "$PREFIX/engwire"

echo "Installed $PREFIX/engwire"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "Add $PREFIX to your PATH." ;;
esac
echo
# launchd keeps running the binary it started, so an upgrade reaches the
# background runner only when the service is installed again.
if [ "$upgrade" = yes ]; then
  echo "Running in the background? Reinstall the service to pick this up: engwire service install"
else
  echo "Next: engwire setup"
fi
