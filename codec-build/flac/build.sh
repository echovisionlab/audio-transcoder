#!/bin/sh
set -eu

FLAC_REVISION=3f1ecff843dd1b8c07fbb5f59425a4ec71fe4f6c
FLAC_ARCHIVE_SHA256=4ace54db53e274f6c73999a644b0a11410f67e5c35c06e4aaa8e5457bbf59f9d
EMSCRIPTEN_VERSION=5.0.7
EMSCRIPTEN_IMAGE='emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c'
SOURCE_DATE_EPOCH=1772631043
EXPECTED_WASM_SHA256=c5af8358bb1ccc99ef3922c15a676aa8c07915ac7c5635cf3a599375fc56ee86

if [ "${1:-}" = "--compile" ]; then
  BUILD_ROOT=$2
  REPOSITORY_ROOT=$3
  case "$(emcc --version | sed -n '1p')" in
    *"${EMSCRIPTEN_VERSION}"*) ;;
    *)
      echo "Expected Emscripten ${EMSCRIPTEN_VERSION}; got: $(emcc --version | sed -n '1p')" >&2
      exit 1
      ;;
  esac

  emcmake cmake -S "$BUILD_ROOT/source" -B "$BUILD_ROOT/build" \
    -DBUILD_PROGRAMS=OFF \
    -DBUILD_CXXLIBS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_TESTING=OFF \
    -DWITH_OGG=OFF \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_MULTITHREADING=OFF \
    -DINSTALL_MANPAGES=OFF \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    '-DCMAKE_C_FLAGS_MINSIZEREL=-DNDEBUG -Oz -flto -msimd128 -ffile-prefix-map=/build/source=.'
  emmake cmake --build "$BUILD_ROOT/build" --target FLAC --parallel 2

  emcc "$REPOSITORY_ROOT/codec-build/flac/bridge.c" \
    "$BUILD_ROOT/build/src/libFLAC/libFLAC.a" \
    -I"$BUILD_ROOT/source/include" \
    -DNDEBUG -Oz -flto -g0 -msimd128 -Wall -Wextra -Werror --no-entry \
    -s STANDALONE_WASM=1 \
    -s FILESYSTEM=0 \
    -s MALLOC=emmalloc \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=4194304 \
    -s MAXIMUM_MEMORY=134217728 \
    -s STACK_SIZE=262144 \
    -s ASSERTIONS=0 \
    -s SUPPORT_LONGJMP=0 \
    -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
    -Wl,--export=wasm_flac_abi_version \
    -Wl,--export=wasm_flac_create \
    -Wl,--export=wasm_flac_last_create_error \
    -Wl,--export=wasm_flac_last_error \
    -Wl,--export=wasm_flac_prepare_pcm \
    -Wl,--export=wasm_flac_pcm \
    -Wl,--export=wasm_flac_encode \
    -Wl,--export=wasm_flac_output \
    -Wl,--export=wasm_flac_output_length \
    -Wl,--export=wasm_flac_frame_count \
    -Wl,--export=wasm_flac_frame_size \
    -Wl,--export=wasm_flac_frame_samples \
    -Wl,--export=wasm_flac_header \
    -Wl,--export=wasm_flac_header_length \
    -Wl,--export=wasm_flac_finish \
    -Wl,--export=wasm_flac_reset \
    -Wl,--export=wasm_flac_destroy \
    -o "$BUILD_ROOT/flac.wasm"
  exit 0
fi

REPOSITORY_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
SCRIPT_DIRECTORY=$REPOSITORY_ROOT/codec-build/flac
MODE=verify-reproduction
MODE_WAS_SET=false
SOURCE_DIRECTORY=
SOURCE_TREE=
OUTPUT_DIRECTORY=

usage() {
  cat <<'EOF'
Usage: build.sh [--verify-reproduction | --relink] [--source-dir DIR | --source-tree DIR] [--output-dir DIR]

  --verify-reproduction  Require the audited FLAC WASM hash. This is the default.
  --relink               Allow modified source output. --output-dir is required
                         and checked-in artifacts are never overwritten.
  --source-dir DIR       Read the pinned libFLAC archive from DIR.
  --source-tree DIR      Relink a modified libFLAC source tree. Valid only with
                         --relink; the tree is copied before building.
  --output-dir DIR       Write flac.wasm to DIR.
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
    --source-tree)
      [ "$#" -ge 2 ] || { echo '--source-tree requires a directory.' >&2; exit 2; }
      SOURCE_TREE=$2
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
if [ -n "$SOURCE_DIRECTORY" ] && [ -n "$SOURCE_TREE" ]; then
  echo 'Choose either --source-dir or --source-tree.' >&2
  exit 2
