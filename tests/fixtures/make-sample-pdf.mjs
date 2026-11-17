// Generates a small, text-based, multi-chapter PDF with bookmarks for tests and
// for trying the reader. Content is original review text written for this project.
//
//   node tests/fixtures/make-sample-pdf.mjs [output.pdf]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const chapters = [
	{
		title: 'Chapter 1. Amino Acids and Proteins',
		sections: [
			[
				'1.1 Structure of amino acids',
				'Every standard amino acid has a central alpha carbon bonded to an amino group, a carboxyl group, a hydrogen atom, and a variable side chain. The side chain determines whether the amino acid is nonpolar, polar, acidic, or basic. Glycine is the only standard amino acid that is not chiral, because its side chain is a second hydrogen atom.',
				'At physiological pH, the amino group is protonated and the carboxyl group is deprotonated, so a free amino acid exists mainly as a zwitterion. The isoelectric point (pI) is the pH at which the molecule carries no net charge. For an amino acid without an ionizable side chain, the pI is the average of the two pKa values.'
			],
			[
				'1.2 Protein structure',
				'Primary structure is the sequence of amino acids joined by peptide bonds. Secondary structure, such as the alpha helix and the beta pleated sheet, is stabilized by hydrogen bonds between backbone atoms. Tertiary structure is the overall three-dimensional shape of a single chain, stabilized by hydrophobic interactions, disulfide bonds, salt bridges, and hydrogen bonds between side chains.',
				'Quaternary structure describes how separate polypeptide subunits assemble. Hemoglobin, with two alpha and two beta subunits, is the classic example. Denaturation disrupts secondary, tertiary, and quaternary structure but leaves the primary sequence intact.'
			]
		]
	},
	{
		title: 'Chapter 2. Enzymes',
		sections: [
			[
				'2.1 How enzymes work',
				'Enzymes are biological catalysts that lower the activation energy of a reaction without changing its equilibrium constant or its change in Gibbs free energy. They stabilize the transition state, which increases the rate of both the forward and the reverse reaction.',
				'The induced fit model states that the active site changes shape when the substrate binds, producing a tighter fit around the transition state. Cofactors are inorganic ions or organic coenzymes that some enzymes require for activity.'
			],
			[
				'2.2 Michaelis-Menten kinetics',
				'The Michaelis-Menten equation is v = Vmax [S] / (Km + [S]). Km is the substrate concentration at which the reaction runs at half of Vmax, so a low Km indicates high affinity for the substrate. At very high substrate concentration, the enzyme is saturated and the rate approaches Vmax.',
				'A Lineweaver-Burk plot graphs 1/v against 1/[S]. Its y-intercept is 1/Vmax and its x-intercept is -1/Km. The double reciprocal form makes it easy to compare inhibitors.'
			],
			[
				'2.3 Enzyme inhibition',
				'A competitive inhibitor binds the active site and competes with the substrate. It raises the apparent Km but does not change Vmax, because enough substrate can outcompete the inhibitor. A noncompetitive inhibitor binds an allosteric site with equal affinity for the free enzyme and the enzyme-substrate complex; it lowers Vmax and leaves Km unchanged.',
				'An uncompetitive inhibitor binds only the enzyme-substrate complex and lowers both Km and Vmax. A mixed inhibitor binds either form with different affinities, changing Vmax and changing Km in either direction.'
			]
		]
	},
	{
		title: 'Chapter 3. Bioenergetics and Metabolism',
		sections: [
			[
				'3.1 Glycolysis',
				'Glycolysis converts one molecule of glucose into two molecules of pyruvate in the cytoplasm. It produces a net gain of two ATP and two NADH. Phosphofructokinase-1 catalyzes the committed, rate-limiting step and is inhibited by ATP and citrate and activated by AMP and fructose 2,6-bisphosphate.',
				'Under anaerobic conditions, lactate dehydrogenase reduces pyruvate to lactate and regenerates NAD+ so that glycolysis can continue.'
			],
			[
				'3.2 Oxidative phosphorylation',
				'The electron transport chain in the inner mitochondrial membrane passes electrons from NADH and FADH2 to oxygen, the final electron acceptor. The energy released pumps protons into the intermembrane space, creating an electrochemical gradient. ATP synthase uses the flow of protons back into the matrix to phosphorylate ADP. This coupling of the proton gradient to ATP synthesis is called chemiosmosis.'
			]
		]
	},
	{
		title: 'Chapter 4. Fluids',
		sections: [
			[
				'4.1 Hydrostatic pressure and buoyancy',
				'Pressure in a static fluid increases with depth: P = P0 + rho g h, where rho is the fluid density and h is the depth below the surface. Pascal\'s principle states that a pressure change applied to an enclosed fluid is transmitted undiminished to every part of the fluid.',
				'Archimedes\' principle states that the buoyant force on a submerged object equals the weight of the fluid it displaces. An object floats when its average density is less than the density of the fluid.'
			],
			[
				'4.2 Fluid dynamics',
				'For an ideal fluid, the continuity equation A1 v1 = A2 v2 shows that flow speed increases where a pipe narrows. Bernoulli\'s equation, P + 1/2 rho v^2 + rho g h = constant, expresses conservation of energy along a streamline, so pressure falls where speed rises.'
			]
		]
	},
	{
		title: 'Chapter 5. Sensation and Perception',
		sections: [
			[
				'5.1 Thresholds and signal detection',
				'The absolute threshold is the minimum stimulus intensity detected half of the time. The difference threshold, or just noticeable difference, is the smallest change in a stimulus that can be detected. Weber\'s law states that the just noticeable difference is a constant proportion of the original stimulus.',
				'Signal detection theory separates sensitivity from response bias. A hit is a correct detection of a present signal, while a false alarm is a report of a signal that was absent.'
			],
			[
				'5.2 Vision',
				'Rods are sensitive to dim light and support night vision, while cones support color vision and high acuity and are concentrated in the fovea. Information from the retina travels through the optic nerve to the lateral geniculate nucleus of the thalamus and then to the visual cortex in the occipital lobe.'
			]
		]
	}
];

