# Reviewed project content

`stable.json` is the shared source for the README summaries and the STS website
introductions. It contains reviewed facts about a published release, with Chinese,
English, and Korean copy. Host IDs and names are maintained once.

The initial baseline describes release `0.2.5`, published on October 15, 2026.
Its annotated tag resolves to commit
`8bc1ac558167121e7f28d9fb0bec05c039952206`. The `evidence` paths are relative to
that commit. This baseline was added after the release; it does not modify the
old tag or claim that this content file existed in the release.

The release includes six Host adapters, including the explicit Oh My Pi
Extension. Its README header had an older five-Host list; the tagged INSTALL.md,
EVIDENCE.md, and package manifest establish OMP support. DSH and later dependency
approval changes on main are not stable-release capabilities. Core Node
requirements, Pi requirements, and the runtime used for OMP verification are
described separately.

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
