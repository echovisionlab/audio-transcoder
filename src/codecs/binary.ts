export function readAscii(
  view: DataView,
  offset: number,
  length: number,
): string {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) {
    return '';
  }

  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

export function writeAscii(
  view: DataView,
  offset: number,
  value: string,
): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function readInt64BE(view: DataView, offset: number): bigint {
  return BigInt.asIntN(64, readUint64BE(view, offset));
}

export function readUint64BE(view: DataView, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(view.getUint8(offset + index));
  }
  return value;
}

export function readInt24LE(view: DataView, offset: number): number {
  const unsigned =
    view.getUint8(offset) |
    (view.getUint8(offset + 1) << 8) |
    (view.getUint8(offset + 2) << 16);
  return unsigned & 0x800000 ? unsigned | 0xff000000 : unsigned;
}

export function readInt24BE(view: DataView, offset: number): number {
  const unsigned =
    (view.getUint8(offset) << 16) |
    (view.getUint8(offset + 1) << 8) |
    view.getUint8(offset + 2);
  return unsigned & 0x800000 ? unsigned | 0xff000000 : unsigned;
}

export function writeInt24LE(
  view: DataView,
  offset: number,
  value: number,
): void {
  view.setUint8(offset, value & 0xff);
  view.setUint8(offset + 1, (value >> 8) & 0xff);
  view.setUint8(offset + 2, (value >> 16) & 0xff);
}

export function writeInt24BE(
  view: DataView,
  offset: number,
  value: number,
): void {
  view.setUint8(offset, (value >> 16) & 0xff);
  view.setUint8(offset + 1, (value >> 8) & 0xff);
  view.setUint8(offset + 2, value & 0xff);
}

export function readExtended80(view: DataView, offset: number): number {
  const exponent = view.getUint16(offset, false);
  const highMantissa = view.getUint32(offset + 2, false);
  const lowMantissa = view.getUint32(offset + 6, false);

  if (exponent === 0 && highMantissa === 0 && lowMantissa === 0) {
    return 0;
  }

  const sign = exponent & 0x8000 ? -1 : 1;
  const power = (exponent & 0x7fff) - 16_383;
  return (
    sign *
    (highMantissa * 2 ** (power - 31) +
      lowMantissa * 2 ** (power - 63))
  );
}

export function writeExtended80(
  view: DataView,
  offset: number,
  value: number,
): void {
  if (value === 0) {
    for (let index = 0; index < 10; index += 1) {
      view.setUint8(offset + index, 0);
    }
    return;
  }

  const sign = value < 0 ? 0x8000 : 0;
  const absolute = Math.abs(value);
  const power = Math.floor(Math.log2(absolute));
  const exponent = sign | (power + 16_383);
  const normalized = absolute / 2 ** power;
  const mantissa = BigInt(Math.round(normalized * 2 ** 63));

  view.setUint16(offset, exponent, false);
  view.setUint32(
    offset + 2,
    Number((mantissa >> 32n) & 0xffffffffn),
    false,
  );
  view.setUint32(offset + 6, Number(mantissa & 0xffffffffn), false);
}