fi
if [ -n "$SOURCE_TREE" ] && [ "$MODE" != relink ]; then
  echo '--source-tree is valid only with --relink.' >&2
  exit 2
fi
if [ -n "$SOURCE_DIRECTORY" ]; then
  SOURCE_DIRECTORY=$(CDPATH='' cd -- "$SOURCE_DIRECTORY" && pwd -P)
fi
if [ -n "$SOURCE_TREE" ]; then
  SOURCE_TREE=$(CDPATH='' cd -- "$SOURCE_TREE" && pwd -P)
fi

if [ -z "$OUTPUT_DIRECTORY" ]; then
  OUTPUT_PATH=$SCRIPT_DIRECTORY/flac.wasm
else
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
  OUTPUT_PATH=$OUTPUT_DIRECTORY/flac.wasm
fi

BUILD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/audio-transcoder-flac.XXXXXX")
trap 'rm -rf "$BUILD_ROOT"' EXIT HUP INT TERM

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ -n "$SOURCE_TREE" ]; then
  SOURCE_ARCHIVE=
elif [ -n "$SOURCE_DIRECTORY" ]; then
  SOURCE_ARCHIVE=$SOURCE_DIRECTORY/flac-${FLAC_REVISION}.tar.gz
  if [ ! -f "$SOURCE_ARCHIVE" ]; then
    echo "Missing libFLAC source archive: $SOURCE_ARCHIVE" >&2
    exit 1
  fi
else
  SOURCE_ARCHIVE=$BUILD_ROOT/flac-${FLAC_REVISION}.tar.gz
  curl --fail --location --retry 3 --silent --show-error \
    --output "$SOURCE_ARCHIVE" \
    "https://github.com/xiph/flac/archive/${FLAC_REVISION}.tar.gz"
fi
if [ -z "$SOURCE_TREE" ]; then
  actual_source_sha=$(sha256_file "$SOURCE_ARCHIVE")
  if [ "$actual_source_sha" != "$FLAC_ARCHIVE_SHA256" ]; then
    echo "libFLAC source SHA-256 mismatch: expected $FLAC_ARCHIVE_SHA256, got $actual_source_sha" >&2
    exit 1
  fi
fi

mkdir -p "$BUILD_ROOT/source"
if [ -n "$SOURCE_TREE" ]; then
  cp -R "$SOURCE_TREE/." "$BUILD_ROOT/source"
else
  tar -xzf "$SOURCE_ARCHIVE" \
    -C "$BUILD_ROOT/source" --strip-components=1
fi

docker run --rm \
  --platform linux/arm64/v8 \
  -e LC_ALL=C \
  -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  -e TZ=UTC \
  -e ZERO_AR_DATE=1 \
  -v "$REPOSITORY_ROOT:/repo:ro" \
  -v "$BUILD_ROOT:/build" \
  "$EMSCRIPTEN_IMAGE" \
  sh /repo/codec-build/flac/build.sh --compile /build /repo

actual_wasm_sha=$(sha256_file "$BUILD_ROOT/flac.wasm")
if [ "$MODE" = verify-reproduction ] && [ "$actual_wasm_sha" != "$EXPECTED_WASM_SHA256" ]; then
  echo "FLAC WASM SHA-256 mismatch: expected $EXPECTED_WASM_SHA256, got $actual_wasm_sha" >&2
  exit 1
fi

cp "$BUILD_ROOT/flac.wasm" "$OUTPUT_PATH"
if [ "$OUTPUT_PATH" = "$SCRIPT_DIRECTORY/flac.wasm" ]; then
  node "$SCRIPT_DIRECTORY/verify.mjs"
fi
printf 'Wrote %s (%s)\n' "$OUTPUT_PATH" "$actual_wasm_sha"
