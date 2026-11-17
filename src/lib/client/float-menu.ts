// The ⋯ menus. A menu is moved to <body> and placed next to the button that
// opened it, so a list box that clips what sticks out of it (overflow: hidden)
// can't cut the menu off. Near the bottom of the window it opens upward, near
// the right edge it shifts left, and it scrolls if the window is too short.
// Use: <div class="menu" use:floatMenu> inside the element that holds the button.

const GAP = 4;
const EDGE = 8;

export function floatMenu(node: HTMLElement, anchor?: HTMLElement | null) {
	let trigger: HTMLElement | null = anchor ?? node.parentElement;
	document.body.appendChild(node);
	node.style.position = 'fixed';
	node.style.right = 'auto';
	node.style.bottom = 'auto';
	node.style.zIndex = '900';
	node.style.overflowY = 'auto';
	node.classList.add('menu-floating');

	function place() {
		if (!trigger || !trigger.isConnected) return;
		const r = trigger.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const vh = window.innerHeight;
		node.style.maxHeight = `${vh - EDGE * 2}px`;
		const w = node.offsetWidth;
		const h = node.offsetHeight;
		// Right edges line up (as the menus always did); shift left or right to stay on screen.
		let left = r.right - w;
		if (left < EDGE) left = r.left;
		left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
		let top = r.bottom + GAP;
		if (top + h > vh - EDGE) {
			const above = r.top - GAP - h;
			top = above >= EDGE ? above : Math.max(EDGE, vh - EDGE - h);
		}
		node.style.left = `${Math.round(left)}px`;
		node.style.top = `${Math.round(top)}px`;
	}

	place();
	// Fonts or icons can change the size right after it opens.
	const raf = requestAnimationFrame(place);
	const onMove = () => place();
	window.addEventListener('resize', onMove);
	window.addEventListener('scroll', onMove, true);
	const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onMove) : null;
	ro?.observe(node);

	return {
		update(next?: HTMLElement | null) {
			trigger = next ?? trigger;
			place();
		},
		destroy() {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onMove);
			window.removeEventListener('scroll', onMove, true);
			ro?.disconnect();
			node.remove();
		}
	};
}
