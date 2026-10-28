# StatusChip

A pill (`radius-pill`, `control-sm` tall) that reports one state in the top bar or on a destination. Each tone pairs a soft ground with its own text colour and always carries a word: `pgm` on `pgm-soft` for LIVE, `pvw` on `pvw-soft` for connected, `amber` on `amber-soft` for warnings, `accent-text` on `accent-soft` for info. Numbers inside are `mono`.

- Filter chips in the gallery use the same shape; the selected one inverts to `text` on `bg`.
- Don't: colour-only dots without a word; more than three chips in the top bar.
