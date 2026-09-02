#!/bin/sh
set -eu

EMSCRIPTEN_VERSION=4.0.20
EMSDK_COMMIT=e4fe26ef59168ff44f4c23c466e497bf60b3411e
LIBOPUSENC_VERSION=0.3
LIBOPUSENC_SHA256=f616d3aff9b2034547894ccb8ab56c36cf1a4acb0d922c5d7119f97bbe58642c
LIBOPUS_VERSION=1.6.1
LIBOPUS_SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
LIBOGG_VERSION=1.3.6
LIBOGG_SHA256=5c8253428e181840cd20d41f3ca16557a9cc04bad4a3d04cce84808677fa1061
EXPECTED_WASM_SHA256=ec1d29d65a7e1957e9551e55cc1a74d3679dc8d4c26df4287350590cc1e7734a

MODE=verify-reproduction
MODE_WAS_SET=false
SOURCE_DIRECTORY=
OUTPUT_DIRECTORY=

usage() {
  cat <<'EOF'
Usage: ogg-opus-build-wasm.sh [--verify-reproduction | --relink] [--source-dir DIR] [--output-dir DIR]

  --verify-reproduction  Require the audited Ogg Opus WASM hash. This is the default.
  --relink               Allow modified source output. --output-dir is required
                         and checked-in artifacts are never overwritten.
  --source-dir DIR       Read the pinned libopusenc, Opus, and libogg archives from DIR.
  --output-dir DIR       Write ogg-opus.wasm to DIR instead of embedding it in TypeScript.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-reproduction)
      [ "$MODE_WAS_SET" = false ] || [ "$MODE" = verify-reproduction ] || { echo 'Choose exactly one build mode.' >&2; exit 2; }
      MODE=verify-reproduction
      MODE_WAS_SET=true
      ;;
    --relink)
      [ "$MODE_WAS_SET" = false ] || [ "$MODE" = relink ] || { echo 'Choose exactly one build mode.' >&2; exit 2; }
      MODE=relink
      MODE_WAS_SET=true
      ;;
    --source-dir)
      [ "$#" -ge 2 ] || { echo '--source-dir requires a directory.' >&2; exit 2; }
      SOURCE_DIRECTORY=$2
      shift
      ;;
    --output-dir)
      [ "$#" -ge 2 ] || { echo '--output-dir requires a directory.' >&2; exit 2; }
      OUTPUT_DIRECTORY=$2
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ "$MODE" = relink ] && [ -z "$OUTPUT_DIRECTORY" ]; then
  echo '--relink requires --output-dir so checked-in artifacts cannot be overwritten.' >&2
  exit 2
fi

REPOSITORY_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
if [ -n "$SOURCE_DIRECTORY" ]; then
  SOURCE_DIRECTORY=$(CDPATH='' cd -- "$SOURCE_DIRECTORY" && pwd -P)
fi
if [ -n "$OUTPUT_DIRECTORY" ]; then
  if [ ! -d "$OUTPUT_DIRECTORY" ]; then
    echo '--output-dir must be an existing directory.' >&2
    exit 2
  fi
  OUTPUT_DIRECTORY=$(CDPATH='' cd -- "$OUTPUT_DIRECTORY" && pwd -P)
  case "$OUTPUT_DIRECTORY/" in
    "$REPOSITORY_ROOT/"*)
      echo '--output-dir must be outside the repository.' >&2
      exit 2
      ;;
  esac
fi

if [ "${OGG_OPUS_EMSDK_ROOT:-}" = "" ]; then
  echo "Set OGG_OPUS_EMSDK_ROOT to emsdk commit ${EMSDK_COMMIT} with ${EMSCRIPTEN_VERSION} installed." >&2
  exit 1
fi

if ! actual_emsdk_commit=$(git -C "$OGG_OPUS_EMSDK_ROOT" rev-parse HEAD 2>/dev/null); then
  echo "OGG_OPUS_EMSDK_ROOT must be an emsdk git checkout at ${EMSDK_COMMIT}." >&2
  exit 1
fi
if [ "$actual_emsdk_commit" != "$EMSDK_COMMIT" ]; then
  echo "Expected emsdk commit ${EMSDK_COMMIT}; got: ${actual_emsdk_commit}" >&2
  exit 1
fi

BUILD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/audio-transcoder-ogg-opus.XXXXXX")
trap 'rm -rf "$BUILD_ROOT"' EXIT HUP INT TERM

# emsdk_env.sh is the supported way to select the pinned compiler toolchain.
# shellcheck disable=SC1091
. "$OGG_OPUS_EMSDK_ROOT/emsdk_env.sh" >/dev/null

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

case "$(emcc --version | sed -n '1p')" in
  *"${EMSCRIPTEN_VERSION}"*) ;;
  *)
    echo "Expected Emscripten ${EMSCRIPTEN_VERSION}; got: $(emcc --version | sed -n '1p')" >&2
    exit 1
    ;;
esac

resolve_and_verify_archive() {
  filename=$1
  url=$2
  expected=$3
  if [ -n "$SOURCE_DIRECTORY" ]; then
    archive=$SOURCE_DIRECTORY/$filename
    if [ ! -f "$archive" ]; then
      echo "Missing source archive: $archive" >&2
      exit 1
    fi
  else
    archive=$BUILD_ROOT/$filename
    curl --fail --location --retry 3 --silent --show-error --output "$archive" "$url"
  fi
  actual=$(sha256_file "$archive")
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 mismatch for $archive: expected $expected, got $actual" >&2
    exit 1
  fi
  printf '%s\n' "$archive"
}

