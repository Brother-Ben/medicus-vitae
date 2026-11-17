// MCAT reference data from the AAMC content outline (spec Appendix A).
// Codes are stored on cards, mistakes, practice and book sections.

export type SectionCode = 'CP' | 'CARS' | 'BB' | 'PS';

export const SECTIONS: { code: SectionCode; name: string; short: string; questions: number; minutes: number }[] = [
	{ code: 'CP', name: 'Chemical and Physical Foundations of Biological Systems', short: 'Chem/Phys', questions: 59, minutes: 95 },
	{ code: 'CARS', name: 'Critical Analysis and Reasoning Skills', short: 'CARS', questions: 53, minutes: 90 },
	{ code: 'BB', name: 'Biological and Biochemical Foundations of Living Systems', short: 'Bio/Biochem', questions: 59, minutes: 95 },
	{ code: 'PS', name: 'Psychological, Social, and Biological Foundations of Behavior', short: 'Psych/Soc', questions: 59, minutes: 95 }
];

export const SECTION_SCORE = { min: 118, max: 132 };
export const TOTAL_SCORE = { min: 472, max: 528 };

export interface Category {
	code: string;
	name: string;
	section: SectionCode;
}

export const CATEGORIES: Category[] = [
	{ code: '1A', name: 'Structure and function of proteins and their amino acids', section: 'BB' },
	{ code: '1B', name: 'Transmission of genetic information', section: 'BB' },
	{ code: '1C', name: 'Transmission of heritable information across generations', section: 'BB' },
	{ code: '1D', name: 'Bioenergetics and fuel molecule metabolism', section: 'BB' },
	{ code: '2A', name: 'Assemblies of molecules, cells, and groups of cells', section: 'BB' },
	{ code: '2B', name: 'Prokaryotes and viruses', section: 'BB' },
	{ code: '2C', name: 'Cell division, differentiation, and specialization', section: 'BB' },
	{ code: '3A', name: 'Nervous and endocrine systems', section: 'BB' },
	{ code: '3B', name: 'Main organ systems', section: 'BB' },
	{ code: '4A', name: 'Translational motion, forces, work, energy, equilibrium', section: 'CP' },
	{ code: '4B', name: 'Fluids', section: 'CP' },
	{ code: '4C', name: 'Electrochemistry and electrical circuits', section: 'CP' },
	{ code: '4D', name: 'Light and sound', section: 'CP' },
	{ code: '4E', name: 'Atoms, nuclear decay, electronic structure, chemical behavior', section: 'CP' },
	{ code: '5A', name: 'Water and its solutions', section: 'CP' },
	{ code: '5B', name: 'Molecules and intermolecular interactions', section: 'CP' },
	{ code: '5C', name: 'Separation and purification methods', section: 'CP' },
	{ code: '5D', name: 'Structure, function, and reactivity of biologically relevant molecules', section: 'CP' },
	{ code: '5E', name: 'Chemical thermodynamics and kinetics', section: 'CP' },
	{ code: '6A', name: 'Sensing the environment', section: 'PS' },
	{ code: '6B', name: 'Making sense of the environment', section: 'PS' },
	{ code: '6C', name: 'Responding to the world', section: 'PS' },
	{ code: '7A', name: 'Individual influences on behavior', section: 'PS' },
	{ code: '7B', name: 'Social processes that influence behavior', section: 'PS' },
	{ code: '7C', name: 'Attitude and behavior change', section: 'PS' },
	{ code: '8A', name: 'Self-identity', section: 'PS' },
	{ code: '8B', name: 'Social thinking', section: 'PS' },
	{ code: '8C', name: 'Social interactions', section: 'PS' },
	{ code: '9A', name: 'Social structure', section: 'PS' },
	{ code: '9B', name: 'Demographic characteristics and processes', section: 'PS' },
	{ code: '10A', name: 'Social inequality', section: 'PS' }
];

export interface Skill {
	code: string;
	name: string;
	kind: 'SIRS' | 'CARS';
}

export const SKILLS: Skill[] = [
	{ code: 'SIRS-1', name: 'Knowledge of scientific concepts and principles', kind: 'SIRS' },
	{ code: 'SIRS-2', name: 'Scientific reasoning and problem-solving', kind: 'SIRS' },
	{ code: 'SIRS-3', name: 'Reasoning about the design and execution of research', kind: 'SIRS' },
	{ code: 'SIRS-4', name: 'Data-based and statistical reasoning', kind: 'SIRS' },
	{ code: 'FC', name: 'Foundations of Comprehension', kind: 'CARS' },
	{ code: 'RWT', name: 'Reasoning Within the Text', kind: 'CARS' },
	{ code: 'RBT', name: 'Reasoning Beyond the Text', kind: 'CARS' }
];

