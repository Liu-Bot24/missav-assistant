# Audit remediation and verification

Baseline: `2dc5b707745ea0e7da312fea3b96ce720b70400e` (v1.0.1).
Scope: MA-01 through MA-06 from the 2026-10-02 audit of this exact snapshot.
The version is unchanged because this is a review proposal, not a release.

## Changes

- **MA-01:** Observe `href`, `class`, `hidden`, `x-show`, and `style`; invalidate a reused card's settled decision, reevaluate its current ID, and ignore extension-owned class differences. The class observer records old values so extension masks do not cause a feedback loop.
- **MA-02:** One 15-second deadline covers response headers and body consumption. Settings changes, page exit, and observed navigation cancel requests. Generation/location checks prevent late responses, cache writes, or old finalizers from taking ownership of newer work. Connection/body failure releases pagination and offers retry.
- **MA-03:** Normalize imported navigation and resource URLs against the source response and a same-origin HTTP(S) base before filtering/deduplication/insertion. Navigation and subsequent-page links stay same-origin; resource URLs permit HTTP(S), including existing CDN URLs. Unsupported URL schemes and invalid srcset candidates are discarded. This is URL-semantics hardening, not a claim that the baseline had exploitable XSS.
- **MA-04:** Storage reads/writes check callback errors and Promise failures. The popup coalesces changes for 150 ms and serializes writes; only the latest acknowledged revision receives a success message. Failed edits remain visibly unsaved, with retry/reload and explicit local-save options. Initial read failure disables editing rather than saving guessed defaults.
- **MA-05:** New settings default to local storage. A shared reader keeps popup and content-script behavior aligned. Old sync settings remain active without writes until an explicit choice; users can use existing copies or deliberately replace a destination copy. Switching to local keeps the old sync copy and does not change other devices. Disclosures identify preference data, sync behavior, and retention.
- **MA-06:** Complete metadata is reused for seven days, not indefinitely. Missing/future/expired timestamps refresh; unavailable refresh does not silently use expired metadata. Cache clear removes stored metadata, discovered categories, and count, and invalidates in-flight work so late responses cannot restore deleted records. The clear message is restricted to this extension's own popup. Logical expiry is not a promise of physical deletion exactly after seven days.

No extension/host permissions were added. The public Recombee client token was not treated as a secret and no real API call, account, preference, website, or media was used for this work.

## Baseline evidence

The untouched baseline passed all 86 existing Node tests. Before the associated production edits, added deterministic tests reproduced:

- reused-card `href` change remained visible instead of becoming hidden
- indefinitely pending connection and body lacked an aborted signal/deadline (two tests)
- settings cancellation lacked an aborted signal and a late-body guard
- cross-directory import retained `../sample-003` instead of the intended absolute source URL
- complete cache with `cachedAt = 0` returned duration `1` without refreshing
- popup quota failure retained stored `enabled = true` but displayed the success message after an attempted `false` save

Fixtures use controlled promises, mocked storage/network, and neutral DOM. These are deterministic behavioral reproductions, not claims about a user's browser/account state.

## Reproducible checks

```sh
npm ci --ignore-scripts
npm test
for file in *.js tests/*.cjs; do node --check "$file"; done
npx playwright install --with-deps chromium
npm run test:browser:all
```

The Node suites cover the original behavior and the new boundaries, including native-API-shaped storage error callbacks, save serialization, migration, late reads, cache expiry/clear/capacity, navigation cancellation, retry ownership, same-origin/base URL handling, and reused metadata IDs.

The GitHub Actions workflow runs all six original browser entry points plus `audit-browser` independently. Browser fixtures fulfill or abort requests and mock metadata/pagination. The new browser suite uses native MutationObserver and DOM URL handling, actual 15-second connection/body deadlines, popup save failures/retries/late callbacks, and explicit local/sync migration. Extension suites use Playwright's bundled Chromium channel for headless MV3 support; see [Playwright extension testing](https://playwright.dev/docs/chrome-extensions).

## Verification boundary

On the cloud editing host, Chromium failed before page creation with `socket() failed: Operation not permitted`. This is recorded as an environment-blocked browser stage, not a product failure or a pass. No attempt was made to bypass that restriction or use a user's device. Real Chrome/Edge installation, real site templates/media, cross-device browser sync, and real API authorization remain outside this fixture-only verification. The PR and exact-commit CI results are the authoritative status of hosted browser checks; Node success alone does not establish browser success.
