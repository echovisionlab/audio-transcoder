/*
 * Copyright (c) 2026-present, Echo Vision Lab contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Adapted from the MediaBunny FLAC encoder bridge at commit
 * 794b84884f1e23cb6241689b3563190d138bbd9a. The Echo Vision Lab bridge removes the
 * nested Worker protocol and exposes a versioned, synchronous raw-WASM ABI.
 */

#include <FLAC/stream_encoder.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define FLAC_ABI_VERSION 1
#define FLAC_COMPRESSION_LEVEL 5
#define FLAC_MAX_CHANNELS 8

enum
{
	FLAC_OK = 0,
	FLAC_INVALID_ARGUMENT = -1,
	FLAC_OUT_OF_MEMORY = -2,
	FLAC_INITIALIZATION_FAILED = -3,
	FLAC_ENCODING_FAILED = -4,
	FLAC_FINISH_FAILED = -5,
	FLAC_INVALID_STATE = -6
} ;

typedef struct
{
	int size ;
	int samples ;
} FLAC_FRAME ;

typedef struct
{
	FLAC__StreamEncoder *encoder ;
	FLAC__int32 *input ;
	int input_capacity_samples ;

	uint8_t *output ;
	int output_size ;
	int output_capacity ;

	FLAC_FRAME *frames ;
	int frame_count ;
	int frame_capacity ;

	uint8_t *header ;
	int header_size ;
	int header_capacity ;
	bool header_done ;
	bool initialized ;

	int channels ;
	int bits_per_sample ;
	int last_error ;
} FLAC_ENCODER ;

static int last_create_error = FLAC_OK ;

static bool
valid_sample_rate (int sample_rate)
{
	switch (sample_rate)
	{
		case 8000 :
		case 16000 :
		case 22050 :
		case 24000 :
		case 32000 :
		case 44100 :
		case 48000 :
		case 88200 :
		case 96000 :
		case 176400 :
		case 192000 :
			return true ;
		default :
			return false ;
	}
}

static bool
checked_int_add (int left, size_t right, int *result)
{
	if (left < 0 || right > (size_t) INT_MAX || left > INT_MAX - (int) right)
		return false ;
	*result = left + (int) right ;
	return true ;
}

static bool
grow_bytes (uint8_t **buffer, int *capacity, int needed, int minimum)
{
	if (needed < 0)
		return false ;
	if (needed <= *capacity)
		return true ;

	int next_capacity = *capacity < minimum ? minimum : *capacity ;
	while (next_capacity < needed)
	{
		if (next_capacity > INT_MAX / 2)
		{
			next_capacity = needed ;
			break ;
		}
		next_capacity *= 2 ;
	}

	uint8_t *replacement = (uint8_t *) realloc (*buffer, (size_t) next_capacity) ;
	if (replacement == NULL)
		return false ;
	*buffer = replacement ;
	*capacity = next_capacity ;
	return true ;
}

static bool
grow_frames (FLAC_ENCODER *encoder, int needed)
{
	if (needed <= encoder->frame_capacity)
		return true ;
	int next_capacity = encoder->frame_capacity < 16 ? 16 : encoder->frame_capacity ;
	while (next_capacity < needed)
	{
		if (next_capacity > INT_MAX / 2)
		{
			next_capacity = needed ;
			break ;
		}
		next_capacity *= 2 ;
	}
	if ((size_t) next_capacity > SIZE_MAX / sizeof (FLAC_FRAME))
		return false ;

	FLAC_FRAME *replacement = (FLAC_FRAME *) realloc (
		encoder->frames,
		(size_t) next_capacity * sizeof (FLAC_FRAME)
	) ;
	if (replacement == NULL)
		return false ;
	encoder->frames = replacement ;
	encoder->frame_capacity = next_capacity ;
	return true ;
}

