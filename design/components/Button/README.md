# Button

Flat fill, one accent. **Primary** (`accent`) at most once per region, for the thing that region is for; everything else is the default `panel-2` button or `ghost`. The live button is the only `pgm-fill` button and only while on air.

- Provide: a verb-first Thai label ("เพิ่มแหล่งภาพ", "เริ่มไลฟ์"), optional leading 18px icon, optional shortcut shown as `wm-kbd` inside the tooltip, never inside the label on phones.
- Sizes: `control-sm` 28 (toolbars), `control-md` 34 (desktop default), `control-lg` 44 (every touch device).
- Icon-only buttons need `aria-label` and a tooltip with the shortcut ("ย้อนกลับ ⌘Z").
- Replaces the shipped gradients (`.btn-primary` #2f6fe8 to #2158c9, `.btn-green`, `.btn-danger`): use flat `accent` / `pgm-fill`; green is never an action.
- Don't: two primaries side by side; red for "delete" in a toolbar (use default + confirm with undo toast).
