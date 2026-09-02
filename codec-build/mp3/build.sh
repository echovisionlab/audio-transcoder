#!/usr/bin/env bash
set -euo pipefail

readonly LAME_VERSION='3.100'
readonly LAME_ARCHIVE_SHA256='ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e'
readonly EMSCRIPTEN_VERSION='5.0.7'
readonly EMSDK_IMAGE='emscripten/emsdk@sha256:19b3a361d84262c1cd133a29fb84368678bab32aee47e074fcd83a216566330c'
readonly SOURCE_EPOCH='1784408064'
readonly EXPECTED_ARTIFACT_SHA256='b0e3a6768c25baf7103557f31ac0f18f86be721796e999605cc9544090e72315'

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIRECTORY

mode='verify-reproduction'
mode_was_set='false'
source_directory=''
source_tree=''
output_directory=''

usage() {
  cat <<'EOF'
Usage: build.sh [--verify-reproduction | --relink] [--source-dir DIR | --source-tree DIR] [--output-dir DIR]

  --verify-reproduction  Require the audited MP3 WASM hash. This is the default.
  --relink               Allow modified source output. --output-dir is required
                         and checked-in artifacts are never overwritten.
  --source-dir DIR       Read lame-3.100.tar.gz from DIR instead of downloading.
  --source-tree DIR      Relink a modified LAME source tree. Valid only with
                         --relink; the tree is copied before building.
  --output-dir DIR       Write mp3.wasm to DIR.
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

REPOSITORY_ROOT="$(cd "${SCRIPT_DIRECTORY}/../.." && pwd -P)"
readonly REPOSITORY_ROOT
if [[ -n "${source_directory}" ]]; then
  source_directory="$(cd "${source_directory}" && pwd -P)"
fi
if [[ -n "${source_tree}" ]]; then
  source_tree="$(cd "${source_tree}" && pwd -P)"
fi

if [[ -z "${output_directory}" ]]; then
  readonly OUTPUT_PATH="${SCRIPT_DIRECTORY}/mp3.wasm"
else
  if [[ ! -d "${output_directory}" ]]; then
    echo '--output-dir must be an existing directory.' >&2
    exit 2
  fi
  output_directory="$(cd "${output_directory}" && pwd -P)"
  case "${output_directory}/" in
    "${REPOSITORY_ROOT}/"*)
      echo '--output-dir must be outside the repository.' >&2
      exit 2
      ;;
  esac
  readonly OUTPUT_PATH="${output_directory}/mp3.wasm"
fi

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/audio-transcoder-mp3-build.XXXXXX")"
readonly BUILD_ROOT

cleanup() {
  rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [[ -n "${source_tree}" ]]; then
  SOURCE_ARCHIVE=''
elif [[ -n "${source_directory}" ]]; then
  readonly SOURCE_ARCHIVE="${source_directory}/lame-${LAME_VERSION}.tar.gz"
  [[ -f "${SOURCE_ARCHIVE}" ]] || {
    echo "Missing LAME source archive: ${SOURCE_ARCHIVE}" >&2
    exit 1
  }
else
  readonly SOURCE_ARCHIVE="${BUILD_ROOT}/lame-${LAME_VERSION}.tar.gz"
  curl --fail --location --retry 3 --silent --show-error \
    "https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz" \
    --output "${SOURCE_ARCHIVE}"
fi

if [[ -z "${source_tree}" ]]; then
  actual_source_sha="$(sha256_file "${SOURCE_ARCHIVE}")"
  if [[ "${actual_source_sha}" != "${LAME_ARCHIVE_SHA256}" ]]; then
    echo "LAME source hash mismatch: ${actual_source_sha}" >&2
    exit 1
  fi
fi

mkdir "${BUILD_ROOT}/source" "${BUILD_ROOT}/out"
if [[ -n "${source_tree}" ]]; then
  cp -R "${source_tree}/." "${BUILD_ROOT}/source"
else
  tar -xzf "${SOURCE_ARCHIVE}" \
    -C "${BUILD_ROOT}/source" \
    --strip-components=1
fi

docker run --rm \
  --platform linux/arm64/v8 \
  -e SOURCE_DATE_EPOCH="${SOURCE_EPOCH}" \
  -e ZERO_AR_DATE=1 \
  -e LC_ALL=C \
  -e TZ=UTC \
  -v "${SCRIPT_DIRECTORY}:/bridge:ro" \
  -v "${BUILD_ROOT}:/work" \
  -w /work/source \
  "${EMSDK_IMAGE}" \
  bash -lc '
    case "$(emcc --version | sed -n "1p")" in
      *"'"${EMSCRIPTEN_VERSION}"'"*) ;;
      *) echo "Unexpected Emscripten version: $(emcc --version | sed -n "1p")" >&2; exit 1 ;;
    esac
    export CFLAGS="-DNDEBUG -DNO_STDIO -Oz -flto -msimd128 -ffile-prefix-map=/work=."
    export LDFLAGS="-Oz -flto"
    emconfigure ./configure \
      --disable-dependency-tracking \
      --disable-shared \
      --enable-static \
      --disable-gtktest \
      --disable-analyzer-hooks \
      --disable-decoder \
      --disable-frontend
    emmake make clean
    emmake make -j8
    emcc /bridge/bridge.c \
      libmp3lame/.libs/libmp3lame.a \
      -Iinclude \
      -DNDEBUG -Oz -flto -g0 -msimd128 --no-entry \
      -s STANDALONE_WASM=1 \
      -s FILESYSTEM=0 \
      -s MALLOC=emmalloc \
      -s ALLOW_MEMORY_GROWTH=1 \
      -s INITIAL_MEMORY=4194304 \
      -s MAXIMUM_MEMORY=67108864 \
      -s STACK_SIZE=262144 \
      -s ASSERTIONS=0 \
      -s ERROR_ON_UNDEFINED_SYMBOLS=1 \
      -Wl,--strip-all \
      -Wl,--export=wasm_mp3_abi_version \
      -Wl,--export=wasm_mp3_create \
      -Wl,--export=wasm_mp3_last_create_error \
      -Wl,--export=wasm_mp3_prepare_pcm \
      -Wl,--export=wasm_mp3_encode \
      -Wl,--export=wasm_mp3_flush \
      -Wl,--export=wasm_mp3_output \
      -Wl,--export=wasm_mp3_reset \
      -Wl,--export=wasm_mp3_destroy \
      -o /work/out/mp3.wasm
  '

actual_artifact_sha="$(sha256_file "${BUILD_ROOT}/out/mp3.wasm")"
if [[ "${mode}" == 'verify-reproduction' && "${actual_artifact_sha}" != "${EXPECTED_ARTIFACT_SHA256}" ]]; then
  echo "MP3 artifact hash mismatch: ${actual_artifact_sha}" >&2
  exit 1
fi

cp "${BUILD_ROOT}/out/mp3.wasm" "${OUTPUT_PATH}"
printf 'Wrote %s (%s)\n' "${OUTPUT_PATH}" "${actual_artifact_sha}"
