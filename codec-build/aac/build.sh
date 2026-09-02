#!/usr/bin/env bash
set -euo pipefail

readonly FFMPEG_VERSION='8.1.2'
readonly FFMPEG_ARCHIVE_SHA256='464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c'
readonly EMSDK_IMAGE='emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c'
readonly SOURCE_EPOCH='1781664417'
readonly EXPECTED_GLUE_SHA256='e1e8467b25fa8401580617ed359067b07c8ceaf5ae662112265040cdba686283'
readonly EXPECTED_WASM_SHA256='90c75819c422afbbb2feb0ba8e9e4ec94a004d800799cfa083182359e5497efc'

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(cd "${SCRIPT_DIRECTORY}/../.." && pwd)"
readonly REPOSITORY_ROOT

mode='verify-reproduction'
mode_was_set='false'
source_directory=''
source_tree=''
output_directory=''

usage() {
  cat <<'EOF'
Usage: build.sh [--verify-reproduction | --relink] [--source-dir DIR | --source-tree DIR] [--output-dir DIR]

  --verify-reproduction  Require the audited AAC JavaScript and WASM hashes.
                         This is the default mode.
  --relink               Allow modified source output. --output-dir is required
                         and checked-in artifacts are never overwritten.
  --source-dir DIR       Read ffmpeg-8.1.2.tar.xz from DIR instead of downloading.
  --source-tree DIR      Relink a modified FFmpeg source tree. Valid only with
                         --relink; the tree is copied before building.
  --output-dir DIR       Write aac.generated.mjs and aac.wasm to DIR.
EOF
}

