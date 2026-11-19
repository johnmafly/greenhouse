# Mock figures

Every sample figure the site shows (decision 0008, rule 1). Each one is marked `data-mock` on the
page, with the note "Sample figures for the private preview" beside it. `greenhouse check` (gate
`mock-figures`) fails when a marked number is missing here or the note is missing beside it.
List the figure as the page shows it; every number in the Figure cell counts.

| Page | Figure | What it shows |
|---|---|---|
| /docs/comparison/ | Example Seed: 1,200 projects created per second, 4 ms median read | Registry benchmark, Example Seed row |
| /docs/comparison/ | Hosted registry: 310 per second, 18 ms | Registry benchmark, hosted registry row |
| /docs/comparison/ | Self-built scripts: 45 per second, 120 ms | Registry benchmark, self-built row |
