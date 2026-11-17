<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '#lib/client/api.js';
	import { toast } from '#lib/client/toast.svelte.js';
	import { FULL_LENGTH_PROVIDERS } from '#lib/aamc.js';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';

	// Bringing in a full-length's question-by-question results: paste what AAMC's
	// score report or review list shows (read by the AI, or by text rules), or type
	// the numbers you got wrong per section. With flId, adds questions to an exam
	// already logged instead of making a new one.

	let { open = $bindable(false), flId = null, today, onsaved }: { open?: boolean; flId?: string | null; today: string; onsaved?: () => void } = $props();

	type Sec = 'CP' | 'CARS' | 'BB' | 'PS';
	const SECS: { id: Sec; name: string; size: number }[] = [
		{ id: 'CP', name: 'Chem/Phys', size: 59 },
		{ id: 'CARS', name: 'CARS', size: 53 },
		{ id: 'BB', name: 'Bio/Biochem', size: 59 },
		{ id: 'PS', name: 'Psych/Soc', size: 59 }
	];
	const EXAMS = ['Practice Exam 1', 'Practice Exam 2', 'Practice Exam 3', 'Practice Exam 4', 'Practice Exam 5', 'Sample Test (scored)', 'Sample Test (unscored)'];

	interface Item {
		section: Sec;
		number: number;
		correct: boolean | null;
		yourAnswer?: string | null;
		correctAnswer?: string | null;
		aamcCode?: string | null;
		skillCode?: string | null;
		topic?: string;
		seconds?: number | null;
	}

	let tab = $state<'paste' | 'manual'>('paste');
	let provider = $state('AAMC');
	let form = $state('Practice Exam 1');
	let date = $state('');
	let scores = $state<Record<'cp' | 'cars' | 'bb' | 'ps' | 'total', number | null>>({ cp: null, cars: null, bb: null, ps: null, total: null });
	let text = $state('');
	let reading = $state(false);
	let items = $state<Item[] | null>(null);
	let method = $state<'ai' | 'text' | null>(null);
	let wrong = $state<Record<Sec, string>>({ CP: '', CARS: '', BB: '', PS: '' });
	let skipped = $state<Record<Sec, string>>({ CP: '', CARS: '', BB: '', PS: '' });
	let saving = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		date = today;
		error = '';
		items = null;
		method = null;
		text = '';
	});

	async function read() {
		reading = true;
		error = '';
		try {
			const r = await api<{ report: { exam: string; date: string | null; total: number | null; cp: number | null; cars: number | null; bb: number | null; ps: number | null; items: Item[]; method: 'ai' | 'text' } }>('/api/full-lengths', {
				body: { action: 'parse', text }
			});
			const rep = r.report;
			items = rep.items;
			method = rep.method;
			if (rep.date) date = rep.date;
			const m = /exam\s*(\d)/i.exec(rep.exam);
			if (m) form = `Practice Exam ${m[1]}`;
			else if (/sample/i.test(rep.exam)) form = /unscored/i.test(rep.exam) ? 'Sample Test (unscored)' : 'Sample Test (scored)';
			scores = { cp: rep.cp ?? scores.cp, cars: rep.cars ?? scores.cars, bb: rep.bb ?? scores.bb, ps: rep.ps ?? scores.ps, total: rep.total ?? scores.total };
			if (!rep.items.length) error = 'No questions with right/wrong marks were found. If you copied the score report, also copy the review list (it lists each question). Or type the ones you got wrong instead.';
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			reading = false;
		}
	}

	const counts = $derived(
		SECS.map((s) => {
			const list = (items ?? []).filter((i) => i.section === s.id);
			return { ...s, n: list.length, right: list.filter((i) => i.correct === true).length, wrong: list.filter((i) => i.correct === false).length, skipped: list.filter((i) => i.correct === null).length };
		})
	);

	async function save() {
		saving = true;
		error = '';
		try {
			const manual = tab === 'manual';
			if (flId) {
				await api('/api/full-lengths', { body: manual ? { action: 'set-items', id: flId, wrong, skipped } : { action: 'set-items', id: flId, items } });
				toast('Questions saved');
				open = false;
				onsaved?.();
				return;
			}
			const exam = { date, provider, form, ...scores, notes: '', items: manual ? [] : (items ?? []), details: { importedFrom: manual ? 'typed' : method === 'ai' ? 'pasted (AI)' : 'pasted' } };
			const r = await api<{ id: string }>('/api/full-lengths', { body: manual ? { action: 'save', exam, wrong, skipped } : { action: 'save', exam } });
			toast('Full-length saved');
			open = false;
			onsaved?.();
			await goto(`/progress/full-lengths/${r.id}`);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	const canSave = $derived(tab === 'manual' ? Object.values(wrong).some((v) => v.trim()) || Object.values(skipped).some((v) => v.trim()) || (!flId && (scores.total || scores.cp)) : !!items?.length);
</script>

<Modal bind:open title={flId ? 'Add question results' : 'Import a full-length'} wide>
	<div class="stack">
		<div class="tabs" role="tablist" aria-label="How">
			<button type="button" role="tab" aria-selected={tab === 'paste'} onclick={() => (tab = 'paste')}>Paste from AAMC</button>
			<button type="button" role="tab" aria-selected={tab === 'manual'} onclick={() => (tab = 'manual')}>Type the ones I got wrong</button>
		</div>

		{#if !flId}
			<div class="form-grid">
				<label class="field"><span class="label">Made by</span><select class="select" bind:value={provider}>{#each FULL_LENGTH_PROVIDERS as p (p)}<option>{p}</option>{/each}</select></label>
				<label class="field"><span class="label">Exam</span><input class="input" list="fl-exams" bind:value={form} /><datalist id="fl-exams">{#each EXAMS as e (e)}<option value={e}></option>{/each}</datalist></label>
				<label class="field"><span class="label">Date taken</span><input class="input" type="date" bind:value={date} /></label>
			</div>
		{/if}

		{#if tab === 'paste'}
			<ol class="small steps">
				<li>On AAMC’s site, open the exam’s <strong>Score Report</strong>, then its <strong>Review</strong> list (the table of every question with correct/incorrect).</li>
				<li>Click on the page, press <span class="kbd">Ctrl</span> <span class="kbd">A</span> then <span class="kbd">Ctrl</span> <span class="kbd">C</span>. Paste below. If sections are on separate pages, paste them one after another.</li>
				<li>Press <strong>Read</strong>, check the numbers, and save. Only your results are kept, not AAMC’s questions.</li>
			</ol>
			<textarea class="textarea" rows="8" bind:value={text} placeholder="Paste the copied score report and review list here…"></textarea>
			<div class="row-tight">
				<button type="button" class="btn btn-navy" disabled={reading || text.trim().length < 40} onclick={read}><Icon name="sparkle" size={15} />{reading ? 'Reading…' : 'Read'}</button>
				{#if method}<span class="small muted">Read {method === 'ai' ? 'by your AI service' : 'by the text rules (connect AI in Settings › AI for any layout)'}</span>{/if}
			</div>
			{#if items?.length}
				<div class="table-wrap">
					<table class="table">
						<thead><tr><th>Section</th><th class="mono">Questions</th><th class="mono">Right</th><th class="mono">Wrong</th><th class="mono">Skipped</th></tr></thead>
						<tbody>
							{#each counts as c (c.id)}
								<tr><td>{c.name}</td><td class="mono">{c.n}{c.n && c.n !== c.size ? ` of ${c.size}` : ''}</td><td class="mono">{c.right}</td><td class="mono">{c.wrong}</td><td class="mono">{c.skipped}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{:else}
			<p class="small muted">For each section, list the question numbers you got wrong (like <span class="mono">3, 7, 12-14</span>). Every other question counts as right. Content categories can be added later.</p>
			<div class="wrong-grid">
				{#each SECS as s (s.id)}
					<label class="field"><span class="label">{s.name} · wrong <span class="muted">(of {s.size})</span></span><input class="input mono" bind:value={wrong[s.id]} placeholder="e.g. 4, 9, 21-23" /></label>
					<label class="field"><span class="label">skipped</span><input class="input mono" bind:value={skipped[s.id]} placeholder="none" /></label>
				{/each}
			</div>
		{/if}

		{#if !flId}
			<div class="scores">
				<span class="label">Scores</span>
				<label><span class="tiny muted">Chem/Phys</span><input class="input input-sm mono" type="number" min="118" max="132" bind:value={scores.cp} /></label>
				<label><span class="tiny muted">CARS</span><input class="input input-sm mono" type="number" min="118" max="132" bind:value={scores.cars} /></label>
				<label><span class="tiny muted">Bio/Biochem</span><input class="input input-sm mono" type="number" min="118" max="132" bind:value={scores.bb} /></label>
				<label><span class="tiny muted">Psych/Soc</span><input class="input input-sm mono" type="number" min="118" max="132" bind:value={scores.ps} /></label>
				<label><span class="tiny muted">Total</span><input class="input input-sm mono" type="number" min="472" max="528" bind:value={scores.total} /></label>
			</div>
		{/if}
		{#if error}<div class="warning small" role="alert"><Icon name="info" size={15} />{error}</div>{/if}
	</div>
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={saving || !canSave} onclick={save}>{saving ? 'Saving…' : 'Save'}</button>
	{/snippet}
</Modal>

<style>
	.steps {
		margin: 0;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		color: var(--text-2);
	}
	.wrong-grid {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		gap: 0.5rem 0.75rem;
	}
	.scores {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 0.75rem;
	}
	.scores label {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		width: 6.5rem;
	}
</style>
