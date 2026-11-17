// Suggests AAMC content categories for a book section by keyword matching.
// Only a suggestion: the owner confirms or edits every tag. Keywords match at
// the start of a word (so "enzyme" also finds "enzymes"); a trailing "$" means
// whole word only.

const KEYWORDS: Record<string, string[]> = {
	'1A': ['amino acid', 'protein', 'peptide', 'enzyme', 'michaelis', 'inhibitor', 'allosteric', 'isoelectric', 'zwitterion', 'alpha helix', 'beta sheet', 'beta pleated', 'tertiary structure', 'quaternary structure', 'denatur', 'chaperone', 'cofactor', 'coenzyme', 'active site', 'substrate', 'vmax$', 'km$', 'lineweaver'],
	'1B': ['dna$', 'rna$', 'mrna$', 'trna$', 'replication', 'transcription', 'translation', 'codon', 'ribosom', 'genetic code', 'promoter', 'operon', 'gene expression', 'splicing', 'intron', 'exon', 'polymerase', 'telomer', 'chromatin', 'histone', 'epigenetic', 'pcr$', 'recombinant', 'southern blot', 'sequencing'],
	'1C': ['mendel', 'allele', 'genotype', 'phenotype', 'dominant', 'recessive', 'meiosis', 'crossing over', 'linkage', 'hardy', 'evolution', 'natural selection', 'genetic drift', 'gene flow', 'speciation', 'heritab', 'pedigree', 'punnett', 'inheritance'],
	'1D': ['glycolysis', 'krebs', 'citric acid cycle', 'electron transport', 'oxidative phosphorylation', 'atp$', 'nadh$', 'fadh2$', 'gluconeogenesis', 'glycogen', 'fatty acid', 'beta-oxidation', 'beta oxidation', 'ketone bod', 'pentose phosphate', 'metabolism', 'bioenergetic', 'chemiosmosis', 'atp synthase', 'lipoprotein', 'phosphofructokinase', 'pyruvate'],
	'2A': ['plasma membrane', 'cell membrane', 'organelle', 'mitochondri', 'endoplasmic reticulum', 'golgi', 'lysosom', 'cytoskeleton', 'microtubule', 'actin', 'epithelial', 'connective tissue', 'membrane transport', 'endocytosis', 'exocytosis', 'phospholipid', 'fluid mosaic', 'tight junction', 'gap junction', 'nucleus', 'peroxisome'],
	'2B': ['bacteri', 'prokaryot', 'virus', 'viral', 'bacteriophage', 'plasmid', 'conjugation', 'transduction', 'lytic', 'lysogenic', 'retrovirus', 'binary fission', 'gram-positive', 'gram-negative', 'antibiotic', 'prion', 'viroid'],
	'2C': ['mitosis', 'cell cycle', 'cytokinesis', 'differentiation', 'stem cell', 'embryo', 'gastrulation', 'neurulation', 'apoptosis', 'cancer', 'oncogene', 'tumor suppressor', 'fertilization', 'blastula', 'blastocyst', 'gametogenesis', 'spermatogenesis', 'oogenesis', 'morphogen'],
	'3A': ['neuron', 'action potential', 'synap', 'neurotransmitter', 'nervous system', 'sympathetic', 'parasympathetic', 'spinal cord', 'reflex arc', 'endocrine', 'hormone', 'pituitary', 'hypothalamus', 'thyroid', 'adrenal', 'insulin', 'glucagon', 'cortisol', 'myelin', 'glial', 'resting potential'],
	'3B': ['heart', 'cardiac', 'circulatory', 'blood pressure', 'respiratory', 'lung', 'alveol', 'kidney', 'nephron', 'renal', 'digestive', 'stomach', 'liver', 'intestin', 'immune', 'lymphocyte', 'antibod', 'antigen', 'skeletal muscle', 'smooth muscle', 'bone', 'skin', 'reproductive system', 'homeostasis', 'hemoglobin'],
	'4A': ['velocity', 'acceleration', 'newton', 'friction', 'kinetic energy', 'potential energy', 'momentum', 'torque', 'projectile', 'gravit', 'work-energy', 'mechanical advantage', 'kinematic', 'inclined plane', 'free-body', 'free body', 'translational'],
	'4B': ['fluid', 'hydrostatic', 'buoyan', 'archimedes', 'pascal', 'bernoulli', 'viscosity', 'continuity equation', 'flow rate', 'poiseuille', 'surface tension', 'specific gravity'],
	'4C': ['electrochemi', 'galvanic', 'electrolytic', 'anode', 'cathode', 'redox', 'reduction potential', 'circuit', 'resistor', 'capacitor', 'current', 'voltage', 'ohm', 'electric field', 'coulomb', 'magnetic field', 'emf$', 'faraday'],
	'4D': ['light', 'sound', 'frequency', 'wavelength', 'doppler', 'refraction', 'reflection', 'lens', 'mirror', 'optic', 'diffraction', 'interference', 'polariz', 'electromagnetic', 'photon', 'decibel', 'standing wave', 'snell'],
	'4E': ['electron configuration', 'orbital', 'quantum', 'nuclear', 'radioactiv', 'half-life', 'isotope', 'alpha decay', 'beta decay', 'gamma', 'periodic table', 'ionization energy', 'electronegativ', 'atomic radius', 'photoelectric', 'bohr'],
	'5A': ['solubility', 'solute', 'solvent', 'molarity', 'acid', 'base', 'ph$', 'buffer', 'titration', 'pka$', 'ksp$', 'colligative', 'osmotic', 'henderson', 'dissociation', 'aqueous'],
	'5B': ['covalent', 'ionic bond', 'intermolecular', 'hydrogen bond', 'van der waals', 'dipole', 'polarity', 'vsepr', 'hybridization', 'molecular geometry', 'sigma bond', 'pi bond', 'london dispersion', 'lewis structure', 'formal charge'],
	'5C': ['separation', 'purification', 'chromatograph', 'distillation', 'extraction', 'recrystalliz', 'electrophoresis', 'centrifug', 'filtration', 'tlc$', 'hplc$'],
	'5D': ['functional group', 'alcohol', 'aldehyde', 'ketone', 'carboxylic', 'ester', 'amide', 'amine', 'carbohydrate', 'stereochem', 'chiral', 'enantiomer', 'isomer', 'nucleophil', 'electrophil', 'sn1$', 'sn2$', 'nmr$', 'infrared', 'spectroscop', 'nucleotide', 'triacylglycerol'],
	'5E': ['thermodynamic', 'enthalpy', 'entropy', 'gibbs', 'free energy', 'equilibrium constant', 'le chatelier', 'rate law', 'activation energy', 'catalyst', 'calorimetr', 'hess', 'ideal gas', 'gas law', 'phase diagram', 'reaction rate'],
	'6A': ['sensation', 'sensory', 'absolute threshold', 'signal detection', 'weber', 'retina', 'rods$', 'cones$', 'cochlea', 'olfact', 'gustat', 'somatosens', 'vestibular', 'transduction', 'just noticeable', 'photoreceptor'],
	'6B': ['perception', 'attention', 'cognition', 'cognitive', 'memory', 'encoding', 'retrieval', 'language', 'intelligence', 'consciousness', 'sleep', 'problem solving', 'decision making', 'gestalt', 'piaget', 'heuristic'],
	'6C': ['emotion', 'stress', 'motivation', 'arousal', 'yerkes', 'drive reduction', 'instinct', 'james-lange', 'cannon-bard', 'schachter', 'coping', 'limbic'],
	'7A': ['personality', 'psychological disorder', 'depress', 'schizophren', 'anxiety', 'bipolar', 'trait theory', 'freud', 'psychoanalytic', 'humanistic', 'big five', 'dsm$'],
	'7B': ['conformity', 'obedience', 'social facilitation', 'groupthink', 'deindividuation', 'bystander', 'peer pressure', 'socialization', 'norms', 'deviance', 'group polarization'],
	'7C': ['classical conditioning', 'operant conditioning', 'reinforce', 'punishment', 'observational learning', 'persuasion', 'elaboration likelihood', 'cognitive dissonance', 'habituation', 'attitude'],
	'8A': ['self-concept', 'self concept', 'identity', 'self-esteem', 'self-efficacy', 'locus of control', 'erikson', 'kohlberg', 'moral development'],
	'8B': ['attribution', 'stereotype', 'prejudice', 'bias', 'fundamental attribution', 'social perception', 'halo effect', 'ethnocentrism', 'stigma', 'just-world'],
	'8C': ['social interaction', 'impression management', 'dramaturg', 'communication', 'attraction', 'aggression', 'altruism', 'social support', 'attachment'],
	'9A': ['social structure', 'institution', 'functionalism', 'conflict theory', 'symbolic interaction', 'social construction', 'bureaucracy', 'material culture', 'religion', 'family'],
	'9B': ['demograph', 'population', 'fertility rate', 'mortality', 'migration', 'urbanization', 'aging', 'ethnicity', 'immigration', 'demographic transition'],
	'10A': ['inequality', 'social class', 'socioeconomic', 'poverty', 'stratification', 'social mobility', 'disparit', 'discrimination', 'privilege', 'prestige', 'social capital', 'segregation']
};

function escapeRegex(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATTERNS: [string, RegExp][] = Object.entries(KEYWORDS).map(([code, words]) => {
	const alternatives = words.map((w) => (w.endsWith('$') ? `${escapeRegex(w.slice(0, -1))}\\b` : escapeRegex(w)));
	return [code, new RegExp(`\\b(?:${alternatives.join('|')})`, 'g')];
});

function count(re: RegExp, text: string) {
	re.lastIndex = 0;
	let n = 0;
	while (re.exec(text)) n++;
	return n;
}

/** Top categories for a section's title and text, strongest first. */
export function suggestCategories(title: string, body: string): { code: string; score: number }[] {
	const t = title.toLowerCase();
	const b = body.slice(0, 250_000).toLowerCase();
	const words = Math.max(1, b.split(/\s+/).length);
	const scored = PATTERNS.map(([code, re]) => {
		const raw = count(re, t) * 12 + count(re, b);
		return { code, score: Math.round((raw / (words / 1000 + 1)) * 10) / 10 };
	})
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score);
	if (!scored.length) return [];
	const top = scored[0].score;
	return scored.filter((s) => s.score >= Math.max(2, top * 0.4)).slice(0, 3);
}
