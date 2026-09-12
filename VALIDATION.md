# Validation

Validated from commit `141e3387d4445d6a2a8defb15320eee186732afe` on 2026-09-12.

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | passed; 90 packages installed for local validation |
| `npm run check` | passed: TypeScript, Effect diagnostics, and 35 Vitest tests |
| `npm run build` | passed |

This validates the reusable TypeScript controller and React/TV adapter contracts. It does not establish browser, Tizen AVPlay, Vizio/webOS, codec, DRM, HDR, or physical-TV playback support; those need their target runtime or device.
