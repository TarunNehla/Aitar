# UI guidelines

These rules apply to every screen in this repository. They sit on top of the
[design system](../src/client/design-system/README.md), which owns colour, type, spacing,
radius, elevation, and motion. Where the two overlap, the design system wins on *how a
thing looks* and this document wins on *how much of it there is*.

> Use minimal text, clear hierarchy, and meaningful icons.
> The interface should explain itself through layout and interaction.

## Text

- One clear heading per view. Not one per section, one per view.
- One short helper sentence, and only when the controls cannot carry the meaning alone.
- Remove repeated instructions. If two screens say the same thing, neither should.
- Remove technical implementation detail from user-facing copy: installation mechanics,
  provider wiring, model identifiers, transport names.
- Put secondary explanation in a tooltip, a dialog, or progressive disclosure — never in a
  paragraph beside the control.
- Empty states get a heading and one useful next action, not a description of the feature.

## Actions

- One obvious primary action per view or per step. Everything else is secondary.
- A step that can fail needs a visible back action.
- Loading, disabled, and error states are part of the control, not extra prose.

## Icons

- Prefer icons for familiar actions.
- Pair an ambiguous icon with a label or a `title` tooltip. An icon-only control always
  needs an `aria-label`.
- Never use an icon as decoration, and never use a generic arrow to stand in for a brand.
- House glyphs come from `src/client/components/Icon.tsx`, which resolves the design
  system's Lucide set. Add a glyph upstream first, then extend the map.
- Provider brand marks are the one exception to "never hand-author SVG". Google and GitHub
  publish their own marks and their sign-in guidelines require them, so they live in
  `src/client/components/ProviderIcon.tsx`, separate from the house set. Nothing else
  belongs in that file.

## Errors

- Keep an error to one sentence: name the thing, then the next move. Never blame the user.
- Put a field error beside its field and wire it up with `aria-describedby`.
- Put a form error beside the control that failed — above the primary action, not at the
  bottom of the page.
- Guidance about a *specific* failure belongs only where that failure appears. Advice about
  social accounts, for example, shows next to the credential error that a social-only user
  actually hits, and nowhere else.

## Accessibility

Accessibility is never the thing that gets cut to reduce text.

- Real `<label>` elements and semantic `<form>` elements.
- Errors connected with `aria-describedby`; success and failure announced through
  `role="status"` and `role="alert"`.
- Accessible names on every icon-only control.
- Visible keyboard focus, always. Never remove the focus ring.
- Never communicate state through colour alone — pair it with an icon or with text.
- Respect `prefers-reduced-motion`; the media query at the end of `styles.css` stays last.

## Layout

- Desktop: keep the content centred and capped. A form does not grow to fill a 27" display.
- Mobile: use the available width, reduce outer padding, keep touch targets at 44px or
  larger, and never scroll horizontally.
- A step should fit without unnecessary scrolling. If it does not, it is doing too much —
  split it rather than shrinking the type.

## Tokens

Authentication and onboarding reuse shared values rather than inventing per-screen ones:

| Token | Purpose |
| --- | --- |
| `--auth-card-width` | Width cap for the authentication card |
| `--control-height` | Standard input and control height |
| `--control-height-lg` | Primary action and provider button height |
| `--touch-target` | Minimum interactive size on small screens |

Everything else — spacing, radius, focus rings, error, success, and muted colour — comes
from `src/client/design-system/tokens/`. Those files are a verbatim upstream mirror, so
app-only layout constants are defined at the top of `src/client/styles.css` instead. A
literal hex or a one-off pixel value in an auth or onboarding rule is a bug.

## Authentication structure

Every authentication view is built from the same pieces in
`src/client/components/auth/`: `AuthShell`, `AuthCard`, `AuthHeader`, `AuthField`,
`PasswordField`, `SocialSignInButtons`, and `AuthStatus`. `AuthScreen` composes them and is
the only component that decides which view is on screen.

View state lives in `src/client/auth-flow.ts` — mode, pending operation, field errors,
general error, and success state — and copy lives in `src/client/auth-copy.ts`. Sign-in,
sign-up, verification, and reset-link URL handling are resolved once, by `readAuthEntry`.
Do not scatter that logic back into unrelated components, and do not add a one-off layout
for a new step.
