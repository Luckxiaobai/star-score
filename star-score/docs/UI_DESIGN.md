# StarScore UI Design Rules

## Direction

The interface follows a compact laboratory-console direction:

- layered translucent surfaces
- restrained cyan-teal and amber accents
- fine grid backgrounds and status traces
- dense, scan-friendly controls
- motion used for state changes, not decoration

The design references the interaction density of RhineLabUI, the continuity
ideas of onetake, the component organization of ThreeUI, and the immediate
feedback style of Bencho. Do not copy their assets or business code.

### HumanV console = dark instrument theme

The HumanV workbench (`<div class="humanv">`) is a self-contained dark
"oscilloscope / mixing console" surface, scoped to `.humanv` so the score
editor view keeps its light theme:

- Deep teal-charcoal background (`#0b1416`) with faint grid + radial glow.
- Dark glass surfaces (`rgba(20,32,35,0.78)`), never pure black.
- Bright teal accent `#2dd4bf` for primary actions and active states.
- Amber `#fbbf24` for warnings / dirty state; red `#f87171` for danger;
  green `#34d399` for completed steps.
- All form controls use `color-scheme: dark` so native selects/scrollbars
  match.
- The piano-roll canvas keeps its own light interior; only its frame is
  restyled to the dark border.

When editing HumanV visuals, redefine colors through the `--lab-*` tokens
inside `.humanv` rather than hardcoding hex values.

## Layout

- Global shell: sticky header, content bands, no floating page sections.
- HumanV: one console header, one left status rail, one main workspace.
- The piano roll is the primary surface and must keep the largest area.
- AI panels live in the main workspace and may scroll vertically.
- Dialogs use the shared command-palette/project-dialog styling.

## Tokens

Use variables from `src/styles/lab-ui.css`:

- `--lab-bg`
- `--lab-surface`
- `--lab-ink`
- `--lab-muted`
- `--lab-line`
- `--lab-accent`
- `--lab-warn`
- `--lab-danger`

Do not introduce a new dominant hue family for one component.

## Motion

- Panels may rise or drop by 8px or less.
- Buttons may translate by 1px and strengthen border/shadow.
- Status dots may pulse only when a real online/active state exists.
- Respect `prefers-reduced-motion`.
- Never animate canvas note rendering or audio-control loops for decoration.

## Responsive Rules

- Below 980px, the HumanV console header and status rail collapse to one column.
- Controls must wrap instead of overlapping.
- The piano roll keeps a usable minimum height.
- Dialog content must remain scrollable on short screens.

## Review Checklist

1. Does the piano roll remain the visual priority?
2. Are status, loading, disabled, and error states visible?
3. Does text fit at desktop and mobile widths?
4. Are animations disabled for reduced-motion users?
5. Did the change stay within the ownership layers in `AGENTS.md`?
