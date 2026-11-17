<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import FlImportDialog from '#lib/components/FlImportDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { CATEGORY_SHORT, FULL_LENGTH_PROVIDERS, MISTAKE_REASONS, MISTAKE_STATE_LABELS, reasonLabel, SKILLS, type MistakeState } from '#lib/aamc.js';
	import { mediumDate } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let editing = $state(false);
	let deleteForm: HTMLFormElement | undefined = $state();
	let deleteOpen = $state(false);
	let importOpen = $state(false);
	const f = $derived(data.fullLength);
	$effect(() => {
		if (form && 'saved' in form) editing = false;
	});

	const SEC: Record<string, string> = { CP: 'Chem/Phys', CARS: 'CARS', BB: 'Bio/Biochem', PS: 'Psych/Soc' };
	const SKILL_NAME = Object.fromEntries(SKILLS.map((s) => [s.code, s.name]));
	const items = $derived(data.review.items);
	const bySection = $derived(items.reduce((m, i) => ((m[i.section] ??= []).push(i), m), {} as Record<string, typeof items>));
	const pct = (b: { correct: number; wrong: number; skipped: number }) => Math.round((b.correct / Math.max(1, b.correct + b.wrong + b.skipped)) * 100);

	// Wrong questions → mistake journal.
	let picked = $state<Record<string, boolean>>({});
	const wrongOnes = $derived(items.filter((i) => i.correct !== true));
	const pickedIds = $derived(Object.keys(picked).filter((k) => picked[k]));
	let reason = $state<string>('content_gap');
	let filter = $state<'all' | 'wrong'>('wrong');
	async function addMistakes() {
		try {
			const r = await api<{ made: number }>('/api/full-lengths', { body: { action: 'mistakes', id: f.id, itemIds: pickedIds, reason } });
			picked = {};
			toast(`${r.made} added to the mistake journal`);
			await invalidate('app:fl');
		} catch (err) {
			toastError(err);
		}
	}
</script>

<svelte:head><title>{f.provider} {f.form} · Medicus Vitae</title></svelte:head>

