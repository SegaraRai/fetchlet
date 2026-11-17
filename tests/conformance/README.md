# Conformance sources and regressions

[Conformance](../../docs/conformance.md) describes how to run the suites,
the supported modes and the known differences.

| Path                | Role                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `sources.lock.json` | Selected upstream tests, pinned commits and SHA-256 of every file  |
| `upstream/wpt/`     | WPT sources, the official testharness, support files, LICENSE.md   |
| `upstream/test262/` | Test262 sources, the official harness, LICENSE, interpreting rules |
| `expectations.json` | Individually reviewed known failures with reasons                  |
| `regressions/`      | Standalone regression tests for bugs found and fixed in fetchlet   |

Upstream sources keep the downloaded bytes; the formatter covers only
fetchlet's runner and regressions. Before selecting a new test, check the
host features, META scripts or includes and modes it needs.
`tools/conformance/update-sources.ts` updates sources, and
`vp run fetch:conformance` restores the recorded versions.