const W = 612;
const H = 792;
const MARGIN = 72;
const BODY_SIZE = 11;
const LEADING = 15;

function esc(s) {
	return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Rough width model for Times-Roman so wrapping looks natural.
function textWidth(s, size) {
	let w = 0;
	for (const ch of s) {
		if ('il.,;:\'|!'.includes(ch)) w += 0.28;
		else if ('mwMW'.includes(ch)) w += 0.78;
		else if (ch === ' ') w += 0.25;
		else if (ch >= 'A' && ch <= 'Z') w += 0.66;
		else w += 0.47;
	}
	return w * size;
}

function wrap(text, size, maxWidth) {
	const words = text.split(/\s+/);
	const lines = [];
	let line = '';
	for (const word of words) {
		const next = line ? line + ' ' + word : word;
		if (textWidth(next, size) > maxWidth && line) {
			lines.push(line);
			line = word;
		} else {
			line = next;
		}
	}
	if (line) lines.push(line);
	return lines;
}

// Lay out content into pages: each page is a list of drawing ops.
const pages = [];
const outline = []; // { title, pageIndex, y }
let ops = [];
let y = H - MARGIN;

function newPage() {
	if (ops.length) pages.push(ops);
	ops = [];
	y = H - MARGIN;
}

function textLine(str, font, size, x = MARGIN) {
	ops.push(`BT /${font} ${size} Tf ${x} ${y.toFixed(2)} Td (${esc(str)}) Tj ET`);
}

function ensureSpace(h) {
	if (y - h < MARGIN) newPage();
}

for (const [ci, chapter] of chapters.entries()) {
	if (ci > 0) newPage();
	outline.push({ title: chapter.title, pageIndex: pages.length, y: H - MARGIN + 20 });
	textLine(chapter.title, 'F2', 18);
	y -= 34;
	for (const [heading, ...paras] of chapter.sections) {
		ensureSpace(60);
		textLine(heading, 'F2', 13);
		y -= 22;
		for (const para of paras) {
			for (const line of wrap(para, BODY_SIZE, W - 2 * MARGIN)) {
				ensureSpace(LEADING);
				textLine(line, 'F1', BODY_SIZE);
				y -= LEADING;
			}
			y -= 8;
		}
		y -= 6;
	}
	if (ci === 1) {
		// A simple figure (Michaelis-Menten curve) to try page-region citations.
		ensureSpace(190);
		const top = y - 10;
		const left = MARGIN + 40;
		const gw = 260;
		const gh = 140;
		const bottom = top - gh;
		ops.push(`0.2 w ${left} ${bottom} m ${left + gw} ${bottom} l S ${left} ${bottom} m ${left} ${top} l S`);
		let path = `${left} ${bottom} m`;
		for (let i = 1; i <= 40; i++) {
			const s = (i / 40) * 10;
			const v = s / (1.5 + s);
			path += ` ${(left + (i / 40) * gw).toFixed(1)} ${(bottom + v * (gh - 10)).toFixed(1)} l`;
		}
		ops.push(`1 w ${path} S`);
		ops.push(`[3 3] 0 d 0.5 w ${left} ${(bottom + (gh - 10)).toFixed(1)} m ${left + gw} ${(bottom + (gh - 10)).toFixed(1)} l S [] 0 d`);
		y = bottom - 18;
		textLine('Figure 2.1 Reaction rate v rises toward Vmax as substrate concentration [S] increases.', 'F3', 9);
		y -= 20;
	}
}
newPage();

// Serialize the PDF.
const objects = [];
const addObj = (body) => {
	objects.push(body);
	return objects.length;
};

const catalogId = addObj(null);
const pagesId = addObj(null);
const outlinesId = addObj(null);
const fontBody = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>');
const fontBold = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
const fontItalic = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>');

const pageIds = [];
for (const [i, pageOps] of pages.entries()) {
	const footer = `BT /F1 9 Tf ${W / 2 - 10} 40 Td (${i + 1}) Tj ET`;
	const stream = [...pageOps, footer].join('\n');
	const contentId = addObj(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
	const pageId = addObj(
		`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontBody} 0 R /F2 ${fontBold} 0 R /F3 ${fontItalic} 0 R >> >> >>`
	);
	pageIds.push(pageId);
}

const outlineItemIds = outline.map(() => addObj(null));
outline.forEach((item, i) => {
	const parts = [
		`/Title (${esc(item.title)})`,
		`/Parent ${outlinesId} 0 R`,
		`/Dest [${pageIds[item.pageIndex]} 0 R /XYZ 0 ${item.y} 0]`
	];
	if (i > 0) parts.push(`/Prev ${outlineItemIds[i - 1]} 0 R`);
	if (i < outline.length - 1) parts.push(`/Next ${outlineItemIds[i + 1]} 0 R`);
	objects[outlineItemIds[i] - 1] = `<< ${parts.join(' ')} >>`;
});

objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlinesId} 0 R /PageMode /UseOutlines >>`;
objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
objects[outlinesId - 1] = `<< /Type /Outlines /First ${outlineItemIds[0]} 0 R /Last ${outlineItemIds.at(-1)} 0 R /Count ${outline.length} >>`;
const infoId = addObj('<< /Title (Sample MCAT Review) /Author (Cortex test fixture) /Producer (make-sample-pdf.mjs) >>');

let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
objects.forEach((body, i) => {
	offsets.push(Buffer.byteLength(out, 'latin1'));
	out += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = Buffer.byteLength(out, 'latin1');
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

const target =
	process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample-mcat-review.pdf');
writeFileSync(target, Buffer.from(out, 'latin1'));
console.log(`Wrote ${target} (${pages.length} pages, ${outline.length} chapters)`);
