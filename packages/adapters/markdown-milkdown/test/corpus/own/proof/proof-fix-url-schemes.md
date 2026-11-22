# URL schemes

Allowed: [web](https://example.com/a?b=c#d), [mail](mailto:someone@example.com), [phone](tel:+15551234), [chat](xmpp:room@example.org?join), [relative](/docs/page), [sibling](./other.md), [anchor](#section) and [spaced](<my file.pdf>).

Refused, the text stays: [a](javascript:alert(1)), [b](JaVaScRiPt:alert(1)), [c](<java	script:alert(1)>), [d](vbscript:msgbox(1)), [e](data:text/html;base64,PHNjcmlwdD4=), [f](file:///etc/passwd), [g](blob:https://example.com/1), [h](<&#106;avascript:alert(1)>), [i](%6Aavascript:alert(1)), [j](javascript%3Aalert(1)), [k](<%20javascript:alert(1)>).

Images: ![allowed](https://example.com/i.png "title"), ![refused alt text](data:image/svg+xml,hi), ![](javascript:alert(1)) with no alt text, and an image link [![kept image](https://example.com/p.png)](javascript:alert(2)).

Autolinks and references: <javascript:alert(3)> and [ref][r].

[r]: vbscript:x
