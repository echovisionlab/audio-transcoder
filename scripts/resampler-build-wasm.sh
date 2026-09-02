#!/bin/sh
set -eu

EMSCRIPTEN_VERSION=5.0.7
EMSCRIPTEN_IMAGE='emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c'
LIBSAMPLERATE_REVISION=aee38d0bc797d0d1a3774ef574af1d5d248d2398
LIBSAMPLERATE_SHA256=deefc369f627b256724c4785bf32de5a839d8672f573aa17b1c89d6974dee3b3
SOURCE_DATE_EPOCH=1655537613
EXPECTED_FAST_SHA256=2c2bf7a58a90af6c8dcb76a98dc90a042cec538e326ae67f6d69aa907d9f93a0
EXPECTED_BALANCED_SHA256=d68f10254f7b694990092943930e43bc4fa9a2f9775da452490764a062112f1c
EXPECTED_BEST_SHA256=47d03b079057d17bbefcf3b17ea92fc2b0a6ba027b5ea13154b4e2f35177b7d0

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

  build_quality() {
    quality=$1
    converter_type=$2
    fast=$3
    medium=$4
    best=$5
    quality_build="$BUILD_ROOT/build-$quality"

    emcmake cmake -S "$BUILD_ROOT/source" -B "$quality_build" \
      -DBUILD_TESTING=OFF \
      -DLIBSAMPLERATE_EXAMPLES=OFF \
      -DLIBSAMPLERATE_INSTALL=OFF \
      -DLIBSAMPLERATE_ENABLE_SINC_FAST_CONVERTER="$fast" \
      -DLIBSAMPLERATE_ENABLE_SINC_MEDIUM_CONVERTER="$medium" \
      -DLIBSAMPLERATE_ENABLE_SINC_BEST_CONVERTER="$best" \
      -DCMAKE_BUILD_TYPE=MinSizeRel \
      '-DCMAKE_C_FLAGS_MINSIZEREL=-Oz -flto -DNDEBUG -DCONFIG_CHAN_NR=32'
    emmake cmake --build "$quality_build" --target samplerate --parallel 2

    emcc "$REPOSITORY_ROOT/vendor/resampler/libsamplerate-bridge.c" \
      "$quality_build/src/libsamplerate.a" \
      -I"$BUILD_ROOT/source/include" \
      -DRESAMPLER_CONVERTER_TYPE="$converter_type" \
      -Oz -flto -g0 -Wall -Wextra -Werror --no-entry \
      -s STANDALONE_WASM=1 \
      -s FILESYSTEM=0 \
      -s MALLOC=emmalloc \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s INITIAL_MEMORY=2097152 \
      -s MAXIMUM_MEMORY=67108864 \
      -s STACK_SIZE=131072 \
      -s ASSERTIONS=0 \
      -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
      -Wl,--export=wasm_resampler_create \
      -Wl,--export=wasm_resampler_last_create_error \
      -Wl,--export=wasm_resampler_prepare \
      -Wl,--export=wasm_resampler_input \
      -Wl,--export=wasm_resampler_output \
      -Wl,--export=wasm_resampler_process \
      -Wl,--export=wasm_resampler_input_frames_used \
      -Wl,--export=wasm_resampler_output_frames_gen \
      -Wl,--export=wasm_resampler_destroy \
      -o "$BUILD_ROOT/resampler-$quality.wasm"
  }

  build_quality fast 2 ON OFF OFF
  build_quality balanced 1 OFF ON OFF
  build_quality best 0 OFF OFF ON
  exit 0
fi

REPOSITORY_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
MODE=verify-reproduction
MODE_WAS_SET=false
SOURCE_DIRECTORY=
OUTPUT_DIRECTORY=

usage() {
  cat <<'EOF'
Usage: resampler-build-wasm.sh [--verify-reproduction | --relink] [--source-dir DIR] [--output-dir DIR]

  --verify-reproduction  Require all three audited resampler WASM hashes.
                         This is the default mode.
  --relink               Allow modified source output. --output-dir is required
                         and checked-in artifacts are never overwritten.
  --source-dir DIR       Read the pinned libsamplerate archive from DIR.
  --output-dir DIR       Write raw resampler-*.wasm files to DIR instead of
                         embedding them in TypeScript.
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

BUILD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/audio-transcoder-resampler.XXXXXX")
trap 'rm -rf "$BUILD_ROOT"' EXIT HUP INT TERM

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ -n "$SOURCE_DIRECTORY" ]; then
  SOURCE_ARCHIVE=$SOURCE_DIRECTORY/libsamplerate-${LIBSAMPLERATE_REVISION}.tar.gz
  if [ ! -f "$SOURCE_ARCHIVE" ]; then
    echo "Missing libsamplerate source archive: $SOURCE_ARCHIVE" >&2
    exit 1
  fi
else
  SOURCE_ARCHIVE=$BUILD_ROOT/libsamplerate-${LIBSAMPLERATE_REVISION}.tar.gz
  curl --fail --location --retry 3 --silent --show-error \
    --output "$SOURCE_ARCHIVE" \
    "https://github.com/libsndfile/libsamplerate/archive/${LIBSAMPLERATE_REVISION}.tar.gz"
fi
actual=$(sha256_file "$SOURCE_ARCHIVE")
if [ "$actual" != "$LIBSAMPLERATE_SHA256" ]; then
  echo "libsamplerate SHA-256 mismatch: expected $LIBSAMPLERATE_SHA256, got $actual" >&2
  exit 1
fi

mkdir -p "$BUILD_ROOT/source"
tar -xzf "$SOURCE_ARCHIVE" \
  -C "$BUILD_ROOT/source" --strip-components=1

docker run --rm \
  --platform linux/arm64/v8 \
  -e LC_ALL=C \
  -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  -e TZ=UTC \
  -v "$REPOSITORY_ROOT:/repo:ro" \
  -v "$BUILD_ROOT:/build" \
  "$EMSCRIPTEN_IMAGE" \
  /repo/scripts/resampler-build-wasm.sh --compile /build /repo

for quality in best balanced fast; do
  case "$quality" in
    best) expected_sha=$EXPECTED_BEST_SHA256 ;;
    balanced) expected_sha=$EXPECTED_BALANCED_SHA256 ;;
    fast) expected_sha=$EXPECTED_FAST_SHA256 ;;
  esac
  actual_sha=$(sha256_file "$BUILD_ROOT/resampler-$quality.wasm")
  if [ "$MODE" = verify-reproduction ] && [ "$actual_sha" != "$expected_sha" ]; then
    echo "Resampler $quality WASM SHA-256 mismatch: expected $expected_sha, got $actual_sha" >&2
    exit 1
  fi
  if [ -n "$OUTPUT_DIRECTORY" ]; then
    mkdir -p "$OUTPUT_DIRECTORY"
    cp "$BUILD_ROOT/resampler-$quality.wasm" "$OUTPUT_DIRECTORY/resampler-$quality.wasm"
    printf 'Wrote %s (%s)\n' "$OUTPUT_DIRECTORY/resampler-$quality.wasm" "$actual_sha"
  else
    node "$REPOSITORY_ROOT/scripts/resampler-embed-wasm.mjs" \
      "$quality" \
      "$BUILD_ROOT/resampler-$quality.wasm" \
      "$REPOSITORY_ROOT/src/stream/resampler-wasm-$quality-binary.ts"
  fi
done
