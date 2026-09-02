/*
 * Deterministic, bounded bridge around libopusenc's pull API.
 *
 * This file is project code. The linked Xiph libraries and their exact source
 * archives are recorded in ogg-opus-PROVENANCE.md.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <ogg/ogg.h>
#include <opus.h>
#include <opusenc.h>

#define OPUS_SAMPLE_RATE 48000
#define OPUS_FRAME_SAMPLES 960
#define OPUS_MAX_CHANNELS 2
#define OPUS_MAX_PCM_SAMPLES \
  (OPUS_FRAME_SAMPLES * OPUS_MAX_CHANNELS)
#define OGG_MAX_PAGE_BYTES (255 * 255 + 27 + 255)
#define OGG_SERIAL ((opus_int32)0x41554430)

#define OGG_OPUS_ERROR_BAD_STATE -1000
#define OGG_OPUS_ERROR_BAD_PAGE -1001
#define OGG_OPUS_ERROR_BAD_SERIAL -1002
#define OGG_OPUS_ERROR_BAD_SEQUENCE -1003
#define OGG_OPUS_ERROR_BAD_GRANULE -1004
#define OGG_OPUS_ERROR_PAGE_TOO_LARGE -1005

#if defined(__GNUC__)
#define WASM_EXPORT __attribute__((used, visibility("default")))
#else
#define WASM_EXPORT
#endif

typedef struct {
  OggOpusEnc *encoder;
  float pcm[OPUS_MAX_PCM_SAMPLES];
  unsigned char *page;
  opus_int32 page_length;
  opus_int64 frames_written;
  opus_int32 expected_page_sequence;
  int channels;
  int drained;
  int eos_seen;
  int preskip;
  int preskip_seen;
} OggOpusEncoder;

static int last_create_error = OPE_OK;

static int validate_page(OggOpusEncoder *state) {
  ogg_page page;
  int header_length;
  int page_sequence;
  int serial;

  if (state->page == NULL || state->page_length < 27 ||
      state->page_length > OGG_MAX_PAGE_BYTES ||
      memcmp(state->page, "OggS", 4) != 0) {
    return state->page_length > OGG_MAX_PAGE_BYTES
               ? OGG_OPUS_ERROR_PAGE_TOO_LARGE
               : OGG_OPUS_ERROR_BAD_PAGE;
  }

  header_length = 27 + state->page[26];
  if (header_length > state->page_length) return OGG_OPUS_ERROR_BAD_PAGE;

  page.header = state->page;
  page.header_len = header_length;
  page.body = state->page + header_length;
  page.body_len = state->page_length - header_length;

  if (ogg_page_version(&page) != 0) return OGG_OPUS_ERROR_BAD_PAGE;
  serial = ogg_page_serialno(&page);
  if ((opus_int32)serial != OGG_SERIAL) return OGG_OPUS_ERROR_BAD_SERIAL;
  page_sequence = ogg_page_pageno(&page);
  if (page_sequence != state->expected_page_sequence) {
    return OGG_OPUS_ERROR_BAD_SEQUENCE;
  }
  state->expected_page_sequence++;

  if (page_sequence == 0) {
    const unsigned char *packet = page.body;
    if (!ogg_page_bos(&page) || page.body_len < 19 ||
        memcmp(packet, "OpusHead", 8) != 0) {
      return OGG_OPUS_ERROR_BAD_PAGE;
    }
    state->preskip = packet[10] | (packet[11] << 8);
    state->preskip_seen = 1;
  } else if (ogg_page_bos(&page)) {
    return OGG_OPUS_ERROR_BAD_PAGE;
  }

  if (ogg_page_eos(&page)) {
    const ogg_int64_t expected_granule =
        (ogg_int64_t)state->preskip + (ogg_int64_t)state->frames_written;
    if (!state->preskip_seen || state->eos_seen ||
        ogg_page_granulepos(&page) != expected_granule) {
      return OGG_OPUS_ERROR_BAD_GRANULE;
    }
    state->eos_seen = 1;
  }

  return OPE_OK;
}

WASM_EXPORT uintptr_t wasm_ogg_opus_create(int channels, int bitrate_bps) {
  OggOpusEncoder *state = NULL;
  OggOpusComments *comments = NULL;
  int error = OPE_OK;

  last_create_error = OPE_OK;
  if (channels < 1 || channels > OPUS_MAX_CHANNELS ||
      bitrate_bps < 500 || bitrate_bps > 512000) {
    last_create_error = OPE_BAD_ARG;
    return 0;
  }

  state = (OggOpusEncoder *)calloc(1, sizeof(*state));
  if (state == NULL) {
    last_create_error = OPE_ALLOC_FAIL;
    return 0;
  }
  state->channels = channels;

  comments = ope_comments_create();
  if (comments == NULL) {
    last_create_error = OPE_ALLOC_FAIL;
    free(state);
    return 0;
  }

  state->encoder = ope_encoder_create_pull(
      comments, OPUS_SAMPLE_RATE, channels, 0, &error);
  ope_comments_destroy(comments);
  if (state->encoder == NULL) {
    last_create_error = error;
    free(state);
    return 0;
  }

#define OGG_OPUS_CTL(request)                         \
  do {                                            \
    error = ope_encoder_ctl(state->encoder, request); \
    if (error != OPE_OK) goto fail;               \
  } while (0)

  OGG_OPUS_CTL(OPE_SET_SERIALNO(OGG_SERIAL));
  OGG_OPUS_CTL(OPE_SET_COMMENT_PADDING(0));
  OGG_OPUS_CTL(OPE_SET_DECISION_DELAY(0));
  OGG_OPUS_CTL(OPE_SET_MUXING_DELAY(OPUS_FRAME_SAMPLES));
  OGG_OPUS_CTL(OPUS_SET_BITRATE(bitrate_bps));
  OGG_OPUS_CTL(OPUS_SET_VBR(1));
  OGG_OPUS_CTL(OPUS_SET_VBR_CONSTRAINT(0));
  OGG_OPUS_CTL(OPUS_SET_COMPLEXITY(10));
  OGG_OPUS_CTL(OPUS_SET_DTX(0));

#undef OGG_OPUS_CTL

  error = ope_encoder_flush_header(state->encoder);
  if (error != OPE_OK) goto fail;
  return (uintptr_t)state;

fail:
  last_create_error = error;
  ope_encoder_destroy(state->encoder);
  free(state);
  return 0;
}

WASM_EXPORT int wasm_ogg_opus_last_create_error(void) {
  return last_create_error;
}

WASM_EXPORT uintptr_t wasm_ogg_opus_pcm(uintptr_t handle) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  return state == NULL ? 0 : (uintptr_t)state->pcm;
}

WASM_EXPORT int wasm_ogg_opus_pcm_capacity_frames(void) {
  return OPUS_FRAME_SAMPLES;
}

WASM_EXPORT int wasm_ogg_opus_max_page_bytes(void) {
  return OGG_MAX_PAGE_BYTES;
}

WASM_EXPORT int wasm_ogg_opus_write(uintptr_t handle, int frames) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  int error;
  if (state == NULL || state->encoder == NULL || state->drained || frames < 0 ||
      frames > OPUS_FRAME_SAMPLES) {
    return OGG_OPUS_ERROR_BAD_STATE;
  }
  error = ope_encoder_write_float(state->encoder, state->pcm, frames);
  if (error == OPE_OK) state->frames_written += frames;
  return error;
}

WASM_EXPORT int wasm_ogg_opus_drain(uintptr_t handle) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  int error;
  if (state == NULL || state->encoder == NULL || state->drained) {
    return OGG_OPUS_ERROR_BAD_STATE;
  }
  error = ope_encoder_drain(state->encoder);
  if (error == OPE_OK) state->drained = 1;
  return error;
}

WASM_EXPORT int wasm_ogg_opus_pull_page(uintptr_t handle) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  int result;
  int validation;
  if (state == NULL || state->encoder == NULL) return OGG_OPUS_ERROR_BAD_STATE;
  state->page = NULL;
  state->page_length = 0;
  result = ope_encoder_get_page(
      state->encoder, &state->page, &state->page_length, 0);
  if (result <= 0) return result;
  validation = validate_page(state);
  return validation == OPE_OK ? 1 : validation;
}

WASM_EXPORT uintptr_t wasm_ogg_opus_page(uintptr_t handle) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  return state == NULL ? 0 : (uintptr_t)state->page;
}

WASM_EXPORT int wasm_ogg_opus_page_length(uintptr_t handle) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  return state == NULL ? 0 : state->page_length;
}

WASM_EXPORT int wasm_ogg_opus_eos_seen(uintptr_t handle) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  return state == NULL ? 0 : state->eos_seen;
}

WASM_EXPORT void wasm_ogg_opus_destroy(uintptr_t handle) {
  OggOpusEncoder *state = (OggOpusEncoder *)handle;
  if (state == NULL) return;
  if (state->encoder != NULL) ope_encoder_destroy(state->encoder);
  memset(state, 0, sizeof(*state));
  free(state);
}