/** CARS has no content categories; its skills stand in for them where a "category" is needed. */
export const CARS_SKILL_CODES = ['FC', 'RWT', 'RBT'];

const categoryByCode = new Map(CATEGORIES.map((c) => [c.code, c]));
const skillByCode = new Map(SKILLS.map((s) => [s.code, s]));

export function category(code: string | null | undefined): Category | undefined {
	return code ? categoryByCode.get(code) : undefined;
}

export function skill(code: string | null | undefined): Skill | undefined {
	return code ? skillByCode.get(code) : undefined;
}

export function isCategoryCode(code: unknown): code is string {
	return typeof code === 'string' && categoryByCode.has(code);
}

export function isSkillCode(code: unknown): code is string {
	return typeof code === 'string' && skillByCode.has(code);
}

/** Section a category or CARS skill belongs to. */
export function sectionOf(code: string | null | undefined): SectionCode | undefined {
	if (!code) return undefined;
	if (CARS_SKILL_CODES.includes(code)) return 'CARS';
	return categoryByCode.get(code)?.section;
}

export function sectionName(code: SectionCode | string): string {
	return SECTIONS.find((s) => s.code === code)?.short ?? code;
}

/** Short display label, e.g. "1A Proteins and amino acids". */
export const CATEGORY_SHORT: Record<string, string> = {
	'1A': 'Proteins and amino acids',
	'1B': 'Genetic information',
	'1C': 'Heredity',
	'1D': 'Bioenergetics and metabolism',
	'2A': 'Cells and tissues',
	'2B': 'Prokaryotes and viruses',
	'2C': 'Cell division and differentiation',
	'3A': 'Nervous and endocrine systems',
	'3B': 'Organ systems',
	'4A': 'Motion, forces, energy',
	'4B': 'Fluids',
	'4C': 'Electrochemistry and circuits',
	'4D': 'Light and sound',
	'4E': 'Atoms and nuclear decay',
	'5A': 'Water and solutions',
	'5B': 'Molecules and interactions',
	'5C': 'Separations',
	'5D': 'Molecular structure and reactivity',
	'5E': 'Thermodynamics and kinetics',
	'6A': 'Sensing the environment',
	'6B': 'Perception and cognition',
	'6C': 'Responding to the world',
	'7A': 'Individual influences',
	'7B': 'Social processes',
	'7C': 'Attitudes and behavior change',
	'8A': 'Self-identity',
	'8B': 'Social thinking',
	'8C': 'Social interactions',
	'9A': 'Social structure',
	'9B': 'Demographics',
	'10A': 'Social inequality',
	FC: 'Foundations of Comprehension',
	RWT: 'Reasoning Within the Text',
	RBT: 'Reasoning Beyond the Text'
};

export const MISTAKE_REASONS = [
	{ code: 'content_gap', label: 'Content gap' },
	{ code: 'misread', label: 'Misread the question' },
	{ code: 'timing', label: 'Ran out of time' },
	{ code: 'reasoning', label: 'Reasoning error' },
	{ code: 'second_guessed', label: 'Second-guessed myself' }
] as const;

export type MistakeReason = (typeof MISTAKE_REASONS)[number]['code'];

export function reasonLabel(code: string): string {
	return MISTAKE_REASONS.find((r) => r.code === code)?.label ?? code;
}

export const MISTAKE_STATES = ['open', 'repair', 'retest', 'resolved'] as const;
export type MistakeState = (typeof MISTAKE_STATES)[number];

export const MISTAKE_STATE_LABELS: Record<MistakeState, string> = {
	open: 'Open',
	repair: 'Repairing',
	retest: 'Ready to retest',
	resolved: 'Resolved'
};

export const FULL_LENGTH_PROVIDERS = [
	'AAMC',
	'Blueprint',
	'UWorld',
	'Kaplan',
	'The Princeton Review',
	'Jack Westin',
	'Altius',
	'Examkrackers',
	'Other'
];

export const PRACTICE_SOURCES = [
	'AAMC Question Pack',
	'AAMC Section Bank',
	'UWorld',
	'Khan Academy',
	'Jack Westin',
	'Blueprint',
	'Kaplan',
	'Own questions',
	'Other'
];
