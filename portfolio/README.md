# Portfolio

One folder per project: `portfolio/<slug>/`

- `intake.yaml`: drafted by the Chief, approved by the owner (schema `schemas/intake.schema.json`).
- `rounds/NN/submission.yaml`: added by `greenhouse submit` in a PR titled `submission: <slug> round NN`.
- `rounds/NN/checks.json`, `rounds/NN/reviews/<n>.json`, `rounds/NN/score.json`, `rounds/NN/ruling.md`: written by the judge.
- `feedback/`: the owner's words, verbatim.

A submission PR may only add files under its own `portfolio/<slug>/rounds/NN/` folder (path-guard check).
