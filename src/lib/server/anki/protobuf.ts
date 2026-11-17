// Just enough protobuf decoding to read the few Anki messages an .apkg needs
// (package metadata, the media list, note type/template/deck settings). Fields
// are returned by number; callers pick what they understand and ignore the rest.

export type ProtoValue = { wire: 0; value: bigint } | { wire: 1; bytes: Buffer } | { wire: 2; bytes: Buffer } | { wire: 5; bytes: Buffer };

export type ProtoMessage = Map<number, ProtoValue[]>;

function readVarint(buf: Buffer, pos: number): [bigint, number] {
	let result = 0n;
	let shift = 0n;
	for (;;) {
		if (pos >= buf.length) throw new Error('Truncated protobuf varint');
		const byte = buf[pos++];
		result |= BigInt(byte & 0x7f) << shift;
		if (!(byte & 0x80)) return [result, pos];
		shift += 7n;
		if (shift > 70n) throw new Error('Protobuf varint too long');
	}
}

export function decodeMessage(buf: Buffer): ProtoMessage {
	const out: ProtoMessage = new Map();
	let pos = 0;
	while (pos < buf.length) {
		const [key, next] = readVarint(buf, pos);
		pos = next;
		const field = Number(key >> 3n);
		const wire = Number(key & 7n);
		let value: ProtoValue;
		if (wire === 0) {
			const [v, p] = readVarint(buf, pos);
			pos = p;
			value = { wire: 0, value: v };
		} else if (wire === 1) {
			value = { wire: 1, bytes: buf.subarray(pos, pos + 8) };
			pos += 8;
		} else if (wire === 2) {
			const [len, p] = readVarint(buf, pos);
			const end = p + Number(len);
			if (end > buf.length) throw new Error('Truncated protobuf field');
			value = { wire: 2, bytes: buf.subarray(p, end) };
			pos = end;
		} else if (wire === 5) {
			value = { wire: 5, bytes: buf.subarray(pos, pos + 4) };
			pos += 4;
		} else {
			throw new Error(`Unsupported protobuf wire type ${wire}`);
		}
		const list = out.get(field);
		if (list) list.push(value);
		else out.set(field, [value]);
	}
	return out;
}

function last(msg: ProtoMessage, field: number) {
	const list = msg.get(field);
	return list ? list[list.length - 1] : undefined;
}

export function getString(msg: ProtoMessage, field: number): string {
	const v = last(msg, field);
	return v && v.wire === 2 ? v.bytes.toString('utf8') : '';
}

export function getBytes(msg: ProtoMessage, field: number): Buffer | null {
	const v = last(msg, field);
	return v && v.wire === 2 ? v.bytes : null;
}

export function getInt(msg: ProtoMessage, field: number): number {
	const v = last(msg, field);
	if (!v || v.wire !== 0) return 0;
	return Number(BigInt.asIntN(64, v.value));
}

export function getFloat(msg: ProtoMessage, field: number): number | null {
	const v = last(msg, field);
	return v && v.wire === 5 ? v.bytes.readFloatLE(0) : null;
}

export function getMessage(msg: ProtoMessage, field: number): ProtoMessage | null {
	const b = getBytes(msg, field);
	return b ? decodeMessage(b) : null;
}

export function getRepeatedMessages(msg: ProtoMessage, field: number): ProtoMessage[] {
	return (msg.get(field) ?? []).filter((v) => v.wire === 2).map((v) => decodeMessage((v as { bytes: Buffer }).bytes));
}

export function has(msg: ProtoMessage, field: number) {
	return msg.has(field);
}