static FLAC__StreamEncoderWriteStatus
write_callback (
	const FLAC__StreamEncoder *stream_encoder,
	const FLAC__byte buffer [],
	size_t bytes,
	uint32_t samples,
	uint32_t current_frame,
	void *client_data
)
{
	(void) stream_encoder ;
	(void) current_frame ;
	FLAC_ENCODER *encoder = (FLAC_ENCODER *) client_data ;

	if (samples == 0)
	{
		if (encoder->header_done)
			return FLAC__STREAM_ENCODER_WRITE_STATUS_OK ;
		int needed = 0 ;
		if (!checked_int_add (encoder->header_size, bytes, &needed)
				|| !grow_bytes (&encoder->header, &encoder->header_capacity, needed, 256))
		{
			encoder->last_error = FLAC_OUT_OF_MEMORY ;
			return FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR ;
		}
		memcpy (encoder->header + encoder->header_size, buffer, bytes) ;
		encoder->header_size = needed ;
		return FLAC__STREAM_ENCODER_WRITE_STATUS_OK ;
	}

	encoder->header_done = true ;
	int output_needed = 0 ;
	if (!checked_int_add (encoder->output_size, bytes, &output_needed)
			|| !grow_bytes (&encoder->output, &encoder->output_capacity, output_needed, 4096)
			|| encoder->frame_count == INT_MAX
			|| !grow_frames (encoder, encoder->frame_count + 1))
	{
		encoder->last_error = FLAC_OUT_OF_MEMORY ;
		return FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR ;
	}
	if (bytes > (size_t) INT_MAX || samples > (uint32_t) INT_MAX)
	{
		encoder->last_error = FLAC_OUT_OF_MEMORY ;
		return FLAC__STREAM_ENCODER_WRITE_STATUS_FATAL_ERROR ;
	}

	memcpy (encoder->output + encoder->output_size, buffer, bytes) ;
	encoder->output_size = output_needed ;
	encoder->frames [encoder->frame_count].size = (int) bytes ;
	encoder->frames [encoder->frame_count].samples = (int) samples ;
	encoder->frame_count++ ;
	return FLAC__STREAM_ENCODER_WRITE_STATUS_OK ;
}

static void
reset_output (FLAC_ENCODER *encoder)
{
	encoder->output_size = 0 ;
	encoder->frame_count = 0 ;
}

static int
initialize_stream (FLAC_ENCODER *encoder)
{
	encoder->header_size = 0 ;
	encoder->header_done = false ;
	FLAC__StreamEncoderInitStatus status = FLAC__stream_encoder_init_stream (
		encoder->encoder,
		write_callback,
		NULL,
		NULL,
		NULL,
		encoder
	) ;
	if (status != FLAC__STREAM_ENCODER_INIT_STATUS_OK)
	{
		encoder->last_error = FLAC_INITIALIZATION_FAILED ;
		return FLAC_INITIALIZATION_FAILED ;
	}
	encoder->initialized = true ;
	encoder->last_error = FLAC_OK ;
	return FLAC_OK ;
}

int
wasm_flac_abi_version (void)
{
	return FLAC_ABI_VERSION ;
}

FLAC_ENCODER *
wasm_flac_create (int channels, int sample_rate, int bits_per_sample)
{
	last_create_error = FLAC_OK ;
	if (channels < 1 || channels > FLAC_MAX_CHANNELS
			|| !valid_sample_rate (sample_rate)
			|| (bits_per_sample != 16 && bits_per_sample != 24))
	{
		last_create_error = FLAC_INVALID_ARGUMENT ;
		return NULL ;
	}

	FLAC_ENCODER *encoder = (FLAC_ENCODER *) calloc (1, sizeof (*encoder)) ;
	if (encoder == NULL)
	{
		last_create_error = FLAC_OUT_OF_MEMORY ;
		return NULL ;
	}
	encoder->channels = channels ;
	encoder->bits_per_sample = bits_per_sample ;
	encoder->encoder = FLAC__stream_encoder_new () ;
	if (encoder->encoder == NULL)
	{
		last_create_error = FLAC_OUT_OF_MEMORY ;
		free (encoder) ;
		return NULL ;
	}

	bool configured = FLAC__stream_encoder_set_channels (encoder->encoder, (uint32_t) channels)
		&& FLAC__stream_encoder_set_sample_rate (encoder->encoder, (uint32_t) sample_rate)
		&& FLAC__stream_encoder_set_bits_per_sample (encoder->encoder, (uint32_t) bits_per_sample)
		&& FLAC__stream_encoder_set_compression_level (
			encoder->encoder,
			FLAC_COMPRESSION_LEVEL
		)
		&& FLAC__stream_encoder_set_verify (encoder->encoder, false) ;
	if (!configured || initialize_stream (encoder) != FLAC_OK)
	{
		last_create_error = configured
			? encoder->last_error
			: FLAC_INITIALIZATION_FAILED ;
		FLAC__stream_encoder_delete (encoder->encoder) ;
		free (encoder->header) ;
		free (encoder) ;
		return NULL ;
	}
	return encoder ;
}

int
wasm_flac_last_create_error (void)
{
	return last_create_error ;
}

int
wasm_flac_last_error (FLAC_ENCODER *encoder)
{
	return encoder == NULL ? FLAC_INVALID_ARGUMENT : encoder->last_error ;
}