<div class="page" style="max-width: 60rem">
	<a href="/progress" class="back small"><Icon name="chevron-left" size={14} />Progress</a>
	<header class="page-header">
		<div>
			<h1>{f.provider} {f.form}</h1>
			<div class="subtitle">{mediumDate(f.date)}{f.details && (f.details as Record<string, unknown>).importedFrom ? ` · imported (${(f.details as Record<string, unknown>).importedFrom})` : ''}</div>
		</div>
		<div class="total mono">{f.total}</div>
	</header>

	{#if !editing}
		<div class="sections">
			{#each [['CP', f.cp], ['CARS', f.cars], ['BB', f.bb], ['PS', f.ps]] as [code, score] (code)}
				{@const b = data.review.bySection.find((x) => x.key === code)}
				<div class="sec">
					<span class="small"><span class="sec-bar" data-sec={code}></span> {SEC[code as string]}</span>
					<span class="mono strong sec-score">{score ?? '—'}</span>
					{#if b}<span class="tiny muted">{b.correct}/{b.correct + b.wrong + b.skipped} right · {pct(b)}%</span>{/if}
				</div>
			{/each}
		</div>
		{#if f.notes}<div class="card card-tight"><div class="section-label">Notes</div><p style="margin-top: 0.375rem; white-space: pre-wrap">{f.notes}</p></div>{/if}
		<div class="row-tight">
			<button type="button" class="btn btn-sm" onclick={() => (editing = true)}><Icon name="edit" size={15} />Edit scores</button>
			<button type="button" class="btn btn-sm" onclick={() => (importOpen = true)}><Icon name="download" size={15} />{items.length ? 'Replace question results' : 'Add question results'}</button>
			<span class="spacer"></span>
			<form method="POST" action="?/delete" use:enhance bind:this={deleteForm}>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (deleteOpen = true)}><Icon name="trash" size={15} />Delete</button>
			</form>
		</div>
	{:else}
		<form method="POST" action="?/save" class="card stack" use:enhance={() => async ({ update }) => update({ reset: false })}>
			<div class="form-grid">
				<div class="field"><label for="d">Date</label><input id="d" name="date" type="date" class="input" value={f.date} /></div>
				<div class="field"><label for="p">Made by</label><select id="p" name="provider" class="select">{#each FULL_LENGTH_PROVIDERS as p (p)}<option selected={p === f.provider}>{p}</option>{/each}</select></div>
				<div class="field"><label for="fm">Exam</label><input id="fm" name="form" class="input" value={f.form} /></div>
			</div>
			<div class="form-grid">
				<div class="field"><label for="cp">Chem/Phys</label><input id="cp" name="cp" type="number" class="input mono" value={f.cp ?? ''} /></div>
				<div class="field"><label for="cars">CARS</label><input id="cars" name="cars" type="number" class="input mono" value={f.cars ?? ''} /></div>
				<div class="field"><label for="bb">Bio/Biochem</label><input id="bb" name="bb" type="number" class="input mono" value={f.bb ?? ''} /></div>
				<div class="field"><label for="ps">Psych/Soc</label><input id="ps" name="ps" type="number" class="input mono" value={f.ps ?? ''} /></div>
			</div>
			<div class="field" style="max-width: 12rem"><label for="t">Total</label><input id="t" name="total" type="number" class="input mono" value={f.total ?? ''} /></div>
			<div class="field"><label for="n">Notes</label><textarea id="n" name="notes" class="textarea" rows="3">{f.notes}</textarea></div>
			{#if form && 'error' in form}<div class="error-box"><Icon name="alert" size={16} />{form.error}</div>{/if}
			<div class="form-actions"><button class="btn btn-primary">Save</button><button type="button" class="btn btn-ghost" onclick={() => (editing = false)}>Cancel</button></div>
		</form>
	{/if}

	{#if items.length}
		<section class="card stack-sm" aria-labelledby="grid-h">
			<div class="card-header">
				<h2 id="grid-h">Every question</h2>
				<span class="legend tiny muted"><span class="q-dot ok"></span>right <span class="q-dot bad"></span>wrong <span class="q-dot skip"></span>skipped <span class="q-dot logged"></span>in your journal</span>
			</div>
			{#each Object.entries(bySection) as [sec, list] (sec)}
				<div class="grid-sec">
					<div class="small strong"><span class="sec-bar" data-sec={sec}></span> {SEC[sec] ?? sec}</div>
					<div class="q-grid">
						{#each list ?? [] as i (i.id)}
							<span
								class="q {i.correct === true ? 'ok' : i.correct === false ? 'bad' : 'skip'}"
								class:logged={!!i.mistakeId}
								title="Q{i.number}{i.aamcCode ? ` · ${i.aamcCode} ${CATEGORY_SHORT[i.aamcCode] ?? ''}` : ''}{i.skillCode ? ` · ${i.skillCode}` : ''}{i.correctAnswer ? ` · answer ${i.correctAnswer}` : ''}{i.yourAnswer ? `, you ${i.yourAnswer}` : ''}">{i.number}</span
							>
						{/each}
					</div>
				</div>
			{/each}
		</section>

		{#if data.review.byCategory.length || data.review.bySkill.length}
			<div class="two">
				{#if data.review.byCategory.length}
					<section class="card card-flush" aria-labelledby="cat-h">
						<div class="card-head"><h2 id="cat-h" class="section-label">By content category</h2></div>
						<div class="list">
							{#each [...data.review.byCategory].sort((a, b) => pct(a) - pct(b)) as b (b.key)}
								<div class="list-row brow">
									<span class="small" style="flex: 1 1 auto; min-width: 0"><span class="mono strong">{b.key}</span> {CATEGORY_SHORT[b.key] ?? ''}</span>
									<span class="mono tiny">{b.correct}/{b.correct + b.wrong + b.skipped}</span>
									<div class="bar" style="width: 5rem" class:warn={pct(b) < 70}><span style="width: {pct(b)}%"></span></div>
								</div>
							{/each}
						</div>
					</section>
				{/if}
				{#if data.review.bySkill.length}
					<section class="card card-flush" aria-labelledby="skill-h">
						<div class="card-head"><h2 id="skill-h" class="section-label">By skill</h2></div>
						<div class="list">
							{#each data.review.bySkill as b (b.key)}
								<div class="list-row brow">
									<span class="small" style="flex: 1 1 auto; min-width: 0" title={SKILL_NAME[b.key] ?? ''}><span class="mono strong">{b.key}</span> {SKILL_NAME[b.key] ?? ''}</span>
									<span class="mono tiny">{b.correct}/{b.correct + b.wrong + b.skipped}</span>
									<div class="bar" style="width: 5rem" class:warn={pct(b) < 70}><span style="width: {pct(b)}%"></span></div>
								</div>
							{/each}
						</div>
					</section>
				{/if}
			</div>
		{/if}

		<section class="card card-flush" aria-labelledby="wrong-h">
			<div class="card-head row" style="justify-content: space-between">
				<h2 id="wrong-h" class="section-label">Questions to review · {wrongOnes.length}</h2>
				<div class="segmented" role="tablist" aria-label="Show">
					<button type="button" role="tab" aria-selected={filter === 'wrong'} onclick={() => (filter = 'wrong')}>Wrong &amp; skipped</button>
					<button type="button" role="tab" aria-selected={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
				</div>
			</div>
			{#if pickedIds.length}
				<div class="bulk row-tight">
					<span class="small strong">{pickedIds.length} picked</span>
					<label class="row-tight small">Reason
						<select class="select input-sm" style="width: auto" bind:value={reason}>{#each MISTAKE_REASONS as r (r.code)}<option value={r.code}>{r.label}</option>{/each}</select>
					</label>
					<button type="button" class="btn btn-sm btn-primary" onclick={addMistakes}><Icon name="journal" size={14} />Add to mistake journal</button>
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => (picked = {})}>Clear</button>
				</div>
			{/if}
			<div class="list">
				{#each filter === 'wrong' ? wrongOnes : items as i (i.id)}
					<div class="list-row">
						<input
							type="checkbox"
							class="pick"
							aria-label="Pick {SEC[i.section]} Q{i.number}"
							disabled={!!i.mistakeId || i.correct === true}
							checked={!!picked[i.id]}
							onchange={(e) => (picked = { ...picked, [i.id]: (e.currentTarget as HTMLInputElement).checked })}
						/>
						<span class="q {i.correct === true ? 'ok' : i.correct === false ? 'bad' : 'skip'}">{i.number}</span>
						<div style="flex: 1 1 14rem; min-width: 0">
							<div class="small strong">{SEC[i.section]} · question {i.number}{i.topic ? ` · ${i.topic}` : ''}</div>
							<div class="list-sub">
								{i.correct === true ? 'Right' : i.correct === false ? 'Wrong' : 'Skipped'}{i.yourAnswer ? ` · you chose ${i.yourAnswer}` : ''}{i.correctAnswer ? ` · answer ${i.correctAnswer}` : ''}{i.aamcCode ? ` · ${i.aamcCode} ${CATEGORY_SHORT[i.aamcCode] ?? ''}` : ''}{i.skillCode ? ` · ${i.skillCode}` : ''}{i.seconds ? ` · ${Math.round(i.seconds)} s` : ''}
							</div>
						</div>
						{#if i.mistakeId}<a class="pill pill-sm pill-accent" href="/mistakes/{i.mistakeId}">In journal</a>{/if}
					</div>
				{:else}
					<p class="small muted" style="padding: 0.75rem 1rem">Nothing wrong or skipped. Nice.</p>
				{/each}
			</div>
		</section>
	{:else}
		<div class="card empty">
			<Icon name="list" size={26} />
			<h2>See every question you got wrong</h2>
			<p>Paste this exam’s score report and review list from AAMC (or type the numbers you missed), and you get the breakdown by section, content category and skill, with one-step journal entries.</p>
			<button type="button" class="btn btn-primary" onclick={() => (importOpen = true)}><Icon name="download" size={15} />Add question results</button>
		</div>
	{/if}

	<section class="card card-flush" aria-labelledby="m-h">
		<div class="card-head row" style="justify-content: space-between">
			<h2 id="m-h" class="section-label">Mistakes from this exam · {data.mistakes.length}</h2>
			<a class="btn btn-sm" href="/mistakes?new=1&source=full_length&fl={f.id}"><Icon name="plus" size={15} />Log a mistake</a>
		</div>
		<div class="list">
			{#each data.mistakes as m (m.id)}
				<a class="list-row" href="/mistakes/{m.id}">
					<span class="pill pill-sm">{MISTAKE_STATE_LABELS[m.state as MistakeState]}</span>
					<span style="flex: 1 1 14rem" class="small strong">{m.summary || 'Untitled'}</span>
					<span class="small muted">{reasonLabel(m.reason)}</span>
					{#if m.aamcCode}<span class="code-tag" title={CATEGORY_SHORT[m.aamcCode]}>{m.aamcCode}</span>{/if}
				</a>
			{:else}
				<p class="small muted" style="padding: 0 1rem 0.875rem">No mistakes logged from this exam yet.</p>
			{/each}
		</div>
	</section>
</div>

<FlImportDialog bind:open={importOpen} flId={f.id} today={data.today} onsaved={() => invalidate('app:fl')} />

<ConfirmDialog bind:open={deleteOpen} title="Delete this full-length?" confirmLabel="Delete" onconfirm={() => deleteForm?.requestSubmit()}>
	<p>Its scores and question results go. Mistakes you logged from it stay in your journal.</p>
</ConfirmDialog>

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-3);
		text-decoration: none;
		align-self: flex-start;
		margin-bottom: -0.5rem;
	}
	.total {
		font-size: 2rem;
		font-weight: 600;
	}
	.sections {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
	}
	.sec {
		display: flex;
		flex-direction: column;
		padding: 0.75rem 1rem;
		border-right: 1px solid var(--border);
	}
	.sec:last-child {
		border-right: 0;
	}
	.sec-score {
		font-size: 1.25rem;
	}
	@media (max-width: 640px) {
		.sections {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.grid-sec {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-top: 0.5rem;
	}
	.q-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
	}
	.q {
		width: 1.75rem;
		height: 1.5rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 600;
		flex: none;
	}
	.q.ok {
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.q.bad {
		background: var(--weak-soft);
		color: var(--weak-text);
	}
	.q.skip {
		background: var(--surface-2);
		color: var(--text-3);
		outline: 1px dashed var(--border-strong);
	}
	.q.logged {
		box-shadow: inset 0 -2px 0 var(--ink);
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}
	.q-dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: 2px;
		display: inline-block;
	}
	.q-dot.ok {
		background: var(--accent-soft);
		outline: 1px solid var(--accent);
	}
	.q-dot.bad {
		background: var(--weak-soft);
		outline: 1px solid var(--weak);
	}
	.q-dot.skip {
		outline: 1px dashed var(--border-strong);
	}
	.q-dot.logged {
		background: var(--ink);
	}
	.two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1rem;
		align-items: start;
	}
	.brow {
		flex-wrap: nowrap;
	}
	.bulk {
		padding: 0.5rem 1rem;
		background: var(--accent-soft);
		border-top: 1px solid var(--border);
	}
	.pick {
		width: 1rem;
		height: 1rem;
		accent-color: var(--accent);
		flex: none;
	}
</style>