LIBOPUSENC_ARCHIVE=$(resolve_and_verify_archive \
  "libopusenc-${LIBOPUSENC_VERSION}.tar.gz" \
  "https://downloads.xiph.org/releases/opus/libopusenc-${LIBOPUSENC_VERSION}.tar.gz" \
  "$LIBOPUSENC_SHA256")
LIBOPUS_ARCHIVE=$(resolve_and_verify_archive \
  "opus-${LIBOPUS_VERSION}.tar.gz" \
  "https://downloads.xiph.org/releases/opus/opus-${LIBOPUS_VERSION}.tar.gz" \
  "$LIBOPUS_SHA256")
LIBOGG_ARCHIVE=$(resolve_and_verify_archive \
  "libogg-${LIBOGG_VERSION}.tar.xz" \
  "https://downloads.xiph.org/releases/ogg/libogg-${LIBOGG_VERSION}.tar.xz" \
  "$LIBOGG_SHA256")

mkdir -p "$BUILD_ROOT/source" "$BUILD_ROOT/prefix"
tar -xzf "$LIBOPUSENC_ARCHIVE" -C "$BUILD_ROOT/source"
tar -xzf "$LIBOPUS_ARCHIVE" -C "$BUILD_ROOT/source"
tar -xJf "$LIBOGG_ARCHIVE" -C "$BUILD_ROOT/source"

COMMON_CFLAGS="-Oz -flto -DNDEBUG"
export CFLAGS="$COMMON_CFLAGS"
export CPPFLAGS="-I$BUILD_ROOT/prefix/include"
export LDFLAGS="-L$BUILD_ROOT/prefix/lib -flto"
export PKG_CONFIG_PATH="$BUILD_ROOT/prefix/lib/pkgconfig"
export DEPS_CFLAGS="-I$BUILD_ROOT/prefix/include/opus"
export DEPS_LIBS="-L$BUILD_ROOT/prefix/lib -lopus"

cd "$BUILD_ROOT/source/libogg-${LIBOGG_VERSION}"
emconfigure ./configure \
  --prefix="$BUILD_ROOT/prefix" \
  --disable-shared \
  --enable-static
emmake make -j2
emmake make install

cd "$BUILD_ROOT/source/opus-${LIBOPUS_VERSION}"
emconfigure ./configure \
  --prefix="$BUILD_ROOT/prefix" \
  --disable-doc \
  --disable-extra-programs \
  --disable-intrinsics \
  --disable-rtcd \
  --disable-shared \
  --enable-static
emmake make -j2
emmake make install

cd "$BUILD_ROOT/source/libopusenc-${LIBOPUSENC_VERSION}"
emconfigure ./configure \
  --prefix="$BUILD_ROOT/prefix" \
  --disable-doc \
  --disable-examples \
  --disable-shared \
  --enable-static
emmake make -j2
emmake make install

WASM_OUTPUT="$BUILD_ROOT/ogg-opus-libopusenc.wasm"
emcc "$REPOSITORY_ROOT/vendor/ogg-opus/ogg-opus-libopusenc-bridge.c" \
  "$BUILD_ROOT/prefix/lib/libopusenc.a" \
  "$BUILD_ROOT/prefix/lib/libopus.a" \
  "$BUILD_ROOT/prefix/lib/libogg.a" \
  -I"$BUILD_ROOT/prefix/include" \
  -I"$BUILD_ROOT/prefix/include/opus" \
  -Oz -flto --no-entry \
  -s STANDALONE_WASM=1 \
  -s FILESYSTEM=0 \
  -s MALLOC=emmalloc \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=8388608 \
  -s MAXIMUM_MEMORY=67108864 \
  -s STACK_SIZE=1048576 \
  -s ASSERTIONS=0 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
  -Wl,--export=wasm_ogg_opus_create \
  -Wl,--export=wasm_ogg_opus_last_create_error \
  -Wl,--export=wasm_ogg_opus_pcm \
  -Wl,--export=wasm_ogg_opus_pcm_capacity_frames \
  -Wl,--export=wasm_ogg_opus_max_page_bytes \
  -Wl,--export=wasm_ogg_opus_write \
  -Wl,--export=wasm_ogg_opus_drain \
  -Wl,--export=wasm_ogg_opus_pull_page \
  -Wl,--export=wasm_ogg_opus_page \
  -Wl,--export=wasm_ogg_opus_page_length \
  -Wl,--export=wasm_ogg_opus_eos_seen \
  -Wl,--export=wasm_ogg_opus_destroy \
  -o "$WASM_OUTPUT"

actual_wasm_sha=$(sha256_file "$WASM_OUTPUT")
if [ "$MODE" = verify-reproduction ] && [ "$actual_wasm_sha" != "$EXPECTED_WASM_SHA256" ]; then
  echo "Ogg Opus WASM SHA-256 mismatch: expected $EXPECTED_WASM_SHA256, got $actual_wasm_sha" >&2
  exit 1
fi

if [ -n "$OUTPUT_DIRECTORY" ]; then
  mkdir -p "$OUTPUT_DIRECTORY"
  cp "$WASM_OUTPUT" "$OUTPUT_DIRECTORY/ogg-opus.wasm"
  printf 'Wrote %s (%s)\n' "$OUTPUT_DIRECTORY/ogg-opus.wasm" "$actual_wasm_sha"
else
  node "$REPOSITORY_ROOT/scripts/ogg-opus-embed-wasm.mjs" \
    "$WASM_OUTPUT" \
    "$REPOSITORY_ROOT/src/stream/runtime/ogg-opus-wasm-binary.ts"
fi
