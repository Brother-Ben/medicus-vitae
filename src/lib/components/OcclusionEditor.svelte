<script lang="ts">
	import { api } from '#lib/client/api.js';
	import { imageName, occlusionText, parseOcclusion, type IoShape } from '#lib/occlusion.js';
	import { toast } from '#lib/client/toast.svelte.js';
	import CategorySelect from './CategorySelect.svelte';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';

	let {
		open = $bindable(false),
		noteId = null,
		noteTypeId = 'nt-image-occlusion',
		fields = null,
		tags: initialTags = [],
		aamcCode: initialCode = null,
		onsaved
	}: {
		open?: boolean;
		/** Editing an existing note (made here or imported from Anki). */
		noteId?: string | null;
		noteTypeId?: string;
		fields?: Record<string, string> | null;
		tags?: string[];
		aamcCode?: string | null;
		onsaved?: () => void;
	} = $props();

	let image = $state<string | null>(null);
	let shapes = $state<IoShape[]>([]);
	let keep = $state<string[]>([]);
	let hideAll = $state(true);
	let header = $state('');
	let backExtra = $state('');
	let comments = $state('');
	let tags = $state('');
	let aamcCode = $state<string | null>(null);
	let tool = $state<'rect' | 'ellipse' | 'select'>('rect');
	let selected = $state<string[]>([]);
	let uploading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let stage: HTMLDivElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();

	$effect(() => {
		if (!open) return;
		error = '';
		selected = [];
		tool = 'rect';
		const f = fields ?? {};
		image = imageName(f['Image'] ?? '');
		const parsed = parseOcclusion(f['Occlusion'] ?? '');
		shapes = parsed.shapes;
		keep = parsed.keep;
		hideAll = parsed.hideAll;
		header = f['Header'] ?? '';
		backExtra = f['Back Extra'] ?? '';
		comments = f['Comments'] ?? '';
		tags = initialTags.join(' ');
		aamcCode = initialCode;
	});

	const cards = $derived(new Set(shapes.map((s) => s.ord)).size + new Set(keep.map((k) => /\{\{c(\d+)/.exec(k)?.[1])).size);

	async function upload(file: File) {
		if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) {
			error = 'Use a PNG, JPEG, GIF or WebP image.';
			return;
		}
		uploading = true;
		error = '';
		try {
			const res = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name || 'image')}`, { method: 'PUT', body: file, headers: { 'content-type': file.type } });
			const data = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
			if (!res.ok || !data.name) throw new Error(data.error ?? 'Upload failed.');
			image = data.name;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			uploading = false;
		}
	}

	function onPaste(e: ClipboardEvent) {
		if (!open) return;
		const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
		const file = item?.getAsFile();
		if (file) {
			e.preventDefault();
			void upload(file);
		}
	}

	// --------------------------------------------------------- drawing

	type Drag =
		| { mode: 'draw'; id: string; x0: number; y0: number }
		| { mode: 'move'; x0: number; y0: number; start: Map<string, { left: number; top: number }> }
		| { mode: 'resize'; id: string; x0: number; y0: number; w0: number; h0: number };
	let drag: Drag | null = null;

	function point(e: PointerEvent) {
		const r = stage!.getBoundingClientRect();
		return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
	}

	const nextOrd = () => (shapes.length ? Math.max(...shapes.map((s) => s.ord)) + 1 : 1);

	function stageDown(e: PointerEvent) {
		if (!stage || e.button !== 0) return;
		const target = e.target as HTMLElement;
		if (target.closest('.shape') || target.closest('.handle')) return;
		if (tool === 'select') {
			selected = [];
			return;
		}
		const p = point(e);
		const id = crypto.randomUUID();
		shapes = [...shapes, { id, ord: nextOrd(), kind: tool, left: p.x, top: p.y, width: 0, height: 0 }];
		drag = { mode: 'draw', id, x0: p.x, y0: p.y };
		stage.setPointerCapture(e.pointerId);
	}

	function shapeDown(e: PointerEvent, s: IoShape) {
		if (e.button !== 0) return;
		e.stopPropagation();
		if (e.shiftKey) selected = selected.includes(s.id) ? selected.filter((x) => x !== s.id) : [...selected, s.id];
		else if (!selected.includes(s.id)) selected = [s.id];
		const p = point(e);
		drag = { mode: 'move', x0: p.x, y0: p.y, start: new Map(shapes.filter((x) => selected.includes(x.id)).map((x) => [x.id, { left: x.left, top: x.top }])) };
		stage!.setPointerCapture(e.pointerId);
	}

	function handleDown(e: PointerEvent, s: IoShape) {
		e.stopPropagation();
		const p = point(e);
		drag = { mode: 'resize', id: s.id, x0: p.x, y0: p.y, w0: s.width, h0: s.height };
		stage!.setPointerCapture(e.pointerId);
	}

	function stageMove(e: PointerEvent) {
		if (!drag) return;
		const p = point(e);
		const d = drag;
		shapes = shapes.map((s) => {
			if (d.mode === 'draw' && s.id === d.id) return { ...s, left: Math.min(d.x0, p.x), top: Math.min(d.y0, p.y), width: Math.abs(p.x - d.x0), height: Math.abs(p.y - d.y0) };
			if (d.mode === 'move' && d.start.has(s.id)) {
				const st = d.start.get(s.id)!;
				return { ...s, left: Math.max(0, Math.min(1 - s.width, st.left + p.x - d.x0)), top: Math.max(0, Math.min(1 - s.height, st.top + p.y - d.y0)) };
			}
			if (d.mode === 'resize' && s.id === d.id) return { ...s, width: Math.max(0.01, Math.min(1 - s.left, d.w0 + p.x - d.x0)), height: Math.max(0.01, Math.min(1 - s.top, d.h0 + p.y - d.y0)) };
			return s;
		});
	}

	function stageUp() {
		const d = drag;
		drag = null;
		if (d?.mode === 'draw') {
			const s = shapes.find((x) => x.id === d.id);
			if (!s || s.width < 0.008 || s.height < 0.008) shapes = shapes.filter((x) => x.id !== d.id);
			else selected = [s.id];
		}
	}

	function renumber(list: IoShape[]) {
		const order = [...new Set(list.map((s) => s.ord))].sort((a, b) => a - b);
		const map = new Map(order.map((o, i) => [o, i + 1]));
		return list.map((s) => ({ ...s, ord: map.get(s.ord)! }));
	}

	function removeSelected() {
		shapes = renumber(shapes.filter((s) => !selected.includes(s.id)));
		selected = [];
	}

	function group() {
		if (selected.length < 2) return;
		const ord = Math.min(...shapes.filter((s) => selected.includes(s.id)).map((s) => s.ord));
		shapes = renumber(shapes.map((s) => (selected.includes(s.id) ? { ...s, ord } : s)));
	}

	function ungroup() {
		let next = nextOrd();
		const seen = new Set<number>();
		shapes = renumber(
			shapes.map((s) => {
				if (!selected.includes(s.id)) return s;
				if (!seen.has(s.ord)) {
					seen.add(s.ord);
					return s;
				}
				return { ...s, ord: next++ };
			})
		);
	}

	function onKey(e: KeyboardEvent) {
		if (!open) return;
		const t = e.target as HTMLElement;
		if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
		if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
			e.preventDefault();
			removeSelected();
		} else if (e.key.toLowerCase() === 'g' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (e.shiftKey) ungroup();
			else group();
		} else if (e.key === 'Escape' && selected.length) {
			e.stopPropagation();
			selected = [];
		} else if (e.key === 'r') tool = 'rect';
		else if (e.key === 'e') tool = 'ellipse';
		else if (e.key === 'v') tool = 'select';
	}

	async function save() {
		if (!image) {
			error = 'Add an image first.';
			return;
		}
		if (!shapes.length && !keep.length) {
			error = 'Draw at least one box over the part to hide.';
			return;
		}
		saving = true;
		error = '';
		const out: Record<string, string> = {
			...(fields ?? {}),
			Occlusion: occlusionText(shapes, hideAll, keep),
			Image: `<img src="${image.replace(/"/g, '&quot;')}">`,
			Header: header,
			'Back Extra': backExtra,
			Comments: comments
		};
		const tagList = tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
		try {
			if (noteId) {
				await api('/api/cards', { method: 'PATCH', body: { noteId, note: { kind: 'anki', fields: out, aamcCode, tags: tagList } } });
				toast('Masks saved');
			} else {
				const r = await api<{ cardIds: string[] }>('/api/cards', { body: { templated: { noteTypeId, fields: out, aamcCode, tags: tagList } } });
				toast(`${r.cardIds.length} image occlusion card${r.cardIds.length === 1 ? '' : 's'} created`);
			}
			open = false;
			onsaved?.();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<svelte:window onpaste={onPaste} onkeydown={onKey} />

<Modal bind:open title={noteId ? 'Edit image occlusion' : 'New image occlusion card'} wide>
	<div class="stack-sm">
		{#if !image}
			<div
				class="drop"
				role="group"
				aria-label="Image"
				ondragover={(e) => e.preventDefault()}
				ondrop={(e) => {
					e.preventDefault();
					const f = e.dataTransfer?.files?.[0];
					if (f) void upload(f);
				}}
			>
				<Icon name="image" size={24} />
				<div>
					<div class="strong">{uploading ? 'Uploading…' : 'Add the image'}</div>
					<div class="small muted">Drop it here, paste it (Ctrl+V, e.g. a screenshot), or choose a file.</div>
				</div>
				<button type="button" class="btn btn-primary" disabled={uploading} onclick={() => fileInput?.click()}>Choose image</button>
				<input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" class="sr-only" onchange={(e) => {
					const f = (e.currentTarget as HTMLInputElement).files?.[0];
					if (f) void upload(f);
				}} />
			</div>
		{:else}
			<div class="tools row-tight" role="toolbar" aria-label="Mask tools">
				<div class="segmented" role="radiogroup" aria-label="Tool">
					<button type="button" role="radio" aria-checked={tool === 'rect'} onclick={() => (tool = 'rect')} title="Rectangle (R)"><Icon name="square" size={14} />Box</button>
					<button type="button" role="radio" aria-checked={tool === 'ellipse'} onclick={() => (tool = 'ellipse')} title="Ellipse (E)"><Icon name="ellipse" size={14} />Ellipse</button>
					<button type="button" role="radio" aria-checked={tool === 'select'} onclick={() => (tool = 'select')} title="Select and move (V)">Select</button>
				</div>
				<button type="button" class="btn btn-sm" disabled={selected.length < 2} onclick={group} title="Hide these together on one card (Ctrl+G)">Group</button>
				<button type="button" class="btn btn-sm btn-ghost" disabled={!selected.length} onclick={ungroup} title="Ctrl+Shift+G">Ungroup</button>
				<button type="button" class="btn btn-sm btn-ghost" disabled={!selected.length} onclick={removeSelected}><Icon name="trash" size={14} />Delete</button>
				<span class="spacer"></span>
				<div class="segmented" role="radiogroup" aria-label="What the front hides">
					<button type="button" role="radio" aria-checked={hideAll} onclick={() => (hideAll = true)} title="Every mask is covered; one is asked">Hide all, guess one</button>
					<button type="button" role="radio" aria-checked={!hideAll} onclick={() => (hideAll = false)} title="Only the asked mask is covered">Hide one, guess one</button>
				</div>
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="stage-wrap">
				<div class="stage" class:drawing={tool !== 'select'} bind:this={stage} onpointerdown={stageDown} onpointermove={stageMove} onpointerup={stageUp} onpointercancel={stageUp}>
					<img src="/api/media/{encodeURIComponent(image)}" alt="The figure being masked" draggable="false" />
					{#each shapes as s (s.id)}
						<div
							class="shape {s.kind}"
							class:sel={selected.includes(s.id)}
							style="left: {s.left * 100}%; top: {s.top * 100}%; width: {s.width * 100}%; height: {s.height * 100}%"
							onpointerdown={(e) => shapeDown(e, s)}
							role="button"
							tabindex="-1"
							aria-label="Mask {s.ord}"
						>
							<span class="ord mono">{s.ord}</span>
							{#if selected.length === 1 && selected[0] === s.id}
								<span class="handle" role="presentation" onpointerdown={(e) => handleDown(e, s)}></span>
							{/if}
						</div>
					{/each}
				</div>
			</div>
			<div class="row" style="justify-content: space-between">
				<span class="small muted">{shapes.length + keep.length} mask{shapes.length + keep.length === 1 ? '' : 's'} · {cards} card{cards === 1 ? '' : 's'}. Drag to draw; Shift+click to pick several, then Group to hide them on one card.</span>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (image = null)}>Change image</button>
			</div>
		{/if}

		<div class="form-grid">
			<label class="field"><span class="label">Header <span class="muted">(optional, shown above)</span></span><input class="input" bind:value={header} /></label>
			<label class="field"><span class="label">Back extra <span class="muted">(optional)</span></span><input class="input" bind:value={backExtra} /></label>
			<div class="field"><label for="io-cat">AAMC category</label><CategorySelect id="io-cat" bind:value={aamcCode} /></div>
			<label class="field"><span class="label">Tags</span><input class="input" bind:value={tags} placeholder="anatomy heart" /></label>
		</div>
		{#if error}<div class="error-box" role="alert"><Icon name="alert" size={16} />{error}</div>{/if}
	</div>
	{#snippet footer()}
		<span class="small muted" style="margin-right: auto">Works in Anki too (its own Image Occlusion type).</span>
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={saving || !image} onclick={save}>{saving ? 'Saving…' : noteId ? 'Save masks' : `Create ${cards || ''} card${cards === 1 ? '' : 's'}`}</button>
	{/snippet}
</Modal>

<style>
	.drop {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.875rem;
		padding: 1.5rem 1.25rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-lg);
		color: var(--text-2);
	}
	.drop > div {
		flex: 1 1 14rem;
	}
	.tools {
		gap: 0.375rem;
	}
	.stage-wrap {
		max-height: 60vh;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
		display: flex;
		justify-content: center;
	}
	.stage {
		position: relative;
		display: inline-block;
		user-select: none;
		touch-action: none;
		line-height: 0;
	}
	.stage.drawing {
		cursor: crosshair;
	}
	.stage img {
		display: block;
		max-width: 100%;
		max-height: 58vh;
		pointer-events: none;
	}
	.shape {
		position: absolute;
		background: color-mix(in srgb, #ff8e8e 75%, transparent);
		border: 1px solid #212121;
		cursor: move;
		line-height: 1;
	}
	.shape.ellipse {
		border-radius: 50%;
	}
	.shape.sel {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.ord {
		position: absolute;
		left: 2px;
		top: 2px;
		font-size: 0.6875rem;
		font-weight: 700;
		color: #111;
		background: rgba(255, 255, 255, 0.85);
		border-radius: 3px;
		padding: 0 3px;
		pointer-events: none;
	}
	.handle {
		position: absolute;
		right: -5px;
		bottom: -5px;
		width: 10px;
		height: 10px;
		background: var(--accent);
		border: 1px solid var(--surface);
		border-radius: 2px;
		cursor: nwse-resize;
	}
</style>
