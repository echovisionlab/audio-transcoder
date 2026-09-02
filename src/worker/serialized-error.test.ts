import { describe, expect, it } from 'vitest';
import { AudioTranscoderError } from '../errors.js';
import {
  deserializeWorkerError,
  serializeWorkerError,
} from './serialized-error.js';

describe('serialized Worker errors', () => {
  it('preserves an optional package error reason across the Worker boundary', () => {
    const error = new AudioTranscoderError(
      'RESOURCE_LIMIT_EXCEEDED',
      'output storage is full',
      { reason: 'output-storage-limit' },
    );

    const serialized = serializeWorkerError(error);
    const deserialized = deserializeWorkerError(serialized);

    expect(serialized).toEqual({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: 'output storage is full',
      name: 'AudioTranscoderError',
      reason: 'output-storage-limit',
    });
    expect(deserialized).toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: 'output storage is full',
      name: 'AudioTranscoderError',
      reason: 'output-storage-limit',
    });
  });

  it('preserves target-size classification without replacing it with a generic code', () => {
    const error = new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      'RIFF cannot represent this output',
      { reason: 'target-size-limit' },
    );

    const serialized = serializeWorkerError(error);
    const deserialized = deserializeWorkerError(serialized);

    expect(serialized).toEqual({
      code: 'UNSUPPORTED_OUTPUT',
      message: 'RIFF cannot represent this output',
      name: 'AudioTranscoderError',
      reason: 'target-size-limit',
    });
    expect(deserialized).toMatchObject({
      code: 'UNSUPPORTED_OUTPUT',
      message: 'RIFF cannot represent this output',
      name: 'AudioTranscoderError',
      reason: 'target-size-limit',
    });
  });

  it('recognizes a valid package error from a different class identity', () => {
    const foreignError = Object.assign(
      new Error('RIFF cannot represent this output'),
      {
        code: 'UNSUPPORTED_OUTPUT',
        name: 'AudioTranscoderError',
        reason: 'target-size-limit',
      },
    );

    expect(foreignError).not.toBeInstanceOf(AudioTranscoderError);
    expect(serializeWorkerError(foreignError)).toEqual({
      code: 'UNSUPPORTED_OUTPUT',
      message: 'RIFF cannot represent this output',
      name: 'AudioTranscoderError',
      reason: 'target-size-limit',
    });

    const withoutReason = Object.assign(new Error('worker failed'), {
      code: 'WORKER_FAILURE',
      name: 'AudioTranscoderError',
    });
    expect(serializeWorkerError(withoutReason)).toEqual({
      code: 'WORKER_FAILURE',
      message: 'worker failed',
      name: 'AudioTranscoderError',
    });
  });

  it('does not trust invalid or non-Error structural classifications', () => {
    const invalidCode = Object.assign(new Error('invalid code'), {
      code: 'NOT_A_PACKAGE_CODE',
      name: 'AudioTranscoderError',
    });
    const invalidReason = Object.assign(new Error('invalid reason'), {
      code: 'UNSUPPORTED_OUTPUT',
      name: 'AudioTranscoderError',
      reason: 'not-a-package-reason',
    });
    const missingCode = Object.assign(new Error('missing code'), {
      name: 'AudioTranscoderError',
    });
    for (const error of [invalidCode, invalidReason, missingCode]) {
      delete error.stack;
      expect(serializeWorkerError(error)).toEqual({
        message: error.message,
        name: 'AudioTranscoderError',
      });
    }
    expect(
      serializeWorkerError({
        code: 'UNSUPPORTED_OUTPUT',
        message: 'plain object',
        name: 'AudioTranscoderError',
        reason: 'target-size-limit',
      }),
    ).toEqual({
      message: 'plain object',
      name: 'AudioTranscoderError',
    });
  });

  it('keeps reason absent for unrelated package errors', () => {
    const deserialized = deserializeWorkerError({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: 'an encoder-specific limit',
      name: 'AudioTranscoderError',
    });

    expect(deserialized).toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      message: 'an encoder-specific limit',
    });
    expect((deserialized as AudioTranscoderError).reason).toBeUndefined();
  });

  it('preserves unknown Error diagnostics including the original stack', () => {
    const error = new TypeError('codec bridge exploded');
    error.stack = 'TypeError: codec bridge exploded\n    at worker-codec.js:4:2';

    const serialized = serializeWorkerError(error);
    const deserialized = deserializeWorkerError(serialized);

    expect(serialized).toEqual({
      message: 'codec bridge exploded',
      name: 'TypeError',
      stack: error.stack,
    });
    expect(deserialized).toMatchObject({
      message: 'codec bridge exploded',
      name: 'TypeError',
      stack: error.stack,
    });

    delete error.stack;
    expect(serializeWorkerError(error)).toEqual({
      message: 'codec bridge exploded',
      name: 'TypeError',
    });
    expect(
      deserializeWorkerError({
        message: 'without stack',
        name: 'RangeError',
      }),
    ).toMatchObject({
      message: 'without stack',
      name: 'RangeError',
    });
  });

  it('serializes Error instances with hostile diagnostic getters safely', () => {
    const stacked = new Error('hidden message');
    Object.defineProperties(stacked, {
      message: {
        configurable: true,
        get(): never {
          throw new Error('message getter failed');
        },
      },
      name: { configurable: true, value: 'TypeError' },
      stack: {
        configurable: true,
        value: 'TypeError: preserved stack diagnostic\n    at codec.js:1:2',
      },
    });
    expect(serializeWorkerError(stacked)).toEqual({
      message: 'TypeError: preserved stack diagnostic',
      name: 'TypeError',
      stack: 'TypeError: preserved stack diagnostic\n    at codec.js:1:2',
    });

    const hostile = new Error('hidden message');
    Object.defineProperties(hostile, {
      message: {
        configurable: true,
        get(): never {
          throw new Error('message getter failed');
        },
      },
      name: {
        configurable: true,
        get(): never {
          throw new Error('name getter failed');
        },
      },
      stack: {
        configurable: true,
        get(): never {
          throw new Error('stack getter failed');
        },
      },
    });
    expect(serializeWorkerError(hostile)).toEqual({
      message: 'An Error was thrown, but its message could not be read.',
      name: 'Error',
    });
  });

  it('keeps valid package classification when its message getter is hostile', () => {
    const error = new AudioTranscoderError(
      'UNSUPPORTED_OUTPUT',
      'hidden message',
      { reason: 'target-size-limit' },
    );
    Object.defineProperties(error, {
      message: {
        configurable: true,
        get(): never {
          throw new Error('message getter failed');
        },
      },
      stack: {
        configurable: true,
        value:
          'AudioTranscoderError: preserved package diagnostic\n    at codec.js:1:2',
      },
    });

    expect(serializeWorkerError(error)).toEqual({
      code: 'UNSUPPORTED_OUTPUT',
      message: 'AudioTranscoderError: preserved package diagnostic',
      name: 'AudioTranscoderError',
      reason: 'target-size-limit',
    });
  });

  it('keeps useful diagnostics for arbitrary thrown values', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const throwingProperties = Object.defineProperties(
      {},
      {
        message: { get: () => { throw new Error('message getter'); } },
        name: { get: () => { throw new Error('name getter'); } },
        stack: { get: () => { throw new Error('stack getter'); } },
      },
    );
    const unstringifiable = {
      toJSON(): never {
        throw new Error('json failed');
      },
      [Symbol.toPrimitive](): never {
        throw new Error('string failed');
      },
    };

    expect(serializeWorkerError('string failure')).toEqual({
      message: 'string failure',
      name: 'Error',
    });
    expect(serializeWorkerError(42)).toEqual({
      message: '42',
      name: 'Error',
    });
    expect(serializeWorkerError(undefined)).toEqual({
      message: 'undefined',
      name: 'Error',
    });
    expect(serializeWorkerError(null)).toEqual({
      message: 'null',
      name: 'Error',
    });
    expect(serializeWorkerError({ detail: 'plain failure' })).toEqual({
      message: '{"detail":"plain failure"}',
      name: 'Error',
    });
    expect(serializeWorkerError(cyclic)).toEqual({
      message: '[object Object]',
      name: 'Error',
    });
    expect(serializeWorkerError(throwingProperties)).toEqual({
      message: '{}',
      name: 'Error',
    });
    expect(
      serializeWorkerError({
        message: 'plain thrown diagnostic',
        name: 'CodecDiagnostic',
        stack: 'codec-stack',
      }),
    ).toEqual({
      message: 'plain thrown diagnostic',
      name: 'CodecDiagnostic',
      stack: 'codec-stack',
    });
    expect(serializeWorkerError(unstringifiable)).toEqual({
      message: 'Unserializable thrown object value.',
      name: 'Error',
    });
  });
});
