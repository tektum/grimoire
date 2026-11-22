# URL schemes

Allowed: [web](https://example.com/a?b=c#d), [mail](mailto:someone@example.com), [phone](tel:+15551234), [chat](xmpp:room@example.org?join), [relative](/docs/page), [sibling](./other.md), [anchor](#section) and [spaced](<my file.pdf>).

Refused, the text stays: a, b, c, d, e, f, g, h, i, j, k.

Images: ![allowed](https://example.com/i.png "title"), refused alt text,  with no alt text, and an image link ![kept image](https://example.com/p.png).

Autolinks and references: javascript:alert(3) and ref.