int
wasm_flac_prepare_pcm (FLAC_ENCODER *encoder, int frames)
{
	if (encoder == NULL || !encoder->initialized || frames < 1
			|| frames > INT_MAX / encoder->channels)
		return FLAC_INVALID_ARGUMENT ;
	int samples = frames * encoder->channels ;
	if (samples <= encoder->input_capacity_samples)
		return FLAC_OK ;
	if ((size_t) samples > SIZE_MAX / sizeof (FLAC__int32))
		return FLAC_OUT_OF_MEMORY ;

	FLAC__int32 *replacement = (FLAC__int32 *) realloc (
		encoder->input,
		(size_t) samples * sizeof (FLAC__int32)
	) ;
	if (replacement == NULL)
	{
		encoder->last_error = FLAC_OUT_OF_MEMORY ;
		return FLAC_OUT_OF_MEMORY ;
	}
	encoder->input = replacement ;
	encoder->input_capacity_samples = samples ;
	return FLAC_OK ;
}

FLAC__int32 *
wasm_flac_pcm (FLAC_ENCODER *encoder)
{
	return encoder == NULL ? NULL : encoder->input ;
}

int
wasm_flac_encode (FLAC_ENCODER *encoder, int frames)
{
	if (encoder == NULL || !encoder->initialized || frames < 1
			|| frames > INT_MAX / encoder->channels)
		return FLAC_INVALID_ARGUMENT ;
	int samples = frames * encoder->channels ;
	if (encoder->input == NULL || samples > encoder->input_capacity_samples)
		return FLAC_INVALID_STATE ;

	int shift = 32 - encoder->bits_per_sample ;
	for (int index = 0 ; index < samples ; index++)
		encoder->input [index] >>= shift ;

	reset_output (encoder) ;
	encoder->last_error = FLAC_OK ;
	if (!FLAC__stream_encoder_process_interleaved (
		encoder->encoder,
		encoder->input,
		(uint32_t) frames
	))
	{
		if (encoder->last_error == FLAC_OK)
			encoder->last_error = FLAC_ENCODING_FAILED ;
		return encoder->last_error ;
	}
	return FLAC_OK ;
}

uint8_t *
wasm_flac_output (FLAC_ENCODER *encoder)
{
	return encoder == NULL ? NULL : encoder->output ;
}

int
wasm_flac_output_length (FLAC_ENCODER *encoder)
{
	return encoder == NULL ? 0 : encoder->output_size ;
}

int
wasm_flac_frame_count (FLAC_ENCODER *encoder)
{
	return encoder == NULL ? 0 : encoder->frame_count ;
}

int
wasm_flac_frame_size (FLAC_ENCODER *encoder, int index)
{
	if (encoder == NULL || index < 0 || index >= encoder->frame_count)
		return 0 ;
	return encoder->frames [index].size ;
}

int
wasm_flac_frame_samples (FLAC_ENCODER *encoder, int index)
{
	if (encoder == NULL || index < 0 || index >= encoder->frame_count)
		return 0 ;
	return encoder->frames [index].samples ;
}

uint8_t *
wasm_flac_header (FLAC_ENCODER *encoder)
{
	return encoder == NULL ? NULL : encoder->header ;
}

int
wasm_flac_header_length (FLAC_ENCODER *encoder)
{
	return encoder == NULL ? 0 : encoder->header_size ;
}

int
wasm_flac_finish (FLAC_ENCODER *encoder)
{
	if (encoder == NULL || !encoder->initialized)
		return FLAC_INVALID_STATE ;
	reset_output (encoder) ;
	encoder->last_error = FLAC_OK ;
	if (!FLAC__stream_encoder_finish (encoder->encoder))
	{
		encoder->initialized = false ;
		if (encoder->last_error == FLAC_OK)
			encoder->last_error = FLAC_FINISH_FAILED ;
		return encoder->last_error ;
	}
	encoder->initialized = false ;
	return FLAC_OK ;
}

int
wasm_flac_reset (FLAC_ENCODER *encoder)
{
	if (encoder == NULL || encoder->initialized)
		return FLAC_INVALID_STATE ;
	return initialize_stream (encoder) ;
}

void
wasm_flac_destroy (FLAC_ENCODER *encoder)
{
	if (encoder == NULL)
		return ;
	if (encoder->initialized)
		(void) FLAC__stream_encoder_finish (encoder->encoder) ;
	FLAC__stream_encoder_delete (encoder->encoder) ;
	free (encoder->input) ;
	free (encoder->output) ;
	free (encoder->frames) ;
	free (encoder->header) ;
	free (encoder) ;
}
