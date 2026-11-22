# ADR 7: Store pages as Markdown

Status: **accepted**

## Context

We need pages that can be diffed, searched and exported. See [the spec](https://docs.example.org/spec#storage).

## Options

| Option | Diffable | Round trip | Cost |
|:---|:---:|:---:|---:|
| Markdown | yes | mostly | low |
| JSON document | no | exact | low |
| HTML | partly | no | `high` |

## Decision

Store **canonical Markdown** next to the Yjs state.

## Consequences

* Some constructs are rewritten once (`-` bullets become `*`).
* A page that cannot be written as Markdown is *refused* and keeps its last good copy.
