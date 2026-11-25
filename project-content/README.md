# Reviewed project content

`stable.json` is the shared source for the README summaries and the STS website
introductions. It contains reviewed facts about a published release, with Chinese,
English, and Korean copy. Host IDs and names are maintained once.

The current baseline describes release `0.2.6`, published on November 19, 2026.
Its annotated tag resolves to commit
`8d50e944fde93b7f59e2620a36ccdcaaddb964cd`. The `evidence` paths are relative to
that commit. Reviewed content is maintained after publication without changing
the release tag.

The six Host integrations remain separate from the DeepSeek Harness preview.
The preview targets DSH `0.2.2-rc.3`, the `web` profile and Standard preset,
requires Node.js 24.9.0+, and uses a separate TGZ release asset. Its Windows
local-probe checks include optional `apply_patch`; they do not establish model
effectiveness or other DSH presets. Codex parent-boundary inheritance and
single-use dependency approval are released in 0.2.6. PR #143's proposed
workflow guidance is not included. Core Node requirements, Pi requirements,
and the runtime used for OMP verification remain described separately.

## Update after review

1. Read the published Release and its resolved tag commit. Check INSTALL.md,
   EVIDENCE.md, the adapter contract, and the relevant Skills at that commit.
2. Update the stable facts and all affected translations in `stable.json`.
   Update `reviewedAt` only when the reviewed content changes. Keep unreleased
   main changes out of this file, even when package.json has the same version.
3. Update `release-proof.json` with the official release metadata and resolved
   commit. It is a captured baseline for offline checks, not a live-release check.
4. Run `npm run content:build` and `npm run check`. The check fails when generated
   README summaries are stale. Long tutorials and historical records remain
   editorial content.
5. Have dot compare the description with the release evidence, review language
   consistency and limitations, then prepare the website import and its checks.

The website importer validates data, not the meaning of a claim. A successful
script run does not replace dot's semantic review. There is no scheduled writer,
automatic merge, or software release in this workflow.

## First import before either PR is merged

With both repositories checked out side by side, run from the website repository:

```sh
node scripts/sync-sts-content.mjs --source ../sts/project-content/stable.json --release ../sts/project-content/release-proof.json
```

Use the actual STS checkout directory name in those paths. This is explicitly an
offline import of a reviewed baseline. It does not claim that public main already
contains the new source. Compare the committed website snapshot with stable.json.

Once the source PR is merged, `node scripts/sync-sts-content.mjs` reads public main
and verifies the latest stable GitHub Release and tag commit. Use `--ref` with a
full source commit SHA to review a specific source revision. A new schema requires
an explicit consumer update; the importer never downloads or executes a validator.
