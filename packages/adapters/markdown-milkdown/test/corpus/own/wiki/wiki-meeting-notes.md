# Platform sync, 2026-11-17

**Attendees:** Omer, Dana, Yossi, Noa
**Facilitator:** Dana

## Agenda

1. Release 0.9 status
2. On-call rota
3. Search latency

## Notes

### Release 0.9

* Code freeze is **Thursday**; Yossi owns the release branch.
* Two blockers left:
  * the *import* job times out on pages over 5 MB ([#412](https://tracker.example.org/412))
  * flaky `collab` test on CI
* Decision: ship without the new sidebar.

### Search latency

Median is fine, p99 is not. Noa will look at the query plan:

> "It is the sort, not the index." (Noa)

## Action items

* [ ] Yossi: cut release branch (Thu)
* [ ] Noa: query plan for slow search
* [x] Dana: send the rota to the channel

| Owner | Item | Due |
|---|---|---|
| Yossi | release branch | Thu |
| Noa | query plan | Fri |
