# Field

Label above, control below, help or error under it. Labels are `caption` in `muted` (12px, was 10.5px). Inputs sit on `well` with a `line-2` border; focus switches the border to `accent-line` and adds `focus-ring`.

- Provide: label, control (input, select, slider, toggle), optional help line. Errors replace the help line in `pgm` and say what to do ("ใส่ URL ที่ขึ้นต้นด้วย rtmp://").
- Sliders show their value in `timecode` mono on the right and accept typing on double-click.
- Secret fields (stream key) are masked with a "แสดง" toggle and never pre-filled in previews or screenshots.