while (($# > 0)); do
  case "$1" in
    --verify-reproduction)
      [[ "${mode_was_set}" == 'false' || "${mode}" == 'verify-reproduction' ]] || { echo 'Choose exactly one build mode.' >&2; exit 2; }
      mode='verify-reproduction'
      mode_was_set='true'
      ;;
    --relink)
      [[ "${mode_was_set}" == 'false' || "${mode}" == 'relink' ]] || { echo 'Choose exactly one build mode.' >&2; exit 2; }
      mode='relink'
      mode_was_set='true'
      ;;
    --source-dir)
      [[ $# -ge 2 ]] || { echo '--source-dir requires a directory.' >&2; exit 2; }
      source_directory=$2
      shift
      ;;
    --source-tree)
      [[ $# -ge 2 ]] || { echo '--source-tree requires a directory.' >&2; exit 2; }
      source_tree=$2
      shift
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || { echo '--output-dir requires a directory.' >&2; exit 2; }
      output_directory=$2
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

if [[ "${mode}" == 'relink' && -z "${output_directory}" ]]; then
  echo '--relink requires --output-dir so checked-in artifacts cannot be overwritten.' >&2
  exit 2
fi
if [[ -n "${source_directory}" && -n "${source_tree}" ]]; then
  echo 'Choose either --source-dir or --source-tree.' >&2
  exit 2
fi
if [[ -n "${source_tree}" && "${mode}" != 'relink' ]]; then
  echo '--source-tree is valid only with --relink.' >&2
  exit 2
fi

REPOSITORY_ROOT_REAL="$(cd "${REPOSITORY_ROOT}" && pwd -P)"
readonly REPOSITORY_ROOT_REAL
if [[ -n "${source_directory}" ]]; then
  source_directory="$(cd "${source_directory}" && pwd -P)"
fi
if [[ -n "${source_tree}" ]]; then
  source_tree="$(cd "${source_tree}" && pwd -P)"
fi

if [[ -z "${output_directory}" ]]; then
  readonly GLUE_OUTPUT_PATH="${REPOSITORY_ROOT}/src/stream/runtime/aac.generated.mjs"
  readonly WASM_OUTPUT_PATH="${SCRIPT_DIRECTORY}/aac.wasm"
else
  if [[ ! -d "${output_directory}" ]]; then
    echo '--output-dir must be an existing directory.' >&2
    exit 2
  fi
  output_directory="$(cd "${output_directory}" && pwd -P)"
  case "${output_directory}/" in
    "${REPOSITORY_ROOT_REAL}/"*)
      echo '--output-dir must be outside the repository.' >&2
      exit 2
      ;;
  esac
  readonly GLUE_OUTPUT_PATH="${output_directory}/aac.generated.mjs"
  readonly WASM_OUTPUT_PATH="${output_directory}/aac.wasm"
fi

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/audio-transcoder-aac-build.XXXXXX")"
readonly BUILD_ROOT

cleanup() {
  rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

mkdir "${BUILD_ROOT}/src" "${BUILD_ROOT}/out"
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
if [[ -n "${source_tree}" ]]; then
  cp -R "${source_tree}/." "${BUILD_ROOT}/src"
elif [[ -n "${source_directory}" ]]; then
  readonly SOURCE_ARCHIVE="${source_directory}/ffmpeg-${FFMPEG_VERSION}.tar.xz"
  [[ -f "${SOURCE_ARCHIVE}" ]] || {
    echo "Missing FFmpeg source archive: ${SOURCE_ARCHIVE}" >&2
    exit 1
  }
else
  readonly SOURCE_ARCHIVE="${BUILD_ROOT}/ffmpeg-${FFMPEG_VERSION}.tar.xz"
  curl --fail --location --silent --show-error \
    "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    --output "${SOURCE_ARCHIVE}"
fi

if [[ -z "${source_tree}" ]]; then
  actual_source_sha="$(sha256_file "${SOURCE_ARCHIVE}")"
  if [[ "${actual_source_sha}" != "${FFMPEG_ARCHIVE_SHA256}" ]]; then
    echo "FFmpeg source hash mismatch: ${actual_source_sha}" >&2
    exit 1
  fi

  tar -xJf "${SOURCE_ARCHIVE}" \
    -C "${BUILD_ROOT}/src" \
    --strip-components=1
fi
cp "${SCRIPT_DIRECTORY}/bridge.c" "${BUILD_ROOT}/bridge.c"

docker run --rm \
  --platform linux/arm64/v8 \
  -e SOURCE_DATE_EPOCH="${SOURCE_EPOCH}" \
  -e ZERO_AR_DATE=1 \
  -e LC_ALL=C \
  -e TZ=UTC \
  -v "${BUILD_ROOT}:/work" \
  -w /work/src \
  "${EMSDK_IMAGE}" \
  bash -lc '
    ./configure \
      --target-os=none \
      --arch=x86_32 \
      --enable-cross-compile \
      --disable-asm \
      --disable-x86asm \
      --disable-inline-asm \
      --disable-programs \
      --disable-doc \
      --disable-debug \
      --disable-all \
      --disable-everything \
      --disable-autodetect \
      --disable-network \
      --disable-pthreads \
      --disable-runtime-cpudetect \
      --disable-gpl \
      --disable-nonfree \
      --enable-avcodec \
      --enable-encoder=aac \
      --cc=emcc \
      --cxx=em++ \
      --ar=emar \
      --nm=emnm \
      --ranlib=emranlib \
      --extra-cflags="-DNDEBUG -Oz -flto -msimd128 -ffile-prefix-map=/work=." \
      --extra-ldflags="-Oz -flto"
    emmake make -j8
    emcc /work/bridge.c \
      libavcodec/libavcodec.a \
      libavutil/libavutil.a \
      -I/work/src \
      -s MODULARIZE=1 \
      -s EXPORT_ES6=1 \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s ENVIRONMENT=web,worker \
      -s FILESYSTEM=0 \
      -s MALLOC=emmalloc \
      -s SUPPORT_LONGJMP=0 \
      -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 \
      -s EXPORTED_FUNCTIONS=_malloc,_free \
      -msimd128 \
      -flto \
      -Oz \
      -o /work/out/aac.generated.mjs
  '

node "${SCRIPT_DIRECTORY}/patch-generated-glue.mjs" \
  "${BUILD_ROOT}/out/aac.generated.mjs"

actual_glue_sha="$(sha256_file "${BUILD_ROOT}/out/aac.generated.mjs")"
actual_wasm_sha="$(sha256_file "${BUILD_ROOT}/out/aac.generated.wasm")"

if [[ "${mode}" == 'verify-reproduction' ]]; then
  if [[ "${actual_glue_sha}" != "${EXPECTED_GLUE_SHA256}" ]]; then
    echo "AAC glue hash mismatch: ${actual_glue_sha}" >&2
    exit 1
  fi
  if [[ "${actual_wasm_sha}" != "${EXPECTED_WASM_SHA256}" ]]; then
    echo "AAC WASM hash mismatch: ${actual_wasm_sha}" >&2
    exit 1
  fi
fi

cp "${BUILD_ROOT}/out/aac.generated.mjs" "${GLUE_OUTPUT_PATH}"
cp "${BUILD_ROOT}/out/aac.generated.wasm" "${WASM_OUTPUT_PATH}"
printf 'Wrote %s (%s)\n' "${GLUE_OUTPUT_PATH}" "${actual_glue_sha}"
printf 'Wrote %s (%s)\n' "${WASM_OUTPUT_PATH}" "${actual_wasm_sha}"
