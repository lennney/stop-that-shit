# Privacy

Stop That Shit is local-only. It has no telemetry, cloud service, transcript
upload, or analytics endpoint.

The plugin stores contract state and append-only runtime evidence in a
host-owned data or configuration directory. Runtime events are metadata-only: event time,
a derived session key, plugin/control revision, tool name, mutability, path
count, boolean hash/dependency intent, bounded contract fields, the Guard
decision, and the response returned to the host.

Runtime events do not store prompts, tool inputs, commands, path text, code,
diffs, tool output, model responses, or raw session identifiers. Manual labels
(`correct`, `incorrect`, or `inconclusive`) are stored in a separate append-only
annotation log. The most recent label is used for summaries; prior labels are
not rewritten.

The session filename is derived from the opaque host session identifier so that
the identifier itself is not exposed as a path. This local derivation is not an
anonymity or security claim. Runtime events report host effect as `unobserved`:
a returned permission deny is not proof that the proposed action did not occur
through another path.

Removing the plugin does not necessarily remove host-owned plugin data. Users
may delete that plugin data through their normal host data-management workflow.
