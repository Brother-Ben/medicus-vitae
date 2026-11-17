import { diffDays, mediumDate } from '#lib/dates.js';
import { accountAppearance } from '#lib/server/appearance.js';
import { pendingCount } from '#lib/server/ai/generate.js';
import { aiConnected } from '#lib/server/ai/providers.js';
import { queueCounts } from '#lib/server/cards.js';
import { sqlite } from '#lib/server/db/index.js';
import { config } from '#lib/server/config.js';
import { guideDone } from '#lib/server/guide.js';
import { hostName, role } from '#lib/server/instance.js';
import { peerState } from '#lib/server/peer.js';
import { activeSession } from '#lib/server/planner.js';
import { listMistakes } from '#lib/server/practice.js';
import { focusPrefs, studyClock, studySettings } from '#lib/server/settings.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ depends }) => {
	depends('app:shell');
	const s = studySettings();
	const clock = studyClock(Date.now(), s);
	const r = role();
	const peer = peerState();
	const name = s.displayName.trim();
	const pendingApprovals = pendingCount();
	const questions = (sqlite().prepare(`SELECT count(*) AS n FROM question WHERE deleted_at IS NULL AND approval_status = 'approved'`).get() as { n: number }).n;
	const look = accountAppearance();
	return {
		shell: {
			displayName: name,
			initial: (name[0] ?? 'Y').toUpperCase(),
			dueCount: queueCounts(clock).total,
			openMistakes: listMistakes({ state: 'active' }).length,
			testDate: s.testDate ? mediumDate(s.testDate) : null,
			daysToTest: s.testDate ? diffDays(clock.today, s.testDate) : null,
			role: r,
			allowQuit: config.allowQuit,
			version: config.version,
			hostName: hostName(),
			standby: r === 'primary' ? null : { heldAt: peer.held?.createdAt ?? null, source: peer.held?.sourceHostName ?? null },
			conflict: !!peer.conflict,
			tutor: aiConnected() || pendingApprovals > 0 || questions > 0,
			pendingApprovals,
			/** Today's session in progress, for the session bar on every page. */
			session: activeSession(),
			focusPrefs: focusPrefs(),
			layout: { nav: look.nav, home: look.home },
			/** The first-time guide was finished or skipped (otherwise it shows once). */
			guideDone: guideDone()
		}
	};
};
