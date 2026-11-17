import { capabilities, claudeCodeAccounts, claudeCodeSettings, findClaudeExecutables, resolveClaudeExe } from '#lib/server/ai/claude-code.js';
import type { RequestHandler } from './$types';

/**
 * Looks for Claude Code on this computer (Settings › AI asks for this after the
 * page shows, since it runs the program a few times): where it is, its version,
 * and which Claude account each of its settings folders is signed in to.
 */
export const GET: RequestHandler = async ({ url }) => {
	const settings = claudeCodeSettings();
	const asked = url.searchParams.get('exe')?.trim() || null;
	const found = findClaudeExecutables();
	const exe = asked ?? resolveClaudeExe(settings);
	if (!exe) return Response.json({ exe: null, found, version: null, accounts: [], problem: 'Claude Code wasn’t found on this computer.' });
	const caps = await capabilities(exe);
	if (!caps.version) {
		return Response.json({ exe, found, version: null, accounts: [], problem: `${exe} didn’t answer like Claude Code does.` });
	}
	const accounts = await claudeCodeAccounts(exe);
	return Response.json({ exe, found: [...new Set([exe, ...found])], version: caps.version, accounts, problem: null });
};
