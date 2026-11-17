// The first-time guide: a short tour that opens each tab in turn and says, in
// plain words, what it's for and what can be done there. The tabs follow the
// account's own menu order; Settings is always last.

import { NAV_ITEMS, type NavId } from './appearance';

export type GuideStepId = 'welcome' | NavId | 'settings';

export interface GuideStep {
	id: GuideStepId;
	/** The page the step opens (the welcome step stays where it is). */
	href: string | null;
	title: string;
	intro: string;
	/** What can be done there: a short name, then a sentence. */
	points: [string, string][];
}

type StepText = Omit<GuideStep, 'id' | 'href'>;

const WELCOME: StepText = {
	title: 'Welcome to Medicus Vitae',
	intro: 'Here’s a quick tour. We’ll open each tab and show you what you can do there. It takes about two minutes.',
	points: [
		['Move around', 'Use Next and Back. The page behind this card is the real one, so feel free to look around.'],
		['Leave any time', 'Close the tour whenever you like. You can take it again from Settings.']
	]
};

const TABS: Record<NavId, StepText> = {
	today: {
		title: 'Today',
		intro: 'Your home page. It shows what to study right now.',
		points: [
			['Start studying', 'Cards due today, your study session, and the book you were reading, one click away.'],
			['Plan a session', 'Line up flashcards, reading, mistakes or your own tasks. A timer keeps you on track and tells you when to take a break.'],
			['Your numbers', 'Cards due, study time this week, how well you remember your cards, your last full-length score and your streak.'],
			['What to work on', 'A short list of what needs attention, taken from your cards, mistakes and weak areas.'],
			['Choose what Today shows', 'Add, hide or reorder sections, like the CARS passage of the day or the cards coming up this week.']
		]
	},
	library: {
		title: 'Library',
		intro: 'Your review books, as PDFs.',
		points: [
			['Import a PDF', 'Add the books you study from. Chapters are found for you.'],
			['Read', 'Highlight in four colors, write notes next to the text, and search inside the book.'],
			['Make a card', 'Select any passage and turn it into a flashcard that links back to that page.'],
			['Track chapters', 'Mark a chapter done when you finish it. Your progress counts only the chapters you mark.'],
			['Link an Anki deck', 'Connect a deck to a book. When you finish a chapter, the cards for it start showing up in your reviews.']
		]
	},
	cards: {
		title: 'Flashcards',
		intro: 'Your flashcards. Each card comes back right before you’re likely to forget it, so you spend less time reviewing and remember more.',
		points: [
			['Study', 'Review the cards due today, all together or one deck at a time. After each card, press Again, Hard, Good or Easy.'],
			['Cards & decks', 'Browse, search and edit your cards, add new ones, put cards on hold, or pick a day for a card to come back.'],
			['Anki', 'Bring in a deck from Anki, or keep Medicus and Anki in step with each other (Settings › Anki sync).'],
			['CARS', 'Timed Jack Westin passages with their questions, and your CARS numbers. On the Jack Westin site, the Send to Medicus button adds the passage you’re on.'],
			['Card types', 'Change how cards look, or make your own, like picture cards that cover the labels on a diagram.']
		]
	},
	mistakes: {
		title: 'Mistake journal',
		intro: 'Every question you got wrong and why, so the same mistake doesn’t happen twice.',
		points: [
			['Log a mistake', 'From a full-length, a practice set or a flashcard. Say why you missed it: you didn’t know it, misread it, ran out of time, reasoned it wrong, or second-guessed yourself.'],
			['Repair it', 'Write down what you’ll do differently next time, and look it up in your books.'],
			['Retest', 'Come back to it later. Once you get it right, it’s marked resolved.'],
			['Filter', 'See your mistakes by reason, by AAMC category, or by where they stand.']
		]
	},
	tutor: {
		title: 'Tutor',
		intro: 'Ask questions in your own words. Answers come from your books, notes and cards, with a link to the page each one came from.',
		points: [
			['Ask', 'Ask about anything you’re studying. While reading, you can also select a passage and choose Ask tutor.'],
			['Research the web', 'For questions your books don’t cover. Answers from websites are marked “From the web”.'],
			['Approvals', 'The tutor can write flashcards and quiz questions from your books. They wait here, and nothing is added until you say yes.'],
			['Quiz', 'Practice with the questions you said yes to.'],
			['Set it up once', 'The tutor uses your ChatGPT or Claude account. Connect it in Settings › AI.']
		]
	},
	progress: {
		title: 'Progress',
		intro: 'How your studying is going, all in one place.',
		points: [
			['Full-length scores', 'Log each practice exam by pasting your AAMC score report or typing the questions you missed, then go back through it question by question.'],
			['Practice sets', 'Log question-bank sets to see how you do by section and topic.'],
			['Strengths and weaknesses', 'Your results by AAMC category, so you know what to study next.'],
			['Why you miss questions', 'The reasons from your mistake journal, added up.'],
			['Study time and memory', 'How long you studied each day, and how well you remember your cards.']
		]
	},
	notes: {
		title: 'Notes',
		intro: 'All your notes in one place.',
		points: [
			['Book notes', 'Notes you wrote while reading, each linked to its page. Open one to jump back into the book.'],
			['Your own notes', 'Upload notes you made somewhere else as a PDF, and link them to the book pages they go with.'],
			['Find them', 'Show one book’s notes, and sort by newest or oldest.']
		]
	},
	search: {
		title: 'Search',
		intro: 'Find anything in your books, notes and cards.',
		points: [
			['Keywords', 'Finds the exact words you type.'],
			['Meaning', 'Finds passages about the same idea, even when they use different words.'],
			['Narrow it down', 'Show only books, only notes or only cards.']
		]
	}
};

const SETTINGS: StepText = {
	title: 'Settings',
	intro: 'Set Medicus up the way you like it.',
	points: [
		['Study & goals', 'Your test date, goal score, study days and how many new cards a day.'],
		['Menu & Today', 'Choose which tabs show in the menu, in what order, and what the Today page shows.'],
		['Appearance', 'Themes, text size, how book pages look, and seasonal decorations.'],
		['Focus & breaks', 'The focus timer, breaks and the chime.'],
		['Anki and the tutor', 'Keep Anki in step with Medicus, and connect the account the tutor uses.'],
		['Keep it safe', 'Backups, a second computer as a spare copy, export and restore, and your password.'],
		['This tour', 'That’s everything. Take the tour again any time with Take the tour at the top of Settings.']
	]
};

/** The tour: a welcome, every tab in the account's menu order, then Settings. */
export function guideSteps(menuOrder: readonly NavId[], opts: { welcome?: boolean } = {}): GuideStep[] {
	const order = [...menuOrder.filter((id) => id in TABS), ...NAV_ITEMS.map((n) => n.id).filter((id) => !menuOrder.includes(id))];
	const steps: GuideStep[] = [];
	if (opts.welcome !== false) steps.push({ id: 'welcome', href: null, ...WELCOME });
	for (const id of order) steps.push({ id, href: NAV_ITEMS.find((n) => n.id === id)!.href, ...TABS[id] });
	steps.push({ id: 'settings', href: '/settings', ...SETTINGS });
	return steps;
}
