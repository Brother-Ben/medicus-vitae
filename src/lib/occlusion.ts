// Image occlusion masks in Anki's own field format (Anki 23.10+), so cards
// made here work in Anki and Anki's work here:
//   {{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.25:oi=1}}
// Coordinates are fractions of the image. oi=1 ("occlude inactive") hides every
// mask on the front ("hide all, guess one"); without it only the asked one is.

export interface IoShape {
	id: string;
	/** Card number (cloze number): shapes with the same number are hidden together. */
	ord: number;
	kind: 'rect' | 'ellipse';
	left: number;
	top: number;
	width: number;
	height: number;
}

const num = (v: number) => {
	const s = Math.max(0, Math.min(1, v)).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
	return s.startsWith('0.') ? s.slice(1) : s;
};

export function occlusionText(shapes: IoShape[], hideAll: boolean, keep: string[] = []): string {
	const parts = shapes.map((s) => {
		const geo =
			s.kind === 'ellipse'
				? `left=${num(s.left)}:top=${num(s.top)}:rx=${num(s.width / 2)}:ry=${num(s.height / 2)}`
				: `left=${num(s.left)}:top=${num(s.top)}:width=${num(s.width)}:height=${num(s.height)}`;
		return `{{c${s.ord}::image-occlusion:${s.kind}:${geo}${hideAll ? ':oi=1' : ''}}}`;
	});
	return [...parts, ...keep].join('<br>');
}

let idSeq = 0;
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s${++idSeq}`);

/** Masks back out of the field (rectangles and ellipses in fractions; anything else is kept as it is). */
export function parseOcclusion(text: string): { shapes: IoShape[]; hideAll: boolean; keep: string[] } {
	const shapes: IoShape[] = [];
	const keep: string[] = [];
	let hideAll = false;
	let any = false;
	for (const m of String(text ?? '').matchAll(/\{\{c([\d,]+)::image-occlusion:(\w+):([^}]*)\}\}/g)) {
		const ord = Number(m[1].split(',')[0]) || 1;
		const props = Object.fromEntries(
			m[3]
				.split(':')
				.map((p) => p.split('='))
				.filter((p) => p.length === 2)
		) as Record<string, string>;
		if (props.oi === '1' || props.oi === 'true') hideAll = true;
		any = true;
		const f = (k: string) => Number(props[k] ?? 0) || 0;
		const pixels = f('left') > 1.5 || f('top') > 1.5 || f('width') > 1.5 || f('height') > 1.5;
		if (pixels || (m[2] !== 'rect' && m[2] !== 'ellipse')) {
			keep.push(m[0]);
			continue;
		}
		if (m[2] === 'rect') shapes.push({ id: newId(), ord, kind: 'rect', left: f('left'), top: f('top'), width: f('width'), height: f('height') });
		else shapes.push({ id: newId(), ord, kind: 'ellipse', left: f('left'), top: f('top'), width: f('rx') * 2, height: f('ry') * 2 });
	}
	return { shapes, hideAll: any ? hideAll : true, keep };
}

/** The file name in an Image field (`<img src="…">`). */
export function imageName(field: string): string | null {
	const m = /<img[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(field ?? '');
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return m[1];
	}
}
