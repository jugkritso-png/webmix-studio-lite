# SourceCard

One input in the bottom strip (the shipped `.card`). The tally is the card's whole border: `pgm` ring + `glow-pgm` when on air, `pvw` ring + `glow-pvw` in preview, `line` otherwise. The tag repeats the state in words (PGM / PVW) on `pgm-fill` / `pvw-fill` so it never depends on hue alone.

- Provide: number (1-9, also the keyboard shortcut), name in `label` (13px, was 11.5-14px), one metadata line in `caption` (12px; the shipped 9px mono uppercase is too small for Thai), a live thumbnail.
- Tap = put in preview; double-tap or number key twice = cut to program. Drag a card onto a monitor to do the same (CapCut-style drag to canvas).
- Don't: colour the foot or name by state; add a third glow colour.
