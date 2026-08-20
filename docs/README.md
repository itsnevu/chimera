# Chimera documentation

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | How the pieces fit, and why the render step is split in two |
| [pipeline.md](pipeline.md) | Every stage, command by command, with what each costs |
| [consistency.md](consistency.md) | The seven levers that keep 1,000 renders on-model |
| [cost-control.md](cost-control.md) | Every guard standing between you and a surprise bill |
| [configuration.md](configuration.md) | Every option in every config file |
| [studio.md](studio.md) | The Next.js UI and its HTTP API |
| [troubleshooting.md](troubleshooting.md) | Errors you will actually hit, and what they mean |
| [ai-mode-plan.md](ai-mode-plan.md) | The original design document |

## The short version

Chimera rolls NFT traits **first**, with real rarity weights, then writes the
prompt from them and renders. That ordering is the whole point: a diffusion
model emits a flat image with no discrete traits, so if you render first you
have nothing to put in the metadata and nothing to compute rarity from.

Two renderers share one engine:

- **layer mode** composites transparent PNGs you drew. Free, instant, exact.
- **AI mode** sends each rolled combination to an image model, conditioned on
  one approved reference image.

Everything about rarity, uniqueness, DNA and metadata is identical between
them, because it is literally the same code.
